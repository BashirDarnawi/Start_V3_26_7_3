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
const nativeServices = read('src/01c-native-services.js');
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
const adsStudio = read('src/systems/ads_studio/15c-ads-studio.js');
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

check('workspace has one complete Advanced experience and no duplicate view switches',
  platform.includes("const ALBAYAN_EXPERIENCE_MODE_KEY = 'albayan_experience_mode';") &&
  platform.includes("return 'advanced';") &&
  platform.includes("document.body.classList.add('workspace-advanced')") &&
  platform.includes("document.body.classList.remove('workspace-simple')") &&
  views.includes('renderWorkspaceTopbar()') &&
  !views.includes('onclick="toggleWorkspaceExperienceMode()"') &&
  !views.includes("onclick=\"setWorkspaceExperienceMode('simple')\"") &&
  !views.includes("onclick=\"setWorkspaceExperienceMode('advanced')\"") &&
  !routing.includes("id: 'workspace-mode'") &&
  css.includes('.workspace-topbar'));
check('workspace progressive panels stay accessible in the complete view',
  !views.includes('if (isAdvancedWorkspaceMode()) return true;') &&
  !views.includes("if (isAdvancedWorkspaceMode()) return '';") &&
  views.includes('panels[view]') &&
  views.includes('function renderWorkspaceFilterToggle(view, activeCount = 0)') &&
  views.includes('aria-expanded="${expanded ? \'true\' : \'false\'}"') &&
  views.includes('aria-controls="${safeView}-advanced-filters"') &&
  ['customers', 'receipts', 'ads', 'audit']
    .every(view => views.includes(`isWorkspaceFilterPanelExpanded('${view}')`)) &&
  css.includes('.workspace-advanced-panel.hidden'));
check('Pages exposes a phone-safe Needs owner filter that composes with search',
  stateServices.includes("pageOwnerFilter: 'all'") &&
  views.includes('function applyPageOwnerFilter(mode)') &&
  views.includes("mode === 'needs-owner' ? 'needs-owner' : 'all'") &&
  views.includes("pageOwnerFilter === 'needs-owner' && !pageNeedsOwner(page)") &&
  views.includes("applyPageOwnerFilter('needs-owner')") &&
  views.includes("isAr ? 'يحتاج مالك' : 'Needs owner'") &&
  views.includes('smart-filter-chips mt-3'));
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
check('audit timeline exposes readable activity fields and detail actions on phones',
  views.includes('management-timeline') &&
  views.includes('management-activity-description') &&
  views.includes('management-activity-author') &&
  views.includes('management-severity-tag') &&
  views.includes('management-category-tag') &&
  views.includes('management-resource-id') &&
  views.includes('onclick="showLogDetails(this.dataset.logId)"') &&
  read('assets/management-workspace.css').includes('.management-timeline-item'));
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
  /mobile-dialog-overlay[^'\n]*fixed inset-0/.test(modals));
check('dialogs taller than a desktop window scroll instead of clipping',
  css.split('align-items: flex-start !important').length >= 3 &&
  css.includes('margin-top: auto') &&
  css.includes('margin-bottom: auto') &&
  css.indexOf('.mobile-dialog-overlay {') < css.indexOf('@media (max-width: 900px), (max-height: 500px)'));
check('Edit Ad keeps an always-visible phone-sized history action in its fixed header',
  adEditModal.includes('data-action="view-ad-edit-history"') &&
  adEditModal.includes('data-ad-id="${Security.escapeHtml(String(adData.id || \'\'))}"') &&
  adEditModal.includes('onclick="showAdEditHistory(this.dataset.adId)"') &&
  adEditModal.includes('class="min-h-11 inline-flex') &&
  adEditModal.includes("const adHistoryCount = getAdEditHistoryCount(adData);") &&
  adEditModal.includes("${isEdit ? `"));
check('the temporary manual-page-creation pause stays a one-line flag and never blocks editing',
  forms.includes('const PAGE_MANUAL_CREATE_PAUSED = ') &&
  forms.includes('if (PAGE_MANUAL_CREATE_PAUSED) {') &&
  !helpers.includes('PAGE_MANUAL_CREATE_PAUSED'));
check('the temporary Meta-only ad-page switch stays a one-line flag',
  adEditModal.includes('const AD_PAGES_META_ONLY_FOR_ADMIN = ') &&
  adEditModal.includes('AD_PAGES_META_ONLY_FOR_ADMIN && isCurrentUserAdmin()') &&
  adEditModal.includes(".filter(p => String(p.metaPageId || '').trim())"));
// The lock must key on the ad's OWN Facebook identity (metaPageId), not on
// whether the local page link happens to be resolved in this browser — a
// fresh import draft has pageId='' until the next sync pass, and an open
// picker in that window is how an ad got attached to another business's page.
check('a Meta-linked ad locks its page field instead of offering the picker',
  adEditModal.includes("const adMetaPageId = String(adData.metaPageId || '').trim();") &&
  adEditModal.includes('const metaPageLocked = isEdit && adIsMetaLinked && (!!metaLockedPage || adMetaPageId !== \'\')') &&
  adEditModal.includes("String(p.metaPageId || '').trim() === adMetaPageId") &&
  adEditModal.includes('${metaPageLocked ? `') &&
  adEditModal.includes('data-lucide="${metaLockedPage ? \'lock\' : \'loader\'}"') &&
  adEditModal.includes('being linked automatically') &&
  adEditModal.includes('يتم ربط صفحة فيسبوك تلقائياً الآن'));
check('a still-linking Meta draft blocks submit with its own message, bilingually',
  modals.includes('awaitingMetaPageLink') &&
  modals.includes("This ad's Facebook page is being linked automatically. Wait a minute and try again.") &&
  modals.includes('يتم ربط صفحة فيسبوك لهذا الإعلان تلقائياً. انتظر دقيقة ثم أعد المحاولة.'));
// Bug-hunt 2026-08-22 guards.
// (1) An office edit of a Delivered / In Progress receipt must echo the
// driver-owned workflow instead of re-deriving it from the form (that reset
// finished deliveries to Office and unassigned the driver).
check('an unchanged-status receipt edit keeps the driver-owned delivery workflow',
  forms.includes("const storedDeliveryStatus = String(editTarget?.deliveryStatus || '');") &&
  forms.includes("(storedDeliveryStatus === 'Delivered' || storedDeliveryStatus === 'In Progress' || storedDeliveryStatus === 'Canceled')") &&
  forms.includes('receiptDeliveryStatus = storedDeliveryStatus;') &&
  forms.includes("receiptDeliveryPersonId = String(editTarget.deliveryPersonId || '');"));
// (2) Live sync fans out through a bounded pool (14 parallel GETs exceeded the
// server's connection cap and came back as raw 503s = the red badge), records
// WHY a tick failed, and says so on the badge with RTL-safe margins.
check('live sync uses a bounded fan-out and the badge says why it failed',
  liveSync.includes('async function _runWithConcurrency(items, limit, fn, isAborted = () => false)') &&
  liveSync.includes('while (next < list.length && !isAborted())') &&
  liveSync.includes('_runWithConcurrency(\n    deltaCollections, SERVER_API.liveSyncConcurrency || 4, safeSince, _syncAborted\n  )') &&
  liveSync.includes('_serverLiveSync.lastFailure = {') &&
  liveSync.includes("(failure.status ? ` (${failure.status})` :") &&
  !liveSync.includes('rounded-full mr-2"></span>') &&
  liveSync.includes('rounded-full me-2"></span>'));
check('the production server allows more connections than one tab fans out',
  /--limit-concurrency",\s*"128"/.test(read('server/Dockerfile')) &&
  read('deploy/albayan.service').includes('--limit-concurrency 128'));
// (3) The imported-ad page lock keys on a LIVE Facebook identity; after an
// unlink (metaImportSource survives) the picker must reopen.
check('imported-ad page lock keys on live Facebook identity, not import provenance',
  adEditModal.includes("const adIsMetaLinked = String(adData.metaAdId || '').trim() !== ''\n        || String(adData.metaPageId || '').trim() !== '';") &&
  !adEditModal.includes("String(adData.metaImportSource || '').trim() !== '';\n      // Meta reveals"));
// (4) The ads-table page cell flags an ad attached to a DIFFERENT Facebook
// page's local page, and the receipt coverage panel is bilingual with LTR money.
check('ads table flags a page mismatch and the coverage panel is bilingual',
  metaAds.includes('data-role="meta-page-mismatch"') &&
  metaAds.includes("isAr ? 'صفحة غير مطابقة' : 'Page mismatch'") &&
  views.includes("isArV ? 'تغطية الدين من أموال الشركة' : 'Company funds debt coverage'") &&
  views.includes("isArV ? 'تغطية من أموال الشركة' : 'Cover with company funds'") &&
  views.includes('<span dir="ltr" class="font-bold text-rose-600 dark:text-rose-300">$${companyCoverableOutstandingUSD.toFixed(2)}</span>'));
// (5) Raw server refusals reach users under a bilingual title with a human
// noun and translated rule text — never "Failed to save receipts: <English>".
check('server refusal toasts are bilingual and never expose internal collection names',
  dataAudit.includes('function _serverRefusalToast(action, collectionName, error)') &&
  dataAudit.includes("['Receipt type is server-controlled', 'نوع الوصل يحدده الخادم ولا يمكن تغييره.']") &&
  dataAudit.includes("receipts: ['الوصل', 'receipt']") &&
  !dataAudit.includes("showNotification('Server Error', `Failed to") &&
  !dataAudit.includes("showNotification('Session Expired',") &&
  helpers.includes("isAr ? 'غير مسموح' : 'Access denied'"));
// Bug-hunt verification round 2 (2026-09-04).
// A zero-value delivery receipt whose debt lives only on linked driver ads
// is not coverable server-side (409 every time) — offer nothing.
check('coverage is not offered for linked-ads-derived delivery debt',
  helpers.includes("if (target.source === 'linked_ads') return 0;"));
// A paid-KEEPING edit that touches only collect / delivery-workflow fields
// must take the generic PATCH path (receipts.markCollected) instead of
// /settle (receipts.edit), or collect-only staff are 403'd.
check('narrow paid-keeping receipt edits bypass the settle route',
  dataAudit.includes('const _RECEIPT_NARROW_GRANT_FIELDS = new Set([') &&
  dataAudit.includes("'collected', 'collectedAmount', 'collectedPayments', 'collectedMatchesReceipt',") &&
  dataAudit.includes('const _narrowPaidKeepingEdit = collectionName === \'receipts\'') &&
  dataAudit.includes("&& (_oldReceiptStatus === 'paid' || old.isPaid === true)") &&
  dataAudit.includes('&& sanitizedUpdates.status === undefined') &&
  dataAudit.includes("&& _nextReceiptStatus === 'paid'\n      && !_narrowPaidKeepingEdit;"));
// The Ad Links section offers Paste link the way Photos offers Paste photo:
// native clipboard in the packaged app, navigator.clipboard on the web,
// bare-domain tolerated, non-links refused, duplicates refused, bilingual.
check('ad links offer a clipboard Paste link button with safe fallbacks',
  adEditModal.includes('pasteAdLinkFromClipboard()') &&
  adEditModal.includes('لصق رابط') &&
  adEditModal.includes('Paste link') &&
  forms.includes('async function pasteAdLinkFromClipboard()') &&
  forms.includes('readNativeClipboardText') &&
  forms.includes('navigator.clipboard.readText()') &&
  forms.includes("url = `https://${url}`;") &&
  forms.includes('انسخ رابطاً أولاً ثم حاول مرة أخرى.') &&
  forms.includes('This link is already in the list.') &&
  nativeServices.includes('async function readNativeClipboardText()'));
// receiptType is server-controlled on edit (any CHANGE is a 405); legacy
// temp receipts store no type at all, so an edit that recomputes the tag
// from tempReceiptNo turns into a forbidden ''->DELIVERY_TEMP change and the
// save fails outright ("Failed to save receipts: Receipt type is
// server-controlled" — the 2026-08-20 employee incident). Edits must echo
// the stored type verbatim; only a NEW receipt derives its tag.
check('a receipt edit echoes its stored type instead of recomputing it',
  forms.includes('receiptType: editTarget') &&
  forms.includes("? (editTarget.receiptType || '')") &&
  forms.includes(": (tempReceiptNo ? 'DELIVERY_TEMP' : (_newReceiptCarried ? 'CARRIED_BALANCE' : ''))"));
// The owner's requested escape hatch: admins may deliberately re-point an
// imported ad, but only through a warned flow whose confirmation is a
// request-only flag — never for employees, never silently, never stored.
check('changing an imported ad page is an admin-only warned flow',
  adEditModal.includes('isCurrentUserAdmin() ? `') &&
  adEditModal.includes('confirmMetaAdPageChange()') &&
  adEditModal.includes('id="ad-page-override-picker"') &&
  adEditModal.includes('id="ad-meta-page-override"') &&
  forms.includes('function confirmMetaAdPageChange()') &&
  forms.includes('if (!isCurrentUserAdmin()) return;') &&
  forms.includes('if (!confirm(warning)) return;') &&
  forms.includes('هذا الإعلان يخص صفحة فيسبوك') &&
  forms.includes('This ad ran on the Facebook page') &&
  modals.includes("isServerModeEnabled() && document.getElementById('ad-meta-page-override')?.value === '1'") &&
  modals.includes('adUpdates.confirmMetaPageOverride = true;'));
check('ad page dropdown marks Meta-imported pages with a Meta badge',
  adEditModal.includes("String(p.metaPageId || '').trim() ?") &&
  adEditModal.includes('>Meta</span>') &&
  adEditModal.includes('dark:bg-blue-900/40 dark:text-blue-300') &&
  adEditModal.includes('data-record-action="select-ad-page"'));
check('admins can record a verified delivery completion, others stay blocked',
  helpers.includes('const isAdminCompletion = isCurrentUserAdmin();') &&
  helpers.includes("!isAdminCompletion && String(state.currentUser?.role || '').toLowerCase() !== 'delivery'") &&
  helpers.includes("!isAdminCompletion && String(receipt.deliveryPersonId || '') !== String(state.currentUser?.id || '')") &&
  views.includes("isCurrentUserAdmin() && isTempDeliveryReceiptNo(receipt.tempReceiptNo) && receipt.deliveryStatus !== 'Delivered'") &&
  views.includes(`onclick="openReceiptDeliveryCompletionModal('\${receipt.id}')"`));
check('editing a temp receipt to Paid-by-delivery routes to the completion flow instead of a raw server error',
  forms.includes("(statusDetail.paidCollection || 'office') === 'delivery' && editTarget") &&
  forms.includes('isTempDeliveryReceiptNo(editTarget.tempReceiptNo)') &&
  forms.includes('openReceiptDeliveryCompletionModal(editTarget.id);') &&
  forms.includes('Only the assigned delivery driver or an admin can complete this delivery.'));
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
const deliveryWorkspaceSource = views.slice(
  views.indexOf('function renderDeliveriesView(logOnly)'),
  views.indexOf('function filterDeliveries(type, value)')
);
const deliveryWorkspaceCss = read('assets/operations-workspace.css');
check('receipt and unified delivery cards expose a gated tap-sized WhatsApp action',
  views.includes('showDeliveryWhatsAppPrompt(this.dataset.receiptId, this)') &&
  views.includes('data-receipt-id=') &&
  views.includes('Share delivery information to WhatsApp') &&
  views.includes('inline-flex min-h-11') &&
  views.includes('canShareDeliveryReceiptToWhatsApp(receipt)') &&
  deliveryWorkspaceSource.includes('canShareDeliveryReceiptToWhatsApp(ad)') &&
  deliveryWorkspaceSource.includes('class="ops-button ops-button--whatsapp"') &&
  deliveryWorkspaceSource.includes('showDeliveryWhatsAppPrompt(this.dataset.receiptId, this)') &&
  deliveryWorkspaceCss.includes('.ops-workspace .ops-button {') &&
  deliveryWorkspaceCss.includes('min-height: 44px;') &&
  views.slice(views.indexOf('function renderDeliveryDashboard()')).includes('canShareDeliveryReceiptToWhatsApp(ad)'));
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
  forms.includes('const availableUSD = getAdDueReceiptEffectiveAvailableUSD(r, dueUsage);') &&
  modals.includes('const selectedDueReceipt = state.receipts.find(') &&
  modals.includes('getAdDueReceiptEffectiveAvailableUSD(selectedDueReceipt, dueUsage)'));
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
check('delivery cards paginate filtered records with bilingual labels and scoped search',
  views.includes('const DELIVERIES_PAGE_SIZE = 30;') &&
  views.includes('_deliveriesShowLimit += DELIVERIES_PAGE_SIZE;') &&
  deliveryWorkspaceSource.includes('const deliveryFilterFingerprint = JSON.stringify([filterStatus, filterDriver, searchTerm]);') &&
  deliveryWorkspaceSource.includes('_deliveriesShowLimit = DELIVERIES_PAGE_SIZE;') &&
  deliveryWorkspaceSource.includes('const visibleDeliveryRows = filteredDeliveries.slice(0, _deliveriesShowLimit);') &&
  deliveryWorkspaceSource.includes('const remainingDeliveryRows = filteredDeliveries.length - visibleDeliveryRows.length;') &&
  deliveryWorkspaceSource.includes('visibleDeliveryRows.map(renderDeliveryCard)') &&
  deliveryWorkspaceSource.includes('data-delivery-record="${safeId}"') &&
  deliveryWorkspaceSource.includes('onclick="loadMoreDeliveries()"') &&
  ['Driver', 'Amount', 'Status', 'Office handover', 'Date', 'Actions']
    .every(label => deliveryWorkspaceSource.includes(`: '${label}'}`)) &&
  deliveryWorkspaceSource.includes("customer?.name || (isAr ? 'غير معروف' : 'Unknown')") &&
  deliveryWorkspaceSource.includes('id="delivery-log-results"') &&
  deliveryWorkspaceSource.includes('if (logOnlyPass) return resultsHtml;') &&
  deliveryWorkspaceSource.indexOf('onclick="loadMoreDeliveries()"') < deliveryWorkspaceSource.indexOf('if (logOnlyPass) return resultsHtml;') &&
  views.includes('if (newResults) results.innerHTML = newResults.innerHTML;') &&
  !deliveryWorkspaceSource.includes('<table') &&
  deliveryWorkspaceCss.includes('.ops-workspace .ops-delivery-grid') &&
  deliveryWorkspaceCss.includes('@media (max-width: 380px)'));
check('delivery cards retain assignment, status, handover, cancellation and report gates',
  deliveryWorkspaceSource.includes("const canAssign = roleLower !== 'delivery' && can('deliveries', 'assign');") &&
  deliveryWorkspaceSource.includes("const canOffice = roleLower !== 'delivery' && can('deliveries', 'markCollected');") &&
  deliveryWorkspaceSource.includes("const canViewDeliveryStats = can('deliveries', 'viewStats');") &&
  deliveryWorkspaceSource.includes("const canExportDeliveries = can('deliveries', 'viewStats') || can('receipts', 'export');") &&
  deliveryWorkspaceSource.includes('const deliveryTarget = _getCollectionTargetCached(ad);') &&
  deliveryWorkspaceSource.includes("roleLower === 'delivery' ? ''") &&
  ['assignDelivery', 'updateDeliveryStatus', 'showDeliveryDetails', 'markOfficeHandover', 'undoOfficeHandover', 'removeDeliveryMission', 'openDeliveryCancelModal', 'exportDeliveryReport', 'checkStuckDeliveries']
    .every(action => deliveryWorkspaceSource.includes(`${action}(`)));
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
  views.includes("shellAdSummaryRow(ad, {") &&
  views.includes('ad-photo-view-button') &&
  views.includes('data-action="view-ad-photos"') &&
  views.includes('data-role="ad-creator"') &&
  css.includes('button.ad-photo-view-button') &&
  css.includes('min-height: 2.75rem'));
check('ads retain the classic desktop table with responsive phone details and direct receipt links',
  views.includes('ads-summary-table mobile-card-table') &&
  !views.includes('<article class="ad-campaign-card"') &&
  views.includes('receiptExchangeRate?.toFixed(2)') &&
  views.includes('renderMetaAdBudgetSummary(ad, isAr)') &&
  views.includes('data-action="view-ad-receipt"') &&
  views.includes("canOpenWorkspaceView('receipts')") &&
  views.includes("<tr ${shellTableDetailAttrs('ads',") &&
  css.includes('table-layout: fixed;') &&
  read('assets/ads-workspace.css').includes('overflow-wrap: anywhere') &&
  read('index.html').includes('assets/ads-workspace.css'));
check('shared financial stats never ellipsize amounts and Add Ad keeps its high-contrast button',
  views.includes('class="workspace-stat-value text-lg md:text-3xl font-bold mt-1 md:mt-2"><bdi>${value}</bdi>') &&
  !views.includes('font-bold mt-1 md:mt-2 truncate">${value}') &&
  read('assets/workspace-layout.css').includes('.workspace-stat-layout { flex-direction: column-reverse;') &&
  views.includes('onclick="showAdModal()" class="btn-shine bg-indigo-600 text-white'));
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
  /if \(_sessionCache\.identity === identity && _sessionCache\.user\)[\s\S]*?return _sessionCache\.user;[\s\S]*?throw e;/.test(serverApi) &&
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
  // The fade still applies only while the badge is genuinely still 'synced';
  // the body grew a visibility reset, so match the guard, not one exact line.
  liveSync.includes("if (indicator?.dataset.status === 'synced') {") &&
  liveSync.includes("indicator.style.opacity = '0';") &&
  liveSync.includes('indicator.onclick = null;') &&
  liveSync.includes("indicator.setAttribute('aria-live', 'polite')"));
// A 3s poll that painted "Syncing…"/"Synced" on every tick left a pill
// flashing in the corner forever and was read as a failure. Routine ticks
// must stay silent; only slow syncs, real errors, and user-initiated syncs
// may paint.
check('a healthy background sync tick paints no badge at all',
  liveSync.includes('const SYNC_BADGE_SLOW_MS = 1200;') &&
  liveSync.includes('function updateSyncIndicator(status, { immediate = false } = {})') &&
  liveSync.includes("if (status === 'syncing' && !immediate) {") &&
  liveSync.includes("_paintSyncIndicator('syncing');") &&
  liveSync.includes("if (status === 'synced' && !immediate && !_syncIndicatorVisible) return;") &&
  liveSync.includes("updateSyncIndicator('syncing', { immediate: true });") &&
  liveSync.includes("updateSyncIndicator('synced', { immediate: true });") &&
  views.includes("updateSyncIndicator('syncing', { immediate: true });") &&
  views.includes("updateSyncIndicator('synced', { immediate: true });"));
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
  adsStudio.includes('studio-section-tabs flex flex-wrap gap-2') &&
  css.includes('.ui-workspace .studio-section-tabs { display: grid;') &&
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
  adsStudio.includes("adsStudioActionAttempt('submit', campaign.id, Number(campaign._lastModified))") &&
  adsStudio.includes("adsStudioActionAttempt('review', campaign.id, Number(campaign._lastModified))") &&
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
  forms.includes("collectionDate: status === 'Not Paid'") &&
  forms.includes("((editTarget ? editTarget.collectionDate : '') || (receiptIsPaid ? new Date().toISOString() : ''))") &&
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
  // foldSearchText is a memo in front of the real folder (a pure-string cache,
  // proven match-identical). Both halves are pinned: the entry point must
  // delegate every uncacheable value, and the folder itself must still
  // normalize Arabic-Indic digits.
  helpers.includes('return _foldSearchTextUncached(value);') &&
  /function _foldSearchTextUncached[\s\S]{0,400}normalizeDigitsAscii\(/.test(helpers) &&
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
check('Meta ad rows expose photo, total budget, duration, account and separate history',
  views.includes('shellAdMedia(ad, isAr)') &&
  read('src/12d-manager-shell.js').includes('return renderAdPrimaryThumbnail(ad, isAr)') &&
  metaAds.includes('function renderAdPrimaryThumbnail(ad, isAr)') &&
  metaAds.includes("return renderMetaAdThumbnail(ad, isAr)") &&
  metaAds.includes('/api/collections/ads/${encodeURIComponent(String(ad.id || \'\'))}/primary-photo') &&
  views.includes('renderMetaAdPageSummary(ad, adPage, adPageDeleted, isAr)') &&
  views.includes('getAdEditHistoryCount(ad)') &&
  metaAds.includes('function openMetaAdPreview(adId)') &&
  metaAds.includes('metaTotalBudgetMinor') &&
  metaAds.includes('function metaAdsTotalRemainingMinor(ad)') &&
  metaAds.includes("'Total remaining'") &&
  !metaAds.includes("totalKind === 'estimated_daily' && days") &&
  metaAds.includes("'Duration'") &&
  metaAds.includes("'Ad account'") &&
  metaAds.includes('showMetaAdHistory(this.dataset.metaHistoryAdId)') &&
  helpers.includes('function getMetaAdHistoryEntries(ad)') &&
  helpers.includes('function showMetaAdHistory(adId)') &&
  css.includes('.meta-ad-thumbnail-button') &&
  css.includes('.meta-ad-thumbnail-placeholder') &&
  metaAds.includes('meta-ad-thumbnail-placeholder') &&
  css.includes('.meta-ad-history-button'));
check('Meta insights tracker exposes active pages and combined remaining budget',
  views.includes('renderMetaInsightsHeaderButton(isAr)') &&
  metaAds.includes('function metaAdsActiveRemainingSummary()') &&
  metaAds.includes('function openMetaInsightsModal()') &&
  metaAds.includes('apiMetaPartnerPages(') &&
  metaAds.includes("'Active pages (Meta partner metric)'") &&
  metaAds.includes("'Total remaining budget — all active ads combined'") &&
  metaAds.includes('metaInsightsLoad(true)') &&
  serverApi.includes('/api/meta-ads/partner-pages') &&
  metaAds.includes('if (!isCurrentUserAdmin() || !isServerModeEnabled())'));
check('Meta page cell shows the page ID once with the real name below it',
  metaAds.includes("name === 'facebook page'") &&
  metaAds.includes('#${Security.escapeHtml(pageId)}') &&
  metaAds.split('#${Security.escapeHtml(pageId)}').length === 2 &&
  metaAds.includes('const pageName = realLocalName || realMetaName;') &&
  !metaAds.includes('realMetaName || localName ||'));
check('Meta Ads API wrapper never accepts a token from browser code',
  serverApi.includes("apiJson('/api/meta-ads/status'") &&
  serverApi.includes("'/api/meta-ads/sync-due'") &&
  !serverApi.includes('metaAccessToken') &&
  !serverApi.includes('access_token'));
check('Meta-first imports stay distinct from real unpaid customer debt',
  helpers.includes('function isMetaAdSetupPending(ad)') &&
  helpers.includes("f.payment === 'pending_setup'") &&
  views.includes("applyAdQuickFilter('setup')") &&
  views.includes("'No debt yet'") &&
  views.includes('completeMetaImportedAd') &&
  modals.includes('This ad was imported automatically from Meta') &&
  modals.includes('No customer debt exists until these details are saved.'));
check('Meta-first automatic discovery is visible and never bulk-imports history from the browser',
  serverApi.includes("'/api/meta-ads/auto-import/run'") &&
  serverApi.includes('body: { includeExisting: false }') &&
  metaAds.includes('Automatic ad and page import') &&
  metaAds.includes('metaAdsCheckForNewAds()') &&
  metaAds.includes('safe drafts that need completion'));
check('Meta rate limits are shown once as a safe automatic pause',
  metaAds.includes('status?.providerState') &&
  metaAds.includes('Paused safely') &&
  metaAds.includes('Albayan is protecting the Meta connection') &&
  metaAds.includes('Automatic retry pending') &&
  metaAds.includes("errorCode.toLowerCase().includes('rate_limited')") &&
  metaAds.includes('providerThrottle ? \'\' :'));

// Optional system-browser app login for packaged Capacitor apps: the app can
// open the hosted login page and receive a one-time code through the
// albayan://auth deep link (PKCE-bound).
const androidManifest = read('android/app/src/main/AndroidManifest.xml');
const iosPlist = read('ios/App/App/Info.plist');
const appLoginStartBody = serverApi.slice(
  serverApi.indexOf('async function startAppBrowserLogin('),
  serverApi.indexOf('function cancelAppBrowserLogin(')
);

check('packaged app defaults to its own login surface with a secure-browser option',
  serverApi.includes("let _nativeLoginMode = 'form';") &&
  views.includes('function renderNativeAppLogin(') &&
  views.includes('return renderNativeAppLogin(bannersHTML, isRTL);') &&
  views.includes('onclick="startAppBrowserLogin()"') &&
  views.includes('onclick="nativeLoginUseForm()"') &&
  views.includes('onclick="nativeLoginUseBrowser()"') &&
  views.includes('onclick="cancelAppBrowserLogin()"') &&
  serverApi.includes('Platform.isCapacitor && isServerModeEnabled()'));

check('native PKCE verifier and device preferences use encrypted platform storage',
  nativeServices.includes("getCapacitorPlugin('SecureStorage')") &&
  nativeServices.includes('internalSetItem') &&
  nativeServices.includes('whenUnlockedThisDeviceOnly') &&
  serverApi.includes('nativeSecureSet(APP_LOGIN_PENDING_KEY') &&
  serverApi.includes('nativeSecureGet(APP_LOGIN_PENDING_KEY') &&
  serverApi.includes('localStorage.removeItem(APP_LOGIN_PENDING_KEY)'));

check('native camera, clipboard and sharing reuse guarded app workflows',
  nativeServices.includes("getCapacitorPlugin('Camera')") &&
  nativeServices.includes("getCapacitorPlugin('Clipboard')") &&
  nativeServices.includes("getCapacitorPlugin('Share')") &&
  nativeServices.includes('_routePastedPhotoFiles(resolvedTarget, [file])') &&
  photoPaste.includes('readNativeClipboardImage()') &&
  helpers.includes('nativeShareContent({') &&
  ['ad', 'receipt'].every(target => modals.includes(`takeNativePhoto('${target}')`)) &&
  helpers.includes("takeNativePhoto('delivery')") &&
  clothes.includes("takeNativePhoto('clothes-product')") &&
  adsStudio.includes("takeNativePhoto('ads-studio')"));

check('native biometric lock, reminders and phone viewport protections are wired',
  nativeServices.includes("getCapacitorPlugin('BiometricAuthNative')") &&
  nativeServices.includes('allowDeviceCredential: true') &&
  nativeServices.includes("getCapacitorPlugin('LocalNotifications')") &&
  nativeServices.includes("navigateToInternal('reconciliation')") &&
  nativeServices.includes('window.visualViewport') &&
  nativeServices.includes("_addNativeListener(keyboard, 'keyboardWillShow'") &&
  nativeServices.includes('const protectedSession = _nativePrefs.biometricEnabled && state?.currentUser;') &&
  nativeServices.includes('Date.now() - _nativeBackgroundedAt >= NATIVE_APP_LOCK_AFTER_MS') &&
  nativeServices.includes('removeNativeAppLock();') &&
  views.includes('data-native-device-settings') &&
  css.includes('.native-app-lock') &&
  css.includes('var(--app-visual-height, 100dvh)'));

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
  liveSync.includes('await maybeCompleteAppLoginHandoff(user, true);') &&
  serverApi.includes("'/api/auth/app-login/handoff'") &&
  views.includes('Signing in to the Albayan app'));

check('an already-signed-in web session never hands off to the app without an explicit tap',
  init.includes('maybeOfferAppLoginHandoffForActiveSession') &&
  serverApi.includes('function maybeOfferAppLoginHandoffForActiveSession()') &&
  serverApi.includes('albayanConfirmAppHandoff()') &&
  serverApi.includes('albayanDeclineAppHandoff()') &&
  serverApi.includes('clearPendingAppLoginRequest();'));

check('destroyed receipt is a third RED chooser option that records only the number',
  helpers.includes("_pickNewReceipt('destroyed')") &&
  helpers.includes('border-color:#dc2626') &&
  helpers.includes("isAr ? 'وصل تالف' : 'Destroyed Receipt'") &&
  helpers.includes('function showDestroyedReceiptModal') &&
  helpers.includes("status: 'Destroyed'") &&
  helpers.includes('isPaid: false'));

check('destroyed receipt number is validated and pre-checked before the server lock',
  helpers.includes('/^(?:[1-9][0-9]*|[SBOE][1-9][0-9]*)$/') &&
  helpers.includes('destroyed-receipt-number'));

check('destroyed receipts are excluded from every client money reader',
  helpers.includes("status === 'Canceled' || status === 'Lost' || status === 'Destroyed'") &&
  helpers.includes("st === 'Canceled' || st === 'Lost' || st === 'Destroyed'") &&
  forms.includes("status !== 'Canceled' && status !== 'Lost' && status !== 'Destroyed'") &&
  dataAudit.includes("if (status === 'destroyed') return 'canceled';") &&
  read('src/12b-control-center.js').includes("getReceiptPaymentState(receipt) !== 'not_paid'"));

check('destroyed receipt lock is enforced on every client edit door, bilingually',
  helpers.includes('function _blockDestroyedReceiptEdit') &&
  helpers.includes('_blockDestroyedReceiptEdit(receipt)') &&
  forms.includes('_blockDestroyedReceiptEdit(editTarget)') &&
  helpers.includes('/destroyed receipt is locked/i'));

check('destroying an auto-serial number still advances the client counter',
  forms.includes("const isDestroyedRow = String(receipt.status || '') === 'Destroyed';") &&
  forms.includes('!usesGroupMethod && !isDestroyedRow') &&
  forms.includes('!hasManualMethod && !isDestroyedRow'));

check('destroyed record carries createdAt so sorting and date filters stay sane',
  helpers.includes('createdAt: new Date().toISOString()'));

check('destroyed receipt card is a minimal red locked-number card',
  views.includes("String(receipt.status || '') === 'Destroyed'") &&
  views.includes('status-badge status-destroyed') &&
  views.includes('border-inline-start:5px solid #dc2626'));

check('destroyed status badge has its red style and Arabic name',
  css.includes('.status-destroyed') &&
  read('src/07-i18n-render-core.js').includes("'Destroyed': 'تالف'"));

check('ads studio wallet and Meta connection live inside the Overview, not tabs',
  adsStudio.includes('${renderAdsStudioWallet()}') &&
  adsStudio.includes('${renderAdsStudioConnections()}') &&
  !adsStudio.includes("{ id: 'wallet',") &&
  !adsStudio.includes("{ id: 'connections',") &&
  adsStudio.includes('function adsStudioWalletHeldMinor') &&
  adsStudio.includes("String(c.status || '') === 'Submitted'") &&
  serverApi.includes("apiJson('/api/wallet/payment-requests'"));

check('ads studio submit is wallet-gated with a bilingual escape hatch',
  adsStudio.includes('adsStudioWalletAvailableMinor() < _budgetMinor') &&
  adsStudio.includes('اشحن محفظتك أولاً'));

check('the ads studio has its own standalone front door at /studio',
  platform.includes('const IS_STUDIO_SHELL') &&
  platform.includes("/^\\/studio(\\/|$)/.test(window.location.pathname") &&
  routing.includes("if (IS_STUDIO_SHELL) return 'ads-studio';") &&
  routing.includes("if (IS_STUDIO_SHELL) view = 'ads-studio';") &&
  read('server/main.py').includes('"/studio",'));

check('the studio shell wears its own brand and never leads back to the manager',
  views.includes("'استوديو إعلانات البيان' : 'Albayan Ads Studio'") &&
  adsStudio.includes("if (IS_STUDIO_SHELL) return '';") &&
  routing.includes('if (IS_STUDIO_SHELL) return;') &&
  dataAudit.includes("if (IS_STUDIO_SHELL) return 'ads-studio';"));

check('the studio shell cannot resurrect manager dialogs or rewrite the manager saved page',
  routing.includes('if (IS_STUDIO_SHELL) { _bootModalParams = null; return; }') &&
  read('src/06-persistence.js').includes('if (prior && prior.currentView) toSave.currentView = prior.currentView;') &&
  read('server/main.py').includes('"/studio/",'));

// ---------- Services Hub redesign (one responsive design for web + mobile) ----------
const servicesWallet = read('src/12c-services-wallet.js');
const adminToolsLoader = read('src/12b0-admin-tools-loader.js');
const bundleManifestJson = JSON.parse(read('src/manifest.json'));

check('hub, plans and charge-wallet screens exist and stay admin-only platform views',
  servicesWallet.includes('function renderServicesHub()') &&
  servicesWallet.includes('function renderPlansView()') &&
  servicesWallet.includes('function renderChargeWalletView()') &&
  views.includes("case 'plans': return renderPlansView();") &&
  views.includes("case 'charge-wallet': return renderChargeWalletView();") &&
  views.includes("'wallet', 'plans', 'charge-wallet', 'clothes-system', 'ads-studio'].includes(state.currentView)") &&
  dataAudit.includes("'service-placeholder', 'wallet', 'plans', 'charge-wallet']") &&
  routing.includes("'plans': '/plans'") && routing.includes("'charge-wallet': '/charge-wallet'"));

check('hub prices come only from the server plan catalog, never hardcoded',
  servicesWallet.includes('function hubPlanForService(serviceId)') &&
  servicesWallet.includes('state.subscriptionPlans') &&
  !/\b\d+(\.\d+)? (LYD|د\.ل)\b/.test(servicesWallet.replace(/\/\/.*$/gm, '')) &&
  servicesWallet.includes("hubText('Subscribe', 'اشترك')") &&
  servicesWallet.includes('refreshSubscriptionPlans(true)'));

check('charge wallet creates a server payment request with a clamped currency and a method from the live catalog',
  servicesWallet.includes('apiWalletPaymentRequestCreate(amountMinor, _chargeWallet.method, idem, currency)') &&
  servicesWallet.includes('apiWalletPaymentMethods()') &&
  servicesWallet.includes("if (!_chargeWallet.method || !_walletPayMethodById(_chargeWallet.method))") &&
  serverApi.includes("const safeCurrency = String(currency || 'USD').toUpperCase() === 'LYD' ? 'LYD' : 'USD';") &&
  servicesWallet.includes("hubText('Local mode', 'الوضع المحلي')"));

check('paywall sheet never sells without a server price and routes a short wallet to Charge wallet',
  modals.includes('NEVER offer a purchase button here') &&
  modals.includes("const preferredPlanId = String(state.modalData?.planId || '');") &&
  modals.includes("${short ? 'disabled' : ''}") &&
  modals.includes("if (typeof hubOpenChargeWallet === 'function') hubOpenChargeWallet(); else navigateTo('wallet');") &&
  modals.includes("state.activeModal === 'subscription-lock')\n      ? ' max-h-[90vh] overflow-y-auto custom-scrollbar'"));

check('hub screens keep every old action, bilingual labels, LTR money and phone touch targets',
  servicesWallet.includes('onclick="toggleTheme()"') && servicesWallet.includes('onclick="toggleLanguage()"') &&
  servicesWallet.includes('onclick="handleLogout()"') &&
  servicesWallet.includes('function handleServiceClick(serviceId)') &&
  servicesWallet.includes('function handleSmartSystemClick(systemId)') &&
  servicesWallet.includes('function cancelSubscriptionFromUi(') &&
  servicesWallet.includes('walletTopUpFromUi()') && servicesWallet.includes('walletTransferFromUi()') &&
  servicesWallet.includes("hubText('Coming soon', 'قريباً')") &&
  servicesWallet.includes('dir="ltr">${hubEsc(walletFormatMinor(balanceMinor, \'LYD\'))}') &&
  (servicesWallet.match(/touch-target/g) || []).length >= 25 &&
  css.includes('.hub-card {') && css.includes('.dark .hub-card {') && css.includes('.hub-tile-watermark {'));

check('admin tools ship lazily with guarded call sites and a bounded retry',
  bundleManifestJson.lazy && Array.isArray(bundleManifestJson.lazy['admin-tools.js']) &&
  bundleManifestJson.lazy['admin-tools.js'].includes('12b-control-center.js') &&
  bundleManifestJson.lazy['admin-tools.js'].includes('13b-merge-tools.js') &&
  bundleManifestJson.files.includes('12b0-admin-tools-loader.js') &&
  views.includes("if (typeof renderControlCenterView === 'function') return renderControlCenterView();") &&
  views.includes("if (typeof resetAdMergePairCache === 'function') resetAdMergePairCache();") &&
  views.includes("typeof renderAdMergeActionButton === 'function' ? renderAdMergeActionButton(ad, isAr) : ''") &&
  helpers.includes("typeof countPageMergeGroups === 'function' ? countPageMergeGroups() : 0") &&
  adminToolsLoader.includes('const _ADMIN_TOOLS_RETRY_COOLDOWN_MS = 30000;') &&
  adminToolsLoader.includes("_adminToolsBundleState === 'failed' && Date.now() - _adminToolsLastFailureAt < _ADMIN_TOOLS_RETRY_COOLDOWN_MS) return;") &&
  adminToolsLoader.includes('onclick="retryAdminToolsLoad()"') &&
  read('server/main.py').includes('"admin-tools.js"'));

// ---------- Social Studio (posts scheduler + auto-reply rules, studio.js bundle) ----------
const socialStudio = read('src/systems/ads_studio/15f-social-studio.js');

check('social studio ships in the studio bundle and is wired into the Ads Studio tabs',
  Array.isArray(bundleManifestJson.lazy['studio.js']) &&
  bundleManifestJson.lazy['studio.js'].includes('systems/ads_studio/15c-ads-studio.js') &&
  bundleManifestJson.lazy['studio.js'].includes('systems/ads_studio/15f-social-studio.js') &&
  adsStudio.includes("{ id: 'posts', icon: 'send', label: 'Posts', labelAr: 'المنشورات' }") &&
  adsStudio.includes("{ id: 'replies', icon: 'message-circle-reply', label: 'Replies', labelAr: 'الردود' }") &&
  adsStudio.includes("else if (_adsStudioActiveTab === 'posts') content = renderSocialStudioPostsTab();") &&
  adsStudio.includes("else if (_adsStudioActiveTab === 'replies') content = renderSocialStudioRepliesTab();") &&
  adsStudio.includes("${typeof renderSocialStudioOverviewSection === 'function' ? renderSocialStudioOverviewSection() : ''}") &&
  adsStudio.includes("if (typeof resetSocialStudioState === 'function') resetSocialStudioState();"));

check('social studio never handles Meta credentials in the browser and only talks to its server API',
  !/accessToken|access_token|appSecret|app_secret|password/i.test(socialStudio) &&
  socialStudio.includes("const result = await apiJson('/api/social-studio' + path, options, extra);") &&
  socialStudio.includes('if (!socialStudioContextIsCurrent(context)) throw makeSessionChangedError();') &&
  (socialStudio.match(/apiJson\(/g) || []).length === 1 &&
  socialStudio.includes('return isServerModeEnabled() && typeof adsStudioCanUse === \'function\' && adsStudioCanUse();') &&
  socialStudio.includes('function resetSocialStudioState()') &&
  socialStudio.includes("if (_social.forUser !== uid) { resetSocialStudioState(); _social.forUser = uid; }"));

check('social composer enforces the post limits and reuses the safe image pipeline',
  socialStudio.includes('const SOCIAL_MAX_CAPTION = 2200;') &&
  socialStudio.includes('const SOCIAL_MAX_MEDIA = 4;') &&
  socialStudio.includes('const SOCIAL_MAX_MEDIA_BYTES = 5 * 1024 * 1024;') &&
  socialStudio.includes('const dataUrl = await compressImageToDataUrl(file);') &&
  socialStudio.includes("if (!isSafeAdsStudioCreativeSource(dataUrl)) throw new Error('unsupported output');") &&
  socialStudio.includes('accept="image/png,image/jpeg,image/webp"') &&
  socialStudio.includes("return socialText('Instagram posts need at least one photo.'") &&
  socialStudio.includes("return socialText('The scheduled time must be in the future.'") &&
  socialStudio.includes('scheduledAt: statusWanted === \'scheduled\' ? new Date(c.scheduledAt).toISOString() : \'\''));

check('social studio page linking is admin-only in the UI and destructive actions confirm first',
  socialStudio.includes("function socialOpenLinkSheet() {\n  if (!isCurrentUserAdmin()) return;") &&
  socialStudio.includes("${isAdmin ? `<button type=\"button\" onclick=\"socialOpenLinkSheet()\"") &&
  socialStudio.includes("const ok = confirm(socialText('Publish this post now?'") &&
  socialStudio.includes("const ok = confirm(socialText('Delete this post?'") &&
  socialStudio.includes("const ok = confirm(socialText(`Delete the rule \"${r.name}\"?`") &&
  socialStudio.includes("const ok = confirm(socialText(`Unlink \"${page.name}\"?"));

check('social studio screens are bilingual, RTL-aware and phone friendly with live-sync-safe fields',
  (socialStudio.match(/socialText\(/g) || []).length >= 80 &&
  (socialStudio.match(/touch-target/g) || []).length >= 30 &&
  socialStudio.includes("isAr ? 'chevron-right' : 'chevron-left'") &&
  socialStudio.includes('id="social-caption"') && socialStudio.includes("oninput=\"socialComposerSet('caption', this.value)\"") &&
  socialStudio.includes('id="social-rule-name"') && socialStudio.includes("oninput=\"socialRuleSet('name', this.value)\"") &&
  socialStudio.includes('id="social-schedule-at"') &&
  socialStudio.includes('role="switch"') &&
  !socialStudio.includes('<table'));

// ---------- Manager phone shell (2026-09 design: tab bar with +, More, Collect, Reminders) ----------
const managerShell = read('src/12d-manager-shell.js');
const serverMain = read('server/main.py');

check('manager shell ships in the startup bundle and the profitability module moved to the admin bundle',
  bundleManifestJson.files.includes('12d-manager-shell.js') &&
  !bundleManifestJson.files.includes('12a-analytics-profit.js') &&
  bundleManifestJson.lazy['admin-tools.js'].includes('12a-analytics-profit.js') &&
  adminToolsLoader.includes("typeof renderProfitabilityPanel === 'function'") &&
  adminToolsLoader.includes("can('analytics', 'viewFinancials')") &&
  views.includes("typeof getCurrentProfitabilitySnapshot === 'function' ? getCurrentProfitabilitySnapshot(ads) : null") &&
  views.includes("profitability && typeof renderProfitabilityPanel === 'function'") &&
  (views.match(/if \(typeof openAnalyticsBreakdown === 'function'\) openAnalyticsBreakdown\(/g) || []).length === 3);

check('phone tab bar is Home · Receipts · (+) · Customers · More with permission gating',
  views.includes("if (typeof renderManagerTabBar === 'function') return renderManagerTabBar();") &&
  managerShell.includes('function renderManagerTabBar()') &&
  managerShell.includes("const canAddReceipt = !delivery && currentUserHasPermission('receipts', 'add');") &&
  managerShell.includes('onclick="showNewReceiptChooser()" class="mobile-bottom-nav-item mobile-bottom-nav-fab"') &&
  managerShell.includes("onclick=\"navigateTo('more')\"") &&
  managerShell.includes('function shellCanOpen(viewId)') &&
  managerShell.includes("lead.filter(entry => shellCanOpen(entry.id))") &&
  css.includes('.mobile-bottom-nav-item.mobile-bottom-nav-fab > .mobile-bottom-nav-fab-circle') &&
  views.includes('aria-controls="app-sidebar"') && views.includes('mobile-menu-button'));

check('More, Collect and Reminders are real routed views with the sidebar access rules',
  views.includes("case 'more': return renderMoreView();") &&
  views.includes("case 'collect': return renderCollectView();") &&
  views.includes("case 'reminders': return renderRemindersView();") &&
  routing.includes("'more': '/more'") && routing.includes("'collect': '/collect'") && routing.includes("'reminders': '/reminders'") &&
  dataAudit.includes("  collect: 'receipts',\n  reminders: 'customers',") &&
  dataAudit.includes("if (String(view || '') === 'more') return true;") &&
  serverMain.includes('"/more",') && serverMain.includes('"/collect",') && serverMain.includes('"/reminders",') &&
  managerShell.includes("tiles.filter(tile => tile.allowed === undefined ? shellCanOpen(tile.id) : tile.allowed)"));

check('collect-a-debt and reminders delegate to the existing money flows and never invent balances',
  managerShell.includes('const statsIndex = buildCustomerStatsIndex();') &&
  managerShell.includes('const stats = getCustomerStats(c.id, statsIndex);') &&
  managerShell.includes("getReceiptPaymentState(r) === 'not_paid'") &&
  managerShell.includes("if (unpaid.length === 1 && currentUserHasPermission('receipts', 'markCollected') && typeof openCollectReceiptModal === 'function') {") &&
  managerShell.includes('if (openCustomerReceipts(cid)) {') &&
  managerShell.includes("return shellCanOpen('receipts') && (isCurrentUserAdmin() || can('customers', 'viewBalance'));") &&
  managerShell.includes("if (!can('customers', 'viewContacts')) return;") &&
  managerShell.includes("const base = (digits && !digits.startsWith('0') && digits.length >= 8) ? `https://wa.me/${digits}` : buildWhatsAppLink(phone);") &&
  managerShell.includes('localStorage.setItem(shellReminderLogKey(), JSON.stringify(log))') &&
  !/fetch\(|apiJson\(/.test(managerShell));

check('home hero hides money without analytics.viewFinancials and onboarding only shows in the packaged app',
  views.includes("renderManagerHomeHero(receipts, ads, canViewFinancials)") &&
  managerShell.includes('${canViewFinancials ? shellEsc(shellLyd(collectedLyd)) : receiptsThisMonth}') &&
  managerShell.includes('if (canViewFinancials) {\n    const statsIndex = buildCustomerStatsIndex();') &&
  managerShell.includes("if (!state.currentUser || IS_STUDIO_SHELL || !shellIsNativeApp()) return false;") &&
  managerShell.includes("localStorage.getItem(SHELL_ONBOARDED_KEY) !== '1'") &&
  views.includes("shellShouldShowOnboarding() ? renderMobileOnboarding() : ''") &&
  (managerShell.match(/touch-target/g) || []).length >= 20 &&
  !managerShell.includes('<table'));

check('global re-skin is flat: no aurora, solid cards, brand-blue primaries and chips',
  css.includes('#aurora-bg, .bg-noise { display: none !important; }') &&
  css.includes('.dark .glass-panel { background: #0f1830;') &&
  css.includes('.bg-indigo-600, .bg-purple-600, .bg-indigo-500 { background-color: var(--brand-blue) !important; }') &&
  css.includes('.smart-filter-chip.is-active { color: #ffffff; background: var(--brand-blue);') &&
  css.includes('.smart-filter-panel.glass-panel { background: transparent;') &&
  views.includes("Albayan <span class=\"text-lg font-bold text-slate-400\">البيان</span>") &&
  views.includes("typeof renderSettingsAppearanceCard === 'function'") &&
  managerShell.includes('function renderSettingsAppearanceCard()') &&
  managerShell.includes("shellSetTheme('") && managerShell.includes("onclick=\"toggleLanguage()\""));

// ---------- compact list rows (design lists) ----------
check('directory cards expose labelled facts and outside actions while preserving full details',
  managerShell.includes('function shellListRow({') &&
  managerShell.includes('class="shell-row-body" aria-labelledby=') &&
  managerShell.includes("${open ? '' : ' hidden'}>${card}</div>") &&
  managerShell.includes('function shellReceiptRow(receipt, customer, card, meta = {})') &&
  managerShell.includes('function shellCustomerRow(customer, stats, card, meta = {})') &&
  managerShell.includes('function shellPageRow(page, card, meta = {})') &&
  managerShell.includes('function shellUserRow(user, card, meta = {})') &&
  views.includes('return shellReceiptRow(receipt, customer, __receiptCard, {') &&
  views.includes('return shellReceiptRow(receipt, customer, __destroyedCard, {') &&
  views.includes('return shellCustomerRow(c, stats, __customerCard, {') &&
  views.includes('return shellPageRow(p, __pageCard, {') &&
  views.includes('return shellUserRow(u, __userCard, { canEditThisUser:') &&
  views.includes('<div id="receipts-grid" class="workspace-directory-grid">') &&
  views.includes('<div id="customers-grid" class="workspace-directory-grid">') &&
  views.includes('<div id="pages-grid" class="workspace-directory-grid">') &&
  views.includes('<div id="users-grid" class="workspace-directory-grid">') &&
  managerShell.includes('workspace-record-facts') && managerShell.includes('workspace-record-actions') &&
  views.includes('data-receipt-card="true" data-receipt-id=') &&
  css.includes('.shell-row-body > .glass-panel {') &&
  read('tests/e2e/critical-flows.spec.js').includes("async function expandRow(page, kind, id) {"));

check('compact rows keep money and permission rules of the cards they summarise',
  managerShell.includes("if (meta.canSeeBalance && stats) {") &&
  managerShell.includes("meta.canSeeContacts\n    ? (phones.length ?") &&
  managerShell.includes('meta.canSeePageFinancials && meta.pageStats ? shellDirectoryFact') &&
  managerShell.includes("meta.hasCustomerDebt && meta.collectionTarget\n    ? Number(meta.collectionTarget.amountLocal) || 0\n    : Number(receipt?.amountLocal) || 0") &&
  managerShell.includes("(meta.receiptRecordFilter && meta.receiptRecordFilter === id)"));

check('ads use their original table and phone summary while deliveries retain job cards',
  views.includes('ads-summary-table mobile-card-table') &&
  views.includes('shellAdSummaryRow(ad, {') &&
  views.includes('<article class="ops-delivery-card') &&
  views.includes('data-delivery-record=') &&
  views.includes("<tr ${shellTableDetailAttrs('ads',") &&
  !views.includes("<tr ${shellTableDetailAttrs('deliveries',") &&
  read('index.html').includes('assets/operations-workspace.css'));

// ---------- deep scan 2026-09-18 ----------
const securitySrc = read('src/02-security.js');
const controlCenterSrc = read('src/12b-control-center.js');
check('phone header names the current view and lists remember their filter-panel choice',
  views.includes('${Security.escapeHtml(String(getWorkspaceViewTitle()))}') &&
  views.includes("const FILTER_PANELS_STORAGE_KEY = 'albayan_filter_panels_v1';") &&
  views.includes('function loadWorkspaceFilterPanels()') &&
  views.includes("if (typeof panels[view] === 'boolean') return panels[view];") &&
  views.includes("const active = ad.deliveryStatus !== 'Delivered' && ad.deliveryStatus !== 'Canceled';"));

check('wallet requests use unguessable idempotency keys and LYD previews match the server arithmetic',
  servicesWallet.includes("const idem = chargeWalletIdemKey(amountMinor, currency, _chargeWallet.method);") &&
  adsStudio.includes("adsStudioChargeIdemKey(amountMinor, method)") &&
  !adsStudio.includes('paycreate-${') && !servicesWallet.includes('paycreate-${') &&
  adsStudio.includes('Math.ceil(Math.round(usd * 100) * Math.round(rate * 10000) / 10000) / 100') &&
  adsStudio.includes('Math.ceil(Math.max(0, Math.trunc(Number(minor) || 0)) * Math.round(rate * 10000) / 10000) / 100') &&
  controlCenterSrc.includes("if (raw === '' || !Number.isFinite(parsed)) return;") &&
  permissionsSrc.includes("if (typeof serverLiveSyncTick === 'function' && isServerModeEnabled()) {"));

check('untrusted strings never sit inside inline handlers and the stripper cannot be doubled past',
  socialStudio.includes('onclick="socialLinkPage(this.dataset.metaPageId, this.dataset.platform, this.dataset.igUserId)"') &&
  !socialStudio.includes("socialLinkPage('${") &&
  modals.includes("const name = Security.escapeHtml(String(targetCustomer ? targetCustomer.name") &&
  securitySrc.includes('for (let pass = 0; pass < 8; pass++) {') &&
  securitySrc.includes("str = str.replace(/vbscript:/gi, '');") &&
  socialStudio.includes("if (sameDraft()) showNotification(socialText('Saved as a draft'"));

check('a failed lazy bundle is not re-requested on every render and the shell recovers honestly',
  read('src/15b0-clothes-loader.js').includes("if (_clothesBundleState === 'failed' && Date.now() - _clothesLastFailureAt < _CLOTHES_RETRY_COOLDOWN_MS) return Promise.resolve();") &&
  read('src/15c0-ads-studio-loader.js').includes("if (_studioBundleState === 'failed' && Date.now() - _studioLastFailureAt < _STUDIO_RETRY_COOLDOWN_MS) return Promise.resolve();") &&
  adminToolsLoader.includes("if (_adminToolsBundleState === 'failed' && Date.now() - _adminToolsLastFailureAt < _ADMIN_TOOLS_RETRY_COOLDOWN_MS) return Promise.resolve();") &&
  views.includes("if (app && !String(app.innerHTML || '').trim()) {") &&
  views.includes('if (PLATFORM_ADMIN_ONLY_VIEWS.has(item.id)) return false;') &&
  servicesWallet.includes("typeof subscriptionPlansLoadFailed !== 'undefined' && subscriptionPlansLoadFailed") &&
  stateServices.includes('let subscriptionPlansLoadFailed = false;'));

check('WhatsApp reminders use international digits and per-account logs; sign-out clears searches and module caches',
  managerShell.includes("const digits = typeof normalizeCustomerPhoneKey === 'function' ? String(normalizeCustomerPhoneKey(phone) || '') : '';") &&
  managerShell.includes('function shellReminderLogKey()') &&
  managerShell.includes('localStorage.getItem(shellReminderLogKey())') &&
  liveSync.includes("for (const key of ['customerSearch', 'receiptSearch', 'adSearch', 'pageSearch', 'auditSearch', 'userSearch', 'receiptCustomerFilter']) {") &&
  liveSync.includes("if (typeof _chargeWallet === 'object' && _chargeWallet) { _chargeWallet.created = null;") &&
  liveSync.includes("if (typeof _controlCenter === 'object' && _controlCenter) {") &&
  dataAudit.includes("const _deliveryExempt = (view === 'delivery-dashboard' || view === 'deliveries') && isDeliveryRole(state.currentUser?.role);"));

// ---------- deep scan round 2 (2026-09-18) ----------
check('server-mode shipments move stock through the transactional route and validation errors are readable',
  serverApi.includes("async function apiMutateClothesShipment(payload) {") &&
  serverApi.includes("apiJson('/api/clothes/shipments/mutate', {") &&
  clothes.includes("const response = await apiMutateClothesShipment({") &&
  clothes.includes("function applyClothesShipmentMutationResponse(response) {") &&
  clothes.includes("function clothesLocalDate(value) {") &&
  !clothes.includes("String(s.receivedAt).split('T')[0]") &&
  serverApi.includes('function apiDetailMessage(data, fallback) {') &&
  serverApi.includes("const msg = apiDetailMessage(data, resp.statusText || 'Request failed');") &&
  serverApi.includes("headers: { 'Content-Type': 'application/json', 'X-Request-ID': newRequestId() },") &&
  serverApi.includes("if (typeof _serverLiveSync !== 'undefined') _serverLiveSync.lastUsersSyncAt = 0;"));

check('money boxes keep thousands separators, WhatsApp links use international digits, campaign actions replay safely',
  forms.includes("const grouped = /^\\s*\\d{1,3}(,\\d{3})+(\\.\\d*)?\\s*$/.test(val);") &&
  forms.includes("normalizeDigitsAscii(val).replace(/،/g, ',').replace(/٫/g, '.')") && !forms.includes("  val = val.replace(/٫/g, '.');") &&
  helpers.includes("const key = typeof normalizeCustomerPhoneKey === 'function' ? String(normalizeCustomerPhoneKey(phone) || '') : '';") &&
  helpers.includes("(searchPhoneKey && entry.key === searchPhoneKey)") &&
  views.includes('href="tel:${encodeURIComponent(normalizeDigitsAscii(phone))}"') &&
  adsStudio.includes("function adsStudioActionAttempt(kind, id, expectedLastModified) {") &&
  adsStudio.includes("const attempt = adsStudioActionAttempt('stop', campaign.id, Number(campaign._lastModified));") &&
  adsStudio.includes("const attempt = adsStudioActionAttempt('publish', campaign.id, Number(campaign._lastModified));") &&
  adsStudio.includes("let cleaned = normalizeDigitsAscii(String(answer)).replace(/[٫،]/g, ',').replace(/\\s+/g, '');") &&
  adsStudio.includes('id="ads-studio-field-name"') && adsStudio.includes('id="ads-studio-field-budgetMinorUSD"') &&
  actionsIo.includes("const metaOverspend = !finalSpendFrozen && metaSpendUSD !== null && metaSpendUSD > adAmountUSD + 0.005;") &&
  read('src/12a-analytics-profit.js').includes("String(ad.metaCurrency || 'USD').toUpperCase() === 'USD'") &&
  read('capacitor.config.json').includes('"readTimeout": 120000'));

// ---------- deep scan round 3 (2026-09-18) ----------
check('reporting: pending-setup ads are unpaid, no default-rate revenue, hero counts money by paid date and actual spend',
  helpers.includes("if (rawStatus === 'pending_setup') return 'not_paid';") &&
  read('src/12a-analytics-profit.js').includes("if (!(analyticsNumber(ad?.amountLocal) > 0) && !(analyticsNumber(ad?.exchangeRate || ad?.rate) > 0)) return 0;") &&
  read('src/12a-analytics-profit.js').includes("snapshot.unpaidSpendUSD > 0 ? `${isAr ?") &&
  managerShell.includes("const paidOn = r => (typeof getReceiptPaidDate === 'function' ? getReceiptPaidDate(r) : null) || r.createdAt || r.startDate;") &&
  managerShell.includes("const adActual = a => (typeof getAdActualSpendUSDLite === 'function' ? getAdActualSpendUSDLite(a) : getAdSpendUSD(a));") &&
  read('src/11b-ad-final-spend.js').includes('function getAdActualSpendUSDLite(ad) {') &&
  read('src/14-forms.js').includes("(storedDeliveryStatus === 'Delivered' || storedDeliveryStatus === 'In Progress' || storedDeliveryStatus === 'Canceled')") &&
  modals.includes("}, state.modalData._lastModified || undefined);") &&
  read('src/09-api-auth.js').includes("const navSignal = (method === 'GET' && typeof getNavigationSignal === 'function') ? getNavigationSignal() : null;") &&
  read('src/08-data-audit.js').includes("if (e?.status === 404) { render(); return true; }") &&
  read('src/08-data-audit.js').includes("Number(res?.lastModified) > 0) array[i]._lastModified = Number(res.lastModified);") &&
  read('src/10-live-sync.js').includes("arr.splice(i, 0, ...newOnes.slice(i, i + 5000));") &&
  read('src/systems/ads_studio/15c-ads-studio.js').includes("_adsStudioEditingBaseline || current._lastModified") &&
  read('src/systems/ads_studio/15c-ads-studio.js').includes("Math.round(rate * 10000) / 10000) / 100") &&
  clothes.includes("clothes-shipment-editing-version") &&
  read('src/16-actions-io.js').includes("if (e?.status === 405 && /coverage/i.test(String(e?.message || ''))) throw new Error(String(e.message));") &&
  read('src/01c-native-services.js').includes('androidBiometryStrength: 1') &&
  read('src/09-api-auth.js').includes('consumeSession: !!consumeSession') &&
  read('src/10-live-sync.js').includes('maybeCompleteAppLoginHandoff(user, true)') &&
  read('src/09-api-auth.js').includes("'Sign-In Link Ignored'") &&
  views.includes("!['canceled', 'lost'].includes(getReceiptPaymentState(r))") &&
  views.includes("const collected = _getCollectedCashLocal(r);") &&
  views.includes("(!raw.includes('T') || /T00:00:00(\\.000)?Z$/.test(raw)) ? raw.match(") &&
  helpers.includes("if (/^0218\\d{8,9}$/.test(digits)) digits = digits.slice(1);") &&
  helpers.includes("if (!digits || digits.startsWith('0') || digits.length < 8) return '';") &&
  helpers.includes("String(ad.status || 'Active') === f.status") &&
  read('src/01c-native-services.js').includes("if (at instanceof Date) at.setHours(9, 0, 0, 0); return { ad, at }; })") &&
  read('src/12d-manager-shell.js').includes("r.receiptType !== 'CARRIED_BALANCE'") &&
  modals.includes('function _localDateInputValue(value) {') &&
  read('src/16-actions-io.js').includes('if (Array.isArray(sanitizedImport.dollarPurchases)) state.dollarPurchases = sanitizedImport.dollarPurchases;') &&
  helpers.includes("const mine = isCurrentUserAdmin() || String(latestData?.deliveryPersonId || '') === String(state.currentUser?.id || '');") &&
  read('src/12b-control-center.js').includes("function ccText(en, ar) {") &&
  socialStudio.includes("if (!(c.mediaUnknown && !c.media.length)) body.media = c.media.slice();") &&
  clothes.includes("updateRecord(state.clothesProducts, editTarget.id, payload, _clothesEditBaseline || undefined)") &&
  clothes.includes("if (amountPaidLYD > total + 0.005 && amountPaidLYD > alreadyCollected + 0.005) {") &&
  clothes.includes("amountPaidLYD = editTarget ? Math.max(total, alreadyCollected) : total;") &&
  helpers.includes("if (e?.status === 409 && isVersionConflict409(e)) {") &&
  helpers.includes("if (e?.status === 409 && /already exists/i.test(String(e?.message || ''))) {") &&
  helpers.includes("const openId = String(_deliveryCompletionOpen?.id || '');"));

const openBraces = (css.match(/\{/g) || []).length;
const closeBraces = (css.match(/\}/g) || []).length;
check('mobile stylesheet braces are balanced', openBraces === closeBraces,
  `${openBraces} opening vs ${closeBraces} closing braces`);

{
  // P1-08a / P1-08b (classic Ads Studio fixes): the real studio helpers run in a sandbox, next to
  // static checks of the source and of both built copies of studio.js.
  const vm = require('vm');
  const studioBox = vm.createContext({
    state: { language: 'en', currentUser: { id: 'studio-check-user' } },
    Security: { escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') },
    isSafeReceiptPhotoSource: () => true,
    getEntityPhotoCountHint: () => 0
  });
  let studioLoadError = '';
  try {
    vm.runInContext((forms.match(/function normalizeDigitsAscii\(value\) \{[\s\S]*?\n\}/) || [''])[0], studioBox);
    vm.runInContext(adsStudio, studioBox);
  } catch (error) { studioLoadError = String(error && error.message || error); }
  const inStudio = code => { try { return vm.runInContext(code, studioBox); } catch (error) { return `THREW ${error && error.message}`; } };
  const inLanguage = (language, code) => { studioBox.state.language = language; const out = inStudio(code); studioBox.state.language = 'en'; return out; };
  const studioFn = name => { const at = adsStudio.indexOf(`function ${name}(`); return at < 0 ? '' : adsStudio.slice(at, adsStudio.indexOf('\n}\n', at)); };

  // P1-08a: a wallet charge row is shown in its own currency; a row without a currency is USD.
  const chargeRow = data => `_adsStudioWalletRequestRow(${JSON.stringify({ id: 'row-check', data })}, false)`;
  const lydRow = { reference: 'PAY-LYDCHECK', amountMinor: 5000, amountMinorLYD: 5000, currency: 'LYD', method: 'bank_transfer', status: 'pending' };
  const usdRow = { reference: 'PAY-USDCHECK', amountMinor: 2000, amountMinorLYD: 13000, method: 'bank_transfer', status: 'pending' };
  const lydEn = String(inLanguage('en', chargeRow(lydRow)));
  const lydAr = String(inLanguage('ar', chargeRow(lydRow)));
  const usdEn = String(inLanguage('en', chargeRow(usdRow)));
  check('LYD rows use LYD', !studioLoadError && !lydEn.includes('$') && lydEn.includes('50.00 LYD') && !lydEn.includes('≈')
    && !lydAr.includes('$') && lydAr.includes('50.00 د.ل') && usdEn.includes('$20.00') && usdEn.includes('≈ 130.00 LYD')
    && studioFn('_adsStudioWalletRequestRow').includes('adsStudioMoneyIn(parseInt(d.amountMinor, 10) || 0, currency)'),
  studioLoadError || `LYD row: ${lydEn.replace(/\s+/g, ' ').slice(0, 300)}`);

  // P1-08a: /studio has no 'ads' view, so the Connections card explains instead of a dead button.
  const studioSources = fs.readdirSync(path.join(ROOT, 'src/systems/ads_studio')).filter(file => file.endsWith('.js'))
    .map(file => read(`src/systems/ads_studio/${file}`)).concat([read('studio.js'), read('www/studio.js')]);
  const connectionsEn = String(inLanguage('en', 'renderAdsStudioConnections()'));
  const connectionsAr = String(inLanguage('ar', 'renderAdsStudioConnections()'));
  check("no navigateTo('ads') in studio", !studioLoadError && !studioSources.some(source => /navigateTo\(\s*['"`]ads['"`]\s*\)/.test(source))
    && adsStudio.includes('${renderAdsStudioConnections()}') && !connectionsEn.includes('<button') && !connectionsAr.includes('<button')
    && connectionsEn.includes('There is nothing for you to connect') && connectionsAr.includes('لا يلزمك ربط أي شيء من جهتك'),
  studioLoadError || 'a studio file or built bundle still calls navigateTo(\'ads\'), or the Connections card lost its text');

  const dashboard = studioFn('renderAdsStudioDashboard');
  check('studio budget summary counts only Submitted and Approved requests',
    dashboard.includes("const budgeted = campaigns.filter(item => ['Submitted', 'Approved'].includes(String(item.status || 'Draft')));")
    && (dashboard.match(/const (lifetimeBudget|dailyBudget) = budgeted\n/g) || []).length === 2);

  // P1-08b: the classic form enforces the server's limits: adLimits from GET /api/studio/me, the
  // server defaults (studio_settings.py) as the fallback, compared field by field.
  const settingsPy = read('server/systems/ads_studio/studio_settings.py');
  const pyNumber = expr => {
    const value = String(expr || '').trim();
    if (/^\d[\d_]*$/.test(value)) return Number(value.replace(/_/g, ''));
    const constant = settingsPy.match(new RegExp(`^${value} = (\\d[\\d_]*)`, 'm'));
    return constant ? Number(constant[1].replace(/_/g, '')) : NaN;
  };
  const publicLimits = ((settingsPy.match(/PUBLIC_LIMIT_FIELDS = \(([^)]*)\)/) || [])[1] || '').split(',').map(f => f.trim().replace(/"/g, '')).filter(Boolean);
  const defaultsPy = settingsPy.slice(settingsPy.indexOf('DEFAULTS: dict'));
  const limitsPy = (defaultsPy.match(/"limits": \{([\s\S]*?)\}/) || [])[1] || '';
  const serverDefaults = Object.fromEntries(publicLimits.map(f => [f, pyNumber((limitsPy.match(new RegExp(`"${f}": ([A-Za-z_\\d]+)`)) || [])[1])]));
  const clientDefaults = JSON.parse(String(inStudio('JSON.stringify(ADS_STUDIO_DEFAULT_LIMITS)')).replace(/^THREW.*/, '{}'));
  const limitProblem = (startDate, endDate, budgetMinorUSD, budgetType = 'lifetime') =>
    String(inStudio(`adsStudioBudgetLimitProblem(${JSON.stringify({ startDate, endDate, budgetMinorUSD, budgetType })})`));
  const lim = clientDefaults;
  const defaultCases = [
    limitProblem('2030-01-01', '2030-01-05', lim.minTotalMinorUSD - 1) !== '',
    limitProblem('2030-01-01', '2030-01-05', lim.minTotalMinorUSD) === '',
    limitProblem('2030-01-01', '2030-03-31', lim.maxTotalMinorUSD) === '',  // 90 days, both ends included
    limitProblem('2030-01-01', '2030-03-31', lim.maxTotalMinorUSD + 1) !== '',
    limitProblem('2030-01-01', '2030-04-01', lim.maxTotalMinorUSD) !== '',  // 91 days
    limitProblem('2030-01-01', '2030-01-10', lim.minPerDayMinorUSD * 10 - 1) !== '',  // lifetime under the per-day floor
    limitProblem('2030-01-01', '2030-01-05', lim.minPerDayMinorUSD, 'daily') === '',
    limitProblem('2030-01-01', '2030-01-10', lim.minPerDayMinorUSD - 1, 'daily') !== '',
    limitProblem('2030-01-01', '2030-03-31', 3000, 'daily') !== ''  // $30 x 90 days is over $2,000
  ];
  // Limits from /me win (minPerDayMinorUSD is optional there and keeps its default); a reset drops them.
  inStudio("_adsStudioLimits = adsStudioCleanLimits({ minTotalMinorUSD: 2000, maxTotalMinorUSD: 5000, maxDays: 10 }); _adsStudioLimitsFor = 'studio-check-user';");
  const fromMe = JSON.parse(String(inStudio('JSON.stringify(adsStudioLimits())')).replace(/^THREW.*/, '{}'));
  const fullDraft = budgetMinorUSD => JSON.stringify({
    name: 'Limit check', objective: 'messages', platforms: ['facebook'], pageName: 'Page', primaryText: 'Copy',
    destination: '+218900000000', creativeImages: ['data:image/png;base64,AAAA'], locations: ['Libya'], ageMin: 18, ageMax: 65,
    startDate: '2099-01-01', endDate: '2099-01-05', budgetMinorUSD, budgetType: 'lifetime'
  });
  const meCases = [
    fromMe.minTotalMinorUSD === 2000 && fromMe.maxTotalMinorUSD === 5000 && fromMe.maxDays === 10 && fromMe.minPerDayMinorUSD === lim.minPerDayMinorUSD,
    limitProblem('2030-01-01', '2030-01-05', 1999) !== '' && limitProblem('2030-01-01', '2030-01-05', 2000) === '',
    limitProblem('2030-01-01', '2030-01-11', 2000) !== '',  // 11 days > maxDays 10
    String(inStudio(`adsStudioValidateStep(4, ${fullDraft(1999)}).join('|')`)).includes('The total budget must be at least $20.00'),
    String(inStudio(`adsStudioValidateStep(4, ${fullDraft(2000)}).length`)) === '0'
  ];
  inStudio('resetAdsStudioLimits()');
  const afterReset = JSON.parse(String(inStudio('JSON.stringify(adsStudioLimits())')).replace(/^THREW.*/, '{}'));
  check('classic budget limits = server limits (adLimits from /api/studio/me, plan defaults as fallback)', !studioLoadError
    && publicLimits.length === 4 && JSON.stringify(Object.keys(clientDefaults).sort()) === JSON.stringify(publicLimits.slice().sort())
    && publicLimits.every(f => Number.isSafeInteger(serverDefaults[f]) && serverDefaults[f] === clientDefaults[f])
    && settingsPy.includes('"adLimits": {field: settings["limits"][field] for field in PUBLIC_LIMIT_FIELDS}')
    && studioFn('refreshAdsStudioLimits').includes("apiJson('/api/studio/me', { method: 'GET' })") && studioFn('refreshAdsStudioLimits').includes('me.adLimits')
    && adsStudio.includes('id="ads-studio-budget-limits"') && studioFn('resetAdsStudioSessionState').includes('resetAdsStudioLimits();')
    && defaultCases.every(Boolean) && meCases.every(Boolean) && JSON.stringify(afterReset) === JSON.stringify(clientDefaults),
  studioLoadError || `server ${JSON.stringify(serverDefaults)} vs client ${JSON.stringify(clientDefaults)}; default cases ${defaultCases}; /me cases ${meCases}`);

  // P1-08b: Arabic-Indic digits typed as money go through normalizeDigitsAscii ('٥٠' is $50.00, never 0).
  const parsed = raw => inStudio(`adsStudioParseMoneyMinor(${JSON.stringify(raw)})`);
  inStudio("beginAdsStudioCampaign(); adsStudioSetDraftField('budgetMinorUSD', '٥٠');");
  const typedBudget = inStudio('adsStudioMoney(_adsStudioDraft.budgetMinorUSD)');
  const budgetInput = (adsStudio.match(/<input[^>]*id="ads-studio-field-budgetMinorUSD"[^>]*>/) || [''])[0];
  const chargeInput = (adsStudio.match(/<input id="ads-studio-charge-amount"[^>]*>/) || [''])[0];
  const moneyBox = tag => tag.includes('type="text"') && tag.includes('inputmode="decimal"') && tag.includes('sanitizeMoneyInput(this)') && !tag.includes('type="number"');
  check("Arabic-Indic budget digits: '٥٠' -> $50.00", !studioLoadError && typedBudget === '$50.00'
    && parsed('٥٠') === 5000 && parsed('١٢٫٥') === 1250 && parsed('۷۵') === 7500 && parsed('1,250') === 125000 && parsed('12،5') === 1250
    && Number.isNaN(parsed('abc')) && studioFn('adsStudioParseMoneyMinor').includes('normalizeDigitsAscii(')
    && moneyBox(budgetInput) && moneyBox(chargeInput)
    && studioFn('adsStudioUpdateLydPreview').includes('adsStudioParseMoneyMinor(') && studioFn('adsStudioCreateWalletCharge').includes('adsStudioParseMoneyMinor(')
    && !/parseFloat\(/.test(studioFn('adsStudioUpdateLydPreview') + studioFn('adsStudioCreateWalletCharge') + studioFn('adsStudioSetDraftField')),
  studioLoadError || `typed '٥٠' became ${typedBudget}`);
}

{
  // P1 classic form (agent C): daily or lifetime budget with days and a live total (P1-06, D4 + D5),
  // intake paused (P1-22), review reason codes (P1-12), Arabic refusals T1-T14 (P1-08c), the D19 post
  // picker, and the review finding "a thousands separator typed one key at a time became a decimal
  // point". The real studio code runs in a sandbox next to the startup bundle's own
  // normalizeDigitsAscii and sanitizeMoneyInput; inline handlers are fired the way a browser does.
  const vm = require('vm');
  const notices = [];
  const apiCalls = [];
  const charges = [];
  const nodes = Object.create(null);
  const box = vm.createContext({
    state: { language: 'en', currentUser: { id: 'p1-user' }, adCampaignRequests: [], currentView: 'ads-studio' },
    Security: {
      escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      sanitizeInput: (value, options = {}) => String(value ?? '').slice(0, options.maxLength || 100000),
      sanitizeObject: value => JSON.parse(JSON.stringify(value)),
      generateSecureId: prefix => `${prefix}-p1check0001`
    },
    document: { getElementById: id => nodes[id] || null, querySelector: selector => nodes[selector] || null, querySelectorAll: () => [] },
    isSafeReceiptPhotoSource: () => true,
    getEntityPhotoCountHint: () => 0,
    isServerModeEnabled: () => true,
    isCurrentUserAdmin: () => true,
    currentUserHasPermission: () => true,
    canActOnRecord: () => true,
    getVisibleRecords: list => (Array.isArray(list) ? list : []).filter(item => item && !item._deleted),
    showNotification: (title, message, kind) => { notices.push({ title: String(title), message: String(message), kind }); },
    render: () => {},
    apiJson: (path, options) => { apiCalls.push({ path, options }); return new Promise(() => {}); },
    withRetry: fn => fn(),
    requestValidatedServerEntity: (collection, action, loader) => loader(),
    getServerSessionIdentity: () => 'p1-session',
    serverSessionIdentityChanged: () => false,
    makeSessionChangedError: () => new Error('session changed'),
    TIME_CONSTANTS: { API_TIMEOUT_LONG_MS: 20000 },
    apiWalletPaymentRequestCreate: amountMinor => { charges.push(amountMinor); return new Promise(() => {}); },
    WALLET: { getBalanceMinor: () => 8500 }
  });
  let loadError = '';
  try {
    for (const name of ['normalizeDigitsAscii', 'sanitizeMoneyInput']) {
      const at = forms.indexOf(`function ${name}(`);
      if (at < 0) throw new Error(`${name} is missing from src/14-forms.js`);
      vm.runInContext(forms.slice(at, forms.indexOf('\n}\n', at) + 2), box);
    }
    vm.runInContext(adsStudio, box);
  } catch (error) { loadError = String(error && error.message || error); }
  const run = code => { try { return vm.runInContext(code, box); } catch (error) { return `THREW ${error && error.message}`; } };
  const inLanguage = (language, code) => { box.state.language = language; const out = run(code); box.state.language = 'en'; return out; };
  const json = code => { try { return JSON.parse(String(run(`JSON.stringify(${code})`))); } catch (_) { return null; } };
  const fn = name => { const at = adsStudio.indexOf(`function ${name}(`); return at < 0 ? '' : adsStudio.slice(at, adsStudio.indexOf('\n}\n', at)); };
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') : ''; };
  const fakeBox = value => ({ value, selectionStart: value.length, setSelectionRange(start) { this.selectionStart = start; } });
  const fire = (code, element) => vm.runInContext(`(function () { ${code || 'throw new Error("no handler")'} })`, box).call(element);
  // One key at a time (oninput after each), then the box loses focus (onchange).
  const typeKeys = (tag, text, element, blur = true) => {
    for (const key of Array.from(text)) { element.value += key; element.selectionStart = element.value.length; fire(attr(tag, 'oninput'), element); }
    if (blur) fire(attr(tag, 'onchange'), element);
    return element;
  };

  // Review finding: "1,500" typed key by key was 1.50 ("1," became "1."). Budget box and charge box.
  run("beginAdsStudioCampaign(); _adsStudioDraft.budgetType = 'daily';");
  const budgetTag = (String(run('renderAdsStudioBudgetStep()')).match(/<input[^>]*id="ads-studio-field-budgetMinorUSD"[^>]*>/) || [''])[0];
  let typedProblem = '';
  const typed = [];
  try {
    const latin = typeKeys(budgetTag, '1,500', fakeBox(''));
    typed.push(run('_adsStudioDraft.budgetMinorUSD'), latin.value);
    const arabic = typeKeys(budgetTag, '١،٥٠٠', fakeBox(''));
    typed.push(run('_adsStudioDraft.budgetMinorUSD'), arabic.value);
    typeKeys(budgetTag, '1,500', fakeBox(''), false);  // still focused: the raw text already counts
    typed.push(run('_adsStudioDraft.budgetMinorUSD'));
    const chargeTag = (adsStudio.match(/<input id="ads-studio-charge-amount"[^>]*>/) || [''])[0];
    const chargeBox = fakeBox('');
    nodes['ads-studio-charge-amount'] = chargeBox;
    nodes['ads-studio-lyd-preview'] = { textContent: '' };
    nodes['ads-studio-charge-currency'] = { value: 'USD' };
    nodes['input[name="ads-studio-charge-method"]:checked'] = { value: 'bank_transfer' };
    run("_adsStudioPayMethods = [{ id: 'bank_transfer' }]; _adsStudioPayRate = { usdToLyd: 5 };");
    typeKeys(chargeTag, '1,500', chargeBox);
    typed.push(chargeBox.value, nodes['ads-studio-lyd-preview'].textContent);
    run('adsStudioCreateWalletCharge()');
    run('_adsStudioChargeBusy = false;');
    chargeBox.value = '';
    typeKeys(chargeTag, '١،٥٠٠', chargeBox, false);  // "Create" tapped while the box still has focus
    run('adsStudioCreateWalletCharge()');
    run('_adsStudioChargeBusy = false;');
    typed.push(attr(budgetTag, 'oninput'), attr(chargeTag, 'oninput'), attr(budgetTag, 'onchange'), attr(chargeTag, 'onchange'));
  } catch (error) { typedProblem = String(error && error.message || error); }
  check("'1,500' typed key by key -> 150000 minor (budget and charge boxes, Arabic comma too)", !loadError && !typedProblem
    && typed[0] === 150000 && typed[1] === '1500' && typed[2] === 150000 && typed[3] === '1500' && typed[4] === 150000
    && typed[5] === '1500' && String(typed[6]).includes('7500.00 LYD') && JSON.stringify(charges) === '[150000,150000]'
    && !typed[7].includes('sanitizeMoneyInput') && !typed[8].includes('sanitizeMoneyInput')
    && typed[9].includes('sanitizeMoneyInput(this)') && typed[10].includes('sanitizeMoneyInput(this)'),
  loadError || typedProblem || JSON.stringify({ typed, charges }));

  // P1-06 (D4 + D5): Daily or Lifetime plus the number of days, a live total, and the /me limits in
  // the server's own refusal words (T1-T4), English and Arabic.
  const draft = extra => JSON.stringify({ startDate: '2030-01-01', budgetType: 'daily', budgetMinorUSD: 1000, durationDays: 7, ...extra });
  const problem = (extra, language = 'en') => String(inLanguage(language, `adsStudioBudgetLimitProblem(${draft(extra)})`));
  run("resetAdsStudioLimits(); beginAdsStudioCampaign(); adsStudioSetDraftField('startDate', '2030-01-01'); adsStudioSetDraftField('durationDays', '١٤');");
  const typedDays = json('[_adsStudioDraft.durationDays, _adsStudioDraft.endDate]');
  run("adsStudioSetDraftField('durationDays', '7.5');");
  const halfDays = json('[_adsStudioDraft.durationDays, adsStudioValidateStep(4, { ..._adsStudioDraft, name: "x", pageName: "p", primaryText: "t", destination: "+218900000000", creativeImages: ["data:image/png;base64,AAAA"], startDate: "2099-01-01", endDate: "2099-01-07" }).join("|")]');
  const budgetStep = String(run("beginAdsStudioCampaign(); _adsStudioDraft.budgetType = 'daily'; renderAdsStudioBudgetStep()"));
  const budgetCases = [
    String(run(`adsStudioBudgetTotalText(${draft()})`)).startsWith('Total: $70.00 for 7 days'),
    String(inLanguage('ar', `adsStudioBudgetTotalText(${draft()})`)).startsWith('الإجمالي: $70.00 لمدة 7 أيام'),
    run(`adsStudioRequestTotalMinor(${draft()})`) === 7000,
    run(`adsStudioRequestTotalMinor(${draft({ budgetType: 'lifetime', budgetMinorUSD: 7000 })})`) === 7000,
    problem({}) === '',
    problem({ budgetType: 'lifetime', budgetMinorUSD: 400 }).startsWith('The total budget must be at least $5.00'),
    problem({ budgetType: 'lifetime', budgetMinorUSD: 400 }, 'ar').startsWith('يجب ألا يقل إجمالي الميزانية عن $5.00'),
    problem({ budgetMinorUSD: 30000 }).startsWith('The total budget must be at most $2000.00'),  // $300 x 7 = $2,100
    problem({ budgetMinorUSD: 30000 }, 'ar').startsWith('يجب ألا يزيد إجمالي الميزانية عن $2000.00'),
    problem({ budgetMinorUSD: 50, durationDays: 20 }).startsWith('Budget per day is below the minimum'),  // $0.50 a day
    problem({ budgetMinorUSD: 50, durationDays: 20 }, 'ar').startsWith('الميزانية اليومية أقل من الحد الأدنى'),
    problem({ budgetType: 'lifetime', budgetMinorUSD: 900, durationDays: 10 }).startsWith('Budget per day is below the minimum'),
    problem({ budgetType: 'lifetime', budgetMinorUSD: 10000, durationDays: 91 }).startsWith('The ad can run for at most 90 days'),
    problem({ budgetType: 'lifetime', budgetMinorUSD: 10000, durationDays: 91 }, 'ar').startsWith('أقصى مدة لتشغيل الإعلان هي 90 يوماً'),
    JSON.stringify(typedDays) === '[14,"2030-01-14"]',
    Array.isArray(halfDays) && halfDays[0] === 0 && String(halfDays[1]).includes('whole number'),
    /id="ads-studio-field-durationDays"[^>]*inputmode="numeric"|inputmode="numeric"[^>]*id="ads-studio-field-durationDays"/.test(budgetStep),
    budgetStep.includes('Budget per day in USD') && budgetStep.includes('id="ads-studio-budget-total"') && budgetStep.includes('Total: $70.00 for 7 days'),
    fn('adsStudioOnBudgetInput').includes('adsStudioRefreshBudgetSummary()') && fn('adsStudioOnDaysInput').includes('adsStudioRefreshBudgetSummary()')
  ];
  check('classic budget: Daily or Lifetime + days, live total, /me limits with the T1-T4 texts (EN/AR)', !loadError && budgetCases.every(Boolean),
    loadError || `cases ${budgetCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // The wallet pre-check before submit and the held amount use the total, not one day's budget.
  box.state.adCampaignRequests = [
    { id: 'held-new', status: 'Submitted', createdBy: 'p1-user', budgetType: 'daily', budgetMinorUSD: 1000, durationDays: 7, totalBudgetMinorUSD: 7000 },
    { id: 'held-legacy', status: 'Submitted', createdBy: 'p1-user', budgetType: 'daily', budgetMinorUSD: 500 },
    { id: 'held-draft', status: 'Draft', createdBy: 'p1-user', budgetType: 'lifetime', budgetMinorUSD: 9900 },
    { id: 'p1-submit', status: 'Draft', createdBy: 'p1-user', name: 'Daily check', objective: 'messages', platforms: ['facebook'], pageName: 'Page',
      primaryText: 'Copy', destination: '+218900000000', creativeImages: ['data:image/png;base64,AAAA'], locations: ['Libya'], ageMin: 18, ageMax: 65,
      startDate: '2099-01-01', endDate: '2099-01-07', durationDays: 7, budgetType: 'daily', budgetMinorUSD: 1000, _lastModified: 5 }
  ];
  notices.length = 0;
  run("_adsStudioIntakeOpen = null; submitAdsStudioCampaignOnce('p1-submit');");  // available $85 - $75 held = $10: one day fits, the total does not
  const walletNotice = notices[0] || {};
  check('wallet pre-check and held amounts use the total (legacy rows keep their held budget)', !loadError
    && run('adsStudioWalletHeldMinor()') === 7500 && walletNotice.title === 'Not enough wallet balance' && walletNotice.message.includes('$70.00')
    && !apiCalls.some(call => String(call.path).endsWith('/submit'))
    && fn('submitAdsStudioCampaignOnce').includes('adsStudioRequestTotalMinor(campaign)') && !fn('submitAdsStudioCampaignOnce').includes('parseInt(campaign.budgetMinorUSD'),
  loadError || JSON.stringify(walletNotice));

  // P1-22: intake paused (/me intake.open false) -> Send disabled with the T5 message; drafts still save.
  run("_adsStudioIntakeOpen = false; beginAdsStudioCampaign(); _adsStudioWizardStep = 5;");
  const pausedHtml = String(run('renderAdsStudioBuilder()'));
  const pausedAr = String(inLanguage('ar', 'renderAdsStudioBuilder()'));
  const sendButton = html => (html.match(/<button[^>]*id="ads-studio-submit-button"[^>]*>/) || [''])[0];
  const saveButton = html => (html.match(/<button[^>]*onclick="saveAdsStudioDraft\(false, this\)"[^>]*>/) || [''])[0];
  const isDisabled = tag => /\sdisabled(?=[\s>])/.test(tag);
  const pausedCard = String(run("renderAdsStudioCampaignCard(state.adCampaignRequests.find(c => c.id === 'p1-submit'))"));
  notices.length = 0;
  // /me was read moments ago, so the submit does not wait for another read (that wait is checked below).
  run("_adsStudioLimitsFor = 'p1-user'; _adsStudioLimitsState = 'done'; _adsStudioLimitsLoadedAt = Date.now(); submitAdsStudioCampaignOnce('p1-submit');");
  const pausedNotice = (notices[0] || {}).message || '';
  run('_adsStudioIntakeOpen = true;');
  const openHtml = String(run('renderAdsStudioBuilder()'));
  const openCard = String(run("renderAdsStudioCampaignCard(state.adCampaignRequests.find(c => c.id === 'p1-submit'))"));
  run('_adsStudioIntakeOpen = null;');
  check('intake paused: Send disabled with the T5 message, drafts still save', !loadError
    && isDisabled(sendButton(pausedHtml)) && !isDisabled(saveButton(pausedHtml)) && saveButton(pausedHtml) !== ''
    && /<p id="ads-studio-intake-note"[^>]*class="text-sm/.test(pausedHtml) && pausedHtml.includes('New ad requests are paused')
    && pausedAr.includes('استقبال طلبات الإعلانات الجديدة متوقف مؤقتاً')
    && /data-ads-studio-submit="1"[^>]*\sdisabled(?=[\s>])/.test(pausedCard) && pausedNotice.startsWith('New ad requests are paused')
    && !isDisabled(sendButton(openHtml)) && sendButton(openHtml) !== '' && /<p id="ads-studio-intake-note"[^>]*class="hidden /.test(openHtml)
    && !/data-ads-studio-submit="1"[^>]*\sdisabled(?=[\s>])/.test(openCard)
    && fn('refreshAdsStudioLimits').includes('me.intake') && fn('refreshAdsStudioLimits').includes('_adsStudioIntakeOpen = intakeOpen')
    && fn('saveAndSubmitAdsStudioDraftOnce').includes('saveAdsStudioDraft(false)'),
  loadError || `paused button ${sendButton(pausedHtml)}; notice ${pausedNotice}`);

  // P1-12: the 7 reason codes with the server list's labels; shown to the customer on a request sent
  // back or rejected; required for changes/reject in the staff form (T7); no native dialogs.
  const reasons = [
    ['budget_dates', 'Budget or dates', 'الميزانية أو التواريخ'],
    ['creative_quality', 'Photo or video quality', 'جودة الصورة أو الفيديو'],
    ['text_policy', 'Text breaks ad rules', 'النص يخالف قواعد الإعلانات'],
    ['targeting', 'Audience or location', 'الجمهور أو الموقع'],
    ['page_access', 'Page access', 'صلاحية الصفحة'],
    ['payment', 'Payment', 'الدفع'],
    ['other', 'Other', 'أخرى']
  ];
  const feedback = (status, code, language = 'en') => String(inLanguage(language, `renderAdsStudioReviewFeedback(${JSON.stringify({ status, reviewReasonCode: code, reviewNote: 'Use a <b>brighter</b> photo' })})`));
  box.state.adCampaignRequests = [
    { id: 'p1-review', status: 'Submitted', createdBy: 'customer-9', name: 'Queued', budgetType: 'lifetime', budgetMinorUSD: 2500, totalBudgetMinorUSD: 2500, _lastModified: 11 },
    { id: 'p1-legacy', status: 'Submitted', createdBy: 'customer-9', name: 'Old daily', budgetType: 'daily', budgetMinorUSD: 1000, _lastModified: 12 }
  ];
  const queue = String(run('renderAdsStudioReviewQueue()'));
  const legacySelect = (queue.match(/<select id="ads-review-reason-p1-legacy"[\s\S]*?<\/select>/) || [''])[0];
  notices.length = 0;
  apiCalls.length = 0;
  run("setAdsStudioReviewNote('p1-review', 'Please use a clearer photo'); reviewAdsStudioCampaignOnce('p1-review', 'Changes Requested');");
  const noReason = [(notices[0] || {}).message, apiCalls.filter(call => String(call.path).endsWith('/review')).length];
  notices.length = 0;
  inLanguage('ar', "reviewAdsStudioCampaignOnce('p1-review', 'Rejected')");
  const noReasonAr = (notices[0] || {}).message;
  run("setAdsStudioReviewReason('p1-review', 'creative_quality'); reviewAdsStudioCampaignOnce('p1-review', 'Changes Requested');");
  const sentBack = (apiCalls.find(call => call.path === '/api/ad-studio/campaigns/p1-review/review') || {}).options || {};
  apiCalls.length = 0;
  run("reviewAdsStudioCampaignOnce('p1-review', 'Approved');");
  const approveFirstTap = [apiCalls.length, run('_adsStudioApproveConfirmId')];
  const confirmRow = String(run('renderAdsStudioReviewQueue()'));
  run("reviewAdsStudioCampaignOnce('p1-review', 'Approved', true);");
  const approved = (apiCalls.find(call => call.path === '/api/ad-studio/campaigns/p1-review/review') || {}).options || {};
  const reviewCode = ['renderAdsStudioReviewQueue', 'reviewAdsStudioCampaign', 'reviewAdsStudioCampaignOnce', 'adsStudioApiReview', 'cancelAdsStudioApproval'].map(fn).join('\n');
  const reasonCases = [
    JSON.stringify(json('ADS_STUDIO_REVIEW_REASONS')) === JSON.stringify(reasons),
    reasons.every(([code, en, ar]) => feedback('Rejected', code).includes(en) && feedback('Changes Requested', code, 'ar').includes(ar)),
    feedback('Changes Requested', 'targeting').includes('Reason:') && feedback('Changes Requested', 'targeting').includes('Use a &lt;b&gt;brighter')
      && !feedback('Changes Requested', 'targeting').includes('<b>brighter'),
    feedback('Rejected', 'text_policy', 'ar').includes('ملاحظة المراجع:'),
    !feedback('Changes Requested', 'evil<script>').includes('evil') && !feedback('Changes Requested', 'evil<script>').includes('Reason:'),
    !feedback('Approved', 'targeting').includes('Audience or location'),
    fn('renderAdsStudioCampaignCard').includes('renderAdsStudioReviewFeedback(campaign)'),
    reasons.every(([code]) => queue.includes(`<option value="${code}"`)) && queue.includes('id="ads-review-reason-p1-review"'),
    legacySelect.includes('<option value="budget_dates" selected>') && queue.includes('Old daily request'),
    noReason[0] === 'Choose a reason for this decision.' && noReason[1] === 0 && noReasonAr === 'اختر سبباً لهذا القرار.',
    sentBack.method === 'POST' && sentBack.body && sentBack.body.reviewReasonCode === 'creative_quality' && sentBack.body.decision === 'Changes Requested'
      && sentBack.body.note === 'Please use a clearer photo',
    approveFirstTap[0] === 0 && approveFirstTap[1] === 'p1-review' && confirmRow.includes('Confirm approval') && confirmRow.includes('$25.00'),
    approved.body && approved.body.decision === 'Approved' && !('reviewReasonCode' in approved.body),
    !/\b(?:confirm|prompt|alert)\(/.test(reviewCode)
  ];
  check('review reason codes: 7 codes EN/AR, shown to the customer, required for changes/reject (T7), in-page approval', !loadError && reasonCases.every(Boolean),
    loadError || `cases ${reasonCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // P1-08c: the Arabic map holds every shared refusal prefix T1-T14 exactly; the entries that were
  // there before are unchanged (entries are only ever added).
  const shared = [
    ['The total budget must be at least ', 'يجب ألا يقل إجمالي الميزانية عن '],
    ['The total budget must be at most ', 'يجب ألا يزيد إجمالي الميزانية عن '],
    ['Budget per day is below the minimum', 'الميزانية اليومية أقل من الحد الأدنى'],
    ['The ad can run for at most ', 'أقصى مدة لتشغيل الإعلان هي '],
    ['New ad requests are paused', 'استقبال طلبات الإعلانات الجديدة متوقف مؤقتاً'],
    ["Today's limit of new ad requests is reached", 'تم الوصول إلى الحد اليومي لطلبات الإعلانات الجديدة'],
    ['Choose a reason for this decision', 'اختر سبباً لهذا القرار'],
    ['Unknown reason code', 'رمز السبب غير معروف'],
    ['The goal detail does not match the objective', 'تفاصيل الهدف لا تتوافق مع هدف الإعلان'],
    ['Unknown location', 'موقع غير معروف'],
    ['Choose a post or add your own photo and text', 'اختر منشوراً أو أضف صورتك ونصك'],
    ['This page is not linked to your account', 'هذه الصفحة غير مرتبطة بحسابك'],
    ['This post is not from your linked page', 'هذا المنشور ليس من صفحتك المرتبطة'],
    ['durationDays must be a whole number of days', 'يجب أن تكون مدة الإعلان عدداً صحيحاً من الأيام']
  ];
  const before = [
    ['Insufficient wallet balance', 'رصيد المحفظة لا يكفي لهذه الميزانية — اشحن المحفظة أولاً'],
    ['already started', 'بدأ هذا الإعلان بالفعل — اطلب منا إيقافه واسترداد الجزء غير المصروف'],
    ['Conflict: record has changed', 'تغيّر السجل — حدّث الصفحة وحاول مرة أخرى'],
    ['Stop the campaign first', 'أوقف الحملة أولاً حتى تعود الميزانية غير المصروفة إلى المحفظة'],
    ['ad_maker subscription is required', 'يلزم اشتراك نشط في استوديو الإعلانات'],
    ['plan price changed', 'تغيّر سعر الباقة — أعد تحميل الباقات وحاول مرة أخرى'],
    ['dates have passed', 'انتهت تواريخ الحملة — اطلب تعديلات ليضبط العميل التاريخ'],
    ['startDate cannot be in the past', 'لا يمكن أن يكون تاريخ البدء في الماضي'],
    ['storage quota reached', 'امتلأت مساحة استوديو الإعلانات — احذف صوراً أو أرشف حملة منتهية (اطلب منا إغلاق حملة تعمل أولاً)'],
    ['refundMinorUSD is required', 'أدخل المبلغ غير المصروف المراد استرداده (0 للإغلاق دون استرداد)'],
    ['Only Approved campaigns can be stopped', 'لا يمكن إيقاف إلا الحملات المعتمدة']
  ];
  const refusalMap = json('_ADS_STUDIO_REFUSAL_AR') || [];
  const arabic = detail => String(inLanguage('ar', `adsStudioRefusalText(${JSON.stringify(detail)})`));
  const refusalCases = [
    shared.every(([en, ar]) => refusalMap.filter(entry => entry[0] === en).length === 1 && refusalMap.some(entry => entry[0] === en && entry[1] === ar)),
    JSON.stringify(refusalMap.slice(0, before.length).map(entry => entry.slice(0, 2))) === JSON.stringify(before),
    arabic('The total budget must be at least $5.00 (this request: $3.00)') === 'يجب ألا يقل إجمالي الميزانية عن $5.00.',
    arabic('The total budget must be at most $2,000.00 (you asked for $2,100.00)') === 'يجب ألا يزيد إجمالي الميزانية عن $2,000.00.',
    arabic('Budget per day is below the minimum of $1.00 (this request: $0.50 per day)') === 'الميزانية اليومية أقل من الحد الأدنى ($1.00).',
    arabic('The ad can run for at most 30 days (this request: 45 days)') === 'أقصى مدة لتشغيل الإعلان هي 30 يوماً.',
    arabic('New ad requests are paused. Please try again later.') === 'استقبال طلبات الإعلانات الجديدة متوقف مؤقتاً',
    arabic({ code: 'PAGE_NOT_LINKED', message: 'This page is not linked to your account' }) === 'هذه الصفحة غير مرتبطة بحسابك',
    arabic('durationDays must be a whole number of days') === 'يجب أن تكون مدة الإعلان عدداً صحيحاً من الأيام',
    String(run("adsStudioRefusalText('Unknown location: Mars')")) === 'Unknown location: Mars'
  ];
  check('Arabic refusal map covers T1-T14 exactly; the older entries are unchanged', !loadError && refusalCases.every(Boolean),
    loadError || `cases ${refusalCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // D19: pick one of the linked page's recent posts, or a new ad without a post; the pasted link is
  // the fallback when no page is linked. Server strings are escaped; only https thumbnails and Meta
  // post links are used.
  box.__pagesPayload = { pages: [
    { id: 'spg_shop', name: '<b>Shop</b>', platform: 'fb', instagram: true },
    { id: 'bad id', name: 'Not an id' },
    { id: 'spg_shop', name: 'Duplicate' }
  ] };
  box.__postsPayload = { checkedAt: '2026-09-25T08:00:00Z', posts: [
    { id: '123_456', platform: 'fb', excerpt: '<img src=x onerror=alert(1)> Summer   sale', imageUrl: 'https://scontent.example.net/p.jpg', permalink: 'https://www.facebook.com/123/posts/456', createdAt: '2026-09-20T10:00:00Z' },
    { id: 'ig_789', platform: 'ig', excerpt: 'Reel', imageUrl: 'javascript:alert(1)', permalink: 'javascript:alert(1)', createdAt: 'not a date' },
    { id: 'tt_1', platform: 'tiktok', excerpt: 'not a Meta post' }
  ] };
  const pages = json('adsStudioNormalizePostPages(__pagesPayload)') || [];
  const posts = json('adsStudioNormalizeRecentPosts(__postsPayload)') || {};
  run(`resetAdsStudioPostPicker(); beginAdsStudioBoost('boost_post');
    _adsStudioPostPicker.forUser = 'p1-user'; _adsStudioPostPicker.pagesState = 'done';
    _adsStudioPostPicker.pages = adsStudioNormalizePostPages(__pagesPayload); _adsStudioPostPicker.pageId = 'spg_shop';
    _adsStudioPostPicker.posts.spg_shop = { state: 'done', error: '', at: Date.now(), ...adsStudioNormalizeRecentPosts(__postsPayload) };`);
  const pickerHtml = String(run('renderAdsStudioBoostBasicsStep()'));
  run("adsStudioChooseBoostPost(1, { getAttribute: () => 'a-post-that-moved' });");  // the list changed under the finger
  const staleTap = run('_adsStudioDraft.sourcePostId');
  run("adsStudioChooseBoostPost(1, { getAttribute: () => 'ig_789' });");
  const igChoice = json('[_adsStudioDraft.sourcePostId, _adsStudioDraft.sourcePostPlatform, _adsStudioDraft.sourcePostRef]');
  run("adsStudioChooseBoostPost(0, { getAttribute: () => '123_456' });");
  const chosen = json('({ id: _adsStudioDraft.sourcePostId, platform: _adsStudioDraft.sourcePostPlatform, ref: _adsStudioDraft.sourcePostRef, page: _adsStudioDraft.connectedAssetId, pageName: _adsStudioDraft.pageName })') || {};
  const chosenErrors = String(run("adsStudioValidateStep(3).join('|')"));
  const payload = json('sanitizedAdsStudioDraft()') || {};
  run("_adsStudioDraft.sourcePostId = ''; _adsStudioDraft.sourcePostRef = '';");
  const noPost = [String(run('adsStudioValidateStep(3)[0]')), String(inLanguage('ar', 'adsStudioValidateStep(3)[0]'))];
  run("adsStudioSetBoostKind('boost_page');");
  const newAd = [run('_adsStudioDraft.boostType'), String(run("adsStudioValidateStep(3).join('|')"))];
  run("adsStudioSetBoostKind('boost_post'); _adsStudioPostPicker.pages = [];");
  const unlinkedHtml = String(run('renderAdsStudioBoostBasicsStep()'));
  const unlinkedError = String(run('adsStudioValidateStep(3)[0]'));
  // The page's posts could not be read (Meta busy): the coded refusal in Arabic, and the link fallback.
  run(`_adsStudioPostPicker.pages = adsStudioNormalizePostPages(__pagesPayload);
    _adsStudioPostPicker.posts.spg_shop = { state: 'failed', posts: [], checkedAt: '', at: Date.now(),
      error: { code: 'META_PAUSED', message: 'Meta is busy right now, so your posts cannot be read. Try again in a minute.' } };`);
  const failedAr = String(inLanguage('ar', 'renderAdsStudioBoostBasicsStep()'));
  const pickerCases = [
    JSON.stringify(pages) === JSON.stringify([{ id: 'spg_shop', name: '<b>Shop</b>', fb: true, ig: true }]),
    Array.isArray(posts.posts) && posts.posts.length === 2 && posts.posts[0].excerpt === '<img src=x onerror=alert(1)> Summer sale'
      && posts.posts[1].imageUrl === '' && posts.posts[1].permalink === '' && posts.checkedAt === '2026-09-25T08:00:00Z',
    pickerHtml.includes('Boost a post') && pickerHtml.includes('New ad without a post'),
    pickerHtml.includes('data-post-id="123_456"') && pickerHtml.includes('src="https://scontent.example.net/p.jpg"'),
    !pickerHtml.includes('<img src=x') && pickerHtml.includes('&lt;img src=x') && !/javascript:/i.test(pickerHtml) && pickerHtml.includes('&lt;b&gt;Shop&lt;/b&gt;'),
    /id="ads-studio-post-link" class="hidden"/.test(pickerHtml),
    staleTap !== 'ig_789' && JSON.stringify(igChoice) === '["ig_789","ig",""]',
    chosen.id === '123_456' && chosen.platform === 'fb' && chosen.ref === 'https://www.facebook.com/123/posts/456' && chosen.page === 'spg_shop' && chosen.pageName === '<b>Shop</b>',
    chosenErrors === '',  // the post is the ad: no own text or photo needed
    payload.sourcePostId === '123_456' && payload.sourcePostPlatform === 'fb' && payload.connectedAssetId === 'spg_shop'
      && payload.destination === 'https://www.facebook.com/123/posts/456' && payload.durationDays === 7 && !('totalBudgetMinorUSD' in payload),
    noPost[0].startsWith('Choose a post or add your own photo and text') && noPost[1].startsWith('اختر منشوراً أو أضف صورتك ونصك'),
    newAd[0] === 'boost_page' && newAd[1].includes('Primary ad text is required.') && newAd[1].includes('PNG, JPEG or WebP'),
    /id="ads-studio-post-link" class=""/.test(unlinkedHtml) && unlinkedHtml.includes('No page is linked to your account yet')
      && unlinkedHtml.includes('id="ads-studio-field-sourcePostRef"') && unlinkedError.includes('paste the post link'),
    /id="ads-studio-post-link" class=""/.test(failedAr) && failedAr.includes('ميتا مشغولة الآن') && !failedAr.includes('Meta is busy'),
    fn('adsStudioLoadPostPages').includes("apiJson('/api/studio/pages', { method: 'GET' })")
      && fn('adsStudioLoadPagePosts').includes('/api/studio/pages/${encodeURIComponent(id)}/recent-posts${force ? \'?refresh=1\' : \'\'}')
  ];
  check('D19 post picker: linked pages and recent posts, escaped, https only, new ad without a post, link fallback', !loadError && pickerCases.every(Boolean),
    loadError || `cases ${pickerCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // The picker keeps the reply's per-platform Meta state: a platform Meta did not read shows "could
  // not read" with Try again and the link fallback, never "no recent posts".
  box.__platformPayload = { checkedAt: '', posts: [], platforms: {
    fb: { state: 'error', checkedAt: '', errorCode: 'page_access', retryAfterSeconds: 0 },
    ig: { state: 'ok', checkedAt: '2026-09-25T08:00:00Z', errorCode: '', retryAfterSeconds: 0 },
    tt: { state: 'error', errorCode: 'x' }
  } };
  box.__pausedPayload = { checkedAt: '', posts: [{ id: 'ig_1', platform: 'ig', excerpt: 'Reel', createdAt: '2026-09-24T10:00:00Z' }],
    platforms: { fb: { state: 'paused', retryAfterSeconds: 300 }, ig: { state: 'ok' } } };
  box.__keptPayload = { checkedAt: '', posts: [{ id: '123_9', platform: 'fb', excerpt: 'Kept', createdAt: '2026-09-24T10:00:00Z' }],
    platforms: { fb: { state: 'paused', retryAfterSeconds: 300 }, ig: { state: 'bogus', retryAfterSeconds: -4 } } };
  box.__okPayload = { checkedAt: '', posts: [], platforms: { fb: { state: 'ok' }, ig: { state: 'ok' } } };
  const platformPosts = json('adsStudioNormalizeRecentPosts(__platformPayload)') || {};
  const keptPlatforms = json('adsStudioNormalizeRecentPosts(__keptPayload).platforms') || {};
  const pickerWith = (entry, language = 'en') => {
    run(`_adsStudioDraft.sourcePostId = ''; _adsStudioDraft.sourcePostRef = ''; _adsStudioPostPicker.pagesState = 'done';
      _adsStudioPostPicker.pages = adsStudioNormalizePostPages(__pagesPayload); _adsStudioPostPicker.pageId = 'spg_shop';
      _adsStudioPostPicker.posts.spg_shop = ${entry};`);
    return String(inLanguage(language, 'renderAdsStudioBoostBasicsStep()'));
  };
  const doneWith = name => `({ state: 'done', error: null, at: Date.now(), ...adsStudioNormalizeRecentPosts(${name}) })`;
  const fbError = pickerWith(doneWith('__platformPayload'));
  const fbErrorAr = pickerWith(doneWith('__platformPayload'), 'ar');
  const fbErrorLink = run('adsStudioShowPostLinkField(_adsStudioDraft)');
  const fbPaused = pickerWith(doneWith('__pausedPayload'));
  const fbKept = pickerWith(doneWith('__keptPayload'));
  const allOk = pickerWith(doneWith('__okPayload'));
  // A 429 (apiJson's 429 branch sets no payload: the message is the detail as JSON) is RATE_LIMITED.
  box.__rate429 = Object.assign(new Error(JSON.stringify({ code: 'RATE_LIMITED', message: 'Too many requests. Please wait a minute and try again.' })), { status: 429, retryAfter: 42 });
  box.__rateShape = new Error('{"code":"RATE_LIMITED","message":"Too many requests. Please wait a minute and try again."}');
  box.__rateMinute = Object.assign(new Error('Rate limited. Try again in 60 seconds.'), { status: 429, retryAfter: 60 });
  const rateInfo = json('adsStudioErrorInfo(__rate429)') || {};
  const rateShape = json('adsStudioErrorInfo(__rateShape)') || {};
  const rateFailed = pickerWith("({ state: 'failed', posts: [], checkedAt: '', at: Date.now(), error: adsStudioErrorInfo(__rate429) })");
  const rateFailedAr = pickerWith("({ state: 'failed', posts: [], checkedAt: '', at: Date.now(), error: adsStudioErrorInfo(__rate429) })", 'ar');
  const linkShown = html => /id="ads-studio-post-link" class=""/.test(html);
  const linkHidden = html => /id="ads-studio-post-link" class="hidden"/.test(html);
  const couldNotRead = 'We could not read your posts from Meta right now';
  const platformCases = [
    JSON.stringify(Object.keys(platformPosts.platforms || {})) === '["fb","ig"]'
      && JSON.stringify(platformPosts.platforms.fb) === JSON.stringify({ state: 'error', errorCode: 'page_access', retryAfterSeconds: 0, checkedAt: '' }),
    keptPlatforms.ig && keptPlatforms.ig.state === '' && keptPlatforms.ig.retryAfterSeconds === 0 && keptPlatforms.fb.retryAfterSeconds === 300,
    fbError.includes(`${couldNotRead} (Facebook). You can paste the post link below.`) && fbError.includes('Ask us to link it again')
      && fbError.includes('adsStudioRetryPagePosts()') && linkShown(fbError) && !fbError.includes('No recent posts on this page') && fbErrorLink === true,
    fbErrorAr.includes('تعذّر علينا قراءة منشوراتك من ميتا الآن (فيسبوك)') && fbErrorAr.includes('يمكنك لصق رابط المنشور بالأسفل') && !fbErrorAr.includes(couldNotRead),
    fbPaused.includes(`${couldNotRead} (Facebook)`) && fbPaused.includes('Meta is busy right now. Try again in 5 minutes.') && linkShown(fbPaused)
      && fbPaused.includes('data-post-id="ig_1"'),
    !fbKept.includes(couldNotRead) && linkHidden(fbKept) && fbKept.includes('data-post-id="123_9"'),
    allOk.includes('No recent posts on this page') && !allOk.includes(couldNotRead) && linkHidden(allOk),
    rateInfo.code === 'RATE_LIMITED' && rateInfo.retryAfterSeconds === 42 && rateInfo.message === 'Too many requests. Please wait a minute and try again.',
    rateShape.code === 'RATE_LIMITED' && rateShape.retryAfterSeconds === 0,
    String(run('adsStudioPickerErrorText(adsStudioErrorInfo(__rateMinute))')) === 'Too many requests. Please wait a minute and try again.',
    String(run('adsStudioPickerErrorText(adsStudioErrorInfo(__rateShape))')) === 'Too many requests. Please wait a minute and try again.',
    rateFailed.includes(`${couldNotRead}. You can paste the post link below. (Too many requests. Please wait 42 seconds and try again.)`)
      && !rateFailed.includes('&quot;code&quot;') && !rateFailed.includes('{"code"') && linkShown(rateFailed),
    rateFailedAr.includes('طلبات كثيرة. انتظر 42 ثانية ثم أعد المحاولة.') && !rateFailedAr.includes('RATE_LIMITED'),
    JSON.stringify(json('[adsStudioWaitText(1), adsStudioWaitText(2), adsStudioWaitText(5), adsStudioWaitText(150), adsStudioWaitText(0)]'))
      === JSON.stringify([['1 second', 'ثانية واحدة'], ['2 seconds', 'ثانيتين'], ['5 seconds', '5 ثوانٍ'], ['3 minutes', '3 دقائق'], null]),
    fn('adsStudioErrorInfo').includes('error?.status === 429') && fn('adsStudioLoadPagePosts').includes('platforms: result.platforms')
      && fn('adsStudioShowPostLinkField').includes('adsStudioPostsUnreadable(picker.posts[picker.pageId])')
  ];
  check('post picker: a platform Meta did not read -> could-not-read note, Try again and the link fallback; 429 -> RATE_LIMITED with its wait (EN/AR)',
    !loadError && platformCases.every(Boolean), loadError || `cases ${platformCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // Intake reopened: /me is read again when the list or dashboard is opened from another tab or page
  // and right before a submit (at most every ADS_STUDIO_INTAKE_RECHECK_MS); a paused-looking submit
  // waits for that answer; the in-place refresh enables Send again.
  run("_adsStudioActiveTab = 'campaigns'; _adsStudioShownTab = 'builder';");
  nodes['.studio-section-tabs'] = {};
  const opened = [run('adsStudioListOpened()'), run('adsStudioListOpened()')];  // tab changed, then the same tab on screen
  delete nodes['.studio-section-tabs'];
  opened.push(run('adsStudioListOpened()'));  // back from another page (no studio tab bar on screen)
  run("_adsStudioActiveTab = 'builder';");
  opened.push(run('adsStudioListOpened()'));  // the builder has its own read (last step)
  run("_adsStudioActiveTab = 'dashboard';");
  opened.push(run('adsStudioListOpened()'));
  apiCalls.length = 0;
  run("_adsStudioLimitsFor = 'p1-user'; _adsStudioLimitsState = 'done'; _adsStudioLimitsLoadedAt = Date.now();");
  const freshRead = [run('adsStudioRecheckIntake()'), apiCalls.length];
  run('_adsStudioLimitsLoadedAt = Date.now() - 60000;');
  const staleRead = [run('adsStudioRecheckIntake() !== null'), run('adsStudioRecheckIntake() === _adsStudioLimitsPending'),
    apiCalls.filter(call => call.path === '/api/studio/me').length];
  box.state.adCampaignRequests = [
    { id: 'p1-reopen', status: 'Draft', createdBy: 'p1-user', name: 'Reopen check', objective: 'messages', platforms: ['facebook'], pageName: 'Page',
      primaryText: 'Copy', destination: '+218900000000', creativeImages: ['data:image/png;base64,AAAA'], locations: ['Libya'], ageMin: 18, ageMax: 65,
      startDate: '2099-01-01', endDate: '2099-01-07', durationDays: 7, budgetType: 'lifetime', budgetMinorUSD: 1000, _lastModified: 5 }
  ];
  run("_adsStudioLimitsState = 'done'; _adsStudioLimitsLoadedAt = Date.now() - 60000; _adsStudioIntakeOpen = false;");
  apiCalls.length = 0;
  notices.length = 0;
  run("submitAdsStudioCampaignOnce('p1-reopen');");
  const waitedSubmit = [apiCalls.filter(call => call.path === '/api/studio/me').length, notices.length, apiCalls.some(call => String(call.path).endsWith('/submit'))];
  const sendNode = { disabled: true, attrs: { title: 'paused' }, getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    setAttribute(name, value) { this.attrs[name] = String(value); }, removeAttribute(name) { delete this.attrs[name]; } };
  nodes['ads-studio-submit-button'] = sendNode;
  run('_adsStudioIntakeOpen = true; adsStudioRefreshIntakeState();');
  const reenabled = sendNode.disabled === false && !('title' in sendNode.attrs);
  delete nodes['ads-studio-submit-button'];
  run("_adsStudioIntakeOpen = null; _adsStudioLimitsState = ''; _adsStudioActiveTab = 'campaigns';");
  const submitCode = fn('submitAdsStudioCampaignOnce');
  const intakeCases = [
    JSON.stringify(opened) === '[true,false,true,false,true]',
    freshRead[0] === null && freshRead[1] === 0,
    staleRead[0] === true && staleRead[1] === true && staleRead[2] === 1,
    JSON.stringify(waitedSubmit) === '[1,0,false]',
    reenabled,
    fn('renderAdsStudioView').includes('refreshAdsStudioLimits(adsStudioListOpened() ? ADS_STUDIO_INTAKE_RECHECK_MS : 0)'),
    submitCode.indexOf('adsStudioRecheckIntake()') > 0 && submitCode.indexOf('adsStudioRecheckIntake()') < submitCode.indexOf('if (_adsStudioIntakeOpen === false) {')
      && submitCode.includes('await intakeRead'),
    fn('refreshAdsStudioLimits').includes('finally { settle(); }') && run('ADS_STUDIO_INTAKE_RECHECK_MS') > 0 && run('ADS_STUDIO_INTAKE_RECHECK_MS') <= 60000
  ];
  check('intake reopened: /me read again on opening the list and before a submit, Send enabled again without a reload', !loadError && intakeCases.every(Boolean),
    loadError || `cases ${intakeCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // Legacy daily request = legacyRules, or no schemaVersion >= 2 (the server's rule); a schemaVersion 2
  // request is never "old" because this copy of it carries no totalBudgetMinorUSD.
  const legacyOf = campaign => run(`adsStudioIsLegacyDailyRequest(${JSON.stringify(campaign)})`);
  box.state.adCampaignRequests = [
    { id: 'p1-v2-daily', status: 'Submitted', createdBy: 'customer-9', name: 'New daily', budgetType: 'daily', budgetMinorUSD: 1000, durationDays: 7, schemaVersion: 2, _lastModified: 13 }
  ];
  const v2Queue = String(run('renderAdsStudioReviewQueue()'));
  const v2Select = (v2Queue.match(/<select id="ads-review-reason-p1-v2-daily"[\s\S]*?<\/select>/) || [''])[0];
  const legacyCases = [
    legacyOf({ budgetType: 'daily', schemaVersion: 2, budgetMinorUSD: 1000, durationDays: 7 }) === false,
    legacyOf({ budgetType: 'daily', schemaVersion: 2, totalBudgetMinorUSD: 7000, legacyRules: false }) === false,
    legacyOf({ budgetType: 'daily', schemaVersion: 2, totalBudgetMinorUSD: 7000, legacyRules: true }) === true,
    legacyOf({ budgetType: 'daily', schemaVersion: 1, totalBudgetMinorUSD: 7000 }) === true,
    legacyOf({ budgetType: 'daily', budgetMinorUSD: 500 }) === true,
    legacyOf({ budgetType: 'lifetime', legacyRules: true }) === false,
    v2Select !== '' && !v2Select.includes('<option value="budget_dates" selected>') && !v2Queue.includes('Old daily request'),
    !fn('adsStudioIsLegacyDailyRequest').includes('totalBudgetMinorUSD')
  ];
  check('legacy daily request only by legacyRules or schemaVersion < 2, never by a missing total', !loadError && legacyCases.every(Boolean),
    loadError || `cases ${legacyCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // The submit-time refusal while Meta is busy (studio_posts.verify_source_post) has its Arabic.
  const metaBusyPrefix = 'Meta is busy right now, so the chosen post could not be checked';
  check('Arabic refusal for "Meta is busy ... the chosen post could not be checked"', !loadError
    && refusalMap.filter(entry => entry[0] === metaBusyPrefix).length === 1
    && arabic(`${metaBusyPrefix}. Try again in a minute.`) === 'ميتا مشغولة الآن، لذلك تعذر التحقق من المنشور المختار. حاول مرة أخرى بعد دقيقة.'
    && String(run(`adsStudioRefusalText(${JSON.stringify(`${metaBusyPrefix}. Try again in a minute.`)})`)) === `${metaBusyPrefix}. Try again in a minute.`,
  loadError || arabic(`${metaBusyPrefix}. Try again in a minute.`));

  const builtStudio = [read('studio.js'), read('www/studio.js')];
  check('built studio bundles carry the P1 classic form', builtStudio.every(bundle => bundle.includes(adsStudio)));
}

{
  // P1-09 + D26 (agent C): the staff "Link Meta campaign" sheet (studio name with one-tap Copy, the
  // allowlisted ad account, digits-only campaign id, linked / NEEDS_MANUAL_RENAME / already linked /
  // budget warning), bilingual publishStatus labels (never a raw value), the customer's Withdraw sheet
  // (P1-03) and the Arabic entries for their refusals. The real studio code runs in a sandbox whose
  // promises settle before each run() returns (microtaskMode 'afterEvaluate'), so every flow is
  // followed to its end; the stubs that return promises are declared inside the sandbox for that.
  const vm = require('vm');
  const notices = [];
  const copied = [];
  const nodes = Object.create(null);
  const who = { admin: true, staff: true, uid: 'p9-staff' };
  const box = vm.createContext({
    state: { language: 'en', currentUser: { id: 'p9-staff' }, adCampaignRequests: [], users: [], currentView: 'ads-studio' },
    Security: {
      escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      sanitizeInput: (value, options = {}) => String(value ?? '').slice(0, options.maxLength || 100000),
      sanitizeObject: value => JSON.parse(JSON.stringify(value)),
      generateSecureId: prefix => `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 14)}`
    },
    document: { getElementById: id => nodes[id] || null, querySelector: () => null, querySelectorAll: () => [] },
    isSafeReceiptPhotoSource: () => true,
    getEntityPhotoCountHint: () => 0,
    isServerModeEnabled: () => true,
    isCurrentUserAdmin: () => who.admin,
    currentUserHasPermission: (collection, action) => who.staff || !['review', 'view'].includes(action),
    canActOnRecord: (collection, action, creator) => who.staff || String(creator || '') === who.uid,
    getVisibleRecords: list => (Array.isArray(list) ? list : []).filter(item => item && !item._deleted),
    showNotification: (title, message, kind) => { notices.push({ title: String(title), message: String(message), kind }); },
    render: () => {},
    withRetry: fn => fn(),
    requestValidatedServerEntity: (collection, action, loader) => loader(),
    validateServerEntityResponse: (collection, entity) => {
      if (!entity || typeof entity.id !== 'string' || !entity.data || entity.data.id !== entity.id) throw new Error('invalid entity');
      return entity;
    },
    getServerSessionIdentity: () => 'p9-session',
    serverSessionIdentityChanged: () => false,
    makeSessionChangedError: () => new Error('session changed'),
    clearCollectionCorruption: () => {},
    markCollectionDirty: () => {},
    saveState: () => {},
    setTimeout: () => 0,
    TIME_CONSTANTS: { API_TIMEOUT_LONG_MS: 20000 },
    WALLET: { getBalanceMinor: () => 10000 },
    IS_STUDIO_SHELL: false
  }, { microtaskMode: 'afterEvaluate' });
  let loadError = '';
  try {
    const at = forms.indexOf('function normalizeDigitsAscii(');
    vm.runInContext(forms.slice(at, forms.indexOf('\n}\n', at) + 2), box);
    vm.runInContext(adsStudio, box);
    vm.runInContext(`
      var __calls = [];
      var __replies = Object.create(null);
      var __syncTicks = 0;
      function apiJson(path, options) {
        __calls.push({ path: String(path), method: String((options && options.method) || 'GET'), body: options && options.body ? JSON.parse(JSON.stringify(options.body)) : null });
        const next = (__replies[path] || []).shift();
        if (!next) return new Promise(() => {});
        if (next.error) return Promise.reject(Object.assign(new Error(next.error.message || 'Request failed'), { status: next.error.status, payload: next.error.payload }));
        return Promise.resolve(JSON.parse(JSON.stringify(next.value)));
      }
      function apiMetaAdsAccounts() { __calls.push({ path: '/api/meta-ads/accounts', method: 'GET', body: null }); return Promise.resolve([{ id: 'act_111', name: 'Main <acct>' }, { id: '222', name: 'Second' }, { id: '111', name: 'Duplicate' }, { id: 'x', name: 'Not an id' }]); }
      async function copyTextToClipboard(text) { __copied.push(String(text)); return true; }
      function apiWalletPaymentMethods() { return Promise.resolve({ methods: [], rate: null }); }
      function apiWalletPaymentRequestList() { __calls.push({ path: 'wallet-list', method: 'GET', body: null }); return Promise.resolve({ requests: [] }); }
      function serverLiveSyncTick() { __syncTicks += 1; return Promise.resolve(); }
    `, box);
    box.__copied = copied;
  } catch (error) { loadError = String(error && error.message || error); }
  const run = code => { try { return vm.runInContext(code, box); } catch (error) { return `THREW ${error && error.message}`; } };
  const inLanguage = (language, code) => { box.state.language = language; const out = run(code); box.state.language = 'en'; return out; };
  const json = code => { try { return JSON.parse(String(run(`JSON.stringify(${code})`))); } catch (_) { return null; } };
  const fn = name => { const at = adsStudio.indexOf(`function ${name}(`); return at < 0 ? '' : adsStudio.slice(at, adsStudio.indexOf('\n}\n', at)); };
  const reply = (path, items) => run(`__replies[${JSON.stringify(path)}] = ${JSON.stringify(items)};`);
  const calls = () => json('__calls') || [];
  const as = (role, uid) => { who.admin = role === 'admin'; who.staff = role !== 'customer'; who.uid = uid; box.state.currentUser = { id: uid }; };
  const card = (campaign, language = 'en') => String(inLanguage(language, `renderAdsStudioCampaignCard(${JSON.stringify(campaign)})`));
  const text = html => String(html).replace(/<[^>]*>/g, ' ');

  // Bilingual publishStatus labels on staff and customer cards; no raw value is ever rendered.
  as('admin', 'p9-staff');
  const labelOf = (campaign, language) => String(inLanguage(language, `(m => ${language === 'ar' ? 'm.labelAr' : 'm.label'})(adsStudioPublishStatusMeta(${JSON.stringify(campaign)}))`));
  const values = ['', 'meta_review', 'live', 'paused', 'mystery<b>'];
  const staffReview = card({ id: 'p9-l1', status: 'Approved', createdBy: 'c-1', publishStatus: 'meta_review', metaCampaignId: '120', name: 'Linked' });
  const staffReviewAr = card({ id: 'p9-l1', status: 'Approved', createdBy: 'c-1', publishStatus: 'meta_review', metaCampaignId: '120', name: 'Linked' }, 'ar');
  const staffOdd = card({ id: 'p9-l2', status: 'Approved', createdBy: 'c-1', publishStatus: 'mystery<b>', name: 'Odd' });
  const staffStopped = card({ id: 'p9-l3', status: 'Stopped', createdBy: 'c-1', publishStatus: '', metaCampaignId: '121', name: 'Stopped' });
  as('customer', 'p9-customer');
  const customerSetup = card({ id: 'p9-l4', status: 'Approved', createdBy: 'p9-customer', publishStatus: '', name: 'Mine' });
  const customerSetupAr = card({ id: 'p9-l4', status: 'Approved', createdBy: 'p9-customer', publishStatus: '', name: 'Mine' }, 'ar');
  const customerLive = card({ id: 'p9-l5', status: 'Approved', createdBy: 'p9-customer', publishStatus: 'live', metaCampaignId: '122', name: 'Mine live' });
  const customerDraft = card({ id: 'p9-l6', status: 'Draft', createdBy: 'p9-customer', name: 'Draft' });
  const labelCases = [
    JSON.stringify(json('ADS_STUDIO_PUBLISH_STATUS.map(row => row[0])')) === '["meta_review","live","paused"]',
    values.every(value => [true, false].every(linked => {
      const c = { publishStatus: value, metaCampaignId: linked ? '9' : '' };
      const en = labelOf(c, 'en');
      const ar = labelOf(c, 'ar');
      return en && ar && en !== ar && en !== value && ar !== value && !en.includes('mystery') && /[؀-ۿ]/.test(ar);
    })),
    text(staffReview).includes('Meta is reviewing the ad') && !text(staffReview).includes('meta_review') && text(staffReviewAr).includes('ميتا تراجع الإعلان'),
    text(staffOdd).includes('Meta status unknown') && !staffOdd.includes('mystery'),
    text(staffStopped).includes('Not live on Meta'),
    text(customerSetup).includes('Being set up in Meta') && text(customerSetupAr).includes('نجهّزه في ميتا'),
    text(customerLive).includes('Live on Meta') && !/>\s*live\s*</.test(customerLive),
    !customerDraft.includes('data-ads-studio-publish-status'),
    !adsStudio.includes('Security.escapeHtml(String(campaign.publishStatus))') && fn('renderAdsStudioCampaignCard').includes('renderAdsStudioPublishChip(campaign)')
  ];
  check('publishStatus has an English and Arabic label for every value on staff and customer cards; no raw value is rendered', !loadError && labelCases.every(Boolean),
    loadError || `cases ${labelCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // Arabic entries for the new server texts (the stage 8 block, in its place; later entries follow it).
  // The account and not-found keys are the server's exact texts (REFUSE_LINK_ACCOUNT, REFUSE_LINK_NOT_FOUND).
  const added = [
    ['Only Submitted campaigns can be withdrawn', 'يمكن سحب الطلبات التي تنتظر المراجعة فقط'],
    ['This request was already approved', 'تمت الموافقة على هذا الطلب بالفعل — اطلب إيقافه بدلاً من سحبه'],
    ['Campaign is missing its owner', 'هذا الطلب غير مرتبط بحساب صاحبه — تواصل مع فريق البيان'],
    ['This Meta campaign is already linked to another request', 'حملة ميتا هذه مرتبطة بطلب آخر'],
    ['Rename the campaign in Meta to the name shown, then link again', 'غيّر اسم الحملة في ميتا إلى الاسم الظاهر ثم اربطها مرة أخرى'],
    ["This Meta ad account is not one of Albayan's ad accounts", 'حساب الإعلانات هذا ليس من حسابات البيان الإعلانية'],
    ['The Meta campaign was not found', 'لم يتم العثور على حملة ميتا']
  ];
  const refusalMap = json('_ADS_STUDIO_REFUSAL_AR') || [];
  const arabic = detail => String(inLanguage('ar', `adsStudioRefusalText(${JSON.stringify(detail)})`));
  const actionsPy = read('server/systems/ads_studio/ad_campaign_actions.py');
  const metaPy = read('server/meta_ads.py');
  const pollPy = read('server/systems/ads_studio/studio_ig_poll.py');
  const addedAt = refusalMap.findIndex(entry => entry[0] === added[0][0]);
  const refusalCases = [
    added.every(([en, ar]) => refusalMap.filter(entry => entry[0] === en).length === 1 && refusalMap.some(entry => entry[0] === en && entry[1] === ar && !entry[2])),
    addedAt > 0 && refusalMap[addedAt - 1][0] === 'Meta is busy right now, so the chosen post could not be checked'
      && JSON.stringify(refusalMap.slice(addedAt, addedAt + added.length).map(entry => entry.slice(0, 2))) === JSON.stringify(added),
    arabic('This request was already approved — ask to stop it instead') === added[1][1],
    arabic('Only Submitted campaigns can be withdrawn') === added[0][1] && arabic('Campaign is missing its owner') === added[2][1],
    arabic('This Meta campaign is already linked to another request (ALB-S-ABCDEFGH)') === added[3][1],
    arabic({ code: 'NEEDS_MANUAL_RENAME', message: 'Rename the campaign in Meta to the name shown, then link again', studioName: 'ALB-S-ABCDEFGH · x' }) === added[4][1],
    arabic("This Meta ad account is not one of Albayan's ad accounts") === added[5][1] && arabic('The Meta campaign was not found') === added[6][1],
    !refusalMap.some(entry => ['This Meta ad account is not allowed', 'Meta campaign not found'].includes(entry[0])),
    String(run("adsStudioRefusalText('This Meta campaign is already linked to another request')")) === 'This Meta campaign is already linked to another request',
    actionsPy.includes('REFUSE_WITHDRAW_NOT_SUBMITTED = "Only Submitted campaigns can be withdrawn"')
      && actionsPy.includes('REFUSE_WITHDRAW_APPROVED = "This request was already approved')
      && actionsPy.includes('detail="Campaign is missing its owner"')
      && actionsPy.includes(`REFUSE_LINK_ACCOUNT = "${added[5][0]}"`) && actionsPy.includes(`REFUSE_LINK_NOT_FOUND = "${added[6][0]}"`)
      && actionsPy.includes(`REFUSE_LINK_TAKEN = "${added[3][0]}"`) && actionsPy.includes(`REFUSE_NEEDS_MANUAL_RENAME = "${added[4][0]}"`)
  ];
  check('Arabic refusal map: withdraw texts and the Meta link texts (already linked, rename, account not allowed, campaign not found)', !loadError && refusalCases.every(Boolean),
    loadError || `cases ${refusalCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // EVERY REFUSE_LINK_* constant (read from the server file), the manual-rename message, the studio
  // code, the approval and publish-status texts, the Manager link's studio refusals (meta_ads.py) and
  // the Instagram check's texts (studio_ig_poll.py) reach Arabic through the map: never the English
  // fallback, and the entry that answers is the one written for that text (never a shorter one).
  const linkConstants = [...actionsPy.matchAll(/^(REFUSE_LINK_[A-Z_]+) = "([^"]+)"/gm)].map(match => [match[1], match[2]]);
  const pyText = (source, name) => (source.match(new RegExp(`^${name} = "([^"]+)"`, 'm')) || [])[1] || '';
  const managerStudio = 'This Meta ad belongs to Albayan Studio (a studio request linked its campaign). It cannot be linked to an Albayan Manager ad.';
  const managerCode = 'This Meta ad belongs to Albayan Studio (its campaign name carries the studio code ALB-S-). It cannot be linked to an Albayan Manager ad.';
  const managerUnread = "Albayan could not read this ad's Meta campaign name to confirm it is not an Albayan Studio ad. Try again in a minute.";
  const pollTexts = [...pollPy.matchAll(/studio_error\(\s*\d+,\s*"[A-Z_]+",\s*"([^"]+)"/g)].map(match => match[1])
    .concat([...pollPy.matchAll(/CHECK(?:S_PER_ACCOUNT_MINUTE|_PRESSES_PER_MINUTE),\s*"([^"]+)"\)/g)].map(match => match[1]));
  const serverTexts = [
    ...linkConstants.map(([, value]) => value),
    `${pyText(actionsPy, 'REFUSE_LINK_META_BUSY')}. Try again in a minute.`, `${pyText(actionsPy, 'REFUSE_LINK_META_FAILED')} (Meta code 100.33)`,
    `${pyText(actionsPy, 'REFUSE_LINK_RATE')}. Please wait a minute.`, `${pyText(actionsPy, 'REFUSE_STUDIO_REF')}. Try again.`,
    pyText(actionsPy, 'REFUSE_NEEDS_MANUAL_RENAME'),
    'Only Submitted campaigns can be reviewed', 'You cannot review your own campaign', 'Invalid review decision',
    'operationId was already used for another review', 'Only Approved campaigns can be marked launched',
    'operationId was already used for another update', 'expectedVersion is required', 'Campaign request not found',
    'A link sets publishStatus meta_review; leave publishStatus out',
    'publishStatus is required (or metaAdAccountId and metaCampaignId to link a Meta campaign)',
    'meta_review is set by linking a Meta campaign (metaAdAccountId and metaCampaignId)',
    managerStudio, managerCode, managerUnread,
    ...pollTexts
  ];
  const firstHit = value => refusalMap.find(([needle]) => value.includes(needle)) || [];
  const englishLeft = serverTexts.filter(value => {
    const ar = arabic(value);
    return !value || ar === value || !/[؀-ۿ]/.test(ar) || /[A-Za-z]{4,}/.test(ar.replace(/ALB-S-/g, '')) || !value.startsWith(firstHit(value)[0] || '\u0000');
  });
  const everyCases = [
    linkConstants.length >= 13 && linkConstants.some(([name]) => name === 'REFUSE_LINK_ACCOUNT') && linkConstants.some(([name]) => name === 'REFUSE_LINK_NOT_FOUND'),
    englishLeft.length === 0,
    pollTexts.length >= 7 && pollTexts.includes('This Instagram account was checked less than a minute ago. Try again in a minute.')
      && pollTexts.includes('Too many requests. Please wait and try again.') && pollTexts.includes('Meta asked Albayan to wait, so no comment was read. Try again in a few minutes.'),
    ['Only Submitted campaigns can be reviewed', 'You cannot review your own campaign', 'Invalid review decision', 'operationId was already used for another review',
      'Only Approved campaigns can be marked launched', 'operationId was already used for another update', 'expectedVersion is required',
      'A link sets publishStatus meta_review; leave publishStatus out', 'publishStatus is required (or metaAdAccountId and metaCampaignId to link a Meta campaign)',
      'meta_review is set by linking a Meta campaign (metaAdAccountId and metaCampaignId)'].every(value => actionsPy.includes(`"${value}"`)),
    [managerStudio, managerCode, managerUnread].every(value => metaPy.replace(/"\s*\n\s*"/g, '').includes(`"${value}"`)),
    arabic(`${pyText(actionsPy, 'REFUSE_LINK_META_BUSY')}. Try again in a minute.`) === 'ميتا مشغولة الآن، لذلك تعذر ربط الحملة. حاول مرة أخرى بعد دقيقة.'
      && arabic({ code: 'RATE_LIMITED', message: 'This Instagram account was checked less than a minute ago. Try again in a minute.' }) === 'فُحص حساب إنستغرام هذا قبل أقل من دقيقة. أعد المحاولة بعد دقيقة.'
      && arabic(managerStudio) === 'إعلان ميتا هذا تابع لاستوديو البيان (ربط طلبٌ في الاستوديو حملته)، ولا يمكن ربطه بإعلان في مدير البيان',
    // The new entries come after the stage 8 block (append-only), each English key once.
    refusalMap.length >= addedAt + added.length + 30 && new Set(refusalMap.map(entry => entry[0])).size === refusalMap.length
  ];
  check('Arabic refusal map: EVERY REFUSE_LINK_* constant, the approval texts, the Manager link\'s studio refusals and the Instagram check texts reach Arabic (no English fallback)',
    !loadError && everyCases.every(Boolean), loadError || `cases ${everyCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}; English left: ${JSON.stringify(englishLeft)}`);

  // Staff launch area: the studio name with one-tap Copy, then the link sheet from the allowlisted accounts.
  as('admin', 'p9-staff');
  const studioName = 'ALB-S-ABCDEFGH · Summer <sale>';
  const approved = { id: 'p9-a', status: 'Approved', createdBy: 'c-1', name: 'Summer <sale>', studioRef: 'ALB-S-ABCDEFGH', studioName,
    paidMinorUSD: 5000, budgetMinorUSD: 5000, budgetType: 'lifetime', startDate: '2099-01-01', endDate: '2099-01-07', _lastModified: 21 };
  box.state.adCampaignRequests = [
    JSON.parse(JSON.stringify(approved)),
    { id: 'p9-b', status: 'Approved', createdBy: 'c-1', name: 'Already linked', metaCampaignId: '999', publishStatus: 'live', _lastModified: 5 },
    { id: 'p9-c', status: 'Submitted', createdBy: 'c-1', name: 'Waiting', _lastModified: 6 }
  ];
  const launch = String(run('renderAdsStudioLaunchQueue()'));
  const label = { textContent: 'Copy' };
  box.__label = label;
  run("adsStudioCopyStudioName('p9-a', { querySelector: () => __label })");
  const copiedLabel = label.textContent;
  box.__labelAr = { textContent: 'نسخ' };
  inLanguage('ar', "adsStudioCopyStudioName('p9-a', { querySelector: () => __labelAr })");
  run("openAdsStudioLinkSheet('p9-a')");
  const sheetHtml = String(run('renderAdsStudioSheets()'));
  const sheetAr = String(inLanguage('ar', 'renderAdsStudioSheets()'));
  const campaignInput = { value: '١٢٠ 200-555' };
  box.__campaignInput = campaignInput;
  run("adsStudioSetLinkField('metaCampaignId', __campaignInput)");
  run('__calls.length = 0;');
  run('linkAdsStudioMetaCampaign()');
  const noAccount = [json('_adsStudioLinkSheet.outcome'), calls().length];
  box.__accountInput = { value: 'act_222' };
  run("adsStudioSetLinkField('accountId', __accountInput)");
  const publishPath = '/api/ad-studio/campaigns/p9-a/publish-status';
  const getPath = '/api/collections/adCampaignRequests/p9-a';
  reply(publishPath, [
    { error: { status: 409, message: 'x', payload: { detail: { code: 'NEEDS_MANUAL_RENAME', message: 'Rename the campaign in Meta to the name shown, then link again', studioName } } } },
    { error: { status: 409, message: 'This Meta campaign is already linked to another request', payload: { detail: 'This Meta campaign is already linked to another request' } } },
    { value: { id: 'p9-a', data: { ...approved, publishStatus: 'meta_review', metaCampaignId: '120200555', metaAdAccountId: '222', linkedAt: '2026-09-25T10:00:00Z', _lastModified: 22 },
      lastModified: 22, renamed: true, removedManagerCopies: 2, keptManagerCopies: 3, warnings: ['meta_budget_above_paid', { code: 'odd_code<b>' }] } }
  ]);
  reply(getPath, [{ value: { id: 'p9-a', data: approved, lastModified: 21 } }]);
  // The last render after a refusal already offers Link again (never a button stuck on "Linking…").
  run("var __lastSheets = ''; render = () => { __lastSheets = renderAdsStudioSheets(); };");
  run('linkAdsStudioMetaCampaign()');
  const renameLastRender = String(run('__lastSheets'));
  run('render = () => {};');
  const renameCall = calls().find(call => call.path === publishPath) || {};
  const renameOutcome = json('_adsStudioLinkSheet.outcome') || {};
  const renameHtml = String(run('renderAdsStudioSheets()'));
  const renameAr = String(inLanguage('ar', 'renderAdsStudioSheets()'));
  run('__calls.length = 0;');
  inLanguage('ar', 'linkAdsStudioMetaCampaign()');
  const linkedElsewhere = [json('_adsStudioLinkSheet.outcome'), (calls().find(call => call.path === publishPath) || {}).body, calls().some(call => call.path === getPath)];
  run('__calls.length = 0;');
  notices.length = 0;
  run('linkAdsStudioMetaCampaign()');
  const linkedOutcome = json('_adsStudioLinkSheet.outcome') || {};
  const linkedHtml = String(run('renderAdsStudioSheets()'));
  const linkedAr = String(inLanguage('ar', 'renderAdsStudioSheets()'));
  const afterLink = json("state.adCampaignRequests.find(c => c.id === 'p9-a')") || {};
  const launchAfter = String(run('renderAdsStudioLaunchQueue()'));
  const linkNotice = notices[0] || {};
  // A reply lost after the link committed: the 409 on the replay is checked against the server.
  box.state.adCampaignRequests.push({ ...JSON.parse(JSON.stringify(approved)), id: 'p9-d', studioName: 'ALB-S-QRSTUVWX · Lost', _lastModified: 40 });
  run("openAdsStudioLinkSheet('p9-d'); _adsStudioLinkSheet.accountId = '111'; _adsStudioLinkSheet.metaCampaignId = '777';");
  reply('/api/ad-studio/campaigns/p9-d/publish-status', [{ error: { status: 409, message: 'Conflict: record has changed', payload: { detail: 'Conflict: record has changed' } } }]);
  // The request read back carries the result the link stored: its warnings and kept copies are shown too.
  reply('/api/collections/adCampaignRequests/p9-d', [{ value: { id: 'p9-d', data: { ...approved, id: 'p9-d', metaCampaignId: '777', publishStatus: 'meta_review', _lastModified: 41,
    metaLinkResult: { renamed: true, removedManagerCopies: 1, keptManagerCopies: 1, warnings: ['meta_budget_above_paid'], metaBudgetMinor: 9000 } }, lastModified: 41 } }]);
  run('linkAdsStudioMetaCampaign()');
  const lostReply = json('_adsStudioLinkSheet.outcome') || {};
  const lostHtml = String(run('renderAdsStudioSheets()'));
  const lostAr = String(inLanguage('ar', 'renderAdsStudioSheets()'));
  // Double tap: one request in flight.
  box.state.adCampaignRequests.push({ ...JSON.parse(JSON.stringify(approved)), id: 'p9-e', _lastModified: 50 });
  run("openAdsStudioLinkSheet('p9-e'); _adsStudioLinkSheet.accountId = '111'; _adsStudioLinkSheet.metaCampaignId = '888'; __calls.length = 0;");
  const sameFlight = run('linkAdsStudioMetaCampaign() === linkAdsStudioMetaCampaign()');
  const flightCalls = calls().filter(call => call.path === '/api/ad-studio/campaigns/p9-e/publish-status').length;
  // Single flight PER REQUEST: while p9-e waits, another request's sheet links on its own; p9-e's
  // sheet opened again shows its link still running and a press joins it (no second call).
  run('var __eFlight = linkAdsStudioMetaCampaign(); closeAdsStudioLinkSheet();');
  box.state.adCampaignRequests.push({ ...JSON.parse(JSON.stringify(approved)), id: 'p9-f', _lastModified: 60 });
  run("openAdsStudioLinkSheet('p9-f'); _adsStudioLinkSheet.accountId = '111'; _adsStudioLinkSheet.metaCampaignId = '999';");
  const otherFlight = run('(() => { const f = linkAdsStudioMetaCampaign(); return f !== __eFlight && f === linkAdsStudioMetaCampaign(); })()');
  const otherCalls = calls().filter(call => call.path === '/api/ad-studio/campaigns/p9-f/publish-status').length;
  run("closeAdsStudioLinkSheet(); openAdsStudioLinkSheet('p9-e');");
  const reopenedBusy = String(run('renderAdsStudioSheets()'));
  const rejoined = run('linkAdsStudioMetaCampaign() === __eFlight');
  const flightsAfter = [calls().filter(call => call.path === '/api/ad-studio/campaigns/p9-e/publish-status').length, run('_adsStudioLinkPromises.size')];
  run('_adsStudioLinkPromises.clear(); closeAdsStudioLinkSheet();');
  // A reviewer (not an admin) cannot read the account list: the account id is typed, digits only.
  as('reviewer', 'p9-reviewer');
  run("_adsStudioMetaAccounts.forUser = ''; __calls.length = 0; openAdsStudioLinkSheet('p9-e');");
  const reviewerSheet = String(run('renderAdsStudioSheets()'));
  const reviewerCalls = calls().filter(call => call.path === '/api/meta-ads/accounts').length;
  run('closeAdsStudioLinkSheet();');
  const linkCode = ['openAdsStudioLinkSheet', 'closeAdsStudioLinkSheet', 'renderAdsStudioLinkSheet', 'renderAdsStudioLinkOutcome', 'linkAdsStudioMetaCampaign',
    'linkAdsStudioMetaCampaignOnce', 'adsStudioApiLinkMetaCampaign', 'adsStudioCopyStudioName', 'renderAdsStudioLaunchQueue', 'renderAdsStudioStudioNameRow'].map(fn);
  const copyHelper = read('src/04-permissions.js');
  const linkCases = [
    launch.includes('data-ads-studio-campaign="p9-a"') && !launch.includes('data-ads-studio-campaign="p9-b"') && !launch.includes('data-ads-studio-campaign="p9-c"'),
    launch.includes('ALB-S-ABCDEFGH · Summer &lt;sale&gt;') && !launch.includes('Summer <sale>') && launch.includes('data-ads-studio-copy="1"') && launch.includes("openAdsStudioLinkSheet('p9-a')"),
    copied.length === 2 && copied.every(value => value === studioName) && copiedLabel === 'Copied' && box.__labelAr.textContent === 'تم النسخ',
    fn('adsStudioCopyStudioName').includes('copyTextToClipboard(name)') && /async function copyTextToClipboard[\s\S]*navigator\.clipboard\.writeText[\s\S]*createElement\('textarea'\)/.test(copyHelper),
    sheetHtml.includes('<select id="ads-studio-link-account"') && sheetHtml.includes('<option value="111"') && sheetHtml.includes('<option value="222"')
      && (sheetHtml.match(/<option value="111"/g) || []).length === 1 && !sheetHtml.includes('value="x"') && sheetHtml.includes('Main &lt;acct&gt;')
      && sheetHtml.includes('ALB-S-ABCDEFGH · Summer &lt;sale&gt;') && sheetHtml.includes('Link Meta campaign') && sheetHtml.includes('$50.00')
      && sheetAr.includes('ربط حملة ميتا') && sheetAr.includes('اختر حساب الإعلانات'),
    campaignInput.value === '120200555' && box.__accountInput.value === '222',
    noAccount[0] && noAccount[0].kind === 'error' && noAccount[0].text === 'Choose the ad account.' && noAccount[1] === 0,
    renameCall.method === 'POST' && renameCall.body && renameCall.body.metaAdAccountId === '222' && renameCall.body.metaCampaignId === '120200555'
      && renameCall.body.expectedVersion === 21 && renameCall.body.expectedLastModified === 21 && renameCall.body.publishStatus === 'meta_review'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(String(renameCall.body.operationId || '')),
    renameLastRender.includes('data-ads-studio-link-result="rename"') && /data-ads-studio-link-submit="1" onclick="linkAdsStudioMetaCampaign\(this\)"  class=/.test(renameLastRender)
      && !renameLastRender.includes('Linking…'),
    renameOutcome.kind === 'rename' && renameOutcome.studioName === studioName
      && renameHtml.includes('Rename it in Meta, then press Link again.') && renameHtml.includes('data-ads-studio-link-result="rename"')
      && (renameHtml.match(/data-ads-studio-copy="1"/g) || []).length === 2 && renameAr.includes('غيّر اسمها في ميتا، ثم اضغط «ربط» مرة أخرى.'),
    linkedElsewhere[0] && linkedElsewhere[0].kind === 'error' && linkedElsewhere[0].text === 'حملة ميتا هذه مرتبطة بطلب آخر'
      && linkedElsewhere[1] && linkedElsewhere[1].operationId === renameCall.body.operationId && linkedElsewhere[2] === true,
    linkedOutcome.kind === 'linked' && linkedOutcome.renamed === true && linkedOutcome.removed === 2 && linkedOutcome.kept === 3
      && JSON.stringify(linkedOutcome.warnings) === '["meta_budget_above_paid","odd_code<b>"]',
    text(linkedHtml).includes('3 copies in Albayan Manager have money or edits and were kept — check them.') && linkedHtml.includes('data-ads-studio-link-kept="3"')
      && linkedAr.includes('3 نسخ في مدير البيان عليها أموال أو تعديلات فبقيت كما هي — راجعها.'),
    text(linkedHtml).includes('Linked. Meta is reviewing the ad now.') && text(linkedHtml).includes('Renamed in Meta to the name shown.')
      && text(linkedHtml).includes('2 copies removed from Albayan Manager.') && text(linkedHtml).includes('The campaign budget in Meta is above what the customer paid')
      && text(linkedHtml).includes('Meta flagged something on this campaign') && !linkedHtml.includes('meta_budget_above_paid') && !linkedHtml.includes('odd_code')
      && !linkedHtml.includes('data-ads-studio-link-submit') && text(linkedHtml).includes('Done'),
    linkedAr.includes('حُذفت نسختان من مدير البيان.') && linkedAr.includes('ميزانية الحملة في ميتا أعلى مما دفعه العميل') && linkedAr.includes('تم الربط. ميتا تراجع الإعلان الآن.'),
    afterLink.metaCampaignId === '120200555' && afterLink.publishStatus === 'meta_review' && !launchAfter.includes('data-ads-studio-campaign="p9-a"')
      && linkNotice.title === 'Meta campaign linked' && linkNotice.kind === 'success',
    lostReply.kind === 'linked' && (json("state.adCampaignRequests.find(c => c.id === 'p9-d').metaCampaignId") === '777'),
    lostReply.renamed === true && lostReply.removed === 1 && lostReply.kept === 1 && JSON.stringify(lostReply.warnings) === '["meta_budget_above_paid"]'
      && text(lostHtml).includes('The campaign budget in Meta is above what the customer paid') && text(lostHtml).includes('1 copy in Albayan Manager has money or edits and was kept — check it.')
      && text(lostHtml).includes('1 copy removed from Albayan Manager.') && lostAr.includes('نسخة واحدة في مدير البيان عليها أموال أو تعديلات فبقيت كما هي — راجعها.'),
    !String(run("renderAdsStudioLinkOutcome({ id: 'x' }, adsStudioLinkOutcomeFrom({ keptManagerCopies: 0 }, ''))")).includes('data-ads-studio-link-kept'),
    sameFlight === true && flightCalls === 1,
    otherFlight === true && otherCalls === 1 && rejoined === true && flightsAfter[0] === 1 && flightsAfter[1] === 2
      && reopenedBusy.includes('data-ads-studio-link-submit="1"') && reopenedBusy.includes('disabled aria-busy="true"') && text(reopenedBusy).includes('Linking…'),
    reviewerCalls === 0 && reviewerSheet.includes('<input id="ads-studio-link-account" type="text" inputmode="numeric"') && reviewerSheet.includes('digits only'),
    JSON.stringify(json("[adsStudioDigitsOnly('act_٣٤٥'), adsStudioDigitsOnly(' 12 34 '), adsStudioDigitsOnly('abc')]")) === '["345","1234",""]',
    JSON.stringify(json(`[adsStudioNeedsManualRename({ code: 'NEEDS_MANUAL_RENAME', message: '' }), adsStudioNeedsManualRename('Rename the campaign in Meta to the name shown, then link again'),
      adsStudioNeedsManualRename({ code: 'OTHER', message: 'Meta campaign not found' }), adsStudioNeedsManualRename('Conflict: record has changed')]`)) === '[true,true,false,false]',
    fn('adsStudioSetLinkField').includes('adsStudioDigitsOnly(input?.value)') && fn('adsStudioDigitsOnly').includes('normalizeDigitsAscii('),
    linkCode.every(Boolean) && !linkCode.some(code => /\b(?:confirm|prompt|alert)\(/.test(code)) && !adsStudio.includes('markAdsStudioCampaignLaunched'),
    fn('linkAdsStudioMetaCampaignOnce').includes("adsStudioActionAttempt('publish', campaign.id, Number(campaign._lastModified))"),
    !/_adsStudioLinkPromise\b/.test(adsStudio) && fn('linkAdsStudioMetaCampaign').includes('_adsStudioLinkPromises.has(campaignId)')
  ];
  check('staff link sheet: studio name + Copy, allowlisted accounts, digits-only id, linked / rename in Meta / already linked / budget warning, kept Manager copies, single flight per request', !loadError && linkCases.every(Boolean),
    loadError || `cases ${linkCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // Customer Withdraw: an in-page sheet on a waiting request, one request per (action, version).
  as('customer', 'p9-customer');
  box.state.adCampaignRequests = [
    { id: 'p9-w', status: 'Submitted', createdBy: 'p9-customer', name: 'Waiting <one>', budgetType: 'daily', budgetMinorUSD: 500, durationDays: 5, totalBudgetMinorUSD: 2500, _lastModified: 31 },
    { id: 'p9-y', status: 'Approved', createdBy: 'p9-customer', name: 'Approved one', _lastModified: 32 },
    { id: 'p9-z', status: 'Submitted', createdBy: 'p9-customer', name: 'Racing', totalBudgetMinorUSD: 1000, _lastModified: 33 }
  ];
  const waitingCard = card(box.state.adCampaignRequests[0]);
  const approvedCard = card(box.state.adCampaignRequests[1]);
  run('__calls.length = 0;');
  run("openAdsStudioWithdraw('p9-w')");
  const withdrawSheet = String(run('renderAdsStudioSheets()'));
  const withdrawSheetAr = String(inLanguage('ar', 'renderAdsStudioSheets()'));
  const beforeTap = calls().length;
  reply('/api/ad-studio/campaigns/p9-w/withdraw', [{ value: { id: 'p9-w', data: { ...box.state.adCampaignRequests[0], status: 'Draft', withdrawnAt: '2026-09-25T10:00:00Z', _lastModified: 34 }, lastModified: 34 } }]);
  notices.length = 0;
  const oneFlight = run("withdrawAdsStudioCampaign('p9-w') === withdrawAdsStudioCampaign('p9-w')");
  const withdrawCalls = calls().filter(call => call.path === '/api/ad-studio/campaigns/p9-w/withdraw');
  const withdrawn = json("state.adCampaignRequests.find(c => c.id === 'p9-w').status");
  const withdrawNotice = notices[0] || {};
  const afterSheet = String(run('renderAdsStudioSheets()'));
  const walletRefreshed = calls().some(call => call.path === 'wallet-list') && run('__syncTicks') >= 1;
  // The approval won the race: the 409 text in Arabic, the card is reloaded and the sheet closes itself.
  run("openAdsStudioWithdraw('p9-z')");
  reply('/api/ad-studio/campaigns/p9-z/withdraw', [
    { error: { status: 503, message: 'Service unavailable' } },
    { error: { status: 409, message: 'This request was already approved — ask to stop it instead', payload: { detail: 'This request was already approved — ask to stop it instead' } } }
  ]);
  reply('/api/collections/adCampaignRequests/p9-z', [{ value: { id: 'p9-z', data: { ...box.state.adCampaignRequests[2], status: 'Approved', _lastModified: 35 }, lastModified: 35 } }]);
  run('__calls.length = 0;');
  notices.length = 0;
  run("withdrawAdsStudioCampaign('p9-z')");
  inLanguage('ar', "withdrawAdsStudioCampaign('p9-z')");
  const raceBodies = calls().filter(call => call.path === '/api/ad-studio/campaigns/p9-z/withdraw').map(call => call.body);
  const raceNotice = notices[1] || {};
  const raceSheet = String(run('renderAdsStudioSheets()'));
  const withdrawCode = ['openAdsStudioWithdraw', 'cancelAdsStudioWithdraw', 'renderAdsStudioWithdrawSheet', 'withdrawAdsStudioCampaign', 'withdrawAdsStudioCampaignOnce', 'adsStudioApiWithdraw'].map(fn);
  const withdrawCases = [
    waitingCard.includes('data-ads-studio-withdraw="1"') && waitingCard.includes("openAdsStudioWithdraw('p9-w')") && !approvedCard.includes('data-ads-studio-withdraw'),
    withdrawSheet.includes('Your $25.00 reservation ends now. The request goes back to Draft.') && withdrawSheet.includes('role="dialog"')
      && withdrawSheet.includes('Waiting &lt;one&gt;') && !withdrawSheet.includes('Waiting <one>')
      && withdrawSheetAr.includes('ينتهي حجز $25.00 الآن، ويعود الطلب إلى المسودة.') && beforeTap === 0,
    oneFlight === true && withdrawCalls.length === 1 && withdrawCalls[0].method === 'POST' && withdrawCalls[0].body.expectedLastModified === 31
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(String(withdrawCalls[0].body.operationId || '')),
    withdrawn === 'Draft' && withdrawNotice.title === 'Request withdrawn' && withdrawNotice.message.includes('$25.00') && afterSheet === '' && walletRefreshed,
    raceBodies.length === 2 && raceBodies[0].operationId === raceBodies[1].operationId && raceBodies[0].expectedLastModified === 33,
    raceNotice.message === 'تمت الموافقة على هذا الطلب بالفعل — اطلب إيقافه بدلاً من سحبه'
      && json("state.adCampaignRequests.find(c => c.id === 'p9-z').status") === 'Approved' && raceSheet === '',
    withdrawCode.every(Boolean) && !withdrawCode.some(code => /\b(?:confirm|prompt|alert)\(/.test(code)),
    fn('withdrawAdsStudioCampaignOnce').includes("adsStudioActionAttempt('withdraw', campaign.id, Number(campaign._lastModified))")
      && fn('withdrawAdsStudioCampaignOnce').includes('resetAdsStudioWalletCache();') && fn('withdrawAdsStudioCampaignOnce').includes('refreshAdsStudioWallet();')
  ];
  check('customer Withdraw: in-page sheet with the held amount (EN/AR), single flight per version, list and wallet refreshed, a 409 in Arabic', !loadError && withdrawCases.every(Boolean),
    loadError || `cases ${withdrawCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // Staff "Unlink Meta campaign" (D26): an in-page sheet with a required reason on a linked Approved
  // card; POST unlink-meta {operationId, expectedLastModified, reason}; the copies that came back and
  // the rename back are shown; single flight per request; a lost reply is read back from the server.
  as('admin', 'p9-staff');
  const linkedReq = { id: 'p9-u', status: 'Approved', createdBy: 'c-1', name: 'Linked <one>', studioRef: 'ALB-S-UNLINKME', studioName: 'ALB-S-UNLINKME · Linked',
    metaCampaignId: '120555', metaAdAccountId: 'act_111', publishStatus: 'meta_review', linkedAt: '2026-09-25T10:00:00Z',
    metaLinkResult: { renamed: true, removedManagerCopies: 2, keptManagerCopies: 0, warnings: [] }, paidMinorUSD: 5000, _lastModified: 70 };
  const copyOf = (id, extra) => ({ ...JSON.parse(JSON.stringify(linkedReq)), id, ...extra });
  box.state.adCampaignRequests = [
    copyOf('p9-u', {}),
    { id: 'p9-s', status: 'Stopped', createdBy: 'c-1', name: 'Stopped linked', metaCampaignId: '120556', _lastModified: 71 },
    { id: 'p9-n', status: 'Approved', createdBy: 'c-1', name: 'Not linked', _lastModified: 72 },
    copyOf('p9-v', { metaCampaignId: '120557', _lastModified: 73 }),
    copyOf('p9-x', { metaCampaignId: '120558', _lastModified: 74 }),
    copyOf('p9-y2', { metaCampaignId: '120559', metaLinkResult: { renamed: false }, _lastModified: 77 })
  ];
  const linkedCard = card(box.state.adCampaignRequests[0]);
  const linkedCardAr = card(box.state.adCampaignRequests[0], 'ar');
  const stoppedLinkedCard = card(box.state.adCampaignRequests[1]);
  const notLinkedCard = card(box.state.adCampaignRequests[2]);
  as('customer', 'c-1');
  const customerLinkedCard = card(box.state.adCampaignRequests[0]);
  run("openAdsStudioUnlinkSheet('p9-u')");
  const customerUnlinkSheet = String(run('renderAdsStudioSheets()'));
  as('admin', 'p9-staff');
  run("openAdsStudioLinkSheet('p9-n'); openAdsStudioUnlinkSheet('p9-u');");
  const oneSheet = [json('_adsStudioLinkSheet'), json('_adsStudioUnlinkSheet.campaignId')];
  const unlinkSheet = String(run('renderAdsStudioSheets()'));
  const unlinkSheetAr = String(inLanguage('ar', 'renderAdsStudioSheets()'));
  run('__calls.length = 0;');
  run("unlinkAdsStudioMetaCampaign('p9-u')");
  const noReason = [json('_adsStudioUnlinkSheet.outcome'), calls().length];
  run("adsStudioSetUnlinkReason({ value: '  The wrong campaign was linked  ' })");
  const unlinkPath = '/api/ad-studio/campaigns/p9-u/unlink-meta';
  reply(unlinkPath, [
    { error: { status: 409, message: 'Conflict: record has changed', payload: { detail: 'Conflict: record has changed' } } },
    { value: { id: 'p9-u', data: { ...linkedReq, metaCampaignId: '', metaAdAccountId: '', publishStatus: '', linkedAt: null, _lastModified: 75 }, lastModified: 75, restoredCopies: 2, renamedBack: true } }
  ]);
  reply('/api/collections/adCampaignRequests/p9-u', [{ value: { id: 'p9-u', data: linkedReq, lastModified: 70 } }]);  // still linked: the 409 was a refusal
  run("var __lastUnlinkSheets = ''; render = () => { __lastUnlinkSheets = renderAdsStudioSheets(); };");
  inLanguage('ar', "unlinkAdsStudioMetaCampaign('p9-u')");
  const refusedLastRender = String(run('__lastUnlinkSheets'));
  run('render = () => {};');
  const refusedUnlink = [json('_adsStudioUnlinkSheet.outcome') || {}, (calls().find(call => call.path === unlinkPath) || {}).body || {}];
  const refusedUnlinkHtml = String(run('renderAdsStudioSheets()'));
  notices.length = 0;
  run('__calls.length = 0;');
  const unlinkFlight = run("unlinkAdsStudioMetaCampaign('p9-u') === unlinkAdsStudioMetaCampaign('p9-u')");
  const unlinkCalls = calls().filter(call => call.path === unlinkPath);
  const unlinkedOutcome = json('_adsStudioUnlinkSheet.outcome') || {};
  const unlinkedHtml = String(run('renderAdsStudioSheets()'));
  const unlinkedAr = String(inLanguage('ar', 'renderAdsStudioSheets()'));
  const afterUnlink = json("state.adCampaignRequests.find(c => c.id === 'p9-u')") || {};
  const queueAfterUnlink = String(run('renderAdsStudioLaunchQueue()'));
  const unlinkNotice = notices[0] || {};
  // A reply lost on the way (no answer at all): the request, read back, holds no Meta campaign any more.
  run("openAdsStudioUnlinkSheet('p9-v'); _adsStudioUnlinkSheet.reason = 'Duplicate';");
  reply('/api/ad-studio/campaigns/p9-v/unlink-meta', [{ error: { message: 'Network request failed' } }]);
  reply('/api/collections/adCampaignRequests/p9-v', [{ value: { id: 'p9-v', data: { ...linkedReq, id: 'p9-v', metaCampaignId: '', publishStatus: '', _lastModified: 76 }, lastModified: 76 } }]);
  run("unlinkAdsStudioMetaCampaign('p9-v')");
  const lostUnlink = json('_adsStudioUnlinkSheet.outcome') || {};
  const lostUnlinkHtml = String(run('renderAdsStudioSheets()'));
  // Albayan renamed the campaign but the answer says it was not renamed back: staff are told to check.
  run("openAdsStudioUnlinkSheet('p9-x'); _adsStudioUnlinkSheet.reason = 'Wrong one';");
  reply('/api/ad-studio/campaigns/p9-x/unlink-meta', [{ value: { id: 'p9-x', data: { ...linkedReq, id: 'p9-x', metaCampaignId: '', _lastModified: 78 }, lastModified: 78, restoredCopies: 0, renamedBack: false } }]);
  run("unlinkAdsStudioMetaCampaign('p9-x')");
  const notBackHtml = String(run('renderAdsStudioSheets()'));
  run("openAdsStudioUnlinkSheet('p9-y2'); _adsStudioUnlinkSheet.reason = 'Wrong one';");
  reply('/api/ad-studio/campaigns/p9-y2/unlink-meta', [{ value: { id: 'p9-y2', data: { ...linkedReq, id: 'p9-y2', metaCampaignId: '', _lastModified: 79 }, lastModified: 79, restoredCopies: 0, renamedBack: false } }]);
  run("unlinkAdsStudioMetaCampaign('p9-y2')");
  const neverRenamedHtml = String(run('renderAdsStudioSheets()'));
  run('closeAdsStudioUnlinkSheet();');
  const unlinkCode = ['openAdsStudioUnlinkSheet', 'closeAdsStudioUnlinkSheet', 'renderAdsStudioUnlinkSheet', 'renderAdsStudioUnlinkOutcome', 'unlinkAdsStudioMetaCampaign',
    'unlinkAdsStudioMetaCampaignOnce', 'adsStudioApiUnlinkMetaCampaign'].map(fn);
  const unlinkCases = [
    linkedCard.includes('data-ads-studio-unlink="1"') && linkedCard.includes("openAdsStudioUnlinkSheet('p9-u')") && text(linkedCard).includes('Unlink Meta campaign')
      && linkedCardAr.includes('إلغاء ربط حملة ميتا') && !linkedCard.includes('data-ads-studio-link="1"'),
    !stoppedLinkedCard.includes('data-ads-studio-unlink') && !notLinkedCard.includes('data-ads-studio-unlink') && !customerLinkedCard.includes('data-ads-studio-unlink') && customerUnlinkSheet === '',
    oneSheet[0] === null && oneSheet[1] === 'p9-u',
    unlinkSheet.includes('role="dialog"') && unlinkSheet.includes('data-ads-studio-unlink-sheet="p9-u"') && unlinkSheet.includes('Linked &lt;one&gt;') && !unlinkSheet.includes('Linked <one>')
      && text(unlinkSheet).includes('The Albayan Manager copies of this campaign that the link removed come back.')
      && text(unlinkSheet).includes('If Albayan renamed the campaign in Meta, it tries to rename it back.')
      && text(unlinkSheet).includes('A stopped request cannot be unlinked.') && text(unlinkSheet).includes('Reason (required)')
      && unlinkSheet.includes('<textarea id="ads-studio-unlink-reason"') && unlinkSheet.includes('120555'),
    unlinkSheetAr.includes('تعود إلى مدير البيان نسخ هذه الحملة التي حذفها الربط.') && unlinkSheetAr.includes('إذا غيّر البيان اسم الحملة في ميتا فسيحاول إعادة اسمها السابق.')
      && unlinkSheetAr.includes('لا يمكن إلغاء ربط طلب موقوف.') && unlinkSheetAr.includes('السبب (مطلوب)'),
    noReason[0] && noReason[0].kind === 'error' && noReason[0].text === 'Write the reason for the unlink (at least 3 characters).' && noReason[1] === 0,
    refusedLastRender.includes('data-ads-studio-unlink-result="error"') && /data-ads-studio-unlink-submit="1" onclick="unlinkAdsStudioMetaCampaign\('p9-u', this\)"  class=/.test(refusedLastRender)
      && !refusedLastRender.includes('جارٍ إلغاء الربط…'),
    refusedUnlink[0].kind === 'error' && refusedUnlink[0].text === 'تغيّر السجل — حدّث الصفحة وحاول مرة أخرى' && text(refusedUnlinkHtml).includes('تغيّر السجل')
      && JSON.stringify(Object.keys(refusedUnlink[1]).sort()) === '["expectedLastModified","operationId","reason"]' && refusedUnlink[1].expectedLastModified === 70
      && refusedUnlink[1].reason === 'The wrong campaign was linked' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(String(refusedUnlink[1].operationId || '')),
    unlinkFlight === true && unlinkCalls.length === 1 && unlinkCalls[0].method === 'POST' && unlinkCalls[0].body.operationId === refusedUnlink[1].operationId,
    unlinkedOutcome.kind === 'unlinked' && unlinkedOutcome.known === true && unlinkedOutcome.restored === 2 && unlinkedOutcome.renamedBack === true,
    text(unlinkedHtml).includes('Unlinked. The request waits for a Meta campaign link again.') && text(unlinkedHtml).includes('2 copies came back to Albayan Manager.')
      && text(unlinkedHtml).includes('Renamed back in Meta.') && !unlinkedHtml.includes('data-ads-studio-unlink-submit') && text(unlinkedHtml).includes('Done')
      && !unlinkedHtml.includes('data-ads-studio-unlink-not-renamed') && !unlinkedHtml.includes('data-ads-studio-unlink-lost'),
    unlinkedAr.includes('تم إلغاء الربط.') && unlinkedAr.includes('عادت نسختان إلى مدير البيان.') && unlinkedAr.includes('أعاد البيان اسم الحملة السابق في ميتا.'),
    afterUnlink.metaCampaignId === '' && queueAfterUnlink.includes('data-ads-studio-campaign="p9-u"') && unlinkNotice.title === 'Meta campaign unlinked' && unlinkNotice.kind === 'success',
    lostUnlink.kind === 'unlinked' && lostUnlink.known === false && lostUnlinkHtml.includes('data-ads-studio-unlink-lost="1"') && text(lostUnlinkHtml).includes('The server reply was lost')
      && json("state.adCampaignRequests.find(c => c.id === 'p9-v').metaCampaignId") === '',
    notBackHtml.includes('data-ads-studio-unlink-not-renamed="1"') && text(notBackHtml).includes('The campaign name in Meta was not changed back — check it in Meta.')
      && !neverRenamedHtml.includes('data-ads-studio-unlink-not-renamed') && !notBackHtml.includes('data-ads-studio-unlink-restored'),
    unlinkCode.every(Boolean) && !unlinkCode.some(code => /\b(?:confirm|prompt|alert)\(/.test(code))
      && fn('unlinkAdsStudioMetaCampaignOnce').includes("adsStudioActionAttempt('unlink', campaign.id, Number(campaign._lastModified))")
      && fn('adsStudioApiUnlinkMetaCampaign').includes('/unlink-meta`') && !fn('adsStudioApiUnlinkMetaCampaign').includes('withRetry')
      && fn('unlinkAdsStudioMetaCampaign').includes('_adsStudioUnlinkPromises.has(campaignId)')
      && fn('resetAdsStudioSessionState').includes('_adsStudioUnlinkPromises.clear();') && fn('resetAdsStudioSessionState').includes('_adsStudioLinkPromises.clear();')
  ];
  check('staff Unlink Meta campaign: in-page sheet with a required reason (EN/AR), single flight per request, copies back / renamed back shown, lost reply read back, refusals in Arabic', !loadError && unlinkCases.every(Boolean),
    loadError || `cases ${unlinkCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);

  // Admin "Check recent comments now" per linked Instagram account (15i, P1-23): {read, new, replied,
  // skipped} (+ errorCode) in English and Arabic; the 429 and 409 texts through the Arabic map.
  const health = read('src/systems/ads_studio/15i-studio-health.js');
  const healthFn = name => { const at = health.indexOf(`function ${name}(`); return at < 0 ? '' : health.slice(at, health.indexOf('\n}\n', at)); };
  box.getAuthMeIdentity = () => 'p9-session';
  let healthError = '';
  try { vm.runInContext(health, box); } catch (error) { healthError = String(error && error.message || error); }
  as('admin', 'p9-staff');
  const igPage = "{ id: 'spg_ig', name: 'Shop <ig>', platform: 'ig' }";
  const igRow = String(run(`renderStudioHealthPage(${igPage})`));
  const igRowAr = String(inLanguage('ar', `renderStudioHealthPage(${igPage})`));
  const fbRow = String(run("renderStudioHealthPage({ id: 'spg_fb', name: 'Shop', platform: 'fb' })"));
  const checkPath = '/api/studio/admin/pages/spg_ig/check-comments';
  reply(checkPath, [
    { value: { read: 12, new: 3, replied: 2, skipped: 9, errorCode: '' } },
    { value: { read: 4, new: 1, replied: 0, skipped: 3, errorCode: 'rate_limited' } },
    { error: { status: 429, message: JSON.stringify({ code: 'RATE_LIMITED', message: 'This Instagram account was checked less than a minute ago. Try again in a minute.' }) } },
    { error: { status: 429, message: JSON.stringify({ code: 'RATE_LIMITED', message: 'This Instagram account was checked less than a minute ago. Try again in a minute.' }) } },
    { error: { status: 409, message: 'x', payload: { detail: { code: 'META_PAUSED', message: 'Meta asked Albayan to wait, so no comment was read. Try again in a few minutes.' } } } },
    { error: { status: 409, message: 'x', payload: { detail: { code: 'NOT_INSTAGRAM', message: 'This linked page is not an Instagram account' } } } },
    { error: { status: 404, message: 'x', payload: { detail: { code: 'UNKNOWN_PAGE', message: 'No linked page has this id' } } } }
  ]);
  run('__calls.length = 0;');
  const checkInFlight = run("studioHealthCheckComments('spg_ig'); studioHealthCheckComments('spg_ig'); __calls.length");
  const checkCalls = calls().filter(call => call.path === checkPath);
  const checkNote = () => json("_studioHealth.results['chk:spg_ig']") || {};
  const checkGood = checkNote();
  const checkGoodRow = String(run(`renderStudioHealthPage(${igPage})`));
  inLanguage('ar', "studioHealthCheckComments('spg_ig')");
  const checkStoppedAr = checkNote();
  run("studioHealthCheckComments('spg_ig')");
  const check429 = checkNote();
  inLanguage('ar', "studioHealthCheckComments('spg_ig')");
  const check429Ar = checkNote();
  inLanguage('ar', "studioHealthCheckComments('spg_ig')");
  const check409Ar = checkNote();
  run("studioHealthCheckComments('spg_ig')");
  const check409 = checkNote();
  run("studioHealthCheckComments('spg_ig')");
  const check404 = checkNote();
  as('reviewer', 'p9-reviewer');
  run('__calls.length = 0;');
  run("studioHealthCheckComments('spg_ig')");
  const reviewerChecks = calls().length;
  as('admin', 'p9-staff');
  const checkCases = [
    !healthError,
    igRow.includes("studioHealthCheckComments('spg_ig')") && text(igRow).includes('Check recent comments now') && igRowAr.includes('افحص التعليقات الأخيرة الآن')
      && text(igRow).includes('Once a minute per account') && !fbRow.includes('studioHealthCheckComments'),
    checkInFlight === 1 && checkCalls.length === 1 && checkCalls[0].method === 'POST' && JSON.stringify(checkCalls[0].body) === '{}',
    checkGood.tone === 'emerald' && String(checkGood.text).startsWith('Read 12 comments: 3 new, 2 answered, 9 skipped') && text(checkGoodRow).includes('Read 12 comments: 3 new, 2 answered, 9 skipped'),
    checkStoppedAr.tone === 'amber' && String(checkStoppedAr.text).includes('قُرئ 4 تعليقاً: 1 جديدة، و0 رُدّ عليها، و3 تُخطّيت') && String(checkStoppedAr.text).includes('توقفت القراءة مبكراً')
      && String(checkStoppedAr.text).includes('طلبت ميتا من البيان الانتظار') && !String(checkStoppedAr.text).includes('rate_limited'),
    check429.text === 'This Instagram account was checked less than a minute ago. Try again in a minute.' && check429.tone === 'amber',
    check429Ar.text === 'فُحص حساب إنستغرام هذا قبل أقل من دقيقة. أعد المحاولة بعد دقيقة.',
    check409Ar.text === 'طلبت ميتا من البيان الانتظار، لذلك لم يُقرأ أي تعليق. أعد المحاولة بعد بضع دقائق.' && check409.text === 'This linked page is not an Instagram account',
    check404.text === 'This page is no longer linked.' && reviewerChecks === 0,
    healthFn('studioHealthCheckComments').split('} finally {', 2)[1].trimStart().startsWith('if (studioHealthGenerationIsCurrent(context))')
      && healthFn('studioHealthCheckComments').includes('/check-comments`') && !/\b(?:confirm|prompt|alert)\(/.test(health)
      && healthFn('studioHealthCheckErrorText').includes('adsStudioRefusalText(detail)') && healthFn('studioHealthCheckErrorText').includes('studioHealthEsc(text)')
  ];
  check('Studio health: admin "Check recent comments now" per Instagram account, counts and Meta error in EN/AR, 429/409 through the Arabic map', !loadError && checkCases.every(Boolean),
    loadError || healthError || `cases ${checkCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);
}

{
  // P2-01, P2-02a-d, P2-08 (Studio v2 core 15g + shell 15h): the real files run in a sandbox after 15c
  // (they reuse its helpers) with a fake browser history, fake timers and a scripted apiJson, next to
  // static checks against the stage fixture, the server's error codes, the built bundles and the CSS.
  // Promises settle before each run() returns (microtaskMode 'afterEvaluate').
  const vm = require('vm');
  const coreSrc = read('src/systems/ads_studio/15g-studio-core.js');
  const shellSrc = read('src/systems/ads_studio/15h-studio-shell.js');
  const fixture = JSON.parse(read('server/systems/ads_studio/stage_cases.json'));
  const errorsPy = read('server/systems/ads_studio/studio_errors.py');
  const who = { admin: false, staff: false, plan: true };
  const urlCalls = [];
  const navCalls = [];
  const memoryStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const win = {
    location: { pathname: '/studio', search: '', href: 'http://localhost/studio' },
    listeners: { popstate: [] },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const list = this.listeners[type] || []; const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage()  // this tab's
  };
  const hist = {
    entries: [], index: 0,
    get length() { return this.entries.length; },
    get state() { return this.entries[this.index] ? this.entries[this.index].state : null; },
    show() { const url = new URL(this.entries[this.index].url, 'http://localhost'); win.location.pathname = url.pathname; win.location.search = url.search; win.location.href = url.href; },
    reset(url, entryState = null) { this.entries = [{ url, state: entryState }]; this.index = 0; this.show(); },
    pushState(entryState, _title, url) { this.entries.splice(this.index + 1); this.entries.push({ url: String(url), state: JSON.parse(JSON.stringify(entryState)) }); this.index++; this.show(); },
    replaceState(entryState, _title, url) { this.entries[this.index] = { url: String(url || this.entries[this.index].url), state: JSON.parse(JSON.stringify(entryState)) }; this.show(); },
    go(delta) {
      const next = this.index + delta;
      if (!delta || next < 0 || next >= this.entries.length) return;
      this.index = next; this.show();
      for (const fn of [...win.listeners.popstate]) fn({ state: this.state });
    },
    back() { this.go(-1); }
  };
  win.history = hist;
  const box = vm.createContext({
    state: { language: 'en', theme: 'light', currentUser: { id: 'v2-user' }, currentView: 'ads-studio', adCampaignRequests: [] },
    Security: { escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') },
    window: win, history: hist, URLSearchParams, URL,
    isServerModeEnabled: () => true,
    isCurrentUserAdmin: () => who.admin,
    currentUserHasPermission: (collection, action) => who.staff || action !== 'review',
    hasSubscription: id => who.plan && id === 'ad_maker',
    updateUrlParams: (params, replace) => { urlCalls.push({ params: JSON.parse(JSON.stringify(params)), replace: !!replace }); },
    requestViewScrollReset: () => {},
    navigateTo: view => { navCalls.push(String(view)); },
    IS_STUDIO_SHELL: true
  }, { microtaskMode: 'afterEvaluate' });
  let loadError = '';
  try {
    const at = forms.indexOf('function normalizeDigitsAscii(');
    vm.runInContext(forms.slice(at, forms.indexOf('\n}\n', at) + 2), box);
    vm.runInContext(`
      var __calls = [];
      var __replies = Object.create(null);
      var __timers = new Map();
      var __timerSeq = 0;
      var __html = '';
      var __navType = 'navigate';
      var __navName = '';
      var _lastRenderedView = null;  // 12-views.js: the view the last full draw showed (never set by this sandbox's render)
      var performance = { now: () => 100, getEntriesByType: () => [{ type: __navType, name: __navName }] };
      var document = { visibilityState: 'visible', __listeners: [], addEventListener(type, fn) { if (type === 'visibilitychange') this.__listeners.push(fn); }, removeEventListener() {} };
      function setTimeout(fn, ms) { const id = ++__timerSeq; __timers.set(id, { fn, ms: Number(ms) || 0 }); return id; }
      function clearTimeout(id) { __timers.delete(id); }
      function __runTimers() { const due = Array.from(__timers.entries()); __timers.clear(); due.forEach(([, t]) => t.fn()); }
      function __setVisible(visible) { document.visibilityState = visible ? 'visible' : 'hidden'; document.__listeners.forEach(fn => fn()); }
      function getUrlParams() { return { tab: new URLSearchParams(window.location.search).get('tab') }; }
      function apiJson(path, options) {
        __calls.push({ path: String(path), method: String((options && options.method) || 'GET') });
        const next = (__replies[path] || []).shift();
        if (!next) return new Promise(() => {});
        if (next.error) return Promise.reject(Object.assign(new Error(next.error.message || 'Request failed'), next.error));
        return Promise.resolve(JSON.parse(JSON.stringify(next.value)));
      }
      // The router's own popstate listener (registered at start-up, before any the studio adds).
      window.addEventListener('popstate', () => { restoreAdsStudioTabFromUrl(); render(); });
    `, box);
    vm.runInContext(adsStudio, box);
    vm.runInContext(coreSrc, box);
    vm.runInContext(shellSrc, box);
    // renderAdsStudioView's first lines (checked below), without the classic body and its data.
    vm.runInContext("function render() { const html = renderStudioV2View(); __html = html || '<classic>'; }", box);
  } catch (error) { loadError = String(error && error.message || error); }
  const run = code => { try { return vm.runInContext(code, box); } catch (error) { return `THREW ${error && error.message}`; } };
  const json = code => { try { return JSON.parse(String(run(`JSON.stringify(${code})`))); } catch (_) { return undefined; } };
  const inLanguage = (language, code) => { box.state.language = language; const out = run(code); box.state.language = 'en'; return out; };
  const html = () => String(run('__html'));
  const search = () => win.location.search;
  const meReply = value => run(`studioResetMe(); __replies['/api/studio/me'] = [{ value: ${JSON.stringify(value)} }]; studioLoadMe();`);
  // A freshly opened page: `url` is the address after the start-up rewrite, `opened` the one it was opened with.
  // The tab's sessionStorage stays (a reload keeps it); the page's own memory starts empty.
  const openAt = (url, navType = 'navigate', entryState = null, opened = '') => {
    hist.reset(url, entryState);
    run(`_studioV2.docRendered = false; _studioV2.layout = null; _studioV2.fromApp = false; _studioV2.popping = false; _studioV2.repin = false; _studioV2.opening = null; _studioV2.reapplied = false; _studioV2.enteredAt = 0; _studioV2.openedAt = 0;
      __navType = ${JSON.stringify(navType)}; __navName = ${JSON.stringify(opened ? `http://localhost${opened}` : '')}; render();`);
  };
  const chainOf = entry => (entry && entry.state && entry.state.studioV2 && entry.state.studioV2.chain) || null;
  const failed = cases => cases.map((ok, i) => ok ? '' : i).filter(String).join(',');

  // Core, then shell, then only v2 screen files (15j and later plug into the shell).
  const v2Lazy = bundleManifestJson.lazy['studio.js'].slice(bundleManifestJson.lazy['studio.js'].indexOf('systems/ads_studio/15g-studio-core.js'));
  check('Studio v2 files ship last in the lazy studio bundle (core before shell) and renderAdsStudioView delegates first',
    JSON.stringify(v2Lazy.slice(0, 2)) === JSON.stringify(['systems/ads_studio/15g-studio-core.js', 'systems/ads_studio/15h-studio-shell.js'])
      && v2Lazy.every(file => /^systems\/ads_studio\/15[g-z]0?-studio-[a-z-]+\.js$/.test(file))
      && bundleManifestJson.lazy['studio.js'][0] === 'systems/ads_studio/15c-ads-studio.js' && !bundleManifestJson.files.some(file => /15[gh]-studio/.test(file))
      && adsStudio.includes("function renderAdsStudioView() {\n  // Studio v2 (P2-02a, 15h-studio-shell.js): only when GET /api/studio/me says so; '' = the classic screens below.\n  const studioV2Html = typeof renderStudioV2View === 'function' ? renderStudioV2View() : '';\n  if (studioV2Html) return studioV2Html;\n  const isAr = adsStudioIsAr();"),
    loadError);

  // P2-01 stage consumer: the client's stage list, looks and flag words equal the server fixture's tables.
  const tableStages = Object.keys(fixture.tables.stages).map(Number).sort((a, b) => a - b).map(n => fixture.tables.stages[String(n)]);
  const clientKeys = json('STUDIO_STAGE_KEYS') || [];
  const looks = json('STUDIO_STAGE_LOOK') || {};
  const clientFlags = json('STUDIO_STAGE_FLAGS') || {};
  const fixtureActions = new Set(tableStages.flatMap(stage => stage.actions).concat(fixture.cases.flatMap(c => (c.expect && c.expect.actions) || [])));
  const caseViews = fixture.cases.filter(c => c.expect && c.expect.stageKey).map(c => {
    const linked = c.expect.linked !== undefined ? c.expect.linked : /^\d+$/.test(String(c.request.metaCampaignId || ''));
    const raw = { stage: c.expect.stage, stageKey: c.expect.stageKey, linked, metaUsedMinor: c.expect.metaUsedMinor, actions: c.expect.actions, tracker: c.expect.tracker };
    const view = json(`studioStageView(${JSON.stringify(raw)})`) || {};
    return view.key === c.expect.stageKey && view.stage === c.expect.stage
      && (c.expect.metaUsedMinor === undefined || view.metaUsedMinor === c.expect.metaUsedMinor)
      && (!c.expect.actions || JSON.stringify(view.actions) === JSON.stringify(c.expect.actions));
  });
  const running = tableStages[7];
  const serverShaped = { stage: 8, stageKey: 'running', labels: { en: running.en, ar: running.ar }, money: fixture.tables.money[running.money], linked: true, metaUsedMinor: 1234, stopRequested: true, actions: ['ask_to_stop', 'ask', 'launch_rocket'], tracker: { step: 'running', side: false } };
  const runningEn = json(`studioStageView(${JSON.stringify(serverShaped)})`) || {};
  box.state.language = 'ar';
  const runningAr = json(`studioStageView(${JSON.stringify(serverShaped)})`) || {};
  box.state.language = 'en';
  const unlinked = json(`studioStageView(${JSON.stringify({ ...serverShaped, stage: 4, stageKey: 'approved_setup', linked: false })})`) || {};
  const newer = json(`studioStageView(${JSON.stringify({ stage: 14, stageKey: 'future_stage', labels: { en: 'Something new', ar: 'شيء جديد' } })})`) || {};
  const stageCases = [
    JSON.stringify(clientKeys) === JSON.stringify(tableStages.map(stage => stage.key)),
    tableStages.every(stage => looks[stage.key] && looks[stage.key][0] === stage.tone && looks[stage.key][1] === stage.icon && typeof looks[stage.key][2] === 'string'),
    Object.keys(fixture.tables.flags).length === Object.keys(clientFlags).length
      && Object.entries(fixture.tables.flags).every(([flag, words]) => clientFlags[flag] && clientFlags[flag][0] === words.en && clientFlags[flag][1] === words.ar),
    [...fixtureActions].every(action => (json('STUDIO_STAGE_ACTIONS') || []).includes(action))
      && tableStages.every(stage => (json('STUDIO_STAGE_TRACKER') || []).includes(stage.tracker)),
    caseViews.length >= 40 && caseViews.every(Boolean),
    runningEn.label === running.en && runningAr.label === running.ar && runningEn.metaUsedMinor === 1234 && runningEn.icon === 'play' && runningEn.tone === 'green'
      && JSON.stringify(runningEn.actions) === '["ask_to_stop","ask"]' && runningEn.flags.length === 1 && runningEn.flags[0].text === fixture.tables.flags.stopRequested.en
      && runningAr.flags[0].text === fixture.tables.flags.stopRequested.ar && runningEn.money === fixture.tables.money.paid_running.en,
    unlinked.metaUsedMinor === null,
    newer.known === false && newer.key === '' && newer.label === 'Something new' && newer.tone === 'slate' && run('studioStageView(null)') === null
  ];
  check('Studio v2 stage consumer: stage keys, looks and flags equal stage_cases.json; server labels in EN/AR; no "Meta used" before a link', !loadError && stageCases.every(Boolean),
    loadError || `cases ${failed(stageCases)}`);

  // P2-01 money and typed input.
  const lydEn = [0, 5000, 123456, -250].map(v => String(run(`studioLyd(${v})`)));
  const lydAr = [0, 5000, 123456].map(v => String(inLanguage('ar', `studioLyd(${v})`)));
  const moneyCases = [
    run('studioUsd(123456)') === '$1,234.56', run('studioUsd(-500)') === '-$5.00', run('studioUsd(0)') === '$0.00', run('studioUsd(123456789)') === '$1,234,567.89',
    run("studioUsd('x')") === '—', run('studioUsd(1.5)') === '—', run("studioUsd('2500')") === '$25.00',
    lydEn[1] === '50.00 LYD' && lydEn[2] === '1,234.56 LYD' && lydEn[3] === '-2.50 LYD' && lydAr[1] === '50.00 د.ل',
    lydEn.concat(lydAr).every(text => !text.includes('$')),
    run("studioLtr('-$5.00')") === '<bdi dir="ltr">-$5.00</bdi>'
  ];
  check('Studio v2 money: USD grouped with "$", LYD in LYD / د.ل and never "$"', !loadError && moneyCases.every(Boolean), loadError || `cases ${failed(moneyCases)}`);

  const amount = raw => run(`studioParseAmount(${JSON.stringify(raw)})`);
  const amountCases = [
    ['٥٠', 5000], ['50', 5000], ['$ 40', 4000], ['40$', 4000], ['12٫5', 1250], ['12,5', 1250], ['12.50', 1250], ['1,250', 125000],
    ['1٬250٫75', 125075], ['١٬٢٥٠', 125000], ['12,345', 1234500], [' 7.5 ', 750], ['0', 0], ['.5', 50], ['١٢٣٤', 123400]
  ].map(([raw, want]) => amount(raw) === want);
  const badAmounts = ['', 'abc', '-5', '+5', '1.234', '1,2345', '12..5', '5 5 5 5 5 5 5 5 5 5 5 5 5 5', null, '1e5'].map(raw => Number.isNaN(amount(raw)));
  const phone = raw => run(`studioParsePhone(${JSON.stringify(raw)})`);
  const phoneCases = [
    ['0912345678', '+218912345678'], ['٠٩١٢٣٤٥٦٧٨', '+218912345678'], ['+218 91 234 5678', '+218912345678'], ['00218912345678', '+218912345678'],
    ['218912345678', '+218912345678'], ['912345678', '+218912345678'], ['+2180912345678', '+218912345678'], ['(091) 234-5678', '+218912345678'],
    ['021-3333333', '+218213333333'], ['+44 20 7946 0958', '+442079460958'], ['0021 612 345 678', '+21612345678']
  ].map(([raw, want]) => phone(raw) === want);
  const badPhones = ['12345', '+218123', '+2181234567890', 'abc', '', '+0123456789', '091234567890123', null, '0912-345-67a'].map(raw => phone(raw) === '');
  check('Studio v2 parsers: amounts (Arabic digits, ٫ and , decimals, thousands) and phones (E.164, Libyan forms) through the classic parser', !loadError
    && amountCases.every(Boolean) && badAmounts.every(Boolean) && phoneCases.every(Boolean) && badPhones.every(Boolean)
    && coreSrc.includes('adsStudioParseMoneyMinor(text)') && coreSrc.includes('normalizeDigitsAscii(String(raw))'),
  loadError || `amounts ${failed(amountCases)} bad ${failed(badAmounts)} phones ${failed(phoneCases)} bad ${failed(badPhones)}`);

  // P2-01 / P2-11 error map: every studio code has EN + AR; the classic prefixes come from the classic map
  // (reused, never copied); 429 by its status; the Arabic fallback is never raw English.
  const serverCodes = [...((errorsPy.match(/STUDIO_ERROR_CODES: dict\[str, int\] = \{([\s\S]*?)\n\}/) || [])[1] || '').matchAll(/"([A-Z_]+)": (\d{3})/g)].map(m => m[1]);
  const clientTexts = json('STUDIO_ERROR_TEXTS') || {};
  const info = (error, kind = 'action', language = 'en') => {
    box.state.language = language;
    const out = json(`studioErrorInfo(Object.assign(new Error(${JSON.stringify(error.message || 'Request failed')}), ${JSON.stringify(error)}), ${JSON.stringify(kind)})`) || {};
    box.state.language = 'en';
    return out;
  };
  const latin = /[A-Za-z]/;
  const walletRefusal = 'Insufficient wallet balance: this request needs $50.00';
  const e429 = info({ status: 429, message: 'Rate limited. Try again in 60 seconds.', retryAfter: 60 });
  const e429b = info({ status: 429, message: JSON.stringify({ code: 'RATE_LIMITED', message: 'x' }), retryAfter: 120 });
  const e429bAr = info({ status: 429, message: 'Rate limited. Try again in 120 seconds.', retryAfter: 120 }, 'action', 'ar');
  const conflict = { status: 409, message: 'x', payload: { detail: { code: 'VERSION_CONFLICT', message: 'Reload' } } };
  const newCode = { status: 409, message: 'x', payload: { detail: { code: 'SOMETHING_NEW', message: 'A brand new refusal' } } };
  const classic = { status: 409, message: walletRefusal, payload: { detail: walletRefusal } };
  const unknownPlain = { status: 409, message: 'A refusal nobody translated yet', payload: { detail: 'A refusal nobody translated yet' } };
  const errorCases = [
    serverCodes.length >= 16 && serverCodes.every(code => Array.isArray(clientTexts[code]) && clientTexts[code][0] && /[؀-ۿ]/.test(clientTexts[code][1])),
    e429.code === 'RATE_LIMITED' && e429.text === 'Too many requests. Please wait a minute and try again.'
      && e429b.text === 'Too many requests. Please wait 2 minutes and try again.' && e429bAr.text === 'طلبات كثيرة. انتظر دقيقتين ثم أعد المحاولة.',
    info(conflict).text === clientTexts.VERSION_CONFLICT[0] && info(conflict, 'action', 'ar').text === clientTexts.VERSION_CONFLICT[1],
    info(newCode).text === 'The action could not be completed. Nothing changed in your balance.' && info(newCode, 'action', 'ar').text === 'تعذّر إتمام العملية. لم يتغير شيء في رصيدك.',
    info(classic, 'action', 'ar').text === inLanguage('ar', `adsStudioRefusalText(${JSON.stringify(walletRefusal)})`) && !latin.test(info(classic, 'action', 'ar').text)
      && info(classic).text === walletRefusal,
    !latin.test(info(unknownPlain, 'action', 'ar').text) && info(unknownPlain, 'read', 'ar').text === 'تعذّر التحميل. أعد المحاولة بعد لحظات.',
    info({ status: 401, message: 'Not authenticated' }).code === 'SESSION_ENDED' && info({ status: 401, message: 'x' }, 'read', 'ar').text === clientTexts.SESSION_ENDED[1],
    info({ status: 500, message: 'Internal Server Error' }).text.startsWith('We could not confirm whether this went through')
      && info({ status: 503, message: 'x' }, 'read').text === 'Albayan could not load this right now. Try again in a minute.',
    info({ name: 'TypeError', message: 'Failed to fetch' }).code === 'NETWORK' && info({ name: 'TypeError', message: 'Failed to fetch' }, 'read', 'ar').text === 'لا يوجد اتصال بالبيان. تحقّق من الإنترنت وأعد المحاولة.',
    info({ status: 422, message: 'body.amount: field required', payload: { detail: [{ loc: ['body', 'amount'], msg: 'field required' }] } }).code === 'INVALID_REQUEST',
    info({ status: 404, message: 'Not Found', payload: { detail: 'Not Found' } }).code === 'NOT_FOUND',
    (() => {
      run("__replies['/api/studio/test-fail'] = [{ error: { status: 409, message: 'x', payload: { detail: { code: 'NOT_LINKED', message: 'n' } } } }]; var __caught = null; studioApi('/api/studio/test-fail', { method: 'POST' }).catch(error => { __caught = error.studio; });");
      const caught = json('__caught') || {};
      return caught.code === 'NOT_LINKED' && caught.text === clientTexts.NOT_LINKED[0];
    })(),
    coreSrc.includes('adsStudioRefusalText(message)') && coreSrc.includes('adsStudioErrorInfo(error)')
      && !['Insufficient wallet balance', 'Only Submitted campaigns can be withdrawn', 'Conflict: record has changed'].some(prefix => coreSrc.includes(prefix) || shellSrc.includes(prefix)),
    // PLAN.md §7.3: the profile's own refusals, in the words the Account screen shows.
    serverCodes.includes('PHONE_INVALID') && serverCodes.includes('CONSENT_REQUIRED')
      && JSON.stringify(clientTexts.PHONE_INVALID) === JSON.stringify(['This is not a phone number we can use. Check it and try again.', 'هذا ليس رقماً صالحاً. راجعه وأعد المحاولة.'])
      && JSON.stringify(clientTexts.CONSENT_REQUIRED) === JSON.stringify(['Tick the box to allow us to contact you on WhatsApp.', 'ضع علامة في المربع لتسمح لنا بالتواصل معك على واتساب.'])
      && info({ status: 400, message: 'x', payload: { detail: { code: 'PHONE_INVALID', message: 'm' } } }, 'action', 'ar').text === clientTexts.PHONE_INVALID[1],
    // The older-route refusals the classic map does not carry: their own words, never raw English in Arabic.
    (() => {
      const limit = 'Ads Studio allows at most 50 open campaign requests per customer. Finish or delete an old request first.';
      const review = 'Submitted campaigns cannot be deleted while under review';
      const limitEn = info({ status: 409, message: limit, payload: { detail: limit } });
      const limitAr = info({ status: 409, message: limit, payload: { detail: limit } }, 'action', 'ar');
      const reviewEn = info({ status: 409, message: review, payload: { detail: review } });
      const reviewAr = info({ status: 409, message: review, payload: { detail: review } }, 'action', 'ar');
      return limitEn.text === 'You have too many open requests. Delete an old draft or wait for one to finish, then try again.' && limitEn.message === limit
        && /[؀-ۿ]/.test(limitAr.text) && !latin.test(limitAr.text) && limitAr.text !== info({ status: 409, message: 'nobody knows this' }, 'action', 'ar').text
        && reviewEn.text.includes('cannot be removed now') && /[؀-ۿ]/.test(reviewAr.text) && !latin.test(reviewAr.text);
    })(),
    // A read cut off by its timeout is a failure; only the app moving on (the navigation signal) cancels one.
    run("studioReadCancelled(Object.assign(new Error('aborted'), { name: 'AbortError' }), { aborted: true })") === true
      && run("studioReadCancelled(Object.assign(new Error('aborted'), { name: 'AbortError' }), { aborted: false })") === false
      && run("studioReadCancelled(Object.assign(new Error('aborted'), { name: 'AbortError' }), null)") === false
      && run("studioReadCancelled(new Error('Failed to fetch'), { aborted: true })") === false
  ];
  check('Studio v2 error map: every studio_errors.py code in EN/AR, classic prefixes reused, 429 by status, Arabic never falls back to raw English', !loadError && errorCases.every(Boolean),
    loadError || `cases ${failed(errorCases)}`);

  // P2-01 /me loader: in-flight join, maxAge, a failed re-read keeps the last reply, per user.
  let notified = 0;
  box.__onMe = () => { notified++; };
  run('studioMeSubscribe(__onMe); __calls.length = 0;');
  meReply({ ui: 'v2', staffDesk: 'v2', isStaff: false, isAdmin: false, services: { help: true, stopRequest: 'yes' }, intake: { open: false },
    contact: { whatsapp: '٠٩١٢٣٤٥٦٧٨', phone: '12', email: 'help@albayan.example' }, adLimits: { minTotalMinorUSD: 700 } });
  run('studioLoadMe(); studioLoadMe();');
  const meCallsJoined = json("__calls.filter(c => c.path === '/api/studio/me').length");
  const me1 = json('studioMe()') || {};
  run('studioLoadMe();');
  const meCallsFresh = json("__calls.filter(c => c.path === '/api/studio/me').length");
  run("__replies['/api/studio/me'] = [{ error: { status: 500, message: 'down' } }]; studioLoadMe(0);");
  const meAfterFailure = json('studioMe()') || {};
  const meCallsForced = json("__calls.filter(c => c.path === '/api/studio/me').length");
  box.state.currentUser = { id: 'other-user' };
  const otherBefore = run('studioMe()');
  run("__replies['/api/studio/me'] = [{ value: { ui: 'yes', staffDesk: 1, isStaff: 'true' } }]; studioLoadMe();");
  const other = json('studioMe()') || {};
  box.state.currentUser = { id: 'v2-user' };
  const meCases = [
    meCallsJoined === 1, me1.ui === 'v2' && me1.staffDesk === 'v2' && me1.isStaff === false, me1.services && me1.services.help === true && me1.services.stopRequest === false,
    me1.intakeOpen === false && me1.contact.whatsapp === '+218912345678' && me1.contact.phone === '' && me1.contact.email === 'help@albayan.example' && me1.adLimits.minTotalMinorUSD === 700,
    meCallsFresh === 1, meCallsForced === 2 && meAfterFailure.ui === 'v2', otherBefore === null && other.ui === 'classic' && other.staffDesk === 'classic' && other.isStaff === false,
    run('studioMe()') === null, notified >= 3,
    run("studioV2Frame()") === '' && coreSrc.includes("apiJson('/api/studio/me', { method: 'GET' })")
  ];
  check('Studio v2 /me loader: one read at a time, reuse within maxAge, failures keep the last reply, never another user\'s', !loadError && meCases.every(Boolean),
    loadError || `cases ${failed(meCases)}`);

  // P2-01 pulse poller hook: no timer while the tab is hidden, one read at a time, onChange on a change only.
  const changes = [];
  box.__onPulse = value => { changes.push(value); };
  run("__timers.clear(); __calls.length = 0; __replies['/api/studio/pulse'] = [{ value: { changedAt: 'a' } }, { value: { changedAt: 'a' } }, { value: { changedAt: 'b' } }]; studioPulseWatch('home', { path: '/api/studio/pulse', intervalMs: 30000, onChange: __onPulse });");
  const pulseFirstTimers = json('Array.from(__timers.values()).map(t => t.ms)');
  run('__runTimers();');  // each run lets the read settle and the next round get scheduled
  run('__runTimers();');
  run('__runTimers();');
  const pulseReads = json("__calls.filter(c => c.path === '/api/studio/pulse').length");
  const pulseNext = json('Array.from(__timers.values()).map(t => t.ms)');
  run('__setVisible(false);');
  const hiddenTimers = json('__timers.size');
  run('__runTimers();');
  const hiddenReads = json("__calls.filter(c => c.path === '/api/studio/pulse').length");
  run('__setVisible(true);');
  const visibleTimers = json('__timers.size');
  run("__runTimers(); var __w = _studioPulse.watches.get('home'); studioPulsePoll(__w); studioPulsePoll(__w);");
  const inFlightReads = json("__calls.filter(c => c.path === '/api/studio/pulse').length");
  run("studioPulseStop('home');");
  const stoppedTimers = json('__timers.size');
  const pulseCases = [
    JSON.stringify(pulseFirstTimers) === '[0]', pulseReads === 3 && JSON.stringify(changes) === '["b"]' && JSON.stringify(pulseNext) === '[30000]',
    hiddenTimers === 0 && hiddenReads === 3, visibleTimers === 1, inFlightReads === 4, stoppedTimers === 0 && run("_studioPulse.watches.size") === 0,
    run("typeof studioPulseWatch('bad', { path: 'https://evil.example/x', onChange: () => {} })") === 'function' && run('_studioPulse.watches.size') === 0,
    !/setInterval\(/.test(coreSrc + shellSrc)
  ];
  check('Studio v2 pulse hook: polls only while visible (no timer when hidden), one read at a time, change-only callback', !loadError && pulseCases.every(Boolean),
    loadError || `cases ${failed(pulseCases)}`);

  // P2-02a-d shell: the frame, nav, header, placeholders, focus mode, the staff desk and the Back model.
  run('__timers.clear();');
  meReply({ ui: 'v2', staffDesk: 'classic', isStaff: false });
  const customerTabs = ['home', 'campaigns', 'replies', 'wallet', 'help', 'inbox', 'account', 'builder', 'posts'];
  const screens = customerTabs.map(tab => { openAt(`/studio?tab=${tab}`); return { tab, html: html() }; });
  const allHtml = [];
  const screenCases = screens.map(({ tab, html: page }) => {
    allHtml.push(page);
    const nav = ['home', 'campaigns', 'replies', 'wallet', 'help'].every(id => page.includes(`data-testid="studio-nav-${id}"`));
    const current = (page.match(/aria-current="page"/g) || []).length;
    return page.includes('data-testid="studio-v2-frame"') && page.includes(`data-testid="studio-screen-${tab}"`) && nav
      && page.includes('Coming soon in the new studio') && current === (tab === 'builder' || tab === 'posts' ? 0 : 1)
      && (tab === 'builder' || tab === 'posts' || new RegExp(`data-testid="studio-nav-${tab}"[^>]*aria-current="page"`).test(page))
      && (tab === 'builder') === /data-testid="studio-nav"[^>]* hidden>/.test(page)
      && (tab === 'builder' ? page.includes('data-testid="studio-close"') && !page.includes('data-testid="studio-nav-inbox"')
        : page.includes('data-testid="studio-nav-inbox"') && page.includes('data-testid="studio-nav-account"'));
  });
  openAt('/studio?tab=dashboard');
  // The pinned 'dashboard' is Home; on Home with nothing behind it in the /studio site there is no Back.
  const dashboardAlias = html().includes('data-testid="studio-screen-home"') && /data-testid="studio-nav-home"[^>]*aria-current="page"/.test(html())
    && !html().includes('data-testid="studio-back"') && screens.find(s => s.tab === 'wallet').html.includes('data-testid="studio-back"');
  box.state.language = 'ar';
  openAt('/studio?tab=wallet');
  const walletAr = html();
  box.state.language = 'en';
  allHtml.push(walletAr);
  openAt('/studio?tab=review');
  const reviewAsCustomer = html().includes('data-testid="studio-screen-home"');
  who.plan = false;
  openAt('/studio?tab=home');
  const gate = html();
  who.plan = true;
  const shellCases = [
    ...screenCases,
    dashboardAlias,
    walletAr.includes('dir="rtl"') && walletAr.includes('قريباً في الاستوديو الجديد') && walletAr.includes('data-lucide="arrow-right"') && walletAr.includes('المحفظة'),
    reviewAsCustomer,
    gate.includes('Activate Ads Studio') && !screens[0].html.includes('Activate Ads Studio'),
    screens.find(s => s.tab === 'account').html.includes('data-testid="studio-basics"') && screens.find(s => s.tab === 'account').html.includes('handleLogout()')
  ];
  check('Studio v2 frame: bottom nav + header (bell, account), one active tab, bilingual placeholders in every screen root, builder focus mode, RTL', !loadError && shellCases.every(Boolean),
    loadError || `cases ${failed(shellCases)}`);

  // The screen registry: a screen file registers the body of its tab; the shell keeps the root, and the
  // placeholder when a draw fails. Only the shell's own tabs (the builder included) take a screen.
  const registryCases = [
    run(`studioV2RegisterScreen('help', route => '<p data-testid="x-help">' + studioEsc(route.section || 'none') + '</p>')`) === true,
    run("studioV2RegisterScreen('nope', () => '')") === false && run("studioV2RegisterScreen('wallet', 'not a function')") === false,
    run(`studioV2RegisterScreen('builder', route => '<p data-testid="x-builder">' + route.section + ' ' + route.step + '</p>')`) === true
  ];
  openAt('/studio?tab=help&section=faq');
  const registered = html();
  run("studioV2RegisterScreen('help', () => { throw new Error('broken screen'); });");
  openAt('/studio?tab=help');
  const brokenScreen = html();
  openAt('/studio?tab=builder&section=boost&step=2');
  const builderScreen = html();
  run("_studioV2Screens.delete('help'); _studioV2Screens.delete('builder');");
  openAt('/studio?tab=builder&section=boost&step=2');
  const builderPlaceholder = html();
  registryCases.push(
    /<section data-testid="studio-screen-help" class="studio-v2-screen" aria-labelledby="studio-v2-title" data-section="faq"><p data-testid="x-help">faq<\/p>/.test(registered)
      && !registered.includes('Coming soon'),
    brokenScreen.includes('data-testid="studio-screen-help"') && brokenScreen.includes('Coming soon in the new studio') && !brokenScreen.includes('x-help'),
    builderScreen.includes('<p data-testid="x-builder">boost 2</p>') && /data-testid="studio-nav"[^>]* hidden>/.test(builderScreen) && !builderScreen.includes('Coming soon'),
    builderPlaceholder.includes('Step 2 of 3: Budget &amp; days') && builderPlaceholder.includes('Coming soon in the new studio'),
    !/renderStudioV2CustomerScreen\s*=|renderStudioV2Builder\s*=/.test(shellSrc)
  );
  check('Studio v2 screen registry: a registered body draws inside the shell\'s own root (the builder too); a failing draw or an unknown tab keeps the placeholder',
    !loadError && registryCases.every(Boolean), loadError || `cases ${failed(registryCases)}`);

  // Back model through the history (PLAN.md §5.1).
  openAt('/studio?tab=home');
  const homeChain = chainOf(hist.entries[0]);
  run("studioV2Open('wallet');");
  const afterWallet = { length: hist.length, index: hist.index, search: search(), active: /data-testid="studio-nav-wallet"[^>]*aria-current="page"/.test(html()), classicTab: run('_adsStudioActiveTab') };
  run("studioV2Open('help');");
  const afterHelp = { length: hist.length, search: search() };
  run('studioV2Back();');
  const backHome = { index: hist.index, search: search(), screen: html().includes('data-testid="studio-screen-home"') };
  run("studioV2Open('builder'); studioV2BuilderStep(1); studioV2BuilderStep(1);");
  const atStep3 = { length: hist.length, search: search(), focus: /data-testid="studio-nav"[^>]* hidden>/.test(html()), step: html().includes('Step 3 of 6: Content') };
  run('studioV2Back();');
  const atStep2 = search();
  run('history.back();');
  const atStep1 = search();
  run('studioV2CloseBuilder();');
  const closed = { index: hist.index, search: search() };
  const homeParent = run("studioV2Parent({ tab: 'home', section: '', id: '', step: 0 }, 'customer')");
  const handledOnHome = run('studioHandleBack()');
  openAt('/studio?tab=campaigns&id=req_1');
  const deep = { length: hist.length, index: hist.index, chains: hist.entries.map(chainOf), detail: html().includes('data-testid="studio-screen-campaigns"') && html().includes('data-id="req_1"') };
  run("studioV2Open('wallet');");
  const lateral = { index: hist.index, search: search(), below: hist.entries[0].url };
  const handledOnWallet = run('studioHandleBack()');
  const afterHandled = search();
  // A reload (or a return through history) trusts the entries under the screen only with this tab's
  // proof of the same screen and chain (sessionStorage); without it the path is rebuilt like a link.
  const proofKey = 'albayan.studio.v2.history';
  const lastProof = win.sessionStorage.getItem(proofKey);
  openAt('/studio?tab=wallet', 'reload', { view: 'ads-studio' });  // the tab last drew Home
  const reloadedUnproven = { length: hist.length, index: hist.index, chains: hist.entries.map(chainOf), search: search() };
  win.sessionStorage.removeItem(proofKey);
  openAt('/studio?tab=help', 'back_forward', { view: 'ads-studio' });  // no proof at all
  const returnedUnproven = { length: hist.length, chains: hist.entries.map(chainOf) };
  openAt('/studio?tab=home');
  run("studioV2Open('wallet');");  // the tab draws Wallet over Home: its proof
  const proofWallet = win.sessionStorage.getItem(proofKey);
  openAt('/studio?tab=wallet', 'reload', { view: 'ads-studio' });
  const reloaded = { length: hist.length, chain: chainOf(hist.entries[0]) };
  win.sessionStorage.setItem(proofKey, JSON.stringify({ chain: ['home|||', 'wallet|||'], url: '/studio?tab=help' }));
  openAt('/studio?tab=wallet', 'back_forward', { view: 'ads-studio' });  // proof of another address
  const otherAddress = hist.length;
  openAt('/studio?tab=builder', 'navigate', null, '/studio?tab=builder&step=3');
  const openedStep = { search: search(), length: hist.length };
  openAt('/studio', 'navigate', null, '/studio?tab=campaigns&id=req_9');
  const openedLost = search();
  openAt('/studio?tab=wallet', 'navigate', null, '/studio?tab=help&id=t_1');
  const openedMoved = search();
  hist.reset('/studio?tab=home');
  run("__navName = 'http://localhost/studio?tab=wallet'; render();");
  const notTwice = search();
  openAt('/studio?tab=home');
  run("setAdsStudioTab('campaigns');");
  const setterV2 = { search: search(), length: hist.length };
  run("setAdsStudioTab('nope');");
  const setterIgnored = search();
  run("setAdsStudioTab('dashboard');");
  const setterHome = { search: search(), index: hist.index };
  const backCases = [
    JSON.stringify(homeChain) === '["home|||"]',
    afterWallet.length === 2 && afterWallet.index === 1 && afterWallet.search === '?tab=wallet' && afterWallet.active && afterWallet.classicTab === 'wallet',
    afterHelp.length === 2 && afterHelp.search === '?tab=help',
    backHome.index === 0 && backHome.search === '?tab=home' && backHome.screen,
    atStep3.length === 4 && atStep3.search === '?tab=builder&step=3' && atStep3.focus && atStep3.step,
    atStep2 === '?tab=builder&step=2' && atStep1 === '?tab=builder&step=1',
    closed.index === 0 && closed.search === '?tab=home',
    homeParent === null && handledOnHome === false,
    deep.length === 3 && deep.index === 2 && deep.detail && JSON.stringify(deep.chains) === JSON.stringify([['home|||'], ['home|||', 'campaigns|||'], ['home|||', 'campaigns|||', 'campaigns||req_1|']]),
    lateral.index === 1 && lateral.search === '?tab=wallet' && lateral.below === '/studio?tab=home',
    handledOnWallet === true && afterHandled === '?tab=home',
    reloaded.length === 1 && JSON.stringify(reloaded.chain) === '["home|||","wallet|||"]'
      && proofWallet === JSON.stringify({ chain: ['home|||', 'wallet|||'], url: '/studio?tab=wallet' }) && lastProof === JSON.stringify({ chain: ['home|||'], url: '/studio?tab=home' })
      && reloadedUnproven.length === 2 && reloadedUnproven.index === 1 && reloadedUnproven.search === '?tab=wallet'
      && JSON.stringify(reloadedUnproven.chains) === JSON.stringify([['home|||'], ['home|||', 'wallet|||']])
      && returnedUnproven.length === 2 && JSON.stringify(returnedUnproven.chains) === JSON.stringify([['home|||'], ['home|||', 'help|||']]) && otherAddress === 2,
    openedStep.search === '?tab=builder&step=3' && openedStep.length === 4 && openedLost === '?tab=campaigns&id=req_9'
      && openedMoved === '?tab=wallet' && notTwice === '?tab=home',
    setterV2.search === '?tab=campaigns' && setterV2.length === 2 && setterIgnored === '?tab=campaigns' && setterHome.search === '?tab=home' && setterHome.index === 0
  ];
  check('Studio v2 Back model: builder step N -> N-1, detail -> list, tabs -> Home, Home leaves; history mirrors the chain; links get their parents', !loadError && backCases.every(Boolean),
    loadError || `cases ${failed(backCases)}`);

  // P2-02d Team desk frame, the classic fallback, the wait state and the pinned setter/restore.
  meReply({ ui: 'classic', staffDesk: 'v2', isStaff: true, isAdmin: false });
  openAt('/studio?tab=review', 'navigate', null, '/studio?tab=review&section=launch');  // after the start-up rewrite
  const staffEn = html();
  const staffChain = hist.entries.map(chainOf);
  box.state.language = 'ar';
  run('render();');
  const staffAr = html();
  box.state.language = 'en';
  allHtml.push(staffEn, staffAr);
  const staffBack = run('studioHandleBack()');
  const staffAfterBack = search();
  const staffOnHome = run('studioHandleBack()');
  openAt('/studio?tab=wallet');
  const staffWallet = html();
  meReply({ ui: 'v2', staffDesk: 'v2', isStaff: false });
  const notStaff = run('studioV2Frame()');
  meReply({ ui: 'classic', staffDesk: 'classic', isStaff: false });
  run("_adsStudioActiveTab = 'wallet';");
  hist.reset('/studio?tab=wallet');
  urlCalls.length = 0;
  const classicAnswer = run('renderStudioV2View()');
  const classicFix = { tab: run('_adsStudioActiveTab'), url: JSON.stringify(urlCalls) };
  urlCalls.length = 0;
  run("setAdsStudioTab('campaigns');");
  const classicSetter = JSON.stringify(urlCalls);
  // The address restore maps the v2-only tabs (wallet, help, inbox, account, home) only in the v2
  // layout; with /me classic, on its way or failed, classic keeps its own rule (the tab on screen stays).
  const restoreAt = url => { hist.reset(url); run("_adsStudioActiveTab = 'posts'; restoreAdsStudioTabFromUrl();"); return run('_adsStudioActiveTab'); };
  const restoredClassicMe = ['wallet', 'home', 'account', 'campaigns'].map(tab => restoreAt(`/studio?tab=${tab}`));
  run("studioResetMe(); __replies['/api/studio/me'] = []; studioLoadMe();");
  const restoredPending = ['wallet', 'help', 'inbox', 'home'].map(tab => restoreAt(`/studio?tab=${tab}`));
  run("studioResetMe(); __replies['/api/studio/me'] = [{ error: { status: 503, message: 'down' } }]; studioLoadMe();");
  const restoredFailed = ['wallet', 'home'].map(tab => restoreAt(`/studio?tab=${tab}`));
  meReply({ ui: 'v2', staffDesk: 'classic', isStaff: false });
  const restoredV2 = ['wallet', 'home', 'campaigns'].map(tab => restoreAt(`/studio?tab=${tab}`));
  meReply({ ui: 'classic', staffDesk: 'classic', isStaff: false });
  run("studioResetMe(); __replies['/api/studio/me'] = []; window.localStorage.setItem('albayan.studio.v2.layout.v2-user', 'customer'); _studioV2.waitFor = '';");
  const waiting = String(run('renderStudioV2View()'));
  run("window.localStorage.removeItem('albayan.studio.v2.layout.v2-user'); _studioV2.waitFor = '';");
  const notWaiting = run('renderStudioV2View()');
  box.isServerModeEnabled = () => false;
  run('studioResetMe();');
  const localMode = run('renderStudioV2View()');
  box.isServerModeEnabled = () => true;
  const onclicks = allHtml.join('\n').match(/onclick="[^"]*"/g) || [];
  const wallet = /wallet|المحفظة|payment|الدفع/i;
  const staffCases = [
    staffEn.includes('data-testid="studio-staff-frame"') && !staffEn.includes('data-testid="studio-v2-frame"')
      && ['requests', 'launch', 'settle', 'tickets', 'health', 'more'].every(id => staffEn.includes(`data-testid="studio-staffnav-${id}"`))
      && /data-testid="studio-staffnav-launch"[^>]*aria-current="page"/.test(staffEn) && (staffEn.match(/aria-current="page"/g) || []).length === 1
      && staffEn.includes('data-testid="studio-screen-review"') && staffEn.includes('data-testid="studio-staff-screen-launch"') && staffEn.includes('Coming soon in the new studio'),
    !wallet.test(staffEn.replace(/data-lucide="[^"]*"/g, '')) && !wallet.test(staffAr.replace(/data-lucide="[^"]*"/g, '')) && !staffEn.includes('studio-nav-wallet') && staffAr.includes('مكتب الفريق'),
    JSON.stringify(staffChain) === JSON.stringify([['review|requests||'], ['review|requests||', 'review|launch||']]),
    staffBack === true && staffAfterBack === '?tab=review&section=requests' && staffOnHome === false,
    staffWallet.includes('data-testid="studio-staff-screen-requests"'),
    notStaff === 'customer',
    classicAnswer === '' && classicFix.tab === 'dashboard' && classicFix.url === JSON.stringify([{ params: { tab: 'dashboard', section: null, id: null, step: null }, replace: true }]),
    classicSetter === JSON.stringify([{ params: { tab: 'campaigns' }, replace: true }]),
    JSON.stringify(restoredClassicMe) === '["posts","posts","posts","campaigns"]' && JSON.stringify(restoredPending) === '["posts","posts","posts","posts"]'
      && JSON.stringify(restoredFailed) === '["posts","posts"]' && JSON.stringify(restoredV2) === '["wallet","dashboard","campaigns"]',
    waiting.includes('data-testid="studio-v2-loading"') && notWaiting === '' && localMode === '',
    onclicks.length > 20 && onclicks.every(attr => /^onclick="(studioV2(Open|OpenSection)\('[a-z]+'\)|studioV2(Back|CloseBuilder)\(\)|studioV2ChooseClassic\(true\)|studioV2BuilderStep\(1\)|toggleLanguage\(\)|toggleTheme\(\)|handleLogout\(\)|showSubscriptionModal\('ad_maker', 'ad_maker'\))"$/.test(attr)),
    !/\b(?:confirm|prompt|alert)\(/.test(coreSrc + shellSrc) && !/access_token|app_?secret|page_?token|Bearer /i.test(coreSrc + shellSrc)
  ];
  check('Studio v2 Team desk (no wallet items), classic when /me says classic or is unknown, pinned setter/restore in both layouts, safe handlers only', !loadError && staffCases.every(Boolean),
    loadError || `cases ${failed(staffCases)}`);

  // Rollout stage 2: a staff member whose /me says ui 'v2' but staffDesk 'classic' (the owner in the
  // customer allowlist while the Team desk is off) keeps the classic review tab (review and launch
  // queues, health) and, as an admin, the classic wallet (payment confirmations); the other tabs are v2.
  who.staff = true;
  const realUpdateUrlParams = box.updateUrlParams;
  meReply({ ui: 'v2', staffDesk: 'classic', isStaff: true, isAdmin: false });
  openAt('/studio?tab=review');
  const deskReview = { html: html(), tab: run('_adsStudioActiveTab'), shown: run('_studioV2.shown'), search: search() };
  openAt('/studio?tab=home');
  const deskHome = html();
  box.state.language = 'ar';
  run('render();');
  const deskHomeAr = html();
  box.state.language = 'en';
  run("studioV2Open('review');");  // the header's "Team desk" button
  const deskOpened = { html: html(), length: hist.length, index: hist.index, chain: chainOf(hist.entries[hist.index]), search: search() };
  // The classic tab bar's "Review Queue": the classic setter (it replaces the entry, which keeps its
  // place in the Back model); a later /me answer does not redraw; "Overview" goes back to v2 Home.
  box.updateUrlParams = (params, replace) => {
    urlCalls.push({ params: JSON.parse(JSON.stringify(params)), replace: !!replace });
    const query = new URLSearchParams(win.location.search);
    Object.entries(params).forEach(([key, value]) => (value === null || value === undefined || value === '' ? query.delete(key) : query.set(key, String(value))));
    const entry = { view: 'ads-studio', params, albayanModal: false };
    if (replace) hist.replaceState(entry, '', `${win.location.pathname}?${query}`); else hist.pushState(entry, '', `${win.location.pathname}?${query}`);
  };
  urlCalls.length = 0;
  run("setAdsStudioTab('review');");
  const deskSetter = { calls: JSON.stringify(urlCalls), chain: chainOf(hist.entries[hist.index]), html: html(), length: hist.length };
  run("__html = 'not drawn again'; studioMeNotify();");
  const deskOnMe = html();
  run("setAdsStudioTab('dashboard');");
  const deskToHome = { index: hist.index, search: search(), home: html().includes('data-testid="studio-screen-home"') };
  box.updateUrlParams = realUpdateUrlParams;
  openAt('/studio?tab=wallet');
  const deskReviewerWallet = html();
  meReply({ ui: 'v2', staffDesk: 'classic', isStaff: true, isAdmin: true });
  openAt('/studio?tab=wallet');
  const deskAdminWallet = { html: html(), tab: run('_adsStudioActiveTab'), wanted: run('studioV2Wanted()') };
  openAt('/studio?tab=campaigns');
  const deskAdminCampaigns = html();
  who.staff = false;
  meReply({ ui: 'v2', staffDesk: 'classic', isStaff: false, isAdmin: false });
  openAt('/studio?tab=review');
  const customerReview = html();
  const deskCases = [
    deskReview.html === '<classic>' && deskReview.tab === 'review' && deskReview.shown === 'desk-classic' && deskReview.search === '?tab=review',
    deskHome.includes('data-testid="studio-v2-frame"') && deskHome.includes('data-testid="studio-screen-home"')
      && /<button type="button" data-testid="studio-nav-review" class="studio-v2-icon-btn" onclick="studioV2Open\('review'\)" aria-label="Team desk"/.test(deskHome)
      && deskHomeAr.includes('aria-label="مكتب الفريق"'),
    deskOpened.html === '<classic>' && deskOpened.length === 2 && deskOpened.index === 1 && deskOpened.search === '?tab=review'
      && JSON.stringify(deskOpened.chain) === '["home|||","review|||"]',
    deskSetter.calls === JSON.stringify([{ params: { tab: 'review' }, replace: true }]) && JSON.stringify(deskSetter.chain) === '["home|||","review|||"]'
      && deskSetter.html === '<classic>' && deskSetter.length === 2,
    deskOnMe === 'not drawn again',
    deskToHome.index === 0 && deskToHome.search === '?tab=home' && deskToHome.home,
    deskReviewerWallet.includes('data-testid="studio-screen-wallet"'),
    deskAdminWallet.html === '<classic>' && deskAdminWallet.tab === 'wallet' && deskAdminWallet.wanted === 'desk-classic'
      && deskAdminCampaigns.includes('data-testid="studio-screen-campaigns"') && deskAdminCampaigns.includes('data-testid="studio-nav-review"'),
    customerReview.includes('data-testid="studio-screen-home"') && !customerReview.includes('studio-nav-review')
  ];
  check('Studio v2 staff with the Team desk off: classic review (queues, health) and admin payments, v2 elsewhere, a "Team desk" header button', !loadError && deskCases.every(Boolean),
    loadError || `cases ${failed(deskCases)}`);

  // /me after sign-out: a read that settles for a session that is gone frees its slot, and the
  // studio's session reset (15c) forgets /me, so the same user signing in again asks the server.
  run("studioResetMe(); __calls.length = 0; __replies['/api/studio/me'] = [{ value: { ui: 'v2' } }]; studioLoadMe(); state.currentUser = null;");
  box.state.currentUser = { id: 'v2-user' };
  const staleLoading = run('studioMeLoading()');
  run("__replies['/api/studio/me'] = [{ value: { ui: 'v2', staffDesk: 'classic' } }]; studioLoadMe();");
  const relogin = { reads: json("__calls.filter(c => c.path === '/api/studio/me').length"), me: json('studioMe()') };
  run("__replies['/api/studio/me'] = []; studioLoadMe(0);");  // a read on its way (it never answers)
  const beforeReset = json('[!!studioMe(), studioMeLoading(), studioMeSession()]') || [];
  run('resetAdsStudioSessionState();');
  const afterReset = json('[studioMe(), studioMeLoading(), studioMeSession()]') || [];
  const meSessionCases = [
    staleLoading === false,
    relogin.reads === 2 && relogin.me && relogin.me.ui === 'v2',
    beforeReset[0] === true && beforeReset[1] === true && afterReset[0] === null && afterReset[1] === false && afterReset[2] === beforeReset[2] + 1,
    adsStudio.includes("  if (typeof studioResetMe === 'function') studioResetMe();")
  ];
  check('Studio v2 /me after sign-out or expiry: a stale read frees its slot and the session reset forgets /me, so signing in again reads it', !loadError && meSessionCases.every(Boolean),
    loadError || `cases ${failed(meSessionCases)}`);

  // "Leave the studio" never trusts history.length: the browser's Back only when this visit came from
  // another screen of this app in this document; otherwise the studio's way out, or no button.
  // Home on an entry with `below` under it; `entered`: the draw before was another screen of the app
  // (12-views.js _lastRenderedView); `popping`: that draw is a Back/Forward return.
  const openBehind = (below, { entered = false, popping = false, entryState = { view: 'ads-studio' } } = {}) => {
    hist.entries = [{ url: below.url, state: below.state || null }, { url: '/studio?tab=home', state: entryState }];
    hist.index = 1;
    hist.show();
    run(`_studioV2.docRendered = false; _studioV2.layout = null; _studioV2.fromApp = false; _studioV2.popping = ${popping}; __navType = 'navigate';
      _lastRenderedView = ${entered ? "'smart-systems'" : 'null'}; render(); _lastRenderedView = null; _studioV2.popping = false;`);
    return { button: html().includes('data-testid="studio-back"'), fromApp: run('_studioV2.fromApp') };
  };
  const leave = () => { navCalls.length = 0; const left = run('studioV2Back()'); return { left, index: hist.index, nav: navCalls.slice() }; };
  const appScreen = { url: '/smart-systems', state: { view: 'smart-systems' } };
  meReply({ ui: 'v2', staffDesk: 'classic', isStaff: false });
  const shellOpen = openBehind({ url: 'https://elsewhere.example/' });  // the /studio site opened after another site
  const shellLeave = leave();
  box.IS_STUDIO_SHELL = false;
  who.admin = true;
  const directOpen = openBehind({ url: 'https://elsewhere.example/' });  // the app opened on the studio: the way out is Smart Systems
  const directLeave = leave();
  const appOpen = openBehind(appScreen, { entered: true });  // opened from another screen of the app (a push)
  const appLeave = leave();
  const returnOpen = openBehind(appScreen, { entered: true, popping: true });  // back into the studio through Forward
  const returnLeave = leave();
  const markedOpen = openBehind(appScreen, { entered: true, entryState: { view: 'ads-studio', studioV2: { chain: ['home|||'] } } });  // a studio entry again
  const markedLeave = leave();
  box.IS_STUDIO_SHELL = true;
  who.admin = false;
  const leaveCases = [
    shellOpen.button === false && shellLeave.left === false && shellLeave.index === 1 && shellLeave.nav.length === 0,
    directOpen.button === true && directOpen.fromApp === false && directLeave.left === true && directLeave.index === 1 && JSON.stringify(directLeave.nav) === '["smart-systems"]',
    appOpen.button === true && appOpen.fromApp === true && appLeave.left === true && appLeave.index === 0 && appLeave.nav.length === 0,
    returnOpen.fromApp === false && returnLeave.index === 1 && JSON.stringify(returnLeave.nav) === '["smart-systems"]',
    markedOpen.fromApp === false && markedLeave.index === 1 && JSON.stringify(markedLeave.nav) === '["smart-systems"]',
    !/history\.length/.test(shellSrc)
  ];
  check('Studio v2 "Leave the studio": Back only after an entry from this app in this document, else the way out or no button (never history.length)', !loadError && leaveCases.every(Boolean),
    loadError || `cases ${failed(leaveCases)}`);

  // Logging in AT a deep link: the platform's post-login route restore (12-views restoreRequestedViewAfterLogin ->
  // updateUrlForView) puts an unmarked entry with the bare ?tab= over the first v2 draw's marked one. The address
  // of that draw comes back once (studioV2ReapplyOpeningAddress): a bare same-tab address on an unmarked entry
  // within 15 s; the reader's own moves (marked), another tab, a bare opening and a late entry are left alone.
  const platformRestore = tab => { hist.pushState({ view: 'ads-studio' }, '', `/studio?tab=${tab}`); run('render();'); return { search: search(), html: html(), chain: chainOf(hist.entries[hist.index]) }; };
  who.staff = true;
  meReply({ ui: 'v2', staffDesk: 'v2', isStaff: true, isAdmin: false });
  openAt('/studio?tab=review&section=tickets');
  const deskFirst = { search: search(), html: html(), entries: hist.entries.length };
  const deskRestored = platformRestore('review');
  const deskAgain = platformRestore('review');  // a second platform entry: only once
  who.staff = false;
  meReply({ ui: 'v2', staffDesk: 'classic', isStaff: false });
  openAt('/studio?tab=campaigns&id=req_77');
  const adRestored = platformRestore('campaigns');
  openAt('/studio?tab=campaigns&id=req_78');
  const otherTab = platformRestore('wallet');  // the app went somewhere else
  openAt('/studio?tab=wallet');
  const bareOpening = platformRestore('wallet');  // nothing beyond the tab to bring back
  openAt('/studio?tab=campaigns&id=req_79');
  run("studioV2Go({ tab: 'campaigns' });");  // the reader's own move up: a marked entry
  const ownMove = { search: search(), chain: chainOf(hist.entries[hist.index]) };
  // A late platform entry: 20 s after the first v2 draw (the studio's own clock, Date.now), the address is left alone.
  openAt('/studio?tab=campaigns&id=req_80');
  run('var __realDateNow = Date.now; Date.now = () => __realDateNow() + 20000;');
  const late = platformRestore('campaigns');
  run('Date.now = __realDateNow;');
  // A slow sign-in: the page was opened long ago (performance.now 20 s) but the studio's first draw is now, so both the
  // reapply after the platform's push and the restore of the opening address keep the deep link.
  run('performance.now = () => 20000;');
  openAt('/studio?tab=campaigns&id=req_81');
  const slowLogin = platformRestore('campaigns');
  openAt('/studio?tab=campaigns', 'navigate', null, '/studio?tab=campaigns&id=req_82');
  const slowRestore = { search: search(), html: html() };
  run('performance.now = () => 100;');
  // Entered the studio long ago (enteredAt 20 s back) and only now the first v2 draw: the opening address is not brought back.
  hist.reset('/studio?tab=campaigns');
  run(`_studioV2.docRendered = false; _studioV2.layout = null; _studioV2.opening = null; _studioV2.reapplied = false; _studioV2.enteredAt = Date.now() - 20000; _studioV2.openedAt = 0;
    __navType = 'navigate'; __navName = 'http://localhost/studio?tab=campaigns&id=req_83'; render();`);
  const lateEntry = search();
  const deepLinkCases = [
    deskFirst.search === '?tab=review&section=tickets' && deskFirst.html.includes('data-section="tickets"') && deskFirst.entries === 2,
    deskRestored.search === '?tab=review&section=tickets' && deskRestored.html.includes('data-section="tickets"') && JSON.stringify(deskRestored.chain) === JSON.stringify(['review|requests||', 'review|tickets||']),
    deskAgain.search === '?tab=review' && deskAgain.html.includes('data-section="requests"'),
    adRestored.search === '?tab=campaigns&id=req_77' && adRestored.html.includes('data-id="req_77"'),
    otherTab.search === '?tab=wallet' && bareOpening.search === '?tab=wallet',
    ownMove.search === '?tab=campaigns' && Array.isArray(ownMove.chain),
    late.search === '?tab=campaigns' && !late.html.includes('data-id="req_80"'),
    slowLogin.search === '?tab=campaigns&id=req_81' && slowLogin.html.includes('data-id="req_81"'),
    slowRestore.search === '?tab=campaigns&id=req_82' && slowRestore.html.includes('data-id="req_82"'),
    lateEntry === '?tab=campaigns',
    shellSrc.includes('function studioV2ReapplyOpeningAddress()') && shellSrc.includes('if (frame) { studioV2RestoreOpeningAddress(); studioV2ReapplyOpeningAddress(); }')
      && shellSrc.includes('_studioV2.opening = { tab: route.tab, section: route.section, id: route.id, step: route.step || 0 };')
      && shellSrc.includes('if (!_studioV2.enteredAt) _studioV2.enteredAt = Date.now();') && shellSrc.includes('_studioV2.openedAt = Date.now();')
      && shellSrc.includes('if (!_studioV2.enteredAt || Date.now() - _studioV2.enteredAt >= STUDIO_V2_OPENING_WINDOW_MS) return;')
      && shellSrc.includes('if (!_studioV2.openedAt || Date.now() - _studioV2.openedAt >= STUDIO_V2_OPENING_WINDOW_MS) return;')
      && !shellSrc.includes('performance.now()')
  ];
  check('Studio v2 deep link through the login form: the platform\'s bare ?tab= entry after the first draw gets the opening section / id back once (same tab, unmarked entry, within 15 s of the studio\'s own first draw, never of the page\'s navigation start, so a slow sign-in keeps it); never the reader\'s own moves, another tab, a bare opening or a late entry',
    !loadError && deepLinkCases.every(Boolean), loadError || `cases ${failed(deepLinkCases)}`);

  // The replies and posts screens live in the lazy bundle studio-pages.js: without a registered screen the shell
  // asks the loader (studioBundleScreen, stubbed here) and shows what it returns inside the tab's own root; '' from
  // it (the bundle is here but its draw failed) keeps the placeholder.
  run("function studioBundleScreen(name) { return '<card ' + name + '>'; }");
  openAt('/studio?tab=replies');
  const lazyReplies = html();
  openAt('/studio?tab=posts');
  const lazyPosts = html();
  run("studioBundleScreen = function () { return ''; };");
  openAt('/studio?tab=replies');
  const lazyEmpty = html();
  run('studioBundleScreen = undefined;');
  openAt('/studio?tab=replies');
  const lazyNone = html();
  const lazyCases = [
    lazyReplies.includes('data-testid="studio-screen-replies"') && lazyReplies.includes('<card studio-pages.js>') && !lazyReplies.includes('data-testid="studio-soon"'),
    lazyPosts.includes('data-testid="studio-screen-posts"') && lazyPosts.includes('<card studio-pages.js>'),
    lazyEmpty.includes('data-testid="studio-soon"') && !lazyEmpty.includes('<card'),
    lazyNone.includes('data-testid="studio-soon"') && !lazyNone.includes('<card')
  ];
  check('Studio v2 shell: the replies and posts tabs ask the loader for studio-pages.js and show its card in the screen root until the screen registers; the placeholder stays when the loader has nothing to show',
    !loadError && lazyCases.every(Boolean), loadError || `cases ${failed(lazyCases)}`);

  // The layout is fixed by the first /me answer of a visit; a later answer updates only the rest
  // (services, intake, limits, contact) until the next page load or the next entry into the studio.
  meReply({ ui: 'v2', staffDesk: 'classic', isStaff: false, services: { help: false } });
  openAt('/studio?tab=wallet');
  run("__html = 'not drawn again'; __replies['/api/studio/me'] = [{ value: { ui: 'classic', staffDesk: 'classic', isStaff: false, services: { help: true }, intake: { open: false } } }]; studioLoadMe(0);");
  const pinned = { frame: run('studioV2Frame()'), html: html(), help: json('studioMe().services.help'), intake: json('studioMe().intakeOpen'),
    remembered: win.localStorage.getItem('albayan.studio.v2.layout.v2-user') };
  run('render();');
  const pinnedDraw = html();
  run("_lastRenderedView = 'smart-systems'; render(); _lastRenderedView = 'ads-studio';");  // the next entry into the studio
  const reentered = { frame: run('studioV2Frame()'), html: html() };
  // An entry while /me is being read again keeps the old layout until that answer arrives.
  meReply({ ui: 'v2', staffDesk: 'classic', isStaff: false });
  openAt('/studio?tab=home');
  run(`var __release = null; var __realApiJson = apiJson;
    apiJson = function (path, options) { if (path !== '/api/studio/me') return __realApiJson(path, options); __calls.push({ path, method: 'GET' }); return new Promise(resolve => { __release = resolve; }); };
    _studioMe.loadedAt = 1; _lastRenderedView = 'smart-systems'; render(); _lastRenderedView = 'ads-studio';`);
  const whileReading = { frame: run('studioV2Frame()'), repin: run('_studioV2.repin'), home: html().includes('data-testid="studio-screen-home"') };
  run("__release({ ui: 'classic', staffDesk: 'classic', isStaff: false }); apiJson = __realApiJson;");
  const afterAnswer = { frame: run('studioV2Frame()'), html: html() };
  meReply({ ui: 'v2', staffDesk: 'classic', isStaff: false });
  openAt('/studio?tab=home');
  const pinCases = [
    pinned.frame === 'customer' && pinned.html === 'not drawn again' && pinned.help === true && pinned.intake === false && pinned.remembered === null,
    pinnedDraw.includes('data-testid="studio-screen-wallet"'),
    reentered.frame === '' && reentered.html === '<classic>',
    whileReading.frame === 'customer' && whileReading.repin === true && whileReading.home,
    afterAnswer.frame === '' && afterAnswer.html === '<classic>'
  ];
  check('Studio v2 layout pinned per visit: later /me answers update services/intake/limits/contact only; a layout change waits for the next load or entry', !loadError && pinCases.every(Boolean),
    loadError || `cases ${failed(pinCases)}`);

  // Typed input: an amount with a comma and a point is read only as grouped thousands with decimals;
  // a Libyan mobile after +218 needs all nine digits.
  const strictAmounts = [['1,250.50', 125050], ['١٬٢٥٠٫٥٠', 125050], ['12,345.6', 1234560], ['1,250.', 125000], ['٥٠٫٢٥', 5025]].map(([raw, want]) => amount(raw) === want);
  const ambiguousAmounts = ['1.250,00', '1.234,56', '12,5.5', '1,5.25', '1,250.5,0', '1,25.00', '1,2,5', '12,5555', '1,250.505'].map(raw => Number.isNaN(amount(raw)));
  const strictPhones = [['+218 91 234 5678', '+218912345678'], ['+218 21 333 3333', '+218213333333'], ['+218 61 222 3344', '+218612223344'], ['0612223344', '+218612223344']].map(([raw, want]) => phone(raw) === want);
  const shortMobiles = ['+218 91 234 567', '091 234 567', '218 91 234 567', '+218 9123 45678 9'].map(raw => phone(raw) === '');
  check('Studio v2 parsers refuse what could mean two amounts ("1.250,00", "12,5.5") and a Libyan mobile without all nine digits', !loadError
    && strictAmounts.every(Boolean) && ambiguousAmounts.every(Boolean) && strictPhones.every(Boolean) && shortMobiles.every(Boolean),
  loadError || `amounts ${failed(strictAmounts)} ambiguous ${failed(ambiguousAmounts)} phones ${failed(strictPhones)} short ${failed(shortMobiles)}`);

  // Built bundles and the P2-08 styles.
  const workspaceCss = read('assets/ads-workspace.css');
  const v2Css = workspaceCss.slice(workspaceCss.indexOf('/* Albayan Studio v2 frame'));
  const studioBytes = fs.statSync(path.join(ROOT, 'studio.js')).size;
  check('Studio v2 ships in both studio.js copies under 1 MiB, with its styles (tokens, dark, focus mode, rail, keyboard) in ads-workspace.css',
    [read('studio.js'), read('www/studio.js')].every(bundle => bundle.includes(coreSrc) && bundle.includes(shellSrc)) && studioBytes < 1024 * 1024
      && read('www/assets/ads-workspace.css') === workspaceCss
      && ['.studio-v2-frame [hidden] { display: none !important; }', 'body.keyboard-open .studio-v2-nav { display: none !important; }', '@media (min-width: 901px)',
        '.studio-v2-nav { position: fixed;', 'html.dark .studio-v2-row.is-danger', '.studio-v2-nav-item[aria-current="page"]', 'overflow-wrap: anywhere'].every(rule => v2Css.includes(rule))
      && !/background(-color)?:\s*#|[^-]color:\s*#(?!be123c|fda4af)/.test(v2Css),
    `studio.js ${studioBytes} bytes`);
}

{
  // P2-03 + P2-04 (Studio v2 Home 15j + My ads 15k): the real files run after 15c, 15g and 15h in a
  // sandbox (fake history and timers, a scripted apiJson, the platform helpers they call stubbed), with
  // /me, the campaigns summary and the wallet summary answered like the server. Promises settle before
  // each run() returns (microtaskMode 'afterEvaluate'); __runTimers() lets a finished read redraw.
  const vm = require('vm');
  const coreSrc = read('src/systems/ads_studio/15g-studio-core.js');
  const shellSrc = read('src/systems/ads_studio/15h-studio-shell.js');
  const homeSrc = read('src/systems/ads_studio/15j-studio-home.js');
  const adsSrc = read('src/systems/ads_studio/15k-studio-ads.js');
  const fixture = JSON.parse(read('server/systems/ads_studio/stage_cases.json'));
  const who = { plan: true };
  const win = {
    location: { pathname: '/studio', search: '', href: 'http://localhost/studio' },
    listeners: { popstate: [] },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const list = this.listeners[type] || []; const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); },
    localStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })()
  };
  const hist = {
    entries: [], index: 0,
    get length() { return this.entries.length; },
    get state() { return this.entries[this.index] ? this.entries[this.index].state : null; },
    show() { const url = new URL(this.entries[this.index].url, 'http://localhost'); win.location.pathname = url.pathname; win.location.search = url.search; win.location.href = url.href; },
    reset(url) { this.entries = [{ url, state: null }]; this.index = 0; this.show(); },
    pushState(entryState, _title, url) { this.entries.splice(this.index + 1); this.entries.push({ url: String(url), state: JSON.parse(JSON.stringify(entryState)) }); this.index++; this.show(); },
    replaceState(entryState, _title, url) { this.entries[this.index] = { url: String(url || this.entries[this.index].url), state: JSON.parse(JSON.stringify(entryState)) }; this.show(); },
    go(delta) {
      const next = this.index + delta;
      if (!delta || next < 0 || next >= this.entries.length) return;
      this.index = next; this.show();
      for (const fn of [...win.listeners.popstate]) fn({ state: this.state });
    },
    back() { this.go(-1); }
  };
  win.history = hist;
  let secureSeq = 0;
  const box = vm.createContext({
    state: { language: 'en', theme: 'light', currentUser: { id: 'u1' }, currentView: 'ads-studio', adCampaignRequests: [], walletTransactions: [] },
    Security: {
      escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      isValidRecordId: value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(value ?? '').trim()),
      generateSecureId: prefix => `${prefix}-${++secureSeq}`,
      sanitizeObject: value => JSON.parse(JSON.stringify(value))
    },
    window: win, history: hist, URLSearchParams, URL,
    isServerModeEnabled: () => true,
    isCurrentUserAdmin: () => false,
    currentUserHasPermission: (collection, action) => action !== 'review' && action !== 'view',
    hasSubscription: id => who.plan && id === 'ad_maker',
    canActOnRecord: () => true,
    getVisibleRecords: list => (Array.isArray(list) ? list.filter(item => item && !item._deleted) : []),
    updateUrlParams: () => {}, requestViewScrollReset: () => {}, IS_STUDIO_SHELL: true,
    TIME_CONSTANTS: { API_TIMEOUT_LONG_MS: 1000 }
  }, { microtaskMode: 'afterEvaluate' });
  let loadError = '';
  try {
    const at = forms.indexOf('function normalizeDigitsAscii(');
    vm.runInContext(forms.slice(at, forms.indexOf('\n}\n', at) + 2), box);
    vm.runInContext(`
      var __calls = [];
      var __replies = Object.create(null);
      var __timers = new Map();
      var __timerSeq = 0;
      var __html = '';
      var __notes = [];
      var __deleted = [];
      var performance = { now: () => 100, getEntriesByType: () => [{ type: 'navigate', name: '' }] };
      var document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
      function setTimeout(fn, ms) { const id = ++__timerSeq; __timers.set(id, { fn, ms: Number(ms) || 0 }); return id; }
      function clearTimeout(id) { __timers.delete(id); }
      function __runTimers() { for (let round = 0; round < 5 && __timers.size; round++) { const due = Array.from(__timers.entries()); __timers.clear(); due.forEach(([, t]) => t.fn()); } }
      function getUrlParams() { return { tab: new URLSearchParams(window.location.search).get('tab') }; }
      function apiJson(path, options) {
        __calls.push({ path: String(path), method: String((options && options.method) || 'GET'), body: options && options.body ? JSON.parse(JSON.stringify(options.body)) : null });
        const next = (__replies[path] || []).shift();
        if (!next) return new Promise(() => {});
        if (next.error) return Promise.reject(Object.assign(new Error(next.error.message || 'Request failed'), next.error));
        return Promise.resolve(JSON.parse(JSON.stringify(next.value)));
      }
      function showNotification(title, message, type) { __notes.push({ title, message, type }); }
      function getServerSessionIdentity() { return 'session'; }
      function serverSessionIdentityChanged() { return false; }
      function makeSessionChangedError() { return new Error('session changed'); }
      function requestValidatedServerEntity(collection, context, loader) { return loader(); }
      function withRetry(fn) { return fn(); }
      function clearCollectionCorruption() {}
      function markCollectionDirty() {}
      function saveState() {}
      function apiStopAdCampaignRequest(id, expectedLastModified, operationId, reason) {
        return apiJson('/api/ad-studio/campaigns/' + encodeURIComponent(id) + '/stop', { method: 'POST', body: { expectedLastModified, operationId, reason: reason || null } });
      }
      // The platform's delete (09-api-auth.js), reduced to its call; the classic deleteRecord must not be used.
      function apiDeleteEntity(collection, id) { __deleted.push(id); return apiJson('/api/collections/' + collection + '/' + id, { method: 'DELETE', body: {} }); }
      function deleteRecord() { __notes.push({ title: 'classic deleteRecord', message: 'used', type: 'error' }); return Promise.resolve(true); }
      // The request builder's entry points (15l), recorded: Home and My ads only call them.
      var __builder = [];
      function studioBuilderStart(kind, options) { __builder.push(['start', kind, options || null]); return true; }
      function studioBuilderEdit(id, options) { __builder.push(['edit', id, !!(options && options.button)]); return Promise.resolve(true); }
      function studioBuilderFix(id, code, button) { __builder.push(['fix', id, code, !!button]); return Promise.resolve(true); }
      function studioBuilderFixLabel(code, kind) { return (code === 'creative_quality' ? 'Fix: photo' : 'Fix: details') + (kind === 'boost' ? ' (boost)' : ''); }
      window.addEventListener('popstate', () => { restoreAdsStudioTabFromUrl(); render(); });
    `, box);
    vm.runInContext(adsStudio, box);
    vm.runInContext(coreSrc, box);
    vm.runInContext(shellSrc, box);
    vm.runInContext(homeSrc, box);
    vm.runInContext(adsSrc, box);
    vm.runInContext("function render() { const html = renderStudioV2View(); __html = html || '<classic>'; }", box);
  } catch (error) { loadError = String(error && error.message || error); }
  const run = code => { try { return vm.runInContext(code, box); } catch (error) { return `THREW ${error && error.message}`; } };
  const json = code => { try { return JSON.parse(String(run(`JSON.stringify(${code})`))); } catch (_) { return undefined; } };
  const html = () => String(run('__html'));
  const failed = cases => cases.map((ok, i) => ok ? '' : i).filter(String).join(',');
  const reply = (path, value) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ value: ${JSON.stringify(value)} });`);
  const replyError = (path, error) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ error: ${JSON.stringify(error)} });`);
  const minutesAgo = n => new Date(Date.now() - n * 60000).toISOString();
  const stageRow = (n, extra = {}) => {
    const entry = fixture.tables.stages[String(n)];
    return {
      stage: n, stageKey: entry.key, labels: { en: entry.en, ar: entry.ar }, money: fixture.tables.money[entry.money],
      nextActorLabels: fixture.tables.nextActors[entry.nextActor], tracker: { step: entry.tracker, side: entry.side },
      actions: entry.actions.slice(), linked: false, metaUsedMinor: null, ...extra
    };
  };
  const requests = () => [
    { id: 'r_draft', createdBy: 'u1', status: 'Draft', name: 'Spring <b>sale</b>', budgetMinorUSD: 2000, budgetType: 'lifetime', durationDays: 5, _created: 1, _lastModified: 11 },
    { id: 'r_wait', createdBy: 'u1', status: 'Submitted', name: 'Waiting ad', budgetMinorUSD: 3000, totalBudgetMinorUSD: 3000, budgetType: 'lifetime', durationDays: 7, submittedAt: '2026-09-20T10:00:00Z', _created: 2, _lastModified: 12 },
    { id: 'r_fix', createdBy: 'u1', status: 'Changes Requested', name: 'Fix me', reviewReasonCode: 'creative_quality', reviewNote: 'Use a brighter <photo>', submittedAt: '2026-09-19T10:00:00Z', _created: 3, _lastModified: 13 },
    { id: 'r_live', createdBy: 'u1', status: 'Approved', name: 'Live ad', metaCampaignId: '120200001', paidMinorUSD: 5000, submittedAt: '2026-09-18T10:00:00Z', _created: 4, _lastModified: 14 },
    { id: 'r_new', createdBy: 'u1', status: 'Approved', name: 'New ad', paidMinorUSD: 5000, startDate: '2099-01-10', endDate: '2099-01-16', durationDays: 7, studioRef: 'ALB-S-AB12CD34', submittedAt: '2026-09-21T10:00:00Z', _created: 5, _lastModified: 15 },
    { id: 'r_done', createdBy: 'u1', status: 'Stopped', closeReason: 'customer_stop', name: 'Done ad', submittedAt: '2026-09-10T10:00:00Z', _created: 6, _lastModified: 16 },
    { id: 'r_other', createdBy: 'u2', status: 'Draft', name: 'Someone else', _created: 7, _lastModified: 17 }
  ];
  const summary = {
    r_draft: stageRow(1), r_wait: stageRow(2), r_fix: stageRow(3),
    r_live: stageRow(8, { linked: true, metaUsedMinor: 300, checkedAt: minutesAgo(5), checkedAgo: { en: 'checked 5 minutes ago', ar: 'فُحص قبل 5 دقائق' } }),
    r_new: stageRow(4), r_done: stageRow(12)
  };
  const wallet = (usd = {}) => ({
    usd: { addedMinor: 20000, adjustmentsMinor: 0, reservedMinor: 3000, inAdsMinor: 10000, metaUsedInAdsMinor: 300, metaCheckedAt: minutesAgo(5), beingReturnedMinor: 0, spentMinor: 2000, availableMinor: 5000, ...usd },
    reserved: [{ campaignId: 'r_wait', name: 'Waiting ad', budgetMinor: 3000, dailyMinor: null, days: null }],
    inAds: [{ campaignId: 'r_live', inAdsMinor: 5000, metaUsedMinor: 300 }, { campaignId: 'r_new', inAdsMinor: 5000, metaUsedMinor: null }],
    chains: [
      { campaignId: 'r_live', bucket: 'inAds', state: 'in_ads', paidMinor: 5000, returnedMinor: 0, netMinor: 5000, metaUsedMinor: 300, checkedAt: minutesAgo(5),
        steps: [{ kind: 'payment', amountMinor: 5000, labels: { en: 'Ad budget paid: Live ad', ar: 'دفع ميزانية إعلان: Live ad' } }] },
      { campaignId: 'r_done', bucket: 'spent', state: 'spent', paidMinor: 4000, returnedMinor: 2000, netMinor: 2000, metaUsedMinor: null, checkedAt: null,
        steps: [{ kind: 'payment', amountMinor: 4000, labels: { en: 'Ad budget paid: Done ad', ar: 'دفع ميزانية إعلان: Done ad' } },
          { kind: 'return', amountMinor: 2000, labels: { en: 'Unused budget returned from: Done ad', ar: 'استرجاع ما لم تصرفه ميتا من: Done ad' } }] }
    ],
    lyd: { balanceMinor: 0 },
    pendingPayments: [{ reference: 'PAY-AB12CD34', amountMinor: 5000, currency: 'LYD', createdAt: '2026-09-24T10:00:00Z', dueAt: null }]
  });
  const me = (extra = {}) => ({ ui: 'v2', staffDesk: 'classic', isStaff: false, isAdmin: false, intake: { open: true }, services: {}, ...extra });
  // A fresh session: /me, both summaries and the synced rows, then the screen at `url` drawn twice
  // (the first draw asks, the answers redraw).
  const open = (url, { meReply = me(), walletReply = wallet(), rows = requests(), summaryReply = summary, language = 'en', extra = () => {} } = {}) => {
    box.state.language = language;
    box.state.adCampaignRequests = rows;
    run("studioResetMe(); studioDataReset(''); __timers.clear(); __calls.length = 0; __notes.length = 0; __replies = Object.create(null);");
    reply('/api/studio/me', meReply);
    reply('/api/studio/campaigns/summary', summaryReply);
    reply('/api/studio/wallet/summary', walletReply);
    extra();
    run('studioLoadMe();');
    hist.reset(url);
    run('_studioV2.docRendered = false; render();');
    run('__runTimers();');  // the answers arrived after the first draw: their redraw
    run('__runTimers();');
    return html();
  };
  const between = (page, testId) => {
    const at = page.indexOf(`data-testid="${testId}"`);
    if (at < 0) return '';
    const end = page.indexOf('data-testid="studio-', at + 20);
    return page.slice(at, end < 0 ? undefined : end);
  };

  // Home: the plug, the strip (exactly the wallet summary), Needs you, trackers, goals, no Getting started.
  const home = open('/studio?tab=home');
  const homeAr = open('/studio?tab=home', { language: 'ar' });
  const returning = open('/studio?tab=home', { walletReply: wallet({ beingReturnedMinor: 700, metaUsedInAdsMinor: null, metaCheckedAt: null }) });
  const paused = open('/studio?tab=home', { meReply: me({ intake: { open: false } }) });
  const homeCases = [
    home.includes('data-testid="studio-screen-home"') && home.includes('data-testid="studio-home"') && !home.includes('Coming soon in the new studio'),
    [['available', 5000, '$50.00'], ['reserved', 3000, '$30.00'], ['in-ads', 10000, '$100.00'], ['spent', 2000, '$20.00']]
      .every(([key, minor, text]) => home.includes(`data-testid="studio-money-${key}" data-minor="${minor}"`) && between(home, `studio-money-${key}`).includes(`<bdi dir="ltr">${text}</bdi>`)),
    !home.includes('studio-money-returning') && returning.includes('data-testid="studio-money-returning" data-minor="700"') && between(returning, 'studio-money-returning').includes('$7.00'),
    between(home, 'studio-money-meta-used').includes('Meta used $3.00 so far · checked 5 minutes ago') && !returning.includes('studio-money-meta-used') && !/Meta used/.test(returning),
    between(home, 'studio-need-fix-r_fix').includes('Needs your changes: Photo or video quality') && between(home, 'studio-need-fix-r_fix').includes('Use a brighter &lt;photo&gt;'),
    between(home, 'studio-need-draft-r_draft').includes('Not sent yet: Spring &lt;b&gt;sale&lt;/b&gt;') && between(home, 'studio-need-draft-r_draft').includes('Your available money covers it'),
    between(home, 'studio-need-pay-PAY-AB12CD34').includes('PAY-AB12CD34 · 50.00 LYD') && between(homeAr, 'studio-need-pay-PAY-AB12CD34').includes('50.00 د.ل')
      && !between(home, 'studio-need-pay-PAY-AB12CD34').includes('$') && !between(homeAr, 'studio-need-pay-PAY-AB12CD34').includes('$'),
    !home.includes('<b>sale') && !home.includes('r_other') && !home.includes('Someone else'),
    ['r_new', 'r_live', 'r_wait'].every(id => home.includes(`data-testid="studio-tracker-${id}"`)) && !home.includes('studio-tracker-r_draft') && !home.includes('studio-tracker-r_done')
      && between(home, 'studio-tracker-r_wait').includes('Waiting for Albayan review') && between(home, 'studio-tracker-r_wait').includes('Next: Albayan team')
      && between(home, 'studio-tracker-r_live').includes('checked 5 minutes ago'),
    ['messages', 'promote', 'grow', 'comments', 'help'].every(key => home.includes(`data-testid="studio-goal-${key}"`)) && !home.includes('studio-home-start') && !home.includes('studio-intake-paused'),
    paused.includes('data-testid="studio-intake-paused"') && paused.includes('New ad requests will open again soon — your drafts are saved.') && paused.includes('saved as a draft until we open again'),
    homeAr.includes('dir="rtl"') && homeAr.includes('متاح') && homeAr.includes('محجوز') && homeAr.includes('في إعلاناتك') && homeAr.includes('صُرف') && homeAr.includes('<bdi dir="ltr">$50.00</bdi>')
      && homeAr.includes('يحتاج تعديلك: جودة الصورة أو الفيديو') && homeAr.includes('استخدمت ميتا $3.00 حتى الآن'),
    json("__calls.filter(c => c.path === '/api/studio/wallet/summary').length") === 1 && json("__calls.filter(c => c.path === '/api/studio/campaigns/summary').length") === 1
  ];
  check('Studio v2 Home: plugged into the shell root; strip = wallet summary (Being returned only when non-zero, Meta used only when given); Needs you, trackers, goals, paused banner, EN/AR, escaped',
    !loadError && homeCases.every(Boolean), loadError || `cases ${failed(homeCases)}`);

  // Home opens the request builder itself: each goal starts its own kind of request, a draft continues
  // where it was, a request sent back opens at the field its reason names ("Fix: photo").
  run('__builder.length = 0;');
  const goalsStarted = ['messages', 'promote', 'grow', 'comments'].map(key => run(`studioHomeGoal('${key}')`));
  const afterGoals = win.location.search;
  const starts = json('__builder') || [];
  run("__builder.length = 0; studioHomeEdit('r_fix', {}); studioHomeEdit('r_draft', {}); studioHomeEdit('r_wait');");
  const edits = json('__builder') || [];
  const wiringCases = [
    JSON.stringify(starts) === JSON.stringify([['start', 'full', { goal: 'messages' }], ['start', 'boost', { boostType: 'boost_post' }], ['start', 'boost', { boostType: 'boost_page' }]])
      && goalsStarted.slice(0, 3).every(out => out === true) && afterGoals === '?tab=replies',
    JSON.stringify(edits) === JSON.stringify([['fix', 'r_fix', 'creative_quality', true], ['edit', 'r_draft', true]]) && win.location.search === '?tab=campaigns&id=r_wait',
    /data-testid="studio-need-fix-r_fix"[\s\S]*?onclick="studioHomeEdit\('r_fix', this\)">Fix: photo<\/button>/.test(home)
      && /data-testid="studio-need-draft-r_draft"[\s\S]*?onclick="studioHomeEdit\('r_draft', this\)">Continue<\/button>/.test(home)
  ];
  check('Studio v2 Home opens the builder: goals start full / boost post / boost page, a draft continues (studioBuilderEdit), a sent-back request opens at its field (studioBuilderFix)',
    !loadError && wiringCases.every(Boolean), loadError || `cases ${failed(wiringCases)}`);

  // Getting started: a new customer (nothing sent yet) sees the four steps; the page step waits for its read.
  const fresh = open('/studio?tab=home', { rows: [requests()[0]], summaryReply: { r_draft: stageRow(1) }, walletReply: wallet({ addedMinor: 0, availableMinor: 0, reservedMinor: 0, inAdsMinor: 0, spentMinor: 0, metaUsedInAdsMinor: null }),
    extra: () => reply('/api/studio/pages', { pages: [] }) });
  const lapsedStart = (() => { who.plan = false; const page = open('/studio?tab=home', { rows: [] }); who.plan = true; return page; })();
  // A customer whose ad_maker plan ran out (a row of theirs that is no longer active) is.
  const lapsedPlan = (() => {
    who.plan = false;
    box.state.serviceSubscriptions = [{ id: 'sub_old', userId: 'u1', serviceId: 'ad_maker', status: 'active', expiresAt: '2026-01-01T00:00:00Z' },
      { id: 'sub_other', userId: 'u2', serviceId: 'ad_maker', status: 'active', expiresAt: '2026-01-01T00:00:00Z' }];
    const page = open('/studio?tab=home', { rows: [] });
    box.state.serviceSubscriptions = [{ id: 'sub_someone', userId: 'u2', serviceId: 'ad_maker', status: 'canceled', expiresAt: '2026-01-01T00:00:00Z' }];
    const other = open('/studio?tab=home', { rows: [] });
    delete box.state.serviceSubscriptions;
    who.plan = true;
    return { page, other };
  })();
  const failedRead = open('/studio?tab=home', { walletReply: undefined, extra: () => { run("__replies['/api/studio/wallet/summary'] = []"); replyError('/api/studio/wallet/summary', { status: 503, message: 'down' }); } });
  const startCases = [
    ['plan', 'page', 'money', 'first'].every(key => fresh.includes(`data-testid="studio-start-${key}"`)),
    between(fresh, 'studio-start-plan').includes('Done') && between(fresh, 'studio-start-page').includes("studioV2Open('replies')") && between(fresh, 'studio-start-money').includes("studioV2Open('wallet')")
      && between(fresh, 'studio-start-page').includes('aria-current="step"'),
    !lapsedStart.includes('data-testid="studio-need-plan"') && !lapsedStart.includes('Your plan has ended') && lapsedStart.includes('Activate Ads Studio')
      && /data-testid="studio-goal-messages"[^>]* disabled/.test(lapsedStart) && between(lapsedStart, 'studio-start-plan').includes("showSubscriptionModal('ad_maker', 'ad_maker')"),
    between(lapsedPlan.page, 'studio-need-plan').includes('Your plan has ended') && between(lapsedPlan.page, 'studio-need-plan').includes("showSubscriptionModal('ad_maker', 'ad_maker')")
      && !lapsedPlan.other.includes('data-testid="studio-need-plan"'),
    ((block) => block.includes('data-testid="studio-home-retry"') && block.includes('Albayan could not load this right now'))(failedRead.slice(failedRead.indexOf('data-testid="studio-home-money"'), failedRead.indexOf('data-testid="studio-home-needs"'))),
    !home.includes('Coming soon') && open('/studio?tab=wallet').includes('Coming soon in the new studio'),
    // A registered screen that throws keeps the shell's own root and placeholder.
    (() => { run("studioV2RegisterScreen('help', () => { throw new Error('broken screen'); })"); const page = open('/studio?tab=help'); run("_studioV2Screens.delete('help')");
      return page.includes('data-testid="studio-screen-help"') && page.includes('Coming soon in the new studio'); })()
  ];
  check('Studio v2 Home: Getting started (plan, page, money, first request) until the first send; lapsed plan; a failed wallet read offers Retry; other tabs keep the shell placeholder',
    !loadError && startCases.every(Boolean), loadError || `cases ${failed(startCases)}`);

  // My ads: list + filters (in the address), detail per stage, money chain, results, reasons.
  const list = open('/studio?tab=campaigns');
  const active = open('/studio?tab=campaigns&section=active');
  const count = (page, key) => (page.match(new RegExp(`data-testid="studio-ads-filter-${key}"[^>]*>.*?studio-ads-count">(\\d+)<`)) || [])[1];
  const detail = id => open(`/studio?tab=campaigns&id=${id}`, { extra: () => reply(`/api/studio/campaigns/${id}/results`, {
    campaignId: id, linked: true, stage: { labels: { en: 'Running', ar: 'يعمل الآن' } },
    results: { metaUsedMinor: 300, paidMinor: 5000, impressions: 12000, reach: 8000, resultType: 'lead', resultCount: 40, checkedAt: minutesAgo(5), checkedAgo: { en: 'checked 5 minutes ago', ar: 'فُحص قبل 5 دقائق' }, stale: false }
  }) });
  const actionsOf = page => [...page.matchAll(/data-testid="studio-ad-action-([a-z_]+)"/g)].map(m => m[1]).join(',');
  const dWait = detail('r_wait');
  const dNew = detail('r_new');
  const dLive = detail('r_live');
  const dDone = detail('r_done');
  const dFix = detail('r_fix');
  const dDraft = detail('r_draft');
  const dMissing = detail('r_other');
  const adsCases = [
    list.includes('data-testid="studio-screen-campaigns"') && list.includes('data-testid="studio-ads-list"') && !list.includes('Coming soon'),
    count(list, 'all') === '6' && count(list, 'active') === '2' && count(list, 'waiting') === '3' && count(list, 'finished') === '1' && !list.includes('studio-ad-r_other'),
    /data-testid="studio-ads-filter-active"[^>]*aria-pressed="true"/.test(active) && active.includes('studio-ad-r_live') && active.includes('studio-ad-r_new') && !active.includes('studio-ad-r_wait')
      && active.includes('data-section="active"'),
    list.includes('Spring &lt;b&gt;sale&lt;/b&gt;') && !list.includes('<b>sale'),
    actionsOf(dWait) === 'withdraw,ask' && between(dWait, 'studio-ad-reserved').includes('$30.00') && dWait.includes('data-step="sent"'),
    actionsOf(dNew) === 'stop,ask_stop,ask' && !/Meta used/.test(dNew),
    actionsOf(dLive) === 'ask_stop,ask' && between(dLive, 'studio-ad-meta-used').includes('Meta used $3.00 so far') && dLive.includes('Meta used $3.00 of $50.00')
      && dLive.includes('12,000') && dLive.includes('Leads') && dLive.includes('data-step="running"'),
    actionsOf(dDone) === 'archive' && between(dDone, 'studio-ad-chain').includes('Unused budget returned from: Done ad') && dDone.includes('<bdi dir="ltr">$20.00</bdi>') && dDone.includes('is-side'),
    actionsOf(dFix) === 'edit,ask' && between(dFix, 'studio-ad-reason').includes('Photo or video quality') && between(dFix, 'studio-ad-reason').includes('Use a brighter &lt;photo&gt;')
      && /data-testid="studio-ad-action-edit" onclick="studioAdsEdit\('r_fix', this\)">.*?<span>Fix: photo<\/span>/.test(dFix),
    actionsOf(dDraft) === 'edit,archive' && dDraft.includes('Delete draft') && dDraft.includes('Not sent yet') && dDraft.includes(`onclick="studioAdsEdit('r_draft', this)"`),
    dMissing.includes('data-testid="studio-ad-missing"') && !dMissing.includes('Someone else'),
    (() => {
      run("__builder.length = 0; studioAdsEdit('r_fix', {}); studioAdsEdit('r_draft'); studioAdsEdit('r_wait');");
      return JSON.stringify(json('__builder')) === JSON.stringify([['fix', 'r_fix', 'creative_quality', true], ['edit', 'r_draft', false]]);
    })()
  ];
  check('Studio v2 My ads: own requests only, filters Active / Waiting / Finished in the address, detail actions from the server stage, money chain and results as the server gives them',
    !loadError && adsCases.every(Boolean), loadError || `cases ${failed(adsCases)}`);

  // Sheets (in-page, never native) and the actions: single flight, one operationId per (action, version).
  open('/studio?tab=campaigns&id=r_new');
  const sheet = (kind, id, contact) => {
    if (contact) run(`_studioMe.value = Object.freeze(Object.assign({}, _studioMe.value, { contact: ${JSON.stringify(contact)}, serviceHours: { openNow: false } }));`);
    return String(run(`renderStudioAdsSheet(${JSON.stringify(kind)}, studioDataRequest(${JSON.stringify(id)}), studioDataStage(studioDataRequest(${JSON.stringify(id)})))`));
  };
  const withdrawSheet = sheet('withdraw', 'r_wait');
  const stopSheet = sheet('stop', 'r_new');
  const askNoContact = sheet('ask_stop', 'r_new');
  const askSheet = sheet('ask_stop', 'r_new', { whatsapp: '+218912345678', phone: '+218912345678', email: 'help@albayan.example' });
  run("__calls.length = 0; __notes.length = 0; __replies['/api/ad-studio/campaigns/r_wait/withdraw'] = [{ value: { id: 'r_wait', lastModified: 20, data: { id: 'r_wait', createdBy: 'u1', status: 'Draft', name: 'Waiting ad', _lastModified: 20 } } }];"
    + " var __w1 = studioAdsRun('withdraw', 'r_wait'); var __w2 = studioAdsRun('withdraw', 'r_wait'); var __wSame = __w1 === __w2; var __wOut = null; __w1.then(out => { __wOut = out; });");
  const withdrawCalls = json("__calls.filter(c => c.path === '/api/ad-studio/campaigns/r_wait/withdraw')") || [];
  const withdrawOut = json('__wOut') || {};
  const afterWithdraw = { status: run("state.adCampaignRequests.find(r => r.id === 'r_wait').status"), rereads: json("__calls.filter(c => c.path === '/api/studio/wallet/summary').length") };
  const refusal = 'This ad has already started — ask us to stop it and refund the unspent part';
  replyError('/api/ad-studio/campaigns/r_new/stop', { status: 409, message: refusal, payload: { detail: refusal } });
  reply('/api/collections/adCampaignRequests/r_new', { id: 'r_new', lastModified: 15, data: requests()[4] });
  run("var __s1 = null; studioAdsRun('stop', 'r_new').then(out => { __s1 = out; });");
  replyError('/api/ad-studio/campaigns/r_new/stop', { status: 500, message: 'Internal Server Error' });
  run("var __s2 = null; studioAdsRun('stop', 'r_new').then(out => { __s2 = out; });");
  const stopBodies = json("__calls.filter(c => c.path === '/api/ad-studio/campaigns/r_new/stop').map(c => c.body)") || [];
  reply('/api/collections/adCampaignRequests/r_done', { id: 'r_done', lastModified: 30 });
  run("var __a = null; studioAdsRun('archive', 'r_done').then(out => { __a = out; });");
  const archived = json("(() => { const row = state.adCampaignRequests.find(r => r.id === 'r_done'); return { deleted: row._deleted === true, version: row._lastModified }; })()") || {};
  // A refusal leaves the request where it was and is explained in the sheet (never the classic toast).
  const underReview = 'Submitted campaigns cannot be deleted while under review';
  replyError('/api/collections/adCampaignRequests/r_draft', { status: 409, message: underReview, payload: { detail: underReview } });
  const notesBefore = json('__notes.length');
  run("var __ar = null; studioAdsRun('archive', 'r_draft').then(out => { __ar = out; });");
  const refusedArchive = { out: json('__ar') || {}, notes: (json('__notes') || []).slice(notesBefore), row: json("state.adCampaignRequests.find(r => r.id === 'r_draft')") || {} };
  // Archive / Delete draft follows the request's own status too: a stage read before a send may still
  // offer "delete" for a request that is waiting for review now.
  const staleDraftStage = "Object.assign(studioDataStage(studioDataRequest('r_draft')), { fromServer: true })";
  const archiveOffers = [
    json(`studioAdsActions(Object.assign({}, studioDataRequest('r_wait'), { status: 'Submitted' }), ${staleDraftStage})`),
    json(`studioAdsActions(Object.assign({}, studioDataRequest('r_new'), { settleBasis: 'meta_final' }), studioStageView({ stage: 11, stageKey: 'finished', actions: ['archive'] }))`),
    json(`studioAdsActions(studioDataRequest('r_new'), studioStageView({ stage: 11, stageKey: 'finished', actions: ['archive'] }))`)
  ];
  run("var __ag = null; studioAdsRun('archive', 'r_live').then(out => { __ag = out; });");
  const sheetCases = [
    withdrawSheet.includes('studio-sheet-withdraw') && withdrawSheet.includes('Your reservation of $30.00 ends now') && withdrawSheet.includes('data-testid="studio-sheet-confirm"')
      && withdrawSheet.includes('role="dialog"') && withdrawSheet.includes('mobile-dialog-overlay'),
    stopSheet.includes('The full $50.00 you paid comes back') && stopSheet.includes('studio-ads-danger'),
    askNoContact.includes('Coming soon') && askNoContact.includes('contact details are not published yet') && !askNoContact.includes('studio-sheet-confirm'),
    askSheet.includes('href="https://wa.me/218912345678?text=') && askSheet.includes('ALB-S-AB12CD34') && askSheet.includes('href="tel:+218912345678"')
      && askSheet.includes('href="mailto:help@albayan.example?subject=') && askSheet.includes('rel="noopener noreferrer"') && askSheet.includes('outside working hours'),
    withdrawCalls.length === 1 && withdrawCalls[0].method === 'POST' && withdrawCalls[0].body.expectedLastModified === 12 && /^campaign-withdraw-\d+$/.test(withdrawCalls[0].body.operationId),
    run('__wSame') === true && withdrawOut.ok === true && afterWithdraw.status === 'Draft' && afterWithdraw.rereads >= 1 && json("__notes.some(n => n.type === 'success' && n.message.includes('$30.00'))") === true,
    json('__s1') && json('__s1').ok === false && json('__s1').text === refusal && json('__s2') && json('__s2').ok === false
      && stopBodies.length === 2 && stopBodies[0].operationId === stopBodies[1].operationId && stopBodies[0].expectedLastModified === 15,
    json('__a') && json('__a').ok === true && json('__a').leave === true && archived.deleted === true && archived.version === 30,
    refusedArchive.out.ok === false && refusedArchive.out.text === 'Our team is reviewing this request, so it cannot be removed now. Withdraw it first.'
      && refusedArchive.notes.length === 0 && refusedArchive.row._deleted !== true && refusedArchive.row.status === 'Draft',
    JSON.stringify(json('__deleted')) === '["r_done","r_draft"]' && json('__ag') && json('__ag').ok === false,
    Array.isArray(archiveOffers[0]) && !archiveOffers[0].includes('archive') && archiveOffers[1].includes('archive') && !archiveOffers[2].includes('archive'),
    json("_studioAdsRuns.size") === 0
  ];
  check('Studio v2 My ads sheets: withdraw / stop / archive / ask to stop (coming soon + public contact); single flight; one operationId per (action, version); refusals shown as the server says',
    !loadError && sheetCases.every(Boolean), loadError || `cases ${failed(sheetCases)}`);

  // Static: bundles, manifest order, no native dialogs or token words, the styles.
  const workspaceCss = read('assets/ads-workspace.css');
  const homeCss = workspaceCss.slice(workspaceCss.indexOf('/* Studio v2 Home and My ads'));
  const lazy = bundleManifestJson.lazy['studio.js'];
  const v2Files = [coreSrc, shellSrc, homeSrc, adsSrc];
  const staticCases = [
    lazy.indexOf('systems/ads_studio/15j-studio-home.js') === lazy.indexOf('systems/ads_studio/15h-studio-shell.js') + 1
      && lazy.indexOf('systems/ads_studio/15k-studio-ads.js') === lazy.indexOf('systems/ads_studio/15j-studio-home.js') + 1,
    [read('studio.js'), read('www/studio.js')].every(bundle => bundle.includes(homeSrc) && bundle.includes(adsSrc)) && !read('script.js').includes('renderStudioHomeBody'),
    !v2Files.some(src => /\b(?:confirm|prompt|alert)\(/.test(src)) && !/access_token|app_?secret|page_?token|Bearer /i.test(homeSrc + adsSrc) && !/setInterval\(/.test(homeSrc + adsSrc),
    homeSrc.includes("studioV2RegisterScreen('home', renderStudioHomeBody)") && adsSrc.includes("studioV2RegisterScreen('campaigns', renderStudioAdsBody)")
      && ![homeSrc, adsSrc].some(src => /renderStudioV2CustomerScreen\s*=|studioPlugScreen/.test(src)),
    homeCss.length > 1000 && read('www/assets/ads-workspace.css') === workspaceCss
      && ['html.dark :is(.studio-v2-frame, .studio-ads-sheet)', '.studio-ads-sheet { position: fixed;', '@media (max-width: 900px)', 'overflow-wrap: anywhere', 'min-height: 44px'].every(rule => homeCss.includes(rule))
      && !/background(-color)?:\s*#|[^-]color:\s*#/.test(homeCss)
  ];
  check('Studio v2 Home + My ads ship after the shell in both studio.js copies (not in script.js), no native dialogs, token words or timers loops, styles with tokens and dark mode',
    staticCases.every(Boolean), `cases ${failed(staticCases)}`);
}

{
  // P2-05a-e (Studio v2 request builder, 15l): the real files (15c, 15g, 15h, 15l) run in a sandbox with
  // a fake history, fake timers and scripted server calls, next to static checks against the server's
  // field lists, goals and review reasons, the built bundles and the CSS.
  const vm = require('vm');
  const builderSrc = read('src/systems/ads_studio/15l-studio-builder.js');
  const coreSrc = read('src/systems/ads_studio/15g-studio-core.js');
  const shellSrc = read('src/systems/ads_studio/15h-studio-shell.js');
  const homeSrc = read('src/systems/ads_studio/15j-studio-home.js');
  const mainPy = read('server/main.py');
  const fieldsPy = read('server/systems/ads_studio/ad_campaign_fields.py');
  const actionsPy = read('server/systems/ads_studio/ad_campaign_actions.py');
  const lazyStudio = bundleManifestJson.lazy['studio.js'];
  const failed = cases => cases.map((ok, i) => ok ? '' : i).filter(String).join(',');

  check('Studio v2 builder (15l) ships after the shell in both studio.js copies, under 1 MiB, no native dialogs or token words',
    lazyStudio.indexOf('systems/ads_studio/15l-studio-builder.js') > lazyStudio.indexOf('systems/ads_studio/15h-studio-shell.js')
      && !bundleManifestJson.files.some(file => /15l-studio/.test(file))
      && [read('studio.js'), read('www/studio.js')].every(bundle => bundle.includes(builderSrc) && bundle.indexOf(shellSrc) < bundle.indexOf(builderSrc))
      && fs.statSync(path.join(ROOT, 'studio.js')).size < 1024 * 1024
      && !/\b(?:confirm|prompt|alert)\(/.test(builderSrc) && !/access_token|app_?secret|page_?token|Bearer /i.test(builderSrc)
      && !/localStorage/.test(builderSrc) && builderSrc.includes('window.sessionStorage.getItem('));

  const win = {
    location: { pathname: '/studio', search: '', href: 'http://localhost/studio' },
    listeners: { popstate: [] },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const list = this.listeners[type] || []; const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
  };
  const hist = {
    entries: [], index: 0,
    get length() { return this.entries.length; },
    get state() { return this.entries[this.index] ? this.entries[this.index].state : null; },
    show() { const url = new URL(this.entries[this.index].url, 'http://localhost'); win.location.pathname = url.pathname; win.location.search = url.search; win.location.href = url.href; },
    reset(url) { this.entries = [{ url, state: null }]; this.index = 0; this.show(); },
    pushState(entryState, _title, url) { this.entries.splice(this.index + 1); this.entries.push({ url: String(url), state: JSON.parse(JSON.stringify(entryState)) }); this.index++; this.show(); },
    replaceState(entryState, _title, url) { this.entries[this.index] = { url: String(url || this.entries[this.index].url), state: JSON.parse(JSON.stringify(entryState)) }; this.show(); },
    go(delta) {
      const next = this.index + delta;
      if (!delta || next < 0 || next >= this.entries.length) return;
      this.index = next; this.show();
      for (const fn of [...win.listeners.popstate]) fn({ state: this.state });
    },
    back() { this.go(-1); }
  };
  win.history = hist;
  let seq = 0;
  const box = vm.createContext({
    state: { language: 'en', theme: 'light', currentUser: { id: 'b-user' }, currentView: 'ads-studio', adCampaignRequests: [] },
    Security: {
      escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      sanitizeInput: (value, options = {}) => String(value ?? '').replace(/[<>]/g, '').trim().slice(0, options.maxLength || 100000),
      sanitizeObject: value => JSON.parse(JSON.stringify(value)),
      generateSecureId: prefix => `${prefix}_${++seq}_abcdef123456`,
      isValidRecordId: value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(value ?? '').trim())
    },
    window: win, history: hist, URLSearchParams, URL, Intl,
    isServerModeEnabled: () => true,
    isCurrentUserAdmin: () => false,
    currentUserHasPermission: (collection, action) => action !== 'review',
    hasSubscription: id => id === 'ad_maker',
    updateUrlParams: () => {},
    requestViewScrollReset: () => {},
    IS_STUDIO_SHELL: true
  }, { microtaskMode: 'afterEvaluate' });
  let loadError = '';
  try {
    const at = forms.indexOf('function normalizeDigitsAscii(');
    vm.runInContext(forms.slice(at, forms.indexOf('\n}\n', at) + 2), box);
    vm.runInContext(`
      var __calls = [];
      var __replies = Object.create(null);
      var __timers = new Map();
      var __timerSeq = 0;
      var __html = '';
      var __notes = [];
      var __patchReply = null;
      var __createReply = null;
      var __openAdd = null;
      var __nav = { aborted: false };  // the app's navigation signal (09-api-auth.js getNavigationSignal)
      function getNavigationSignal() { return __nav; }
      // Wallet's Add money (15m), recorded.
      function studioWalletOpenAdd(purpose, amountMinor) { __openAdd = [purpose, amountMinor]; return true; }
      var performance = { now: () => 100, getEntriesByType: () => [{ type: 'navigate', name: '' }] };
      var document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, getElementById: () => null };
      function setTimeout(fn, ms) { const id = ++__timerSeq; __timers.set(id, { fn, ms: Number(ms) || 0 }); return id; }
      function clearTimeout(id) { __timers.delete(id); }
      function __runTimers() { const due = Array.from(__timers.entries()); __timers.clear(); due.forEach(([, t]) => t.fn()); }
      function getUrlParams() { return { tab: new URLSearchParams(window.location.search).get('tab') }; }
      function showNotification(title, text) { __notes.push(String(title) + ': ' + String(text)); }
      function apiJson(path, options) {
        __calls.push({ path: String(path), method: String((options && options.method) || 'GET'), body: options && options.body ? JSON.parse(JSON.stringify(options.body)) : null });
        const next = (__replies[path] || []).shift();
        if (!next) return new Promise(() => {});
        if (next.error) return Promise.reject(Object.assign(new Error(next.error.message || 'Request failed'), next.error));
        return Promise.resolve(JSON.parse(JSON.stringify(next.value)));
      }
      function __entity(data) { return { id: data.id, data: JSON.parse(JSON.stringify(data)), lastModified: data._lastModified }; }
      function apiCreateEntity(collection, record) {
        __calls.push({ path: 'create:' + collection, method: 'POST', body: JSON.parse(JSON.stringify(record)) });
        if (__createReply) { const reply = __createReply; __createReply = null; return Promise.reject(Object.assign(new Error(reply.error.message || 'refused'), reply.error)); }
        return Promise.resolve(__entity({ ...record, status: 'Draft', createdBy: 'b-user', _lastModified: 1000 }));
      }
      function apiPatchEntity(collection, id, updates, expected) {
        __calls.push({ path: 'patch:' + id, method: 'PATCH', body: JSON.parse(JSON.stringify(updates)), expected });
        if (__patchReply) { const reply = __patchReply; __patchReply = null; return reply.error ? Promise.reject(Object.assign(new Error('refused'), reply.error)) : Promise.resolve(reply.value); }
        const row = state.adCampaignRequests.find(item => item.id === id) || {};
        return Promise.resolve(__entity({ ...row, ...updates, _lastModified: Number(expected) + 1 }));
      }
      function apiSubmitAdCampaignRequest(id, expected, operationId) {
        __calls.push({ path: 'submit:' + id, method: 'POST', expected, operationId });
        return Promise.resolve(__entity({ ...(state.adCampaignRequests.find(item => item.id === id) || {}), status: 'Submitted', totalBudgetMinorUSD: 5000, _lastModified: Number(expected) + 1 }));
      }
      function ensureEntityMediaLoaded(collection, id) { return Promise.resolve(state.adCampaignRequests.find(item => item.id === id) || null); }
      function isEntityMediaHydrated() { return true; }
      function getEntityPhotoCountHint() { return 0; }
      function getVisibleRecords(list) { return list.filter(item => item && !item._deleted); }
      function saveState() {}
      function markCollectionDirty() {}
      function clearCollectionCorruption() {}
      function compressImageToDataUrl() { return Promise.resolve('data:image/png;base64,AAAA'); }
      function isSafeReceiptPhotoSource(value) { return /^data:image\\//.test(String(value)); }
      window.addEventListener('popstate', () => { restoreAdsStudioTabFromUrl(); render(); });
    `, box);
    vm.runInContext(adsStudio, box);
    vm.runInContext(coreSrc, box);
    vm.runInContext(shellSrc, box);
    vm.runInContext(homeSrc, box);  // Home's data layer: the one copy of the wallet summary
    vm.runInContext(builderSrc, box);
    vm.runInContext("function render() { const html = renderStudioV2View(); __html = html || '<classic>'; }", box);
  } catch (error) { loadError = String(error && error.message || error); }
  const run = code => { try { return vm.runInContext(code, box); } catch (error) { return `THREW ${error && error.message}`; } };
  const json = code => { try { return JSON.parse(String(run(`JSON.stringify(${code})`))); } catch (_) { return undefined; } };
  const html = () => String(run('__html'));
  const search = () => win.location.search;
  const openAt = url => { hist.reset(url); run('_studioV2.docRendered = false; render();'); };
  run(`studioResetMe(); __replies['/api/studio/me'] = [{ value: { ui: 'v2', staffDesk: 'classic', isStaff: false, intake: { open: true },
    adLimits: { minTotalMinorUSD: 500, maxTotalMinorUSD: 200000, minPerDayMinorUSD: 100, maxDays: 90 } } }]; studioLoadMe();`);
  run(`__replies['/api/studio/ad-options'] = [{ value: { goals: [{ key: 'messages', objective: 'messages', labelEn: 'Messages', labelAr: 'رسائل' }, { key: 'sales', objective: 'sales', labelEn: 'Sales', labelAr: 'مبيعات' }],
    locations: [{ key: 'libya', labelEn: 'All of Libya', labelAr: 'كل ليبيا' }, { key: 'tripoli', labelEn: 'Tripoli', labelAr: 'طرابلس' }, { key: 'benghazi', labelEn: 'Benghazi', labelAr: 'بنغازي' }] } }];
    __replies['/api/studio/pages'] = [{ value: { pages: [{ id: 'spg_1', name: '<img src=x onerror=alert(1)>Shop', hasFacebook: true, hasInstagram: true, healthy: false }] } }];
    __replies['/api/studio/wallet/summary'] = [{ value: { usd: { availableMinor: 1000, reservedMinor: 0 }, pendingPayments: [{ reference: 'PAY-LYD', amountMinor: 900, currency: 'LYD' }, { reference: 'PAY-AB12CD34', amountMinor: 2500, currency: 'USD' }] } }];`);

  // Drawing: every step of both kinds, from the shell's own route; ids on every input; safe handlers.
  const handlerRe = /^(?:onclick|oninput|onchange)="(?:studioBuilder[A-Za-z]+\((?:\d+|'[a-z_]+'|this|\d+, this|'[A-Za-z]+', this)?\)|studioV2(?:Back|CloseBuilder)\(\)|studioV2ChooseClassic\(true\)|studioV2Open\('[a-z]+'\)|showSubscriptionModal\('ad_maker', 'ad_maker'\))"$/;
  const pages = [];
  // An address never converts an open draft (only studioBuilderSwitchKind does): each kind starts its own.
  for (const [section, count] of [['full', 6], ['boost', 3]]) {
    run(`studioBuilderStart('${section}');`);
    for (let step = 1; step <= count; step++) {
      openAt(`/studio?tab=builder&section=${section}&step=${step}`);
      pages.push({ section, step, html: html() });
    }
  }
  const stepCases = pages.map(({ section, step, html: page }) => {
    const names = section === 'full' ? ['Goal', 'Page', 'Content', 'Audience', 'Budget & days', 'Review'] : ['Post', 'Budget & days', 'Review'];
    const last = step === names.length;
    const controls = page.match(/<(?:input|textarea|select)\b[^>]*>/g) || [];
    const handlers = page.match(/\bon(?:click|input|change)="[^"]*"/g) || [];
    return page.includes('data-testid="studio-builder"') && page.includes(`data-kind="${section}"`) && page.includes(`data-step="${step}"`)
      && page.includes(`Step ${step} of ${names.length}: ${names[step - 1].replace('&', '&amp;')}`)
      && page.includes(last ? 'data-testid="studio-builder-send"' : 'data-testid="studio-builder-next"')
      && page.includes('data-testid="studio-builder-save"') && !page.includes('Coming soon in the new studio')
      && controls.every(tag => /\bid="[a-z][a-z0-9-]*"/.test(tag))
      && handlers.length > 0 && handlers.every(attr => handlerRe.test(attr))
      && !/<img src=x/.test(page);
  });
  const promote = pages.find(item => item.section === 'boost' && item.step === 1).html;
  const content = pages.find(item => item.section === 'full' && item.step === 3).html;
  const pageStep = pages.find(item => item.section === 'full' && item.step === 2).html;
  run("studioBuilderStart('full'); _studioBuilder.pages.state = ''; __replies['/api/studio/pages'] = [{ value: { pages: [{ id: 'spg_1', name: '<img src=x onerror=alert(1)>Shop', hasFacebook: true, hasInstagram: true, healthy: false }] } }];");
  openAt('/studio?tab=builder&section=full&step=2');
  const pagesDrawn = html();
  stepCases.push(
    promote.includes('data-testid="studio-builder-kind-post"') && promote.includes('data-testid="studio-builder-to-full"'),
    content.includes('id="ads-studio-image-input"') && content.includes('data-photo-paste-target="ads-studio"') && content.includes('onchange="studioBuilderPhotosChosen(this)"'),
    pagesDrawn.includes('&lt;img src=x onerror=alert(1)&gt;Shop') && !pagesDrawn.includes('<img src=x') && pagesDrawn.includes('needs attention'),
    pageStep.includes('data-testid="studio-builder-platform-facebook"')
  );
  run("studioBuilderStart('boost');");
  box.state.language = 'ar';
  openAt('/studio?tab=builder&section=boost&step=2');
  const arabic = html();
  box.state.language = 'en';
  stepCases.push(/dir="rtl"/.test(arabic) && arabic.includes('الخطوة 2 من 3') && arabic.includes('الإجمالي بالدولار الأمريكي') && !/\bLYD\b|د\.ل/.test(arabic));
  check('Studio v2 builder draws every step of the quick boost and the full request (ids on inputs, safe handlers, escaped server words, Arabic RTL)',
    !loadError && stepCases.every(Boolean), loadError || `cases ${failed(stepCases)}`);

  // Typed input: Arabic-Indic digits, 09x phones, days; what is sent is only what the server takes.
  const allowed = new Set(((mainPy.match(/AD_CAMPAIGN_ALLOWED_FIELDS = frozenset\(\s*\{([\s\S]*?)\}\s*\)/) || [])[1] || '').match(/"([A-Za-z]+)"/g).map(item => item.slice(1, -1)));
  run("studioBuilderStart('full');");
  run("studioBuilderInput('budget', { value: '٥٠' }); studioBuilderInput('days', { value: '١٤' }); studioBuilderInput('destination', { value: '٠٩١ ٢٣٤ ٥٦٧٨' });");
  const typed = json('{ budget: _adsStudioDraft.budgetMinorUSD, days: _adsStudioDraft.durationDays, total: studioBuilderTotalText(_studioBuilder.session), payload: studioBuilderPayload(_adsStudioDraft) }') || {};
  run("studioBuilderInput('destination', { value: 'www.no-scheme' }); studioBuilderInput('days', { value: '0' }); studioBuilderInput('budget', { value: '1.234' });");
  const halfTyped = json('studioBuilderPayload(_adsStudioDraft)') || {};
  const goalsPy = Object.fromEntries([...fieldsPy.matchAll(/"([a-z_]+)": \("([a-z_]+)", "[a-z_]+"\)/g)].map(m => [m[1], m[2]]));
  const clientGoals = json('STUDIO_BUILDER_GOALS.map(goal => [goal[0], goal[1]])') || [];
  const typedCases = [
    typed.budget === 5000 && typed.days === 14 && String(typed.total).includes('$50.00') && String(typed.total).includes('14 days'),
    typed.payload && typed.payload.destination === '+218912345678' && typed.payload.durationDays === 14 && typed.payload.budgetMinorUSD === 5000,
    typed.payload && Object.keys(typed.payload).every(field => allowed.has(field)) && typed.payload.goalDetail === 'messages' && typed.payload.objective === 'messages',
    !('destination' in halfTyped) && !('durationDays' in halfTyped) && !('budgetMinorUSD' in halfTyped) && halfTyped.name,
    clientGoals.length === Object.keys(goalsPy).length && clientGoals.every(([key, objective]) => goalsPy[key] === objective),
    run("studioBuilderDestination('https://wa.me/218912345678')") === 'https://wa.me/218912345678' && run("studioBuilderDestination('+44 20 7946 0958')") === '+442079460958'
  ];
  check('Studio v2 builder: Arabic digits in money, days and phones (09x -> +2189x); half-typed values are never sent; goals equal the server\'s',
    !loadError && typedCases.every(Boolean), loadError || `cases ${failed(typedCases)}`);

  // Budget rules = server rules (limits from /me), and the wallet line from the wallet summary.
  run("_adsStudioDraft.budgetType = 'daily'; studioBuilderInput('budget', { value: '0.9' }); studioBuilderInput('days', { value: '7' });");
  const floor = String(run('studioBuilderBudgetProblem(_studioBuilder.session)'));
  run("studioBuilderInput('budget', { value: '0.5' }); studioBuilderInput('days', { value: '3' });");
  const minTotal = String(run('studioBuilderBudgetProblem(_studioBuilder.session)'));
  run("studioBuilderInput('days', { value: '91' });");
  const maxDays = json('studioBuilderStepProblems(_studioBuilder.session, "budget")') || {};
  run("studioBuilderInput('days', { value: '5' }); studioBuilderInput('budget', { value: '10' });");
  run(`__replies['/api/studio/wallet/summary'] = [{ value: { usd: { availableMinor: 1000, reservedMinor: 0 }, pendingPayments: [{ reference: 'PAY-LYD', amountMinor: 900, currency: 'LYD' }, { reference: 'PAY-AB12CD34', amountMinor: 2500, currency: 'USD' }] } }];
    studioBuilderLoadWallet(true);`);
  const walletHtml = String(run('studioBuilderWalletHtml(_studioBuilder.session)'));
  run("_adsStudioDraft.budgetType = 'lifetime'; studioBuilderInput('budget', { value: '50' }); __openAdd = null; studioBuilderAddMoney();");
  const addMoney = json('__openAdd');
  run("_adsStudioDraft.budgetType = 'daily'; studioBuilderInput('budget', { value: '10' });");
  const budgetCases = [
    floor.includes('$1.00 a day'), minTotal.includes('at least $5.00') && minTotal.includes('$0.50 × 3 days = $1.50'), String(maxDays.days || '').includes('90'),
    walletHtml.includes('You have <bdi dir="ltr">$10.00</bdi> available') && walletHtml.includes('Short by <bdi dir="ltr">$40.00</bdi>')
      && walletHtml.includes('PAY-AB12CD34') && walletHtml.includes('$25.00') && !walletHtml.includes('PAY-LYD')
      && walletHtml.includes('onclick="studioBuilderAddMoney()"'),
    run('studioBuilderWalletShort(_studioBuilder.session)') === true && run('studioBuilderSendBlocked(_studioBuilder.session)') === true,
    // "Add money" opens Wallet's Add money on "my ads" with the missing $40.00 ($50.00 - $10.00 available).
    JSON.stringify(addMoney) === '["ads",4000]' && !/section: 'add'/.test(builderSrc)
  ];
  check('Studio v2 builder: total limits, the per-day floor and max days from /me; the wallet line and a pending USD payment from the wallet summary',
    !loadError && budgetCases.every(Boolean), loadError || `cases ${failed(budgetCases)}`);

  // The suggested totals carry their own amount: typed days that move the per-day floor never turn a
  // tap on "$20.00" into another amount, and the chips follow the typed days in place.
  run("studioBuilderStart('full'); studioBuilderSetDays(7);");
  openAt('/studio?tab=builder&section=full&step=5');
  const budgetPage = html();
  run("var __els = { 'studio-b-presets': { innerHTML: '', hidden: false } }; document.getElementById = id => __els[id] || null;");
  run("studioBuilderInput('days', { value: '30' });");
  const repainted = json("__els['studio-b-presets']") || {};
  run('studioBuilderPreset(2000);');
  const tapped = json('_adsStudioDraft.budgetMinorUSD');
  run('studioBuilderPreset(0); studioBuilderPreset(1234);');
  const keptBudget = json('_adsStudioDraft.budgetMinorUSD');
  const floorHint = String(run('studioBuilderBudgetProblem(_studioBuilder.session)'));
  run('document.getElementById = () => null; __timers.clear(); __calls.length = 0;');
  const presetCases = [
    budgetPage.includes('id="studio-b-presets"') && ['2000', '3500', '6000', '10000'].every(minor => budgetPage.includes(`onclick="studioBuilderPreset(${minor})"`))
      && /onclick="studioBuilderPreset\(2000\)"[^>]*><span>\$20\.00<\/span>/.test(budgetPage),
    repainted.innerHTML.includes('studioBuilderPreset(3500)') && repainted.innerHTML.includes('studioBuilderPreset(15000)') && !repainted.innerHTML.includes('studioBuilderPreset(2000)') && repainted.hidden === false,
    tapped === 2000 && keptBudget === 2000 && floorHint.includes('Meta needs at least $1.00 a day')
  ];
  check('Studio v2 builder: a suggested total sets the amount on its chip, whatever the typed days did meanwhile; the chips follow the days in place',
    !loadError && presetCases.every(Boolean), loadError || `cases ${failed(presetCases)}`);

  // Saving as you go: one create with a fixed id, then PATCH with only the changed fields and the
  // version; a conflict never overwrites.
  run('__timers.clear();');
  // Starting another request first sends what the open one still had waiting (its own create).
  run("studioBuilderStart('boost');");
  const flushedOld = json('__calls.filter(call => call.path === "create:adCampaignRequests").map(call => call.body.boostType)') || [];
  run("__calls.length = 0; studioBuilderInput('postLink', { value: 'https://www.facebook.com/shop/posts/1' }); studioBuilderInput('pageName', { value: 'Shop' });");
  const beforeTimer = json('__calls.filter(call => call.method !== "GET").length');
  run('__runTimers();');
  const create = json('__calls.find(call => call.path === "create:adCampaignRequests")') || {};
  run('state.adCampaignRequests = [JSON.parse(JSON.stringify(_studioBuilder.session.draft))]; state.adCampaignRequests[0]._lastModified = 1000;');
  run("studioBuilderInput('notes', { value: 'Morning only' }); __runTimers();");
  const patch = json('__calls.find(call => call.path.startsWith("patch:"))') || {};
  run("__replies['/api/collections/adCampaignRequests/' + encodeURIComponent(_studioBuilder.session.id)] = [{ value: { id: _studioBuilder.session.id, lastModified: 3000, data: { id: _studioBuilder.session.id, status: 'Draft', createdBy: 'b-user', _lastModified: 3000 } } }];");
  run("__patchReply = { error: { status: 409, message: 'Conflict: record has changed' } }; studioBuilderInput('notes', { value: 'Evenings' }); __runTimers();");
  const conflict = json('{ status: _studioBuilder.session.status, version: _studioBuilder.session.conflict && _studioBuilder.session.conflict.version }') || {};
  run("studioBuilderInput('notes', { value: 'Evenings too' }); __runTimers();");
  const patchesAfterConflict = json('__calls.filter(call => call.path.startsWith("patch:")).length');
  run('studioBuilderKeepMine(); __runTimers();');
  const kept = json('__calls.filter(call => call.path.startsWith("patch:")).slice(-1)[0]') || {};
  const saveCases = [
    beforeTimer === 0 && JSON.stringify(flushedOld) === '[""]',
    create.body && /^campaign_/.test(create.body.id) && create.body.boostType === 'boost_post' && create.body.sourcePostRef === 'https://www.facebook.com/shop/posts/1'
      && Object.keys(create.body).every(field => field === 'id' || allowed.has(field)),
    patch.expected === 1000 && JSON.stringify(Object.keys(patch.body || {})) === '["notes"]' && patch.body.notes === 'Morning only',
    conflict.status === 'conflict' && conflict.version === 3000 && patchesAfterConflict === 2,
    kept.expected === 3000 && kept.body && kept.body.notes === 'Evenings too' && kept.body.sourcePostRef === 'https://www.facebook.com/shop/posts/1'
  ];
  check('Studio v2 builder saves as you go: one create (fixed id), then PATCH of the changed fields with expectedLastModified; a conflict never overwrites',
    !loadError && saveCases.every(Boolean), loadError || `cases ${failed(saveCases)}`);

  // The server's limit of open requests is said as that, never as "changed on another device"; the
  // next change tries the create again once the customer has freed a slot.
  const keptSession = 'var __keptSession = _studioBuilder.session; var __keptDraft = _adsStudioDraft;';
  run(keptSession);
  const openLimit = 'Ads Studio allows at most 50 open campaign requests per customer. Finish or delete an old request first.';
  run("studioBuilderStart('full'); __timers.clear();");
  const limitId = String(run('_studioBuilder.session.id'));
  run(`__createReply = { error: { status: 409, message: ${JSON.stringify(openLimit)}, payload: { detail: ${JSON.stringify(openLimit)} } } };
    __replies['/api/collections/adCampaignRequests/' + encodeURIComponent(${JSON.stringify(limitId)})] = [{ error: { status: 404, message: 'Not Found', payload: { detail: 'Not Found' } } }];
    studioBuilderInput('notes', { value: 'First try' }); __runTimers();`);
  const limited = json('{ status: _studioBuilder.session.status, text: _studioBuilder.session.statusText, quota: _studioBuilder.session.quota, conflict: _studioBuilder.session.conflict, created: _studioBuilder.session.created }') || {};
  openAt('/studio?tab=builder&section=full&step=6');
  const limitHtml = html();
  run("studioBuilderInput('notes', { value: 'Second try' }); __runTimers();");
  const retried = json(`{ status: _studioBuilder.session.status, created: _studioBuilder.session.created, quota: _studioBuilder.session.quota,
    creates: __calls.filter(call => call.path === 'create:adCampaignRequests' && call.body.id === ${JSON.stringify(limitId)}).length }`) || {};
  // A late answer for the draft the customer just left never points the reload memory back at it.
  const tabStore = new Map();
  win.sessionStorage = { getItem: k => (tabStore.has(k) ? tabStore.get(k) : null), setItem: (k, v) => tabStore.set(k, String(v)), removeItem: k => tabStore.delete(k) };
  run("studioBuilderStart('full'); studioBuilderInput('notes', { value: 'Left behind' });");
  const leftId = String(run('_studioBuilder.session.id'));
  run("studioBuilderStart('full');");  // the left draft's save is sent on the way out; its answer lands after the new one opened
  const memoryAfter = json('studioBuilderMemory()');
  const leftSaved = json(`__calls.some(call => call.path === 'create:adCampaignRequests' && call.body.id === ${JSON.stringify(leftId)})`);
  delete win.sessionStorage;
  // A quick boost has no platform choice: an empty list (both boxes unticked in the full request, or
  // a stored boost) becomes the page's platforms or both, so Send never meets "at least one platform".
  run("studioBuilderStart('full'); studioBuilderTogglePlatform('facebook'); studioBuilderTogglePlatform('instagram');");
  const unticked = json('_adsStudioDraft.platforms');
  run("studioBuilderSwitchKind('boost');");
  const boosted = json('{ draft: _adsStudioDraft.platforms, sent: studioBuilderPayload(_adsStudioDraft).platforms }') || {};
  run("studioBuilderOpenSession('boost', Object.assign(newAdsStudioDraft(), { id: 'stored_boost_1', boostType: 'boost_post', platforms: [] }), { created: true, baseline: 5 });");
  const storedBoost = json('_adsStudioDraft.platforms');
  run('__timers.clear(); _studioBuilder.session = __keptSession; _adsStudioDraft = __keptDraft;');
  const limitCases = [
    limited.status === 'error' && limited.quota === true && limited.conflict === null && limited.created === false
      && limited.text === 'You have too many open requests. Delete an old draft or wait for one to finish, then try again.',
    limitHtml.includes('data-testid="studio-builder-quota"') && !limitHtml.includes('studio-builder-conflict') && limitHtml.includes('onclick="studioBuilderOpenMyAds()"')
      && limitHtml.includes('Not saved: You have too many open requests.'),
    retried.status === 'saved' && retried.created === true && retried.quota === false && retried.creates === 2,
    memoryAfter === null && leftSaved === true,
    JSON.stringify(unticked) === '[]' && Array.isArray(boosted.draft) && boosted.draft.length > 0 && JSON.stringify(boosted.sent) === JSON.stringify(boosted.draft)
      && JSON.stringify(storedBoost) === '["facebook","instagram"]'
  ];
  check('Studio v2 builder: the 50-open-requests limit is shown as that (a way to My ads, the next change retries); a late save never repoints the reload memory; a quick boost always has platforms',
    !loadError && limitCases.every(Boolean), loadError || `cases ${failed(limitCases)}`);

  // Sending: single flight, an operationId per (action, version), the reserved total from the server.
  run(`_studioBuilder.session.status = 'saved'; _studioBuilder.session.conflict = null; _studioBuilder.session.rights = true;
    Object.assign(studioDataSlot('wallet'), { value: { usd: { availableMinor: 900000, reservedMinor: 0 }, pendingPayments: [] }, loadedAt: Date.now(), promise: null });`);
  run("studioBuilderInput('budget', { value: '50' }); __runTimers();");
  // A change the server refuses (413) and that is then undone leaves nothing unsaved: the status is
  // "saved" again, and Send goes through even while the undo's own save is still waiting.
  const storageFull = 'Ads Studio storage quota reached. Remove images, or archive a finished campaign (ask us to close a running one first).';
  const notesNow = String(run('_adsStudioDraft.notes'));
  run(`__patchReply = { error: { status: 413, message: ${JSON.stringify(storageFull)} } }; studioBuilderInput('notes', { value: 'A note the server refuses' }); __runTimers();`);
  const refusedOnce = String(run('_studioBuilder.session.status'));
  run(`studioBuilderInput('notes', { value: ${JSON.stringify(notesNow)} }); __runTimers();`);
  const undoneSaved = String(run('_studioBuilder.session.status'));
  run(`__patchReply = { error: { status: 413, message: ${JSON.stringify(storageFull)} } }; studioBuilderInput('notes', { value: 'Refused again' }); __runTimers();`);
  const refusedTwice = String(run('_studioBuilder.session.status'));
  run(`studioBuilderInput('notes', { value: ${JSON.stringify(notesNow)} });`);  // its save waits; Send settles it
  run("__replies['/api/studio/me'] = [{ value: { ui: 'v2', staffDesk: 'classic', intake: { open: true }, adLimits: { minTotalMinorUSD: 500, maxTotalMinorUSD: 200000, minPerDayMinorUSD: 100, maxDays: 90 } } }];");
  run('var __s1 = studioBuilderSend(null); var __s2 = studioBuilderSend(null); var __same = __s1 === __s2;');
  run('__runTimers();');
  const sent = json('{ same: __same, submits: __calls.filter(call => call.path.startsWith("submit:")), sent: _studioBuilder.sent, session: !!_studioBuilder.session }') || {};
  openAt('/studio?tab=builder&section=boost&step=3');
  const sentHtml = html();
  const sendCases = [
    sent.same === true && Array.isArray(sent.submits) && sent.submits.length === 1 && /^campaign-submit_/.test(sent.submits[0].operationId),
    sent.sent && sent.sent.totalMinor === 5000 && sent.session === false,
    sentHtml.includes('data-testid="studio-builder-sent"') && sentHtml.includes('Sent. <bdi dir="ltr">$50.00</bdi> is reserved, not charged.'),
    refusedOnce === 'error' && undoneSaved === 'saved' && refusedTwice === 'error',
    // Both summaries are read again after a send (Home, My ads and Wallet show the reserve at once).
    json("__calls.some(call => call.path === '/api/studio/campaigns/summary')") === true
  ];
  check('Studio v2 builder sends once (single flight, operationId per action and version) and shows the reserved total the server stamped',
    !loadError && sendCases.every(Boolean), loadError || `cases ${failed(sendCases)}`);

  // P2-05e: every review reason (the server's P1-12 list) opens a step and a field, in both kinds.
  const reasonsPy = [...(actionsPy.match(/REVIEW_REASON_LABELS[^=]*= \{([\s\S]*?)\n\}/) || [])[1].matchAll(/"([a-z_]+)": \{/g)].map(m => m[1]);
  const places = json(`${JSON.stringify(reasonsPy)}.map(code => {
    const field = STUDIO_BUILDER_FIX[code];
    return [code, field, studioBuilderFieldStep('full', field, {}).step, studioBuilderFieldStep('boost', field, { boostType: 'boost_page' }).step,
      studioBuilderFieldStep('boost', field, { boostType: 'boost_post' }).field, studioBuilderFixLabel(code)];
  })`) || [];
  box.state.language = 'ar';
  const arLabel = run("studioBuilderFixLabel('creative_quality')");
  box.state.language = 'en';
  const byCode = Object.fromEntries(places.map(item => [item[0], item.slice(1)]));
  const fixCases = [
    reasonsPy.length === 7 && places.every(item => item[1] && item[2] >= 1 && item[3] >= 1),
    JSON.stringify(byCode.creative_quality) === JSON.stringify(['photos', 3, 1, 'post', 'Fix: photo']) && arLabel === 'أصلح: الصورة',
    byCode.budget_dates[1] === 5 && byCode.budget_dates[2] === 2 && byCode.targeting[1] === 4 && byCode.targeting[2] === 2
      && byCode.page_access[1] === 2 && byCode.other[1] === 6 && byCode.other[2] === 3 && byCode.text_policy[1] === 3
  ];
  // The Fix entry: a sent-back request opens at its step with the field outlined and the team's words.
  run(`state.adCampaignRequests = [{ id: 'req_fix_1', status: 'Changes Requested', createdBy: 'b-user', _lastModified: 7, name: 'Fix me', goalDetail: 'messages', objective: 'messages',
    platforms: ['facebook'], pageName: 'Shop', primaryText: 'Hi', destination: '+218912345678', creativeImages: ['data:image/png;base64,AAAA'], locationKeys: ['libya'],
    budgetMinorUSD: 2000, budgetType: 'lifetime', durationDays: 7, startDate: '2020-01-01', endDate: '2020-01-07', reviewReasonCode: 'creative_quality', reviewNote: '<b>Too dark</b>' }];
    __replies['/api/collections/adCampaignRequests/req_fix_1?include_media=false'] = [{ error: { status: 0, name: 'TypeError', message: 'Failed to fetch' } }];`);
  run("studioBuilderFix('req_fix_1', 'creative_quality');");
  const fixHtml = html();
  fixCases.push(
    search() === '?tab=builder&section=full&step=3' && /data-field="photos" data-fix="1"/.test(fixHtml.replace(/class="[^"]*" /g, ''))
      && fixHtml.includes('data-testid="studio-builder-fix-banner"') && fixHtml.includes('&lt;b&gt;Too dark&lt;/b&gt;') && fixHtml.includes('Photo or video quality'),
    json('_adsStudioDraft.startDate') === run('_adsStudioDateOffset(0)')
  );
  check('Studio v2 builder "Fix: <field>": every review reason maps to a step and a field in both kinds; the sent-back request opens there, outlined',
    !loadError && fixCases.every(Boolean), loadError || `cases ${failed(fixCases)}`);

  // Intake paused (P1-22): the draft still saves, Send is off and says why.
  run(`studioResetMe(); __replies['/api/studio/me'] = [{ value: { ui: 'v2', staffDesk: 'classic', intake: { open: false },
    adLimits: { minTotalMinorUSD: 500, maxTotalMinorUSD: 200000, minPerDayMinorUSD: 100, maxDays: 90 } } }]; studioLoadMe();`);
  run("studioBuilderStart('boost');");
  openAt('/studio?tab=builder&section=boost&step=3');
  const pausedHtml = html();
  const paused = pausedHtml.includes('data-testid="studio-builder-paused"') && /data-testid="studio-builder-send"[^>]*\sdisabled>/.test(pausedHtml)
    && pausedHtml.includes('Sending is paused for now');
  run(`studioResetMe(); __replies['/api/studio/me'] = [{ value: { ui: 'v2', staffDesk: 'classic', intake: { open: true },
    adLimits: { minTotalMinorUSD: 500, maxTotalMinorUSD: 200000, minPerDayMinorUSD: 100, maxDays: 90 } } }]; studioLoadMe();`);

  // The photo path stays the classic one, wrapped only to redraw and save; the address keeps its kind.
  run("studioBuilderStart('boost'); studioBuilderSetBoostKind('boost_page'); __calls.length = 0;");
  run("uploadAdsStudioCreativeFiles([{ type: 'image/png', size: 10 }]);");
  run('__runTimers();');
  const photo = json('{ photos: _adsStudioDraft.creativeImages.length, created: __calls.some(call => call.path === "create:adCampaignRequests" && call.body.creativeImages.length === 1) }') || {};
  hist.reset('/studio?tab=builder&step=2');
  run('render(); __runTimers();');
  const repaired = { search: search(), kind: /data-kind="boost"/.test(html()) };
  const workspaceCss = read('assets/ads-workspace.css');
  const builderCss = workspaceCss.slice(workspaceCss.indexOf('/* Albayan Studio v2 request builder'));
  const hookCases = [
    paused,
    run('uploadAdsStudioCreativeFiles.name') === 'uploadAdsStudioCreativeFilesForBuilder' && run("_studioV2Screens.has('builder') && _studioData.painters.has('builder')") === true
      && !/renderStudioV2Builder\s*=|renderStudioV2CustomerScreen\s*=/.test(builderSrc) && builderSrc.includes("studioV2RegisterScreen('builder', route => studioBuilderRender(route));"),
    photo.photos === 1 && photo.created === true,
    repaired.kind && repaired.search === '?tab=builder&section=boost&step=1',
    builderCss.length > 1000 && read('www/assets/ads-workspace.css') === workspaceCss
      && ['html.dark .studio-b {', 'body.keyboard-open .studio-b-save { display: none; }', '.studio-b-chip { display: inline-flex;', 'min-height: 44px', '.studio-b .is-fix', 'prefers-reduced-motion']
        .every(rule => builderCss.includes(rule))
      && !/background(-color)?:\s*#|[^-]color:\s*#(?!be123c|fda4af)/.test(builderCss)
  ];
  check('Studio v2 builder: intake paused turns Send off; the classic photo path (paste, file input, limits) stays; an address that lost its kind is put right; styles ship',
    !loadError && hookCases.every(Boolean), loadError || `cases ${failed(hookCases)}`);

  // One wallet copy: a money action anywhere in the studio (studioDataRefresh: a withdraw in My ads, a
  // payment in Wallet) renews the builder's wallet lines at once, not after its own half minute.
  run("studioDataReset('b-user'); studioBuilderStart('boost'); studioBuilderInput('budget', { value: '50' });");
  run(`__replies['/api/studio/wallet/summary'] = [{ value: { usd: { availableMinor: 1000, reservedMinor: 0 }, pendingPayments: [] } },
    { value: { usd: { availableMinor: 99900, reservedMinor: 0 }, pendingPayments: [] } }]; studioBuilderLoadWallet();`);
  const shortBefore = run('studioBuilderWalletShort(_studioBuilder.session)');
  run('studioDataRefresh();');
  const shortAfter = run('studioBuilderWalletShort(_studioBuilder.session)');
  const summaryReads = json("__calls.filter(call => call.path === '/api/studio/wallet/summary').length");
  // A read cut off by its timeout is a failure the step explains (Try again); only the app moving on
  // cancels one, and then the next draw simply asks again.
  run("_studioBuilder.pages.state = ''; __replies['/api/studio/pages'] = [{ error: { name: 'AbortError', message: 'signal is aborted without reason' } }]; studioBuilderLoadPages();");
  const pagesTimedOut = String(run('_studioBuilder.pages.state'));
  run("__nav.aborted = true; _studioBuilder.pages.state = ''; __replies['/api/studio/pages'] = [{ error: { name: 'AbortError', message: 'The operation was aborted' } }]; studioBuilderLoadPages();");
  const pagesCancelled = String(run('_studioBuilder.pages.state'));
  run('__nav.aborted = false;');
  const copyCases = [
    shortBefore === true && shortAfter === false && summaryReads >= 2 && !/_studioBuilder\.wallet\b/.test(builderSrc),
    pagesTimedOut === 'failed' && pagesCancelled !== 'failed'  // cancelled: '' and, on the redraw it causes, asked again
  ];
  check('Studio v2 builder: its wallet lines read Home\'s one copy of the summary (renewed by every money action); a timed-out read fails with Try again, a cancelled one is asked again',
    !loadError && copyCases.every(Boolean), loadError || `cases ${failed(copyCases)}`);
}

{
  // P2-06 + P2-07 (Studio v2 wallet and account, 15m): the real 15c, 15g, 15h and 15m run in a sandbox
  // with a fake history, a scripted apiJson and the platform's wallet helpers reduced to apiJson calls;
  // the phone rule is checked against the server's own table (phone_cases.json), and static checks
  // cover the bundle, the styles and the profile route. Promises settle before each run() returns.
  const vm = require('vm');
  const walletSrc = read('src/systems/ads_studio/15m-studio-wallet.js');
  const coreSrc = read('src/systems/ads_studio/15g-studio-core.js');
  const shellSrc = read('src/systems/ads_studio/15h-studio-shell.js');
  const homeSrc = read('src/systems/ads_studio/15j-studio-home.js');
  const phoneTable = JSON.parse(read('server/systems/ads_studio/phone_cases.json')).cases;
  const win = {
    location: { pathname: '/studio', search: '', href: 'http://localhost/studio' },
    listeners: { popstate: [] },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const list = this.listeners[type] || []; const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); },
    localStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })()
  };
  const hist = {
    entries: [], index: 0,
    get length() { return this.entries.length; },
    get state() { return this.entries[this.index] ? this.entries[this.index].state : null; },
    show() { const url = new URL(this.entries[this.index].url, 'http://localhost'); win.location.pathname = url.pathname; win.location.search = url.search; win.location.href = url.href; },
    reset(url) { this.entries = [{ url, state: null }]; this.index = 0; this.show(); },
    pushState(entryState, _title, url) { this.entries.splice(this.index + 1); this.entries.push({ url: String(url), state: JSON.parse(JSON.stringify(entryState)) }); this.index++; this.show(); },
    replaceState(entryState, _title, url) { this.entries[this.index] = { url: String(url || this.entries[this.index].url), state: JSON.parse(JSON.stringify(entryState)) }; this.show(); },
    go(delta) {
      const next = this.index + delta;
      if (!delta || next < 0 || next >= this.entries.length) return;
      this.index = next; this.show();
      for (const fn of [...win.listeners.popstate]) fn({ state: this.state });
    },
    back() { this.go(-1); }
  };
  win.history = hist;
  let idSeq = 0;
  const box = vm.createContext({
    state: { language: 'en', theme: 'light', currentUser: { id: 'wallet-user', name: 'Sara <script>x</script>', email: 'sara@albayan.example' }, currentView: 'ads-studio', adCampaignRequests: [] },
    Security: {
      escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      generateSecureId: prefix => `${prefix}_${Date.now()}_${String(++idSeq).padStart(12, '0')}`,
      isValidRecordId: value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(value ?? '').trim())
    },
    window: win, history: hist, URLSearchParams, URL,
    isServerModeEnabled: () => true,
    isCurrentUserAdmin: () => false,
    currentUserHasPermission: (collection, action) => action !== 'review',
    hasSubscription: id => id === 'ad_maker',
    updateUrlParams: () => {},
    requestViewScrollReset: () => {},
    IS_STUDIO_SHELL: true
  }, { microtaskMode: 'afterEvaluate' });
  let loadError = '';
  try {
    const at = forms.indexOf('function normalizeDigitsAscii(');
    vm.runInContext(forms.slice(at, forms.indexOf('\n}\n', at) + 2), box);
    vm.runInContext(`
      var __calls = [];
      var __replies = Object.create(null);
      var __timers = new Map();
      var __timerSeq = 0;
      var __html = '';
      var __notes = [];
      var __sheet = null;
      var __plan = null;
      var __held = [];                 // answers held back until the test lets them arrive (__held.shift()())
      var __nav = { aborted: false };  // the app's navigation signal (09-api-auth.js getNavigationSignal)
      function getNavigationSignal() { return __nav; }
      var performance = { now: () => 100, getEntriesByType: () => [{ type: 'navigate', name: '' }] };
      var document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelectorAll: () => [] };
      function setTimeout(fn, ms) { const id = ++__timerSeq; __timers.set(id, { fn, ms: Number(ms) || 0 }); return id; }
      function clearTimeout(id) { __timers.delete(id); }
      function apiJson(path, options) {
        const method = String((options && options.method) || 'GET');
        __calls.push({ path: String(path), method, body: options && options.body !== undefined ? JSON.parse(JSON.stringify(options.body)) : undefined });
        const next = (__replies[method + ' ' + path] || []).shift();
        if (!next) return new Promise(() => {});
        if (next.error) return Promise.reject(Object.assign(new Error(next.error.message || 'Request failed'), next.error));
        if (next.hold) return new Promise(resolve => { __held.push(() => resolve(JSON.parse(JSON.stringify(next.value)))); });
        return Promise.resolve(JSON.parse(JSON.stringify(next.value)));
      }
      // The platform's wallet helpers (09-api-auth.js), reduced to their calls.
      function apiWalletPaymentRequestCreate(amountMinor, method, idempotencyKey, currency) {
        return apiJson('/api/wallet/payment-requests', { method: 'POST', body: { amountMinor, currency, method, idempotencyKey } });
      }
      function apiWalletPaymentRequestDecide(requestId, action) {
        return apiJson('/api/wallet/payment-requests/' + requestId + '/' + action, { method: 'POST', body: {} });
      }
      function showNotification(title, text, type) { __notes.push({ title: String(title), text: String(text), type }); }
      function hubPlanForService() { return __plan; }
      function refreshSubscriptionPlans() { return Promise.resolve([]); }
      window.addEventListener('popstate', () => { restoreAdsStudioTabFromUrl(); render(); });
    `, box);
    vm.runInContext(adsStudio, box);
    vm.runInContext(coreSrc, box);
    vm.runInContext(shellSrc, box);
    vm.runInContext(homeSrc, box);  // Home's data layer: the one copy of the wallet summary
    vm.runInContext(walletSrc, box);
    vm.runInContext("function render() { const html = renderStudioV2View(); __html = html || '<classic>'; }", box);
    // The sheet needs a real page (e2e covers it); here its options are kept and confirmed by hand.
    vm.runInContext('studioWalletSheet = function (options) { __sheet = options; };', box);
  } catch (error) { loadError = String(error && error.message || error); }
  const run = code => { try { return vm.runInContext(code, box); } catch (error) { return `THREW ${error && error.message}`; } };
  const json = code => { try { return JSON.parse(String(run(`JSON.stringify(${code})`))); } catch (_) { return undefined; } };
  const html = () => String(run('__html'));
  const failed = cases => cases.map((ok, i) => ok ? '' : i).filter(String).join(',');
  const reply = (method, path, value) => run(`(__replies[${JSON.stringify(`${method} ${path}`)}] = __replies[${JSON.stringify(`${method} ${path}`)}] || []).push(${JSON.stringify({ value })});`);
  const replyError = (method, path, error) => run(`(__replies[${JSON.stringify(`${method} ${path}`)}] = __replies[${JSON.stringify(`${method} ${path}`)}] || []).push(${JSON.stringify({ error })});`);
  const calls = (method, path) => (json('__calls') || []).filter(c => c.method === method && c.path === path);
  const openAt = url => { hist.reset(url); run('_studioV2.docRendered = false; render();'); };
  const inLanguage = (language, code) => { box.state.language = language; const out = run(code); box.state.language = 'en'; return out; };
  const between = (page, testid, end) => {
    const at = page.indexOf(`data-testid="${testid}"`);
    return at < 0 ? '' : page.slice(at, end ? page.indexOf(end, at) : undefined);
  };
  const textOf = (page, testid) => {
    const at = page.indexOf(`data-testid="${testid}"`);
    if (at < 0) return null;
    const open = page.indexOf('>', at);
    return page.slice(open + 1, page.indexOf('</', open)).replace(/<[^>]+>/g, '').trim() || page.slice(open + 1, page.indexOf('</p>', open)).replace(/<[^>]+>/g, '').trim();
  };
  const amountOf = (page, testid) => {
    const at = page.indexOf(`data-testid="${testid}"`);
    if (at < 0) return null;
    return (page.slice(at).match(/<bdi dir="ltr">([^<]*)<\/bdi>/) || [])[1] || null;
  };
  const noDollarOnDinars = page => !/\$[^<\s]*\s*(?:LYD|د\.ل)/.test(page) && !/(?:LYD|د\.ل)\s*\$/.test(page);
  const plain = page => String(page).replace(/<[^>]+>/g, '');

  // A wallet as GET /api/studio/wallet/summary answers it (P1-07), the owner's payment requests
  // and the methods catalog (payment_methods.py instructions, the exact server templates).
  const iso = minutesAgo => new Date(Date.now() - minutesAgo * 60000).toISOString();
  const step = (kind, ref, amountMinor, en, ar) => ({ kind, ref, transactionId: `t_${ref}_${amountMinor}`, amountMinor, at: '2026-09-22T10:00:00Z', labels: { en, ar } });
  const summary = (overrides = {}) => ({
    usd: { addedMinor: 10000, adjustmentsMinor: 0, reservedMinor: 1000, inAdsMinor: 2000, metaUsedInAdsMinor: null, metaCheckedAt: null,
      beingReturnedMinor: 0, spentMinor: 500, availableMinor: 6500, ...(overrides.usd || {}) },
    reserved: [{ campaignId: 'cmp_wait', name: 'Waiting ad', submittedAt: '2026-09-20T10:00:00Z', budgetMinor: 1000, dailyMinor: 200, days: 5 }],
    inAds: [],
    chains: overrides.chains || [
      { campaignId: 'cmp_sale', name: 'Summer <b>sale</b>', archived: false, requestMissing: false, state: 'in_ads', bucket: 'inAds', paidMinor: 2000, returnedMinor: 0,
        netMinor: 2000, paidAt: '2026-09-22T10:00:00Z', metaUsedMinor: null, checkedAt: null,
        steps: [step('payment', 'cpay', 2000, 'Ad budget paid: Summer <b>sale</b>', 'دفع ميزانية إعلان: Summer <b>sale</b>')] },
      { campaignId: 'cmp_old', name: 'Old ad', archived: true, requestMissing: false, state: 'spent', bucket: 'spent', paidMinor: 1000, returnedMinor: 500,
        netMinor: 500, paidAt: '2026-09-10T10:00:00Z', metaUsedMinor: null, checkedAt: null,
        steps: [step('payment', 'cpay', 1000, 'Ad budget paid: Old ad', 'دفع ميزانية إعلان: Old ad'), step('return', 'stoprefund', 500, 'Unused budget returned from: Old ad', 'استرجاع ما لم تصرفه ميتا من: Old ad')] },
      { campaignId: 'cmp_old', name: 'Old ad', archived: true, requestMissing: false, state: 'returned', bucket: 'beingReturned', paidMinor: 700, returnedMinor: 700,
        netMinor: 0, paidAt: '2026-09-01T10:00:00Z', metaUsedMinor: null, checkedAt: null,
        steps: [step('payment', 'cpay', 700, 'Ad budget paid: Old ad', 'دفع ميزانية إعلان: Old ad'), step('return', 'rel', 700, 'Ad budget returned (not approved)', 'استرجاع ميزانية إعلان لم يُعتمد')] }
    ],
    lyd: { balanceMinor: 5000 },
    pendingPayments: [
      { reference: 'PAY-USDAAAA1', amountMinor: 2500, currency: 'USD', createdAt: '2026-09-25T08:00:00Z', dueAt: null },
      { reference: 'PAY-LYDBBBB2', amountMinor: 15000, currency: 'LYD', createdAt: '2026-09-25T07:00:00Z', dueAt: null }
    ]
  });
  const requests = { requests: [
    { id: 'wpr_1', data: { reference: 'PAY-USDAAAA1', status: 'pending', currency: 'USD', amountMinor: 2500, amountMinorLYD: 17250, lydRate: 6.9, method: 'adfali', createdAt: '2026-09-25T08:00:00Z' } },
    { id: 'wpr_2', data: { reference: 'PAY-LYDBBBB2', status: 'pending', currency: 'LYD', amountMinor: 15000, amountMinorLYD: 15000, method: 'bank_transfer', createdAt: '2026-09-25T07:00:00Z' } },
    { id: 'wpr_3', data: { reference: 'PAY-DONECCC3', status: 'confirmed', currency: 'USD', amountMinor: 10000, method: 'adfali', createdAt: '2026-09-20T07:00:00Z', confirmedAt: '2026-09-20T09:00:00Z' } }
  ] };
  const methodsCatalog = { methods: [
    { id: 'adfali', name: { en: 'Adfali', ar: 'ادفع لي' }, desc: { en: 'Pay from your phone balance', ar: 'ادفع من رصيد هاتفك' }, icon: 'smartphone', requiresReceiptPhoto: false,
      instructions: { en: 'Pay {amountLYD} LYD via Adfali and keep the code {reference} in the payment note.', ar: 'ادفع {amountLYD} د.ل عبر ادفع لي واذكر الرمز {reference} في ملاحظة الدفع.' } },
    { id: 'bank_transfer', name: { en: 'Bank transfer', ar: 'حوالة مصرفية' }, desc: { en: 'Transfer and attach the receipt photo', ar: 'حوّل وأرفق صورة الإيصال' }, icon: 'landmark', requiresReceiptPhoto: true,
      instructions: { en: 'Transfer {amountLYD} LYD, write {reference} in the transfer note, then attach the receipt photo here.', ar: 'حوّل {amountLYD} د.ل واكتب {reference} في بيان الحوالة ثم أرفق صورة الإيصال هنا.' } }
  ], rate: { usdToLyd: 6.9, date: '2026-09-25' } };
  const SUMMARY = '/api/studio/wallet/summary';
  const MINE = '/api/wallet/payment-requests';
  const METHODS = '/api/wallet/payment-requests/methods';
  const allHtml = [];

  check('Studio v2 wallet (15m) ships in the lazy studio bundle after the shell, in both built copies, and studio.js stays under 1 MiB',
    !loadError && bundleManifestJson.lazy['studio.js'].indexOf('systems/ads_studio/15m-studio-wallet.js') > bundleManifestJson.lazy['studio.js'].indexOf('systems/ads_studio/15h-studio-shell.js')
      && !bundleManifestJson.files.some(file => /15m-studio/.test(file))
      && [read('studio.js'), read('www/studio.js')].every(bundle => bundle.includes(walletSrc))
      && fs.statSync(path.join(ROOT, 'studio.js')).size < 1024 * 1024
      && run("_studioV2Screens.has('wallet') && _studioV2Screens.has('account')") === true && !/renderStudioV2CustomerScreen\s*=/.test(walletSrc),
    loadError || `studio.js ${fs.statSync(path.join(ROOT, 'studio.js')).size} bytes`);

  // The phone rule: the screens and the server read every typed number the same way.
  const phoneWrong = phoneTable.filter(([raw, want]) => run(`studioParsePhone(${JSON.stringify(raw)})`) !== want).map(([raw]) => JSON.stringify(raw));
  check('Studio v2 phone rule: studioParsePhone gives the server table (phone_cases.json, also read by test_studio_profile.py)',
    !loadError && phoneTable.length >= 30 && phoneWrong.length === 0, loadError || `wrong: ${phoneWrong.join(' ')}`);

  // The wallet screen: the four numbers, pending payments with their code and instructions, the
  // money of each ad grouped by ad, the dinar plan card, recent payments.
  run("studioResetMe(); __replies['GET /api/studio/me'] = [{ value: { ui: 'v2', staffDesk: 'classic', isStaff: false, contact: { whatsapp: '0912345678' } } }]; studioLoadMe();");
  reply('GET', SUMMARY, summary());
  reply('GET', MINE, requests);
  reply('GET', METHODS, methodsCatalog);
  openAt('/studio?tab=wallet');
  const en = html();
  allHtml.push(en);
  box.state.language = 'ar';
  run('render();');
  const ar = html();
  box.state.language = 'en';
  allHtml.push(ar);
  const usdCard = between(en, 'studio-wallet-pending-item', '</article>');
  const lydCardEn = en.slice(en.indexOf('data-currency="LYD"'), en.indexOf('</article>', en.indexOf('data-currency="LYD"')));
  const lydCardAr = ar.slice(ar.indexOf('data-currency="LYD"'), ar.indexOf('</article>', ar.indexOf('data-currency="LYD"')));
  const adCards = en.split('data-testid="studio-wallet-ad"').slice(1);
  const walletCases = [
    en.includes('data-testid="studio-screen-wallet"') && en.includes('data-testid="studio-wallet-numbers"') && en.includes('data-testid="studio-v2-frame"'),
    amountOf(en, 'studio-wallet-available-amount') === '$65.00' && amountOf(en, 'studio-wallet-reserved-amount') === '$10.00'
      && amountOf(en, 'studio-wallet-in-ads-amount') === '$20.00' && amountOf(en, 'studio-wallet-spent-amount') === '$5.00',
    !en.includes('data-testid="studio-wallet-meta-used"') && !en.includes('data-testid="studio-wallet-ad-meta-used"') && !/Meta used/.test(en),
    !en.includes('data-testid="studio-wallet-being-returned"'),
    amountOf(en, 'studio-wallet-lyd-amount') === '50.00 LYD' && amountOf(ar, 'studio-wallet-lyd-amount') === '50.00 د.ل'
      && !between(en, 'studio-wallet-lyd', '</section>').includes('$') && !between(ar, 'studio-wallet-lyd', '</section>').includes('$'),
    usdCard.includes('PAY-USDAAAA1') && plain(usdCard).includes('Pay 172.50 LYD via Adfali and keep the code PAY-USDAAAA1 in the payment note.')
      && usdCard.includes('<bdi dir="ltr" class="studio-v2-wallet-nowrap">PAY-USDAAAA1</bdi> in the payment note.')
      && usdCard.includes('$25.00') && usdCard.includes('172.50 LYD') && usdCard.includes("studioWalletCopy('PAY-USDAAAA1')")
      && usdCard.includes("studioWalletAskCancel('wpr_1')") && !usdCard.includes('studio-wallet-receipt'),
    lydCardEn.includes('150.00 LYD') && !lydCardEn.includes('$') && lydCardEn.includes('data-testid="studio-wallet-receipt"')
      && lydCardEn.includes("studioWalletAttachReceipt('wpr_2', this)") && lydCardAr.includes('150.00 د.ل') && !lydCardAr.includes('$')
      && plain(lydCardAr).includes('حوّل 150.00 د.ل واكتب PAY-LYDBBBB2 في بيان الحوالة ثم أرفق صورة الإيصال هنا.'),
    adCards.length === 2 && adCards[0].includes('data-campaign="cmp_sale"') && (adCards[1].match(/data-testid="studio-wallet-cycle"/g) || []).length === 2
      && adCards[1].includes('Archived') && adCards[1].includes('Unused budget returned from: Old ad') && adCards[1].includes('Returned in full'),
    !en.includes('<b>sale</b>') && en.includes('Summer &lt;b&gt;sale&lt;/b&gt;') && !ar.includes('<b>sale</b>'),
    between(en, 'studio-wallet-reserved-list', '</section>').includes('$10.00') && between(en, 'studio-wallet-reserved-list', '</section>').includes('$2.00 a day for 5 days'),
    (en.match(/data-testid="studio-wallet-history-item"/g) || []).length === 1 && between(en, 'studio-wallet-history', '</section>').includes('PAY-DONECCC3'),
    ar.includes('dir="rtl"') && ar.includes('متاح') && ar.includes('في إعلاناتك') && ar.includes('رصيد الاشتراك (بالدينار)') && noDollarOnDinars(en) && noDollarOnDinars(ar),
    /data-testid="studio-wallet-add"[^>]*onclick="studioWalletOpenAdd\(\)"/.test(en) && !/data-testid="studio-wallet-add"[^>]*disabled/.test(en),
    calls('GET', SUMMARY).length === 1 && calls('GET', MINE).length === 1 && calls('GET', METHODS).length === 1,
    ['numbers', 'available', 'reserved', 'in-ads', 'spent', 'where', 'add', 'refresh', 'pending', 'reserved-list', 'ads', 'lyd', 'history']
      .every(id => [en, ar].every(page => (page.match(new RegExp(`data-testid="studio-wallet-${id}"`, 'g')) || []).length === 1))
  ];
  check('Studio v2 wallet: the four numbers equal the wallet summary, no "Meta used" before a link, dinars never with "$", pending codes with the method\'s own instructions, money grouped by ad, EN/AR',
    !loadError && walletCases.every(Boolean), loadError || `cases ${failed(walletCases)}`);

  // Meta used (once linked and checked) and "On its way back" appear only when the server says so.
  const linked = summary({ usd: { metaUsedInAdsMinor: 340, metaCheckedAt: iso(5), beingReturnedMinor: 700 } });
  linked.chains[0] = { ...linked.chains[0], metaUsedMinor: 340, checkedAt: iso(5) };
  reply('GET', SUMMARY, linked);
  reply('GET', MINE, requests);
  run('studioWalletRefresh();');
  const withMeta = html();
  allHtml.push(withMeta);
  box.state.language = 'ar';
  run('render();');
  const withMetaAr = html();
  box.state.language = 'en';
  const reloadCalls = calls('GET', SUMMARY).length;
  run('render(); render();');
  run('studioWalletWhereToggle({ open: true }); render();');
  const whereOpen = html();
  run('studioWalletWhereToggle({ open: false }); render();');
  const whereClosed = html();
  const metaCases = [
    /data-testid="studio-wallet-where" ontoggle="studioWalletWhereToggle\(this\)" open>/.test(whereOpen) && /data-testid="studio-wallet-where" ontoggle="studioWalletWhereToggle\(this\)">/.test(whereClosed),
    textOf(withMeta, 'studio-wallet-meta-used') === 'Meta used $3.40 so far · checked 5 min ago',
    textOf(withMeta, 'studio-wallet-ad-meta-used') === 'Meta used $3.40 so far · checked 5 min ago',
    textOf(withMetaAr, 'studio-wallet-meta-used') === 'استخدمت ميتا $3.40 حتى الآن · فُحص قبل 5 دقائق',
    between(withMeta, 'studio-wallet-being-returned', 'usually within minutes').includes('$7.00'),
    reloadCalls === 2 && calls('GET', SUMMARY).length === 2  // a fresh answer is reused by later draws
  ];
  check('Studio v2 wallet: "Meta used $Y · checked X ago" and "On its way back" only when the server sends them; a fresh answer is not read again',
    !loadError && metaCases.every(Boolean), loadError || `cases ${failed(metaCases)}`);

  // Add money (J2): purpose first, amount (Arabic digits), method, a confirm screen, then the code.
  run("studioWalletOpenAdd();");
  const purposeStep = html();
  const addUrl = win.location.search;
  run("studioWalletPickPurpose('ads');");
  const amountStep = html();
  run("studioWalletAmountInput({ value: '0.5' }); studioWalletFlowStep(1);");
  const tooSmall = json('_studioWallet.add') || {};
  run("studioWalletAmountInput({ value: 'abc' }); studioWalletFlowStep(1);");
  const notNumber = json('_studioWallet.add') || {};
  run("studioWalletAmountInput({ value: '٢٥' });");
  const helpText = run('studioWalletAmountHelp(_studioWallet.add)');
  run('studioWalletFlowStep(1);');
  const methodStep = html();
  run("studioWalletPickMethod('adfali');");
  const confirmStep = html();
  allHtml.push(purposeStep, amountStep, methodStep, confirmStep);
  replyError('POST', MINE, { name: 'TypeError', message: 'Failed to fetch' });
  run('studioWalletCreate(); studioWalletCreate();');
  const afterFailure = { posts: calls('POST', MINE).length, error: (json('_studioWallet.add') || {}).error, screen: html() };
  reply('POST', MINE, { id: 'wpr_new', data: { reference: 'PAY-NEWDDDD4', status: 'pending', currency: 'USD', amountMinor: 2500, amountMinorLYD: 17250, lydRate: 6.9, method: 'adfali', createdAt: '2026-09-25T10:00:00Z' } });
  reply('GET', SUMMARY, summary());
  reply('GET', MINE, requests);
  run('studioWalletCreate();');
  const created = html();
  allHtml.push(created);
  const posts = calls('POST', MINE);
  run("studioWalletOpenAdd('ads', 5000); studioWalletPickMethod('adfali');");
  reply('POST', MINE, { id: 'wpr_new2', data: { reference: 'PAY-NEWEEEE5', status: 'pending', currency: 'USD', amountMinor: 5000, amountMinorLYD: 34500, method: 'adfali' } });
  reply('GET', SUMMARY, summary());
  reply('GET', MINE, requests);
  run('studioWalletCreate();');
  const secondPost = calls('POST', MINE).slice(-1)[0] || {};
  const addCases = [
    addUrl === '?tab=wallet&id=add-money' && purposeStep.includes('data-testid="studio-wallet-purpose-ads"') && purposeStep.includes('data-testid="studio-wallet-purpose-plan"')
      && purposeStep.includes('Step 1 of 4: Purpose') && purposeStep.includes('You pay in dinars either way'),
    ['1000', '2500', '5000', '10000'].every(minor => amountStep.includes(`data-testid="studio-wallet-preset-${minor}"`)) && amountStep.includes('id="studio-wallet-amount"')
      && amountStep.includes('$25.00') && amountStep.includes('$100.00'),
    tooSmall.step === 2 && tooSmall.error === 'The smallest amount is $1.00.' && notNumber.step === 2 && notNumber.error === 'Type the amount in numbers, such as 25 or 25.50.',
    helpText === "= $25.00 · about 172.50 LYD at today's rate (estimate)",
    methodStep.includes('data-testid="studio-wallet-method-adfali"') && methodStep.includes('data-testid="studio-wallet-method-bank_transfer"') && methodStep.includes('You attach a photo of the transfer receipt.'),
    textOf(confirmStep, 'studio-wallet-confirm-amount') === '$25.00' && textOf(confirmStep, 'studio-wallet-confirm-method') === 'Adfali'
      && amountOf(confirmStep, 'studio-wallet-confirm-lyd') === '172.50 LYD' && confirmStep.includes('What happens next') && confirmStep.includes('data-testid="studio-wallet-create"'),
    afterFailure.posts === 1 && afterFailure.error === run('STUDIO_ERROR_KIND_TEXTS.action.NETWORK[0]') && afterFailure.error.length > 20
      && afterFailure.screen.includes(afterFailure.error),
    posts.length === 2 && JSON.stringify(posts[0].body) === JSON.stringify(posts[1].body) && posts[1].body.amountMinor === 2500 && posts[1].body.currency === 'USD'
      && posts[1].body.method === 'adfali' && /^studiopay_\d+_\d{12}$/.test(posts[1].body.idempotencyKey),
    created.includes('data-testid="studio-wallet-created"') && amountOf(created, 'studio-wallet-created-reference') === 'PAY-NEWDDDD4'
      && plain(created).includes('Pay 172.50 LYD via Adfali and keep the code PAY-NEWDDDD4 in the payment note.') && amountOf(created, 'studio-wallet-created-lyd') === '172.50 LYD'
      && created.includes("studioWalletCopy('PAY-NEWDDDD4')") && created.includes('onclick="studioWalletFinishAdd()"'),
    secondPost.body && secondPost.body.amountMinor === 5000 && secondPost.body.idempotencyKey !== posts[1].body.idempotencyKey
  ];
  check('Studio v2 Add money: purpose, amount ($10-$100 or typed, Arabic digits), method, confirm screen, one key per request replayed after a lost answer, single-flight, the PAY- code and how to pay',
    !loadError && addCases.every(Boolean), loadError || `cases ${failed(addCases)}`);

  // Dinars for the plan: LYD all the way (never "$"), the plan price as the ready amount.
  run("__plan = { id: 'svc:ad_maker', priceMinor: 12000, currency: 'LYD' }; studioWalletOpenAdd('plan');");
  const planAmount = html();
  run('studioWalletPickAmount(12000); studioWalletFlowStep(1);');
  run("studioWalletPickMethod('bank_transfer');");
  const planConfirm = html();
  box.state.language = 'ar';
  run('render();');
  const planConfirmAr = html();
  box.state.language = 'en';
  allHtml.push(planAmount, planConfirm, planConfirmAr);
  reply('POST', MINE, { id: 'wpr_lyd', data: { reference: 'PAY-LYDFFFF6', status: 'pending', currency: 'LYD', amountMinor: 12000, amountMinorLYD: 12000, method: 'bank_transfer' } });
  reply('GET', SUMMARY, summary());
  reply('GET', MINE, requests);
  run('studioWalletCreate();');
  const planCreated = html();
  allHtml.push(planCreated);
  const planPost = calls('POST', MINE).slice(-1)[0] || {};
  // No dollar rate: a dollar request cannot say what to pay in dinars, so it is not created.
  run("studioWalletOpenAdd('ads', 2500); studioWalletPickMethod('adfali'); _studioWallet.rate = 0; render();");
  const noRate = html();
  allHtml.push(noRate);
  const postsBefore = calls('POST', MINE).length;
  run('studioWalletCreate();');
  run('_studioWallet.rate = 6.9;');
  const planCases = [
    planAmount.includes('data-testid="studio-wallet-preset-12000"') && planAmount.includes('Plan price') && planAmount.includes('120.00 LYD') && !between(planAmount, 'studio-wallet-add-flow').includes('$'),
    textOf(planConfirm, 'studio-wallet-confirm-amount') === '120.00 LYD' && !planConfirm.includes('studio-wallet-confirm-lyd')
      && !between(planConfirm, 'studio-wallet-confirm', '</dl>').includes('$') && planConfirm.includes('the dinars then appear on your plan balance'),
    textOf(planConfirmAr, 'studio-wallet-confirm-amount') === '120.00 د.ل' && noDollarOnDinars(planConfirmAr),
    planPost.body && planPost.body.currency === 'LYD' && planPost.body.amountMinor === 12000 && planPost.body.method === 'bank_transfer',
    planCreated.includes('PAY-LYDFFFF6') && !between(planCreated, 'studio-wallet-created', '</dl>').includes('$') && planCreated.includes('data-testid="studio-wallet-receipt"'),
    noRate.includes('data-testid="studio-wallet-no-rate"') && /data-testid="studio-wallet-create"[^>]*disabled/.test(noRate) && noRate.includes('+218912345678')
      && calls('POST', MINE).length === postsBefore
  ];
  check('Studio v2 Add money for the plan: dinars all the way (never "$"), the plan price as the ready amount; no dollar request without today\'s rate',
    !loadError && planCases.every(Boolean), loadError || `cases ${failed(planCases)}`);

  // Cancel a waiting request: an in-page sheet first, one call however many taps.
  reply('GET', SUMMARY, summary());
  reply('GET', MINE, requests);
  run("studioWalletFinishAdd(); studioWalletRefresh();");
  run("__sheet = null; studioWalletAskCancel('wpr_1');");
  const sheet = json('__sheet ? { title: __sheet.title, text: __sheet.text, confirm: __sheet.confirm, cancel: __sheet.cancel, danger: __sheet.danger, testid: __sheet.testid } : null') || {};
  reply('POST', '/api/wallet/payment-requests/wpr_1/cancel', { id: 'wpr_1', data: { status: 'canceled' } });
  reply('GET', SUMMARY, summary());
  reply('GET', MINE, requests);
  run("__notes.length = 0; __sheet.onConfirm(); studioWalletCancel('wpr_1');");
  const cancelCalls = calls('POST', '/api/wallet/payment-requests/wpr_1/cancel');
  const cancelNote = json('__notes') || [];
  run("__sheet = null; studioWalletAskCancel('wpr_3'); studioWalletAskCancel('nope');");
  const noSheetForDone = run('__sheet');
  const cancelCases = [
    sheet.testid === 'studio-wallet-cancel-sheet' && sheet.danger === true && sheet.title === 'Cancel this payment request?' && sheet.text.includes('PAY-USDAAAA1') && sheet.cancel === 'Keep it',
    cancelCalls.length === 1 && cancelNote.length === 1 && cancelNote[0].type === 'success' && cancelNote[0].title === 'Payment request cancelled',
    noSheetForDone === null
  ];
  check('Studio v2 wallet: cancelling a payment request asks in an in-page sheet (never a native dialog) and calls the server once',
    !loadError && cancelCases.every(Boolean), loadError || `cases ${failed(cancelCases)}`);

  // Account (P2-07): name read only, language, theme, the optional WhatsApp number with consent, sign out.
  const PROFILE = '/api/studio/profile';
  reply('GET', PROFILE, { whatsappNumber: null, whatsappConsentAt: null, updatedAt: null });
  openAt('/studio?tab=account');
  const account = html();
  run('studioAccountEdit(true);');
  const editor = html();
  run("studioAccountDraftNumber({ value: '٠٩١ ٢٣٤ ٥٦٧٨' }); studioAccountSave();");
  const noConsent = { puts: calls('PUT', PROFILE).length, error: String(run('_studioAccount.formError')), screen: html() };
  run("studioAccountDraftNumber({ value: '12345' }); studioAccountDraftConsent({ checked: true }); studioAccountSave();");
  const badNumber = { puts: calls('PUT', PROFILE).length, error: String(run('_studioAccount.formError')) };
  reply('PUT', PROFILE, { whatsappNumber: '+218912345678', whatsappConsentAt: '2026-09-25T10:00:00Z', updatedAt: '2026-09-25T10:00:00Z' });
  run("studioAccountDraftNumber({ value: '٠٩١ ٢٣٤ ٥٦٧٨' }); studioAccountDraftConsent({ checked: true }); studioAccountSave(); studioAccountSave();");
  const saved = html();
  const savePuts = calls('PUT', PROFILE);
  run('studioAccountEdit(true);');
  const reConsent = run('_studioAccount.draftConsent');
  run('studioAccountEdit(false);');
  box.state.language = 'ar';
  run('render();');
  const accountAr = html();
  box.state.language = 'en';
  run("__sheet = null; studioAccountAskRemove();");
  const removeSheet = json('__sheet ? { testid: __sheet.testid, danger: __sheet.danger } : null') || {};
  reply('PUT', PROFILE, { whatsappNumber: null, whatsappConsentAt: null, updatedAt: '2026-09-25T11:00:00Z' });
  run('__sheet.onConfirm();');
  const removed = html();
  const removePut = calls('PUT', PROFILE).slice(-1)[0] || {};
  allHtml.push(account, editor, noConsent.screen, saved, accountAr, removed);
  const accountCases = [
    account.includes('data-testid="studio-screen-account"') && account.includes('Sara &lt;script&gt;x&lt;/script&gt;') && !account.includes('<script>x')
      && account.includes('data-testid="studio-account-language"') && account.includes('onclick="toggleLanguage()"') && account.includes('onclick="toggleTheme()"')
      && /data-testid="studio-account-logout"[^>]*onclick="handleLogout\(\)"/.test(account) && account.includes('href="/privacy"')
      && account.includes('data-testid="studio-account-whatsapp-none"') && calls('GET', PROFILE).length === 1,
    editor.includes('id="studio-account-whatsapp"') && editor.includes('type="tel"') && editor.includes('id="studio-account-whatsapp-consent"') && !editor.includes(' checked'),
    noConsent.puts === 0 && noConsent.error === 'Tick the box to allow us to contact you on WhatsApp.' && noConsent.screen.includes(noConsent.error)
      && noConsent.screen.includes('We will save it as +218912345678.'),
    badNumber.puts === 0 && badNumber.error.startsWith('Type a WhatsApp number'),
    savePuts.length === 1 && JSON.stringify(savePuts[0].body) === JSON.stringify({ whatsappNumber: '+218912345678', whatsappConsent: true })
      && amountOf(saved, 'studio-account-whatsapp-number') === '+218912345678' && saved.includes('data-testid="studio-account-whatsapp-remove"'),
    reConsent === false,
    accountAr.includes('dir="rtl"') && accountAr.includes('واتساب (اختياري)') && accountAr.includes('تسجيل الخروج') && accountAr.includes('اللغة'),
    removeSheet.testid === 'studio-account-remove-sheet' && removeSheet.danger === true
      && JSON.stringify(removePut.body) === JSON.stringify({ whatsappNumber: null, whatsappConsent: false }) && removed.includes('data-testid="studio-account-whatsapp-none"')
  ];
  check('Studio v2 Account: name read only (escaped), language, theme, sign out; a WhatsApp number is sent only as E.164 with the consent box ticked; removal asks first',
    !loadError && accountCases.every(Boolean), loadError || `cases ${failed(accountCases)}`);

  // ONE copy of the wallet summary (Home's, 15j): a money action anywhere in the studio (a withdraw in
  // My ads calls studioDataRefresh) shows on Wallet at once, not after Wallet's own half minute, and
  // Wallet's own actions renew what Home and My ads show.
  const withoutUsdPending = { ...summary(), pendingPayments: summary().pendingPayments.slice(1) };
  run("studioDataReset('wallet-user'); _studioWallet.requestsAt = 0;");
  reply('GET', SUMMARY, summary());
  reply('GET', MINE, requests);
  openAt('/studio?tab=wallet');
  const oneCopyBefore = amountOf(html(), 'studio-wallet-available-amount');
  const readsBeforeRefresh = calls('GET', SUMMARY).length;
  reply('GET', SUMMARY, summary({ usd: { reservedMinor: 0, availableMinor: 7500 } }));
  run('studioDataRefresh();');  // what 15k's studioAdsAfterMoney does after "$10.00 is available again"
  run('render();');  // Wallet's next draw (15j redraws once the answer is in)
  const oneCopyAfter = amountOf(html(), 'studio-wallet-available-amount');
  const readsAfterRefresh = calls('GET', SUMMARY).length - readsBeforeRefresh;
  // A forced read after Cancel never joins a read that started before the cancel (that older answer
  // can still list the request as waiting): one more read follows it.
  run('_studioData.slots.wallet.loadedAt -= 31000;');  // the wallet has been open for a while
  const readsBeforeCancel = calls('GET', SUMMARY).length;
  run(`__replies['GET ${SUMMARY}'] = [{ hold: true, value: ${JSON.stringify(summary())} }, { value: ${JSON.stringify(withoutUsdPending)} }];
    __replies['GET ${MINE}'] = [{ value: ${JSON.stringify(requests)} }, { value: ${JSON.stringify(requests)} }];`);
  reply('POST', '/api/wallet/payment-requests/wpr_1/cancel', { id: 'wpr_1', data: { status: 'canceled' } });
  run("studioWalletCancel('wpr_1');");
  const readsWhileHeld = calls('GET', SUMMARY).length - readsBeforeCancel;
  run('__held.shift()(); render();');
  const readsAfterCancel = calls('GET', SUMMARY).length - readsBeforeCancel;
  const pendingAfterCancel = json('studioWalletSummary().pending.map(item => item.reference)') || [];
  const homePendingAfterCancel = json("studioDataValue('wallet').pendingPayments.map(item => item.reference)") || [];
  const cancelledScreen = html();
  const oneCopyCases = [
    oneCopyBefore === '$65.00' && oneCopyAfter === '$75.00' && readsAfterRefresh === 1,
    readsWhileHeld === 1 && readsAfterCancel === 2 && JSON.stringify(pendingAfterCancel) === '["PAY-LYDBBBB2"]'
      && JSON.stringify(homePendingAfterCancel) === '["PAY-LYDBBBB2"]' && !cancelledScreen.includes('data-reference="PAY-USDAAAA1"'),
    json('_studioData.slots.wallet.loadedAt') <= Date.now() && !/_studioWallet\.summary\b|studioApi\('\/api\/studio\/wallet\/summary'/.test(walletSrc)
  ];
  check('Studio v2 wallet reads Home\'s one copy of the summary: a money action elsewhere shows at once; a forced read after Cancel never joins an older read',
    !loadError && oneCopyCases.every(Boolean), loadError || `cases ${failed(oneCopyCases)}`);

  // Add money keeps its idempotency key until the server answers with the request: after a lost answer,
  // Add money opened again for the same amount and method replays the same request (no second PAY- code).
  run("studioWalletOpenAdd('ads', 2500); studioWalletPickMethod('adfali');");
  replyError('POST', MINE, { name: 'TypeError', message: 'Failed to fetch' });
  run('studioWalletCreate();');
  const lostKey = ((calls('POST', MINE).slice(-1)[0] || {}).body || {}).idempotencyKey;
  run("studioWalletFinishAdd(); studioWalletOpenAdd(); studioWalletPickPurpose('ads'); studioWalletPickAmount(2500); studioWalletFlowStep(1); studioWalletPickMethod('adfali');");
  reply('POST', MINE, { id: 'wpr_replayed', data: { reference: 'PAY-REPLAYGG7', status: 'pending', currency: 'USD', amountMinor: 2500, amountMinorLYD: 17250, method: 'adfali' } });
  reply('GET', SUMMARY, summary());
  reply('GET', MINE, requests);
  run('studioWalletCreate();');
  const replayKey = ((calls('POST', MINE).slice(-1)[0] || {}).body || {}).idempotencyKey;
  const keyCases = [
    /^studiopay_\d+_\d{12}$/.test(String(lostKey)) && replayKey === lostKey && run('_studioWallet.idem.key') === '' && html().includes('PAY-REPLAYGG7'),
    // The builder's "short by $0.50" still opens a valid amount (the smallest one, $1.00).
    run("studioWalletOpenAdd('ads', 50); _studioWallet.add.amountText") === '1.00' && run("studioWalletOpenAdd('ads', 4000); _studioWallet.add.step + ':' + _studioWallet.add.amountText") === '2:40.00'
  ];
  run('studioWalletFinishAdd();');
  check('Studio v2 Add money: the idempotency key survives reopening Add money until the server answers, so a lost answer is replayed; an amount from another screen is at least $1.00',
    !loadError && keyCases.every(Boolean), loadError || `cases ${failed(keyCases)}`);

  // A read cut off by its timeout shows the problem with Try again (never "Reading…" for ever, nor a new
  // read every 15 s); only the app moving on (the navigation signal) cancels a read quietly.
  run("studioDataReset('wallet-user'); _studioWallet.requestsAt = 0;");
  replyError('GET', SUMMARY, { name: 'AbortError', message: 'signal is aborted without reason' });
  reply('GET', MINE, requests);
  openAt('/studio?tab=wallet');
  const walletTimedOut = html();
  const readsAfterTimeout = calls('GET', SUMMARY).length;
  run('render(); render();');
  const readsAfterRedraws = calls('GET', SUMMARY).length;
  run("studioDataReset('wallet-user'); _studioWallet.requestsAt = 0; __nav.aborted = true;");
  replyError('GET', SUMMARY, { name: 'AbortError', message: 'The operation was aborted' });
  reply('GET', MINE, requests);
  openAt('/studio?tab=wallet');
  const walletCancelled = html();
  run('__nav.aborted = false;');
  run("_studioAccount.profile = null; _studioAccount.error = ''; _studioAccount.loading = null;");
  replyError('GET', '/api/studio/profile', { name: 'AbortError', message: 'signal is aborted without reason' });
  openAt('/studio?tab=account');
  const profileTimedOut = html();
  const timeoutCases = [
    walletTimedOut.includes('data-testid="studio-wallet-problem"') && walletTimedOut.includes('data-testid="studio-wallet-retry"')
      && walletTimedOut.includes('No connection to Albayan') && !walletTimedOut.includes('Reading your wallet'),
    readsAfterRedraws === readsAfterTimeout,
    walletCancelled.includes('Reading your wallet') && !walletCancelled.includes('studio-wallet-problem'),
    profileTimedOut.includes('data-testid="studio-account-retry"') && !profileTimedOut.includes('Reading your profile')
  ];
  check('Studio v2 wallet/account: a timed-out read shows the problem and Try again; a read the app cancelled is simply asked again',
    !loadError && timeoutCases.every(Boolean), loadError || `cases ${failed(timeoutCases)}`);

  // Another signed-in user starts empty; a failing screen falls back to the frame's own placeholder.
  box.state.currentUser = { id: 'other-user', name: 'Other' };
  const otherWallet = run("studioWalletScope(); studioWalletSummary() === null && _studioWallet.requests === null && _studioWallet.add === null && _studioWallet.idem.key === ''");
  const otherAccount = run('studioAccountScope(); _studioAccount.profile === null');
  box.state.currentUser = { id: 'wallet-user', name: 'Sara' };
  run("var __realWallet = renderStudioWalletScreen; renderStudioWalletScreen = function () { throw new Error('boom'); };");
  run("studioResetMe(); __replies['GET /api/studio/me'] = [{ value: { ui: 'v2', staffDesk: 'classic', isStaff: false } }]; studioLoadMe();");
  openAt('/studio?tab=wallet');
  const fallback = html();
  run('renderStudioWalletScreen = __realWallet;');
  const onclicks = allHtml.join('\n').match(/\son[a-z]+="[^"]*"/g) || [];
  const safeHandler = /^\son(?:click|input|change|toggle)="(studioV2(Open|OpenSection)\('[a-z]+'\)|studioV2(Back|CloseBuilder)\(\)|studioV2ChooseClassic\(true\)|studioWallet(OpenAdd|Refresh|RetryMethods|FinishAdd|Create)\(\)|studioWalletWhereToggle\(this\)|studioWalletOpenAdd\('plan'\)|studioWalletPickPurpose\('(ads|plan)'\)|studioWalletPickAmount\(\d+\)|studioWalletPickMethod\('[a-z0-9_]+'\)|studioWalletFlowStep\(-?1\)|studioWalletCopy\('PAY-[A-Z0-9]+'\)|studioWalletAskCancel\('[A-Za-z0-9_.:-]+'\)|studioWalletAttachReceipt\('[A-Za-z0-9_.:-]+', this\)|studioWalletAmountInput\(this\)|studioAccount(Edit\((true|false)\)|Save\(\)|AskRemove\(\)|Retry\(\)|DraftNumber\(this\)|DraftConsent\(this\))|toggleLanguage\(\)|toggleTheme\(\)|handleLogout\(\)|showSubscriptionModal\('ad_maker', 'ad_maker'\))"$/;
  const staticCases = [
    otherWallet === true && otherAccount === true,
    fallback.includes('data-testid="studio-screen-wallet"') && fallback.includes('Coming soon in the new studio'),
    onclicks.length > 40 && onclicks.every(attr => safeHandler.test(attr)),
    !/\b(?:confirm|prompt|alert)\(/.test(walletSrc) && !/access_token|app_?secret|page_?token|Bearer /i.test(walletSrc),
    json('STUDIO_WALLET_REFUSALS').every(([start, textEn, textAr]) => start && textEn && /[؀-ۿ]/.test(textAr) && !/[A-Za-z]{3}/.test(textAr.replace(/JPG|PNG/g, ''))),
    run("studioWalletMoney(5000, 'LYD')") === '50.00 LYD' && inLanguage('ar', "studioWalletMoney(5000, 'LYD')") === '50.00 د.ل' && run("studioWalletMoney(5000, 'USD')") === '$50.00',
    run('studioWalletLydEstimate(100, 4.9)') === 490 && run('studioWalletLydEstimate(2500, 6.9)') === 17250 && run('studioWalletLydEstimate(333, 4.8765)') === 1624
  ];
  check('Studio v2 wallet/account: per-user state, the frame placeholder if a screen fails, safe handlers only, no native dialogs or keys, refusals in EN/AR, the server\'s dinar rounding',
    !loadError && staticCases.every(Boolean), loadError || `cases ${failed(staticCases)}`);

  // Styles and the server contract.
  const css = read('assets/ads-workspace.css');
  const walletCss = css.slice(css.indexOf('/* Albayan Studio v2 wallet and account'));
  const studioApiPy = read('server/systems/ads_studio/studio_api.py');
  const profilePy = read('server/systems/ads_studio/studio_profile.py');
  const errorsPy = read('server/systems/ads_studio/studio_errors.py');
  const refusalCodes = ['PHONE_REFUSAL_CODE', 'CONSENT_REFUSAL_CODE'].map(name => (profilePy.match(new RegExp(`^${name} = "([A-Z_]+)"$`, 'm')) || [])[1]);
  const routerBody = studioApiPy.slice(studioApiPy.indexOf('def create_studio_router('), studioApiPy.indexOf('    return router', studioApiPy.indexOf('def create_studio_router(')));
  check('Studio v2 wallet/account styles (tokens, light and dark tones, 44px controls, no page overflow) and the /api/studio/profile route (owner only, known error codes)',
    css.indexOf('/* Albayan Studio v2 wallet and account') > css.indexOf('/* Albayan Studio v2 frame') && read('www/assets/ads-workspace.css') === css
      && ['html.dark .studio-v2-frame, html.dark .studio-v2-wsheet-overlay {', '.studio-v2-wallet-strip { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));',
        '.studio-v2-wallet-small { min-height: 44px;', '.studio-v2-wallet-choice { display: flex;', 'min-height: 64px;', '.studio-v2-wsheet-overlay { position: fixed;',
        '.studio-v2-account-check > input { flex-shrink: 0; width: 24px; height: 24px;', 'overflow-wrap: anywhere'].every(rule => walletCss.includes(rule))
      && !/background(-color)?:\s*#|[^-]color:\s*#/.test(walletCss)
      && routerBody.includes('router.include_router(create_studio_profile_router(')
      && refusalCodes.every(code => code && errorsPy.includes(`"${code}": 400`))
      && profilePy.includes('BODY_FIELDS = ("whatsappNumber", "whatsappConsent")') && profilePy.includes('{"whatsapp": change}'),
    `codes ${refusalCodes.join(',')}`);
}

{
  // P3-07 / P3-13 help desk (server/systems/ads_studio/studio_support.py): the ticket refusals are studio codes with the
  // HTTP status the screens expect and plain EN/AR words (the "Help is off" one promises no WhatsApp line: D16 is only a
  // recommendation); the router is mounted; every customer answer passes through the staff-identity redaction.
  const errorsPy = read('server/systems/ads_studio/studio_errors.py');
  const coreSrc = read('src/systems/ads_studio/15g-studio-core.js');
  const supportPy = read('server/systems/ads_studio/studio_support.py');
  const studioApiPy = read('server/systems/ads_studio/studio_api.py');
  const helpCodes = { SERVICE_OFF: 403, UNKNOWN_TICKET: 404, UNKNOWN_PAYMENT: 404, IDEMPOTENCY_MISMATCH: 409, TICKET_OPEN_LIMIT: 409, TICKET_MESSAGE_LIMIT: 409, TICKET_CLOSED: 409 };
  const texts = Object.fromEntries(Object.keys(helpCodes).map(code => [code, (coreSrc.match(new RegExp(`\\n  ${code}: \\['([^']+)', '([^']+)'\\],`)) || []).slice(1)]));
  const missing = Object.entries(helpCodes).filter(([code, status]) => !errorsPy.includes(`"${code}": ${status},`) || texts[code].length !== 2
    || !/[؀-ۿ]/.test(texts[code][1]) || /[A-Za-z]/.test(texts[code][1]) || !supportPy.includes(`studio_error(${status}, "${code}"`)).map(([code]) => code);
  const customerRoutes = supportPy.slice(supportPy.indexOf('    # ---- customer'.replace('----', '-'.repeat(62))), supportPy.indexOf('    # ---- staff (P3-13)'.replace('----', '-'.repeat(62))));
  const customerReturns = customerRoutes.split('\n').filter(line => /^\s+return /.test(line) && !/^\s+return (customer_status|redact_staff_identity)\(/.test(line));
  check('Studio help desk (P3-07, P3-13): ticket refusals are studio codes with EN/AR words, the router is mounted, customer answers pass the staff-identity redaction',
    missing.length === 0 && !/whatsapp|واتساب/i.test(texts.SERVICE_OFF.join(' '))
      && studioApiPy.includes('router.include_router(create_studio_support_router(')
      && customerRoutes.length > 1000 && customerReturns.length === 5 && customerReturns.every(line => line.includes('for_customer('))
      && supportPy.includes('return redact_staff_identity(value, user)'),
    `missing ${missing.join(',')} returns ${customerReturns.length}`);
}

{
  // P3-05, P3-10, P3-11, P3-17, P3-20 (server: studio_activity.py, studio_stop.py): the new refusals reach Arabic in
  // both maps (the v2 codes and the classic /api/ad-studio texts), the routes are registered, the stop request
  // reuses the /stop refusal text, and the built bundles carry the new words.
  const stopPy = read('server/systems/ads_studio/studio_stop.py');
  const activityPy = read('server/systems/ads_studio/studio_activity.py');
  const actionsPy = read('server/systems/ads_studio/ad_campaign_actions.py');
  const studioApiPy = read('server/systems/ads_studio/studio_api.py');
  const errorsPy = read('server/systems/ads_studio/studio_errors.py');
  const coreSrc = read('src/systems/ads_studio/15g-studio-core.js');
  const bundle = read('studio.js');
  const arabicOnly = value => /[؀-ۿ]/.test(value) && !/[A-Za-z]{3}/.test(value);
  const pyConst = name => (stopPy.match(new RegExp(`^${name} = "([^"]+)"`, 'm')) || [])[1] || '';
  const v2Text = code => coreSrc.match(new RegExp(`\\n  ${code}: \\['([^']+)', '([^']+)'\\],`)) || [];
  const classicAr = prefix => (adsStudio.match(new RegExp(`\\n  \\['${prefix}', '([^']+)'\\],`)) || [])[1] || '';
  const newCodes = [['STAFF_DESK_IN_USE', 409], ['UNKNOWN_CUSTOMER', 404], ['NO_CONSENT', 409]];
  const off = pyConst('REFUSE_STOP_REQUEST_OFF');
  const cases = [
    newCodes.every(([code, status]) => errorsPy.includes(`"${code}": ${status},`) && v2Text(code)[1] && arabicOnly(v2Text(code)[2] || '')),
    off.startsWith('Stop requests are not open yet') && arabicOnly(classicAr('Stop requests are not open yet')),
    pyConst('REFUSE_STOP_NOT_APPROVED') === 'Only Approved campaigns can be stopped' && arabicOnly(classicAr('Only Approved campaigns can be stopped'))
      && actionsPy.includes('detail="Only Approved campaigns can be stopped"'),
    studioApiPy.includes('router.include_router(create_studio_desk_router(') && actionsPy.includes('add_stop_request_route(router,'),
    stopPy.includes('@router.post("/{campaign_id}/stop-request")') && stopPy.includes('@router.get("/staff/pulse")')
      && stopPy.includes('@router.get("/staff/customers/{customer_id}/contact")'),
    activityPy.includes('@router.get("/activity")') && activityPy.includes('@router.post("/activity/seen")'),
    newCodes.every(([code]) => bundle.includes(v2Text(code)[2] || '\u0000')) && bundle.includes(classicAr('Stop requests are not open yet') || '\u0000')
      && read('www/studio.js') === bundle
  ];
  check('Studio P3 desk: stop request, inbox, staff pulse and contact link routes registered; new refusals in EN/AR (v2 codes and the classic map); bundles rebuilt',
    cases.every(Boolean), `cases ${cases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);
}

{
  // P3-05, P3-08, P3-09, P3-10 (Studio help desk, inbox, stop request and the staff tickets, 15n): the real
  // 15c, 15g, 15h, 15j, 15k and 15n run in a sandbox (fake history and timers, a scripted apiJson keyed by
  // path) with /me answered like the server, in the v2 layout and in classic. Promises settle before each
  // run() returns (microtaskMode 'afterEvaluate'). Static checks cover the bundle, the styles and the texts.
  const vm = require('vm');
  const helpSrc = read('src/systems/ads_studio/15n-studio-help.js');
  const coreSrc = read('src/systems/ads_studio/15g-studio-core.js');
  const shellSrc = read('src/systems/ads_studio/15h-studio-shell.js');
  const homeSrc = read('src/systems/ads_studio/15j-studio-home.js');
  const adsSrc = read('src/systems/ads_studio/15k-studio-ads.js');
  const who = { staff: false };
  const win = {
    location: { pathname: '/studio', search: '', href: 'http://localhost/studio' },
    listeners: { popstate: [] },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const list = this.listeners[type] || []; const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); },
    localStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })()
  };
  const hist = {
    entries: [], index: 0,
    get length() { return this.entries.length; },
    get state() { return this.entries[this.index] ? this.entries[this.index].state : null; },
    show() { const url = new URL(this.entries[this.index].url, 'http://localhost'); win.location.pathname = url.pathname; win.location.search = url.search; win.location.href = url.href; },
    reset(url) { this.entries = [{ url, state: null }]; this.index = 0; this.show(); },
    pushState(entryState, _title, url) { this.entries.splice(this.index + 1); this.entries.push({ url: String(url), state: JSON.parse(JSON.stringify(entryState)) }); this.index++; this.show(); },
    replaceState(entryState, _title, url) { this.entries[this.index] = { url: String(url || this.entries[this.index].url), state: JSON.parse(JSON.stringify(entryState)) }; this.show(); },
    go(delta) {
      const next = this.index + delta;
      if (!delta || next < 0 || next >= this.entries.length) return;
      this.index = next; this.show();
      for (const fn of [...win.listeners.popstate]) fn({ state: this.state });
    },
    back() { this.go(-1); }
  };
  win.history = hist;
  let secureSeq = 0;
  const box = vm.createContext({
    state: { language: 'en', theme: 'light', currentUser: { id: 'u1', name: 'Sara', email: 'sara@albayan.example' }, currentView: 'ads-studio', adCampaignRequests: [], walletTransactions: [] },
    Security: {
      escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      isValidRecordId: value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(value ?? '').trim()),
      generateSecureId: prefix => `${prefix}-${++secureSeq}`,
      sanitizeObject: value => JSON.parse(JSON.stringify(value))
    },
    window: win, history: hist, URLSearchParams, URL,
    isServerModeEnabled: () => true,
    isCurrentUserAdmin: () => false,
    currentUserHasPermission: (collection, action) => (who.staff ? true : action !== 'review' && action !== 'view'),
    hasSubscription: id => id === 'ad_maker',
    canActOnRecord: () => true,
    getVisibleRecords: list => (Array.isArray(list) ? list.filter(item => item && !item._deleted) : []),
    getEntityPhotoCountHint: () => 0,
    updateUrlParams: () => {}, requestViewScrollReset: () => {}, IS_STUDIO_SHELL: true,
    TIME_CONSTANTS: { API_TIMEOUT_LONG_MS: 1000 }
  }, { microtaskMode: 'afterEvaluate' });
  let loadError = '';
  try {
    const at = forms.indexOf('function normalizeDigitsAscii(');
    vm.runInContext(forms.slice(at, forms.indexOf('\n}\n', at) + 2), box);
    vm.runInContext(`
      var __calls = [];
      var __replies = Object.create(null);
      var __timers = new Map();
      var __timerSeq = 0;
      var __html = '';
      var __notes = [];
      var performance = { now: () => 100, getEntriesByType: () => [{ type: 'navigate', name: '' }] };
      var document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
      function setTimeout(fn, ms) { const id = ++__timerSeq; __timers.set(id, { fn, ms: Number(ms) || 0 }); return id; }
      function clearTimeout(id) { __timers.delete(id); }
      function __runTimers() { for (let round = 0; round < 5 && __timers.size; round++) { const due = Array.from(__timers.entries()); __timers.clear(); due.forEach(([, t]) => t.fn()); } }
      function getUrlParams() { return { tab: new URLSearchParams(window.location.search).get('tab') }; }
      function apiJson(path, options) {
        __calls.push({ path: String(path), method: String((options && options.method) || 'GET'), body: options && options.body ? JSON.parse(JSON.stringify(options.body)) : null });
        const next = (__replies[path] || []).shift();
        if (!next) return new Promise(() => {});
        if (next.error) return Promise.reject(Object.assign(new Error(next.error.message || 'Request failed'), next.error));
        return Promise.resolve(JSON.parse(JSON.stringify(next.value)));
      }
      function showNotification(title, message, type) { __notes.push({ title, message, type }); }
      function getServerSessionIdentity() { return 'session'; }
      function serverSessionIdentityChanged() { return false; }
      function makeSessionChangedError() { return new Error('session changed'); }
      function requestValidatedServerEntity(collection, context, loader) { return loader(); }
      function withRetry(fn) { return fn(); }
      function markCollectionDirty() {}
      function saveState() {}
      function studioBuilderStart() { return true; }
      window.addEventListener('popstate', () => { restoreAdsStudioTabFromUrl(); render(); });
    `, box);
    vm.runInContext(adsStudio, box);
    vm.runInContext(coreSrc, box);
    vm.runInContext(shellSrc, box);
    vm.runInContext(homeSrc, box);
    vm.runInContext(adsSrc, box);
    vm.runInContext(helpSrc, box);
    // The classic page needs the platform's wallet and more; here the classic tab's own screens are drawn by name.
    vm.runInContext("function render() { const html = renderStudioV2View(); __html = html || '<classic>'; }", box);
  } catch (error) { loadError = String(error && error.message || error); }
  const run = code => { try { return vm.runInContext(code, box); } catch (error) { return `THREW ${error && error.message}`; } };
  const json = code => { try { return JSON.parse(String(run(`JSON.stringify(${code})`))); } catch (_) { return undefined; } };
  const html = () => String(run('__html'));
  const failed = cases => cases.map((ok, i) => ok ? '' : i).filter(String).join(',');
  const reply = (path, value) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ value: ${JSON.stringify(value)} });`);
  const replyError = (path, error) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ error: ${JSON.stringify(error)} });`);
  const calls = (method, path) => (json('__calls') || []).filter(c => c.method === method && c.path === path);
  const openAt = url => { hist.reset(url); run('_studioV2.docRendered = false; render();'); };
  const inLanguage = (language, code) => { box.state.language = language; const out = run(code); box.state.language = 'en'; return out; };
  const arabicOnly = value => /[؀-ۿ]/.test(value) && !/[A-Za-z]{3}/.test(value.replace(/PAY|LYD|USD|T-|ALB-S/g, ''));
  const meReply = value => run(`studioResetMe(); __replies['/api/studio/me'] = [{ value: ${JSON.stringify(value)} }]; studioLoadMe();`);
  const soon = minutes => new Date(Date.now() + minutes * 60000).toISOString();
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  const T1 = 'tkt_' + '1'.repeat(40);
  const T2 = 'tkt_' + '2'.repeat(40);
  const T3 = 'tkt_' + '3'.repeat(40);
  const ticket = (id, number, status, extra = {}) => ({
    id, number, subject: 'Why is my ad <b>late</b>?', category: 'ad', status, audience: 'staff', priority: 'normal', kind: 'question',
    relatedType: 'campaign', relatedId: 'r_new', createdAt: ago(120), updatedAt: ago(30), dueAt: status === 'open' ? soon(180) : null,
    lastMessageAt: ago(30), resolvedAt: null, reopenUntil: null, ...extra
  });
  const requests = () => [
    { id: 'r_new', createdBy: 'u1', status: 'Approved', name: 'New ad', paidMinorUSD: 5000, startDate: '2099-01-10', endDate: '2099-01-16', durationDays: 7, studioRef: 'ALB-S-AB12CD34', objective: 'messages', platforms: ['facebook'], submittedAt: ago(500), _created: 5, _lastModified: 15 },
    { id: 'r_other', createdBy: 'someone-else', status: 'Approved', name: 'Not mine', paidMinorUSD: 100, _created: 6, _lastModified: 16 }
  ];
  const meV2 = { ui: 'v2', staffDesk: 'classic', isStaff: false, isAdmin: false, services: { help: true, stopRequest: true, tiktok: false },
    serviceHours: { timezone: 'Africa/Tripoli', openNow: false, week: { sun: { open: '09:00', close: '17:00' }, mon: { open: '09:00', close: '17:00' }, tue: { open: '09:00', close: '17:00' }, wed: { open: '09:00', close: '17:00' }, thu: { open: '09:00', close: '17:00' }, fri: null, sat: null }, holidays: [{ date: '2099-03-01', labelEn: 'Spring day', labelAr: 'يوم الربيع' }], ramadan: null, onDutyUntil: '23:00' },
    contact: { whatsapp: '+218912345678', phone: '+218213333333', email: 'help@albayan.example' } };
  const allHtml = [];

  // Bundle, manifest and the shell registry.
  check('Studio help desk (15n) ships right after 15m in the lazy studio bundle, in both built copies under 1 MiB, and registers the Help and Inbox screens with the shell',
    !loadError && bundleManifestJson.lazy['studio.js'].indexOf('systems/ads_studio/15n-studio-help.js') === bundleManifestJson.lazy['studio.js'].indexOf('systems/ads_studio/15m-studio-wallet.js') + 1
      && !bundleManifestJson.files.some(file => /15n-studio/.test(file))
      && [read('studio.js'), read('www/studio.js')].every(bundle => bundle.includes(helpSrc)) && !read('script.js').includes('renderStudioHelpBody')
      && fs.statSync(path.join(ROOT, 'studio.js')).size < 1024 * 1024
      && run("_studioV2Screens.has('help') && _studioV2Screens.has('inbox')") === true
      && helpSrc.includes("studioV2RegisterScreen('help', renderStudioHelpBody)") && helpSrc.includes("studioV2RegisterScreen('inbox', renderStudioInboxBody)"),
    loadError || `studio.js ${fs.statSync(path.join(ROOT, 'studio.js')).size} bytes`);

  // The v2 Help tab: the list in its two groups, the due time, the hours card and the contact links.
  box.state.adCampaignRequests = requests();
  meReply(meV2);
  reply('/api/studio/tickets?status=active', { tickets: [ticket(T1, 'T-000001', 'open'), ticket(T2, 'T-000002', 'answered')], nextCursor: null });
  reply('/api/studio/activity', { items: [], unreadCount: 0, nextCursor: null, seenAt: null });  // the bell's badge reads the feed on every screen
  openAt('/studio?tab=help');
  const helpList = html();
  allHtml.push(helpList);
  const helpListAr = inLanguage('ar', 'render(); __html');
  const listCases = [
    helpList.includes('data-testid="studio-screen-help"') && helpList.includes('data-testid="studio-help-new"') && !helpList.includes('studio-help-off'),
    helpList.includes('data-testid="studio-help-list-team"') && helpList.includes('T-000001') && helpList.includes('We reply by') && helpList.includes('Waiting for our team'),
    helpList.includes('data-testid="studio-help-list-you"') && helpList.includes('T-000002') && helpList.includes('Waiting for you'),
    helpList.includes('Why is my ad &lt;b&gt;late&lt;/b&gt;?') && !helpList.includes('<b>late</b>'),
    helpList.includes('data-testid="studio-help-hours"') && helpList.includes('09:00–17:00') && helpList.includes('Closed now') && helpList.includes('2099-03-01 (Spring day)'),
    helpList.includes('href="https://wa.me/218912345678"') && helpList.includes('href="tel:+218213333333"') && helpList.includes('href="mailto:help@albayan.example"'),
    helpListAr.includes('تذاكري') && helpListAr.includes('بانتظار فريقنا') && helpListAr.includes('نرد قبل') && helpListAr.includes('يوم الربيع'),
    calls('GET', '/api/studio/tickets?status=active').length === 1,
    calls('GET', '/api/studio/activity').length === 1 && helpList.includes('data-testid="studio-nav-inbox"') && !helpList.includes('studio-inbox-badge')  // nothing unread: no badge
  ];
  check('Studio v2 Help: tickets grouped "waiting for you" / "waiting for our team" with due times, hours and contact from /me, Arabic words',
    !loadError && listCases.every(Boolean), loadError || `cases ${failed(listCases)}`);

  // "Ask about this" pre-fills New ticket; a lost answer replays the same operationId; success opens the thread.
  run("studioHelpAskAbout('campaign', 'r_new');");
  const form = html();
  allHtml.push(form);
  run("studioHelpDraftSet('message', 'It has not started yet.');");
  replyError('/api/studio/tickets', { name: 'TypeError', message: 'Failed to fetch' });
  run('studioHelpSend();');
  const formAfterLoss = html();
  const newTicket = { ticket: ticket(T3, 'T-000003', 'open', { subject: 'About my ad: New ad' }), message: { id: 'tkm_' + '3'.repeat(40), from: 'customer', text: 'It has not started yet.', createdAt: ago(0) } };
  reply('/api/studio/tickets', newTicket);
  run('studioHelpSend();');
  const thread = html();
  allHtml.push(thread);
  const posts = calls('POST', '/api/studio/tickets');
  const formCases = [
    win.location.search.includes('tab=help') && win.location.search.includes('id=new') === false || form.includes('data-testid="studio-help-form"'),
    form.includes('data-testid="studio-help-category-ad" aria-pressed="true"') && form.includes('value="About my ad: New ad"')
      && form.includes('value="campaign:r_new" selected') && form.includes('My ad: New ad (ALB-S-AB12CD34)') && !form.includes('Not mine'),
    formAfterLoss.includes('data-testid="studio-help-error"') && formAfterLoss.includes('The connection dropped'),
    posts.length === 2 && posts[0].body.operationId === posts[1].body.operationId
      && JSON.stringify(posts[1].body) === JSON.stringify({ subject: 'About my ad: New ad', category: 'ad', message: 'It has not started yet.', operationId: posts[0].body.operationId, relatedType: 'campaign', relatedId: 'r_new' }),
    win.location.search === `?tab=help&id=${T3}` && thread.includes('data-testid="studio-ticket-thread"') && thread.includes('T-000003')
      && thread.includes('It has not started yet.') && thread.includes('data-from="customer"') && thread.includes('data-testid="studio-ticket-resolve"'),
    (json('__notes') || []).some(note => note.title === 'Ticket sent' && /T-000003/.test(note.message)),
    json('_studioHelp.draft') === null
  ];
  check('Studio v2 Help: "Ask about this" pre-fills the request, a lost answer replays the same operationId, the sent ticket opens as its thread',
    !loadError && formCases.every(Boolean), loadError || `cases ${failed(formCases)}`);

  // The thread: the team's answer is "Albayan team" (never a name), a reply reopens, resolve and reopen carry operationIds.
  reply(`/api/studio/tickets/${T3}`, { ticket: ticket(T3, 'T-000003', 'answered'), messages: [newTicket.message, { id: 'tkm_' + '4'.repeat(40), from: 'team', text: 'Starting <today>', createdAt: ago(5) }] });
  run(`studioHelpRefreshThread('${T3}');`);
  const answered = html();
  allHtml.push(answered);
  run(`studioHelpReplySet('${T3}', 'Thanks!');`);
  reply(`/api/studio/tickets/${T3}/messages`, { ticket: ticket(T3, 'T-000003', 'open'), message: { id: 'tkm_' + '5'.repeat(40), from: 'customer', text: 'Thanks!', createdAt: ago(0) } });
  run(`studioHelpReplySend('${T3}');`);
  const replied = html();
  reply(`/api/studio/tickets/${T3}/resolve`, { ticket: ticket(T3, 'T-000003', 'resolved', { resolvedAt: ago(0), reopenUntil: soon(7 * 24 * 60) }) });
  run(`studioHelpStatus('${T3}', 'resolve');`);
  const resolved = html();
  reply(`/api/studio/tickets/${T3}/reopen`, { ticket: ticket(T3, 'T-000003', 'open') });
  run(`studioHelpStatus('${T3}', 'reopen');`);
  const reopened = html();
  const replyPost = calls('POST', `/api/studio/tickets/${T3}/messages`)[0];
  const threadCases = [
    answered.includes('data-from="team"') && answered.includes('Albayan team') && answered.includes('Starting &lt;today&gt;') && answered.includes('Waiting for you') && !/sara|reviewer|authorId/i.test(answered),
    replyPost && replyPost.body.text === 'Thanks!' && /^reply-\d+$/.test(replyPost.body.operationId) && replied.includes('Thanks!') && replied.includes('Waiting for our team'),
    resolved.includes('data-status="resolved"') && resolved.includes('data-testid="studio-ticket-reopen"') && !resolved.includes('data-testid="studio-ticket-resolve"')
      && /^resolve-\d+$/.test((calls('POST', `/api/studio/tickets/${T3}/resolve`)[0] || { body: {} }).body.operationId),
    reopened.includes('data-status="open"') && reopened.includes('data-testid="studio-ticket-resolve"') && calls('POST', `/api/studio/tickets/${T3}/reopen`).length === 1,
    (json('__notes') || []).some(note => note.title === 'Ticket resolved') && (json('__notes') || []).some(note => note.title === 'Ticket reopened')
  ];
  check('Studio v2 Help thread: the team is always "Albayan team", a reply reopens the ticket, resolve and reopen post operationIds',
    !loadError && threadCases.every(Boolean), loadError || `cases ${failed(threadCases)}`);

  // Inbox: opening it reads the feed afresh (the bell's read above is minutes young), the feed in the
  // reader's language, unread items, the bell badge inside the header's bell, "Mark all seen".
  reply('/api/studio/activity', { items: [
    { id: 'act_1', kind: 'ticket_answered', title: { en: 'The team answered your ticket', ar: 'ردّ الفريق على تذكرتك' }, body: { en: 'Ticket T-000003: open it.', ar: 'التذكرة T-000003: افتحها.' }, relatedType: 'ticket', relatedId: T3, createdAt: ago(5), unread: true },
    { id: 'act_2', kind: 'request_approved', title: { en: 'Your ad was approved', ar: 'تمت الموافقة على إعلانك' }, body: { en: '$50.00 was paid.', ar: 'دُفع $50.00.' }, relatedType: 'campaign', relatedId: 'r_new', createdAt: ago(60), unread: false }
  ], unreadCount: 1, nextCursor: null, seenAt: ago(30) });
  openAt('/studio?tab=inbox');
  const inbox = html();
  allHtml.push(inbox);
  const badgeBefore = run("studioInboxBadge('inbox')");
  const inboxAr = inLanguage('ar', 'render(); __html');
  reply('/api/studio/activity/seen', { activitySeenAt: ago(5), unreadCount: 0 });
  run('studioInboxMarkSeen();');
  const seen = html();
  const seenPost = calls('POST', '/api/studio/activity/seen')[0];
  run("studioInboxOpen('act_1');");
  const inboxCases = [
    inbox.includes('data-testid="studio-screen-inbox"') && inbox.includes('data-testid="studio-inbox-item-act_1" data-kind="ticket_answered" data-unread="1"')
      && inbox.includes('The team answered your ticket') && inbox.includes('data-testid="studio-inbox-unread" data-count="1"') && inbox.includes('1 new'),
    String(badgeBefore).includes('data-testid="studio-inbox-badge"') && String(badgeBefore).includes('>1<')
      && /data-testid="studio-nav-inbox"[^>]*>(?:(?!<\/button>)[\s\S])*data-testid="studio-inbox-badge"/.test(inbox)  // the badge sits inside the bell
      && calls('GET', '/api/studio/activity').length === 2 && json('_studioInbox.loading') === null,
    inboxAr.includes('ردّ الفريق على تذكرتك') && inboxAr.includes('الإشعارات'),
    seenPost && seenPost.body.upTo === json('_studioInbox.items')[0].createdAt && seen.includes('data-count="0"') && seen.includes('data-unread="0"') && run("studioInboxBadge('inbox')") === '' && !seen.includes('studio-inbox-badge'),
    win.location.search === `?tab=help&id=${T3}`,
    shellSrc.includes("const badge = tab === 'inbox' && typeof studioInboxBadge === 'function' ? String(studioInboxBadge(route.tab) || '') : '';")
  ];
  check('Studio v2 Inbox: the feed with unread items in the reader\'s language, the bell badge, "Mark all seen" posts the newest time, an item opens its ticket',
    !loadError && inboxCases.every(Boolean), loadError || `cases ${failed(inboxCases)}`);

  // Ask to stop: the sheet's words, one operationId per ad until the server answers, the after-hours line.
  const askSheet = run("renderStudioStopSheet(studioDataRequest('r_new'), { note: '', sending: false, error: '', result: null })");
  replyError('/api/ad-studio/campaigns/r_new/stop-request', { name: 'TypeError', message: 'Failed to fetch' });
  run("_studioStop.__lost = studioStopSendOnce('r_new', 'Please stop <it>').catch(e => e.message);");
  const stopAnswer = { ticket: { id: T1, number: 'T-000009', subject: 'Stop request', category: 'ad', status: 'open', audience: 'staff', relatedType: 'campaign', relatedId: 'r_new', createdAt: ago(0), updatedAt: ago(0), dueAt: soon(120), lastMessageAt: ago(0), urgent: true },
    stopRequestedAt: ago(0), afterHours: true, urgentContact: { whatsapp: '+218 91 999 8888', phone: '+218211111111' } };
  reply('/api/ad-studio/campaigns/r_new/stop-request', stopAnswer);
  run("_studioStop.__sent = null; studioStopSendOnce('r_new', 'Please stop <it>').then(r => { _studioStop.__sent = r; });");
  const sent = json('_studioStop.__sent');
  const stopPosts = calls('POST', '/api/ad-studio/campaigns/r_new/stop-request');
  const sentSheet = run("renderStudioStopSheet(studioDataRequest('r_new'), { note: '', sending: false, error: '', result: _studioStop.__sent })");
  const sentSheetAr = inLanguage('ar', "renderStudioStopSheet(studioDataRequest('r_new'), { note: '', sending: false, error: '', result: _studioStop.__sent })");
  const inHours = run("renderStudioStopSheet(studioDataRequest('r_new'), { note: '', sending: false, error: '', result: Object.assign({}, _studioStop.__sent, { afterHours: false }) })");
  const stopCases = [
    String(askSheet).includes('data-testid="studio-sheet-ask-stop"') && String(askSheet).includes('data-state="ask"') && String(askSheet).includes('Ask us to stop this ad')
      && String(askSheet).includes('ALB-S-AB12CD34') && String(askSheet).includes('data-testid="studio-stop-note"') && String(askSheet).includes('Send the stop request') && String(askSheet).includes('outside working hours'),
    stopPosts.length === 2 && stopPosts[0].body.operationId === stopPosts[1].body.operationId && stopPosts[1].body.note === 'Please stop <it>' && /^stopask-\d+$/.test(stopPosts[1].body.operationId),
    sent && sent.ticket.number === 'T-000009' && sent.afterHours === true && sent.urgentContact.whatsapp === '+218919998888' && run("studioStopRequestedAt('r_new')") === stopAnswer.stopRequestedAt,
    String(sentSheet).includes('data-state="sent"') && String(sentSheet).includes('Ticket T-000009') && String(sentSheet).includes('We pause it in Meta by')
      && String(sentSheet).includes('data-testid="studio-stop-after-hours"') && String(sentSheet).includes('href="https://wa.me/218919998888?text=') && String(sentSheet).includes('href="tel:+218211111111"')
      && String(sentSheet).includes('until 23:00') && String(sentSheet).includes(`studioStopOpenTicket('${T1}')`),
    String(sentSheetAr).includes('أُرسل طلب الإيقاف') && String(sentSheetAr).includes('راسل فريق المناوبة على واتساب'),
    !String(inHours).includes('studio-stop-after-hours') && String(inHours).includes('Ticket T-000009'),
    calls('GET', '/api/studio/campaigns/summary').length >= 1,
    !/\b(?:confirm|prompt|alert)\(/.test(helpSrc) && !/access_token|app_?secret|page_?token|Bearer /i.test(helpSrc) && !/setInterval\(/.test(helpSrc)
  ];
  check('Studio Ask to stop (P3-10): the sheet explains, one operationId per ad is replayed after a lost answer, the answer shows the ticket number, the due time and the after-hours urgent line',
    !loadError && stopCases.every(Boolean), loadError || `cases ${failed(stopCases)}`);

  // Classic: the help tab exists only while the service is on, the tab fix keeps it, the classic card offers the sheet and "Ask about this".
  const meClassic = Object.assign({}, meV2, { ui: 'classic' });
  meReply(meClassic);
  run('_studioStop.requested.clear();');  // the stop asked above belongs to that flow, not to this card
  const classicTabs = json('adsStudioTabsForUser().map(tab => tab.id)');
  run("_adsStudioActiveTab = 'help'; studioV2ClassicTabFix();");
  const keptHelp = run('_adsStudioActiveTab');
  const classicHelp = run("_studioHelp.classic = { view: 'list', id: '', filter: 'active' }; renderStudioHelpClassic()");
  const card = run("renderAdsStudioCampaignCard(studioDataRequest('r_new'))");
  const cardRequested = run("renderAdsStudioCampaignCard(Object.assign({}, studioDataRequest('r_new'), { stopRequestedAt: '2026-09-25T10:00:00Z', stopRequestTicketId: '" + T1 + "' }))");
  run("_adsStudioActiveTab = 'help'; studioHelpGo('new');");
  const classicNew = run("_studioHelp.classic.view + ':' + _adsStudioActiveTab");
  const classicForm = run('renderStudioHelpClassic()');
  meReply(Object.assign({}, meClassic, { services: { help: false, stopRequest: false, tiktok: false } }));
  const offTabs = json('adsStudioTabsForUser().map(tab => tab.id)');
  const offButton = run("studioHelpAskButton('campaign', 'r_new')");
  const cardOff = run("renderAdsStudioCampaignCard(studioDataRequest('r_new'))");
  run("_adsStudioActiveTab = 'help'; studioV2ClassicTabFix();");
  const droppedHelp = run('_adsStudioActiveTab');
  const classicCases = [
    JSON.stringify(classicTabs) === JSON.stringify(['dashboard', 'campaigns', 'builder', 'posts', 'replies', 'help']) && keptHelp === 'help',
    String(classicHelp).includes('class="studio-help studio-help-classic"') && String(classicHelp).includes('My tickets') && String(classicHelp).includes('dir="ltr"'),
    String(card).includes('data-ads-studio-ask-stop="1"') && String(card).includes("studioStopSheetOpen('r_new', this)") && String(card).includes('data-testid="studio-ask-campaign-r_new"')
      && !String(card).includes('data-ads-studio-stop-requested'),
    String(cardRequested).includes('data-ads-studio-stop-requested="1"') && String(cardRequested).includes('Stop requested') && String(cardRequested).includes(`studioHelpOpen('${T1}')`) && !String(cardRequested).includes('data-ads-studio-ask-stop'),
    classicNew === 'new:help' && String(classicForm).includes('data-testid="studio-help-form"'),
    JSON.stringify(offTabs) === JSON.stringify(['dashboard', 'campaigns', 'builder', 'posts', 'replies']) && offButton === '' && !String(cardOff).includes('data-ads-studio-ask-stop') && String(cardOff).includes('Ask us to stop it') === false,
    droppedHelp === 'dashboard',
    // No function of another file is wrapped by 15n: the shell and My ads call its hooks behind typeof guards.
    !/^\s*(?:studioV2\w+|studioAds\w+|setAdsStudioTab|restoreAdsStudioTabFromUrl)\s*=\s*function/m.test(helpSrc)
      && shellSrc.includes('function studioV2ClassicTabKnown(tab) {') && shellSrc.includes("return name === 'help' && typeof studioHelpClassicTab === 'function' && studioHelpClassicTab() === true;")
      && shellSrc.includes('if (studioV2ClassicTabKnown(_adsStudioActiveTab)) return;') && shellSrc.includes('if (tab && !studioV2ClassicTabKnown(tab) && typeof updateUrlParams === ')
      && adsSrc.includes("if (kind === 'ask' && typeof studioHelpAskAbout === 'function' && studioHelpAskAbout('campaign', request.id)) return true;")
      && adsSrc.includes("if (kind === 'ask_stop' && typeof studioStopSheetOpen === 'function' && studioStopSheetOpen(request.id, opener)) return true;"),
    adsStudio.includes("tabs.push({ id: 'help', icon: 'life-buoy', label: 'Help', labelAr: 'المساعدة' });")
      && adsStudio.includes("else if (_adsStudioActiveTab === 'help' && typeof renderStudioHelpClassic === 'function') content = renderStudioHelpClassic();")
      && adsStudio.includes("(typeof renderStudioStaffTicketsClassic === 'function' ? renderStudioStaffTicketsClassic() : '')")
      && adsStudio.includes("['note must be text', 'يجب أن تكون الملاحظة نصاً']")
  ];
  check('Studio classic layout: a Help tab and the stop-request sheet only while the services are on, the tab fix keeps ?tab=help, the card shows "Stop requested" with its ticket',
    !loadError && classicCases.every(Boolean), loadError || `cases ${failed(classicCases)}`);

  // Staff tickets (classic review tab): stop requests first, the thread, a reply, a status change, the consented contact link; never a person's id on screen.
  who.staff = true;
  meReply(Object.assign({}, meClassic, { isStaff: true }));
  const urgentTicket = ticket(T1, 'T-000009', 'open', { subject: 'Stop request', priority: 'urgent', kind: 'stop_request', ownerId: 'cust-77', overdue: true, messageCount: 1 });
  reply('/api/studio/staff/tickets?status=active', { tickets: [urgentTicket, ticket(T2, 'T-000002', 'open', { ownerId: 'cust-77', messageCount: 2 })], nextCursor: null });
  run('_studioStaff.forUser = ""; renderStudioStaffTicketsClassic();');
  const staffList = run('renderStudioStaffTicketsClassic()');
  reply(`/api/studio/staff/tickets/${T1}`, { ticket: urgentTicket, messages: [{ id: 'tkm_' + '9'.repeat(40), from: 'customer', text: 'Please stop it', createdAt: ago(9), authorId: 'cust-77' }] });
  run(`studioStaffOpen('${T1}');`);
  const staffThread = run('renderStudioStaffTicketsClassic()');
  run(`studioStaffReplySet('${T1}', 'Paused in Meta.');`);
  reply(`/api/studio/staff/tickets/${T1}/messages`, { ticket: Object.assign({}, urgentTicket, { status: 'answered', dueAt: null, overdue: false }), message: { id: 'tkm_' + '8'.repeat(40), from: 'team', text: 'Paused in Meta.', createdAt: ago(0), authorId: 'u1' } });
  run(`studioStaffReplySend('${T1}');`);
  const staffAnswered = run('renderStudioStaffTicketsClassic()');
  reply(`/api/studio/staff/tickets/${T1}/status`, { ticket: Object.assign({}, urgentTicket, { status: 'resolved', dueAt: null, overdue: false, resolvedAt: ago(0) }) });
  run(`studioStaffStatus('${T1}', 'resolved');`);
  const staffResolved = run('renderStudioStaffTicketsClassic()');
  reply(`/api/studio/staff/customers/cust-77/contact?relatedType=ticket&relatedId=${T1}`, { customerId: 'cust-77', whatsapp: '+218911234567', whatsappUrl: 'https://wa.me/218911234567?text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7', consentAt: ago(1000) });
  run(`studioStaffContact('${T1}');`);
  const staffContact = run('renderStudioStaffTicketsClassic()');
  const staffReply = calls('POST', `/api/studio/staff/tickets/${T1}/messages`)[0];
  const staffStatus = calls('POST', `/api/studio/staff/tickets/${T1}/status`)[0];
  const staffCases = [
    String(staffList).includes('data-testid="studio-staff-tickets"') && String(staffList).includes('data-testid="studio-staff-urgent-count"') && String(staffList).indexOf('T-000009') < String(staffList).indexOf('T-000002')
      && String(staffList).includes('Urgent: stop request') && String(staffList).includes('Overdue since') && String(staffList).includes('data-testid="studio-staff-filter-active" aria-pressed="true"'),
    String(staffThread).includes('data-testid="studio-staff-thread"') && String(staffThread).includes('Please stop it') && String(staffThread).includes('data-testid="studio-staff-reply-send"') && !String(staffThread).includes('cust-77') && !String(staffThread).includes('authorId'),
    staffReply && staffReply.body.text === 'Paused in Meta.' && /^answer-\d+$/.test(staffReply.body.operationId) && String(staffAnswered).includes('data-status="answered"') && String(staffAnswered).includes('Answered') && String(staffAnswered).includes('Paused in Meta.'),
    staffStatus && staffStatus.body.status === 'resolved' && /^status-\d+$/.test(staffStatus.body.operationId) && String(staffResolved).includes('data-testid="studio-staff-status-open"') && !String(staffResolved).includes('data-testid="studio-staff-status-resolved"'),
    String(staffContact).includes('data-testid="studio-staff-whatsapp-link"') && String(staffContact).includes('href="https://wa.me/218911234567?text=') && !String(staffContact).includes('cust-77'),
    !helpSrc.includes('category=') && !helpSrc.includes('audience=')  // no way to ask for admin-only tickets: the server's audience rule decides alone
  ];
  check('Studio staff tickets (P3-09, P3-11): stop requests pinned and overdue, the thread, a reply marks it answered, status changes, the consented WhatsApp link; never a customer id on screen',
    !loadError && staffCases.every(Boolean), loadError || `cases ${failed(staffCases)}`);
  who.staff = false;

  // Texts, handlers and styles.
  const textPairs = [...helpSrc.matchAll(/adsStudioText\((?:'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`),\s*((?:'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`))\)/g)].map(m => m[1]);
  const onclicks = allHtml.join('\n').match(/\son[a-z]+="[^"]*"/g) || [];
  const safeHandler = /^\son(?:click|input|change|submit)="(event\.preventDefault\(\); studioHelp(Send|ReplySend\('tkt_[0-9a-f]{40}'\))\(?\)?;?|studioHelp(Open|Filter|Retry|More|RetryThread|RefreshThread|New|CancelNew|Send|Status|DraftCategory|DraftSet|DraftRelated|ReplyInput|Go|AskAbout)\((?:'[A-Za-z0-9_.:-]+'(?:, (?:'[A-Za-z0-9_.:-]+'|this|this\.value))?|this\.value)?\)|studioInbox(Open|More|Retry|MarkSeen)\((?:'[A-Za-z0-9_.:-]+')?\)|studioV2(Open|OpenSection)\('[a-z]+'\)|studioV2Go\(\{ tab: 'campaigns', id: '[A-Za-z0-9_.:-]+' \}\)|studioV2(Back|CloseBuilder)\(\)|studioV2ChooseClassic\(true\)|setAdsStudioTab\('[a-z]+'\)|studioAdsSheet\('[a-z_]+', '[A-Za-z0-9_.:-]+', this\)|studioAdsEdit\('[A-Za-z0-9_.:-]+', this\)|studioAdsOpen\('[A-Za-z0-9_.:-]+'\)|studioAdsFilter\('[a-z]*'\)|studioAds(BackToList|CloseSheet|ConfirmSheet)\(\)|studioHomeGoal\('[a-z]+'\)|studioHome(OpenRequest|Edit)\('[A-Za-z0-9_.:-]+'(?:, this)?\)|studioDataRetry\(\)|toggleLanguage\(\)|toggleTheme\(\)|handleLogout\(\))"$/;
  const workspaceCss = read('assets/ads-workspace.css');
  const helpCss = workspaceCss.slice(workspaceCss.indexOf('/* Albayan Studio help desk'));
  const staticCases = [
    textPairs.length >= 120 && textPairs.every(ar => /[؀-ۿ]/.test(ar)),
    onclicks.length > 30 && onclicks.every(attr => safeHandler.test(attr)),
    helpCss.length > 2000 && read('www/assets/ads-workspace.css') === workspaceCss
      && ['html.dark :is(.studio-help, .studio-stop-sheet)', '.studio-help-chip { display: inline-flex;', 'min-height: 44px', 'overflow-wrap: anywhere', '.studio-inbox-badge { position: absolute;', '@media (max-width: 900px)'].every(rule => helpCss.includes(rule))
      && !/background(-color)?:\s*#|[^-]color:\s*#/.test(helpCss),
    arabicOnly(String(inLanguage('ar', "studioHelpWhen('2026-09-27T08:30:00Z')"))) && run("studioHelpWhen('2026-09-27T08:30:00Z')") === 'Sun 27 Sep, 10:30' && run("studioHelpWhen('nope')") === ''
  ];
  check('Studio help desk: every text pair has Arabic, only known handlers reach the page, the styles use the tokens with dark tones, times read in Tripoli time',
    !loadError && staticCases.every(Boolean), loadError || `cases ${failed(staticCases)} pairs ${textPairs.length} handlers ${onclicks.filter(attr => !safeHandler.test(attr)).slice(0, 3).join(' | ')}`);
}

{
  // Team desk (P3-06b/c/d, P3-17, M12; 15o0 loader in studio.js, 15i + 15p + 15q in the staff-only bundle
  // studio-staff.js): the bundle rule, the loader, the hooks in 15h and 15c, and the desk itself in a vm
  // sandbox (the review queue and decisions, launch, the settle countdown and refusals, the pulse badges
  // and title count, the admin settings forms with expectedVersion, the 409 reload flow and the
  // server's validation message).
  const vm = require('vm');
  const loaderSrc = read('src/systems/ads_studio/15o0-studio-staff-loader.js');
  const deskSrc = read('src/systems/ads_studio/15p-studio-desk.js');
  const adminSrc = read('src/systems/ads_studio/15q-studio-admin.js');
  const healthSrc = read('src/systems/ads_studio/15i-studio-health.js');
  const coreSrc = read('src/systems/ads_studio/15g-studio-core.js');
  const shellSrc = read('src/systems/ads_studio/15h-studio-shell.js');
  const homeSrc = read('src/systems/ads_studio/15j-studio-home.js');
  const adsSrc = read('src/systems/ads_studio/15k-studio-ads.js');
  const helpSrc = read('src/systems/ads_studio/15n-studio-help.js');
  const staffFiles = ['systems/ads_studio/15i-studio-health.js', 'systems/ads_studio/15p-studio-desk.js', 'systems/ads_studio/15q-studio-admin.js'];
  const ADS_STUDIO_REASONS_LIST = ['budget_dates', 'creative_quality', 'text_policy', 'targeting', 'page_access', 'payment', 'other'];  // 15c ADS_STUDIO_REVIEW_REASONS (P1-12)
  const STUDIO_ADMIN_KEYS_LIST = ['rollout', 'intake', 'capabilities', 'limits', 'settlement', 'hours', 'contact', 'targets', 'thresholds'];  // studio_settings.SETTING_KEYS
  const studioLazy = bundleManifestJson.lazy['studio.js'];
  const staffLazy = bundleManifestJson.lazy['studio-staff.js'];
  const pagesLazy = bundleManifestJson.lazy['studio-pages.js'];
  const MiB = 1024 * 1024;
  const builtStudio = read('studio.js');
  const builtStaff = read('studio-staff.js');
  const builtPages = read('studio-pages.js');
  const pagesSrcForRule = read('src/systems/ads_studio/15o-studio-pages.js');
  const socialSrcForRule = read('src/systems/ads_studio/15f-social-studio.js');
  const bundleSizes = ['studio.js', 'studio-staff.js', 'studio-pages.js'].map(name => `${name} ${fs.statSync(path.join(ROOT, name)).size} B`).join(', ');
  check('BUNDLE RULE: studio-staff.js holds exactly 15i + 15p + 15q, studio-pages.js exactly 15o, studio.js holds none of them and the loader 15o0 right after 15n; the three bundles ship in both copies, each under 1 MiB, none of them in script.js',
    JSON.stringify(staffLazy) === JSON.stringify(staffFiles) && JSON.stringify(pagesLazy) === JSON.stringify(['systems/ads_studio/15o-studio-pages.js'])
      && staffFiles.concat(pagesLazy).every(file => !studioLazy.includes(file) && !bundleManifestJson.files.includes(file))
      && studioLazy.indexOf('systems/ads_studio/15o0-studio-staff-loader.js') === studioLazy.indexOf('systems/ads_studio/15n-studio-help.js') + 1
      && !bundleManifestJson.files.includes('systems/ads_studio/15o0-studio-staff-loader.js')
      && builtStudio === read('www/studio.js') && builtStaff === read('www/studio-staff.js') && builtPages === read('www/studio-pages.js')
      && builtStudio.includes(loaderSrc) && !builtStudio.includes('function renderStudioDeskSection(') && !builtStudio.includes('function renderStudioHealthSection(') && !builtStudio.includes('function renderStudioPagesBody(')
      && [healthSrc, deskSrc, adminSrc].every(src => builtStaff.includes(src)) && !builtStaff.includes(loaderSrc) && builtPages === pagesSrcForRule
      && ['renderStudioDeskSection', 'renderStudioStaffSection', 'renderStudioPagesBody', 'ensureStudioBundle'].every(name => !read('script.js').includes(name))
      && ['studio.js', 'studio-staff.js', 'studio-pages.js'].every(name => fs.statSync(path.join(ROOT, name)).size < MiB),
    bundleSizes);
  check('the lazy bundle loader (15o0) is ONE named loader for studio-staff.js and studio-pages.js (script-tag URL with the same ?v=, one promise per bundle, 30 s failure cooldown, typeof-guarded ready checks, bilingual retry cards) and every frame calls it: the desk (15h, 15c), the replies/posts tabs (15h), the guide links (15k, 15m), the Help list (15n), the classic handover (15f); both bundles are served and shipped',
    loaderSrc.includes("const base = parts[0].replace(/script(\\.min)?\\.js$/, name);") && loaderSrc.includes('const _STUDIO_BUNDLE_RETRY_COOLDOWN_MS = 30000;')
      && loaderSrc.includes("if (slot.state === 'failed' && Date.now() - slot.failedAt < _STUDIO_BUNDLE_RETRY_COOLDOWN_MS) return Promise.resolve();")
      && loaderSrc.includes("ready: () => typeof renderStudioDeskSection === 'function' && typeof renderStudioHealthSection === 'function',")
      && loaderSrc.includes("ready: () => typeof renderStudioPagesBody === 'function' && typeof studioGuideOpen === 'function',")
      && loaderSrc.includes('onclick="retryStudioBundle(\'${name}\')"') && ['تعذر تحميل مكتب الفريق', 'جارٍ تحميل مكتب الفريق', 'تعذر تحميل الصفحات والأدلة', 'جارٍ تحميل الصفحات والأدلة'].every(words => loaderSrc.includes(words))
      && ['function ensureStudioBundle(name, readyCheck = null)', 'function studioBundleScreen(name)', 'function renderStudioStaffSection(section, route = null)', "function studioGuideLinks(keys, testId = 'studio-guide-links')", 'function studioPagesClassicHandover(tab)'].every(sig => loaderSrc.includes(sig))
      && shellSrc.includes("typeof renderStudioStaffSection === 'function' ? renderStudioStaffSection(section[0], route) :")
      && shellSrc.includes("const STUDIO_V2_LAZY_SCREENS = Object.freeze({ replies: 'studio-pages.js', posts: 'studio-pages.js' });") && shellSrc.includes('body = studioBundleScreen(STUDIO_V2_LAZY_SCREENS[route.tab]) || null;')
      && adsStudio.includes("typeof renderStudioStaffSection === 'function' ? renderStudioStaffSection('health')") && !adsStudio.includes('renderStudioHealthSection()')
      && adsSrc.includes("typeof studioGuideLinks === 'function' ? studioGuideLinks(['stages', 'settle'], 'studio-ad-guides') : ''")
      && read('src/systems/ads_studio/15m-studio-wallet.js').includes("typeof studioGuideLinks === 'function' ? studioGuideLinks(['money', 'settle'], 'studio-wallet-guides') : ''")
      && helpSrc.includes("else if (typeof studioBundleScreen === 'function') guides = studioBundleScreen('studio-pages.js');")
      && socialSrcForRule.includes("typeof studioPagesClassicHandover === 'function' ? studioPagesClassicHandover('replies') : ''") && socialSrcForRule.includes("studioPagesClassicHandover('posts')") && !socialSrcForRule.includes('studioPagesClassicDelegate(')
      && read('server/main.py').includes('return _serve_lazy_bundle(request, "studio-staff.js")') && read('server/main.py').includes('return _serve_lazy_bundle(request, "studio-pages.js")')
      && /^\s*COPY\s.*\bstudio-staff\.js\b/m.test(read('server/Dockerfile')) && /^\s*COPY\s.*\bstudio-pages\.js\b/m.test(read('server/Dockerfile')));
  // ---- the loader alone in a vm sandbox: one request per bundle with the main bundle's ?v=, the card meanwhile,
  // a failure's cooldown and Retry, the screen once the bundle's functions are here, the handover and the guide links.
  const loaderDoc = { tags: [], createElement: () => ({ removed: false, remove() { this.removed = true; } }), querySelectorAll: () => [{ src: 'https://albayan.example/studio/script.js?v=abc123' }] };
  loaderDoc.head = { appendChild: tag => loaderDoc.tags.push(tag) };
  const loaderMe = { value: { ui: 'v2' } };
  const loaderBox = vm.createContext({ state: { language: 'en', currentView: 'ads-studio' }, document: loaderDoc, __now: 1000, studioMe: () => loaderMe.value, adsStudioIsAr: () => false }, { microtaskMode: 'afterEvaluate' });
  let loaderError = '';
  try {
    vm.runInContext('var __renders = 0; function render() { __renders++; } var Date = { now: () => __now };', loaderBox);
    vm.runInContext(loaderSrc, loaderBox);
  } catch (error) { loaderError = String(error && error.message || error); }
  const lrun = code => { try { return vm.runInContext(code, loaderBox); } catch (error) { return `THREW ${error && error.message}`; } };
  const pagesCard = String(lrun("studioBundleScreen('studio-pages.js')"));
  lrun("studioBundleScreen('studio-pages.js')");  // a second draw: no second request
  const staffCard = String(lrun("renderStudioStaffSection('requests', { tab: 'review' })"));
  const requested = Array.from(lrun('document.tags.map(tag => tag.src)') || []);
  lrun('document.tags[0].onerror()');  // the pages request failed
  const failedCard = String(lrun("studioBundleScreen('studio-pages.js')"));
  const tagsInCooldown = lrun('document.tags.length');
  lrun('__now += 30001;');
  const afterCooldown = String(lrun("studioBundleScreen('studio-pages.js')"));
  const tagsAfterCooldown = lrun('document.tags.length');
  lrun('document.tags[2].onerror(); __now += 1;');
  const rendersBeforeRetry = lrun('__renders');
  lrun("retryStudioBundle('studio-pages.js')");  // the Retry button: a new request at once
  const tagsAfterRetry = lrun('document.tags.length');
  const rendersAfterRetry = lrun('__renders');
  const handoverCard = String(lrun("studioPagesClassicHandover('replies')"));
  const guideLinksMeanwhile = String(lrun("studioGuideLinks(['money'])"));
  loaderMe.value = { ui: 'classic' };
  const handoverClassic = String(lrun("studioPagesClassicHandover('posts')"));
  loaderMe.value = { ui: 'v2' };
  lrun("function renderStudioDeskSection(section, route) { return '<desk ' + section + '>'; } function renderStudioHealthSection() { return '<health>'; } document.tags[1].onload();");
  const staffDrawn = String(lrun("renderStudioStaffSection('requests', { tab: 'review' })"));
  const healthDrawn = String(lrun("renderStudioStaffSection('health')"));
  lrun("function renderStudioPagesBody() { return '<pages>'; } function studioGuideOpen() { return true; } function studioPagesClassicDelegate(tab) { return '<delegate ' + tab + '>'; } function renderStudioGuideLinks(keys, testId) { return '<links ' + keys.join(',') + ' ' + testId + '>'; } document.tags[3].onload();");
  const pagesReady = String(lrun("studioBundleScreen('studio-pages.js')"));
  const handoverReady = String(lrun("studioPagesClassicHandover('replies')"));
  const guideLinksReady = String(lrun("studioGuideLinks(['money', 'settle'], 'studio-wallet-guides')"));
  const loaderCases = [
    pagesCard.includes('data-testid="studio-pages-bundle-loading"') && pagesCard.includes('Loading pages and guides…') && staffCard.includes('data-testid="studio-staff-bundle-loading"') && staffCard.includes('Loading the Team desk…'),
    JSON.stringify(requested) === JSON.stringify(['https://albayan.example/studio/studio-pages.js?v=abc123', 'https://albayan.example/studio/studio-staff.js?v=abc123']),
    failedCard.includes('data-testid="studio-pages-bundle-failed"') && failedCard.includes('onclick="retryStudioBundle(\'studio-pages.js\')"') && failedCard.includes("Couldn't load pages and guides") && tagsInCooldown === 2,
    afterCooldown.includes('data-testid="studio-pages-bundle-loading"') && tagsAfterCooldown === 3,
    tagsAfterRetry === 4 && rendersAfterRetry === rendersBeforeRetry + 1,
    handoverCard.includes('data-testid="studio-pg-classic"') && handoverCard.includes('data-testid="studio-pages-bundle-loading"') && guideLinksMeanwhile === '' && handoverClassic === '',
    staffDrawn === '<desk requests>' && healthDrawn === '<health>',
    pagesReady === '' && handoverReady === '<delegate replies>' && guideLinksReady === '<links money,settle studio-wallet-guides>'
  ];
  check('the lazy bundle loader in a sandbox: one script request per bundle with the main bundle\'s ?v=, the bilingual card meanwhile, a failed request backs off 30 s (Retry asks again at once and redraws), the desk section and the pages screen draw once their functions are here, the classic handover shows the card only while /me says v2, guide links wait for the bundle',
    !loaderError && loaderCases.every(Boolean), loaderError || `cases ${loaderCases.map((ok, i) => ok ? '' : i).filter(String).join(',')}`);
  // A bundle that executed but did not register its functions (a mismatched or truncated copy): the failed state with
  // the same cooldown as a lost request (the tag is removed, the promise freed), a later draw asks again after 30 s
  // and Retry asks again at once; never a resolved promise that every later draw returns without a request.
  const brokenDoc = { tags: [], createElement: () => ({ removed: false, remove() { this.removed = true; } }), querySelectorAll: () => [{ src: 'https://albayan.example/studio/script.js?v=abc123' }] };
  brokenDoc.head = { appendChild: tag => brokenDoc.tags.push(tag) };
  const brokenBox = vm.createContext({ state: { language: 'en', currentView: 'ads-studio' }, document: brokenDoc, __now: 1000, studioMe: () => ({ ui: 'v2' }), adsStudioIsAr: () => false }, { microtaskMode: 'afterEvaluate' });
  let brokenError = '';
  try {
    vm.runInContext('var __renders = 0; function render() { __renders++; } var Date = { now: () => __now };', brokenBox);
    vm.runInContext(loaderSrc, brokenBox);
  } catch (error) { brokenError = String(error && error.message || error); }
  const brun = code => { try { return vm.runInContext(code, brokenBox); } catch (error) { return `THREW ${error && error.message}`; } };
  brun("studioBundleScreen('studio-pages.js')");
  brun('document.tags[0].onload()');  // executed, but renderStudioPagesBody / studioGuideOpen never appeared
  const brokenState = { state: brun("studioBundleState('studio-pages.js')"), removed: brun('document.tags[0].removed'), promise: brun("_studioBundles.get('studio-pages.js').promise === null"), failedAt: brun("_studioBundles.get('studio-pages.js').failedAt") };
  const brokenCard = String(brun("studioBundleScreen('studio-pages.js')"));
  const brokenTagsInCooldown = brun('document.tags.length');
  brun('__now += 30001;');
  const brokenAfterCooldown = String(brun("studioBundleScreen('studio-pages.js')"));
  const brokenTagsAfterCooldown = brun('document.tags.length');
  brun('document.tags[1].onload(); __now += 1;');  // the same broken copy again
  const brokenRendersBeforeRetry = brun('__renders');
  brun("retryStudioBundle('studio-pages.js')");
  const brokenTagsAfterRetry = brun('document.tags.length');
  const brokenRendersAfterRetry = brun('__renders');
  brun("function renderStudioPagesBody() { return '<pages>'; } function studioGuideOpen() { return true; } document.tags[2].onload();");
  const brokenReady = { state: brun("studioBundleState('studio-pages.js')"), screen: String(brun("studioBundleScreen('studio-pages.js')")) };
  const brokenCases = [
    brokenState.state === 'failed' && brokenState.removed === true && brokenState.promise === true && brokenState.failedAt === 1000,
    brokenCard.includes('data-testid="studio-pages-bundle-failed"') && brokenTagsInCooldown === 1,
    brokenAfterCooldown.includes('data-testid="studio-pages-bundle-loading"') && brokenTagsAfterCooldown === 2,
    brokenTagsAfterRetry === 3 && brokenRendersAfterRetry === brokenRendersBeforeRetry + 1,
    brokenReady.state === 'ready' && brokenReady.screen === ''
  ];
  check('the lazy bundle loader: a bundle that executed without registering its functions is failed with the 30 s cooldown (tag removed, promise freed), a later draw and Retry request it again, and it is ready once a good copy registers',
    !brokenError && brokenCases.every(Boolean), brokenError || `cases ${brokenCases.map((ok, i) => ok ? '' : i).filter(String).join(',')} state ${JSON.stringify(brokenState)}`);
  const deskPairs =[...(deskSrc + adminSrc).matchAll(/adsStudioText\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g)]
    .map(m => m[4] ?? m[5] ?? m[6] ?? '');
  const deskCss = workspaceCssFor => workspaceCssFor.slice(workspaceCssFor.indexOf('/* Albayan Studio v2 Team desk and admin tools'));
  const deskCssText = deskCss(read('assets/ads-workspace.css'));
  // An unclosed block swallows every rule after it (two @media blocks were left open before the desk
  // shipped, so the wallet, help and desk styles applied only at 359 px or narrower): braces must balance.
  const braceDepth = (() => {
    const plain = read('assets/ads-workspace.css').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'[^'\n]*'|"[^"\n]*"/g, '');
    let depth = 0;
    let lowest = 0;
    for (const ch of plain) { if (ch === '{') depth++; else if (ch === '}') depth--; lowest = Math.min(lowest, depth); }
    return { final: depth, lowest };
  })();
  check('ads-workspace.css closes every block it opens (an open block would hide every rule after it outside its media query)', braceDepth.final === 0 && braceDepth.lowest === 0, `final depth ${braceDepth.final}, lowest ${braceDepth.lowest}`);
  check('Team desk files: no native dialogs, no token words, every text pair has Arabic, the styles use the tokens (no raw colours) and are synced to www',
    ![loaderSrc, deskSrc, adminSrc].some(src => /\b(?:confirm|prompt|alert)\(/.test(src.replace(/\/\/.*$/gm, '')))
      && !/accessToken|access_token|appSecret|app_secret|password/i.test(deskSrc + adminSrc)
      && deskPairs.length >= 200 && deskPairs.every(ar => /[؀-ۿ]/.test(ar))
      && deskCssText.length > 4000 && read('www/assets/ads-workspace.css') === read('assets/ads-workspace.css')
      && ['.studio-desk-badge.is-urgent', '.studio-v2-nav.is-staff .studio-v2-nav-item { position: relative; }', '@media (max-width: 900px)', '@media (max-width: 359px)', 'overflow-wrap: anywhere', 'min-height: 44px'].every(rule => deskCssText.includes(rule))
      && !/background(-color)?:\s*#|[^-]color:\s*#/.test(deskCssText),
    `pairs ${deskPairs.length}, first without Arabic: ${deskPairs.find(ar => !/[؀-ۿ]/.test(ar)) || 'none'}`);

  // ---- the desk in a vm sandbox
  const who = { staff: true, admin: false };
  const win = {
    location: { pathname: '/studio', search: '', href: 'http://localhost/studio' },
    listeners: { popstate: [] },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const list = this.listeners[type] || []; const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); },
    localStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })()
  };
  const hist = {
    entries: [], index: 0,
    get length() { return this.entries.length; },
    get state() { return this.entries[this.index] ? this.entries[this.index].state : null; },
    show() { const url = new URL(this.entries[this.index].url, 'http://localhost'); win.location.pathname = url.pathname; win.location.search = url.search; win.location.href = url.href; },
    reset(url) { this.entries = [{ url, state: null }]; this.index = 0; this.show(); },
    pushState(entryState, _title, url) { this.entries.splice(this.index + 1); this.entries.push({ url: String(url), state: JSON.parse(JSON.stringify(entryState)) }); this.index++; this.show(); },
    replaceState(entryState, _title, url) { this.entries[this.index] = { url: String(url || this.entries[this.index].url), state: JSON.parse(JSON.stringify(entryState)) }; this.show(); },
    go(delta) { const next = this.index + delta; if (!delta || next < 0 || next >= this.entries.length) return; this.index = next; this.show(); for (const fn of [...win.listeners.popstate]) fn({ state: this.state }); },
    back() { this.go(-1); }
  };
  win.history = hist;
  let secureSeq = 0;
  const box = vm.createContext({
    state: { language: 'en', theme: 'light', currentUser: { id: 'u1', name: 'Reviewer', email: 'rev@albayan.example' }, currentView: 'ads-studio', adCampaignRequests: [], walletTransactions: [], users: [{ id: 'c1', name: 'Customer One' }] },
    Security: {
      escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      isValidRecordId: value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(value ?? '').trim()),
      generateSecureId: prefix => `${prefix}-${++secureSeq}`,
      sanitizeObject: value => JSON.parse(JSON.stringify(value)),
      sanitizeInput: (value, options) => String(value ?? '').slice(0, (options && options.maxLength) || 10000)
    },
    window: win, history: hist, URLSearchParams, URL,
    isServerModeEnabled: () => true,
    isCurrentUserAdmin: () => who.admin,
    currentUserHasPermission: (collection, action) => (who.staff ? true : action !== 'review' && action !== 'view'),
    hasSubscription: () => false,
    canActOnRecord: () => true,
    getVisibleRecords: list => (Array.isArray(list) ? list.filter(item => item && !item._deleted) : []),
    getEntityPhotoCountHint: () => 2,
    getAuthMeIdentity: () => 'session',
    updateUrlParams: () => {}, requestViewScrollReset: () => {}, IS_STUDIO_SHELL: true,
    TIME_CONSTANTS: { API_TIMEOUT_LONG_MS: 1000 }
  }, { microtaskMode: 'afterEvaluate' });
  let loadError = '';
  try {
    const at = forms.indexOf('function normalizeDigitsAscii(');
    vm.runInContext(forms.slice(at, forms.indexOf('\n}\n', at) + 2), box);
    vm.runInContext(`
      var __calls = [];
      var __replies = Object.create(null);
      var __timers = new Map();
      var __timerSeq = 0;
      var __html = '';
      var __notes = [];
      var performance = { now: () => 100, getEntriesByType: () => [{ type: 'navigate', name: '' }] };
      var document = { visibilityState: 'visible', title: 'Albayan Studio', addEventListener() {}, removeEventListener() {} };
      var console = { warn() {}, log() {}, error() {} };
      function setTimeout(fn, ms) { const id = ++__timerSeq; __timers.set(id, { fn, ms: Number(ms) || 0 }); return id; }
      function clearTimeout(id) { __timers.delete(id); }
      function __runTimers() { for (let round = 0; round < 5 && __timers.size; round++) { const due = Array.from(__timers.entries()); __timers.clear(); due.forEach(([, t]) => t.fn()); } }
      function getUrlParams() { return { tab: new URLSearchParams(window.location.search).get('tab') }; }
      function apiJson(path, options) {
        __calls.push({ path: String(path), method: String((options && options.method) || 'GET'), body: options && options.body ? JSON.parse(JSON.stringify(options.body)) : null });
        const next = (__replies[path] || []).shift();
        if (!next) return new Promise(() => {});
        if (next.error) return Promise.reject(Object.assign(new Error(next.error.message || 'Request failed'), next.error));
        return Promise.resolve(JSON.parse(JSON.stringify(next.value)));
      }
      function showNotification(title, message, type) { __notes.push({ title, message, type }); }
      function getServerSessionIdentity() { return 'session'; }
      function serverSessionIdentityChanged() { return false; }
      function makeSessionChangedError() { return new Error('session changed'); }
      function requestValidatedServerEntity(collection, context, loader) { return loader(); }
      function validateServerEntityResponse() {}
      function withRetry(fn) { return fn(); }
      function markCollectionDirty() {}
      function clearCollectionCorruption() {}
      function saveState() {}
      function studioBuilderStart() { return true; }
      window.addEventListener('popstate', () => { restoreAdsStudioTabFromUrl(); render(); });
    `, box);
    vm.runInContext(adsStudio, box);
    vm.runInContext(coreSrc, box);
    vm.runInContext(shellSrc, box);
    vm.runInContext(homeSrc, box);
    vm.runInContext(adsSrc, box);
    vm.runInContext(helpSrc, box);
    vm.runInContext(loaderSrc, box);
    vm.runInContext(healthSrc, box);
    vm.runInContext(deskSrc, box);
    vm.runInContext(adminSrc, box);
    vm.runInContext("function render() { const html = renderStudioV2View(); __html = html || '<classic>'; }", box);
  } catch (error) { loadError = String(error && error.message || error); }
  const run = code => { try { return vm.runInContext(code, box); } catch (error) { return `THREW ${error && error.message}`; } };
  const json = code => { try { return JSON.parse(String(run(`JSON.stringify(${code})`))); } catch (_) { return undefined; } };
  const html = () => String(run('__html'));
  const failed = cases => cases.map((ok, i) => ok ? '' : i).filter(String).join(',');
  const reply = (path, value) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ value: ${JSON.stringify(value)} });`);
  const replyError = (path, error) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ error: ${JSON.stringify(error)} });`);
  const calls = (method, path) => (json('__calls') || []).filter(c => c.method === method && c.path === path);
  const openAt = url => { hist.reset(url); run('_studioV2.docRendered = false; render();'); };
  const inLanguage = (language, code) => { box.state.language = language; const out = run(code); box.state.language = 'en'; return out; };
  const arabicOnly = value => /[؀-ۿ]/.test(value) && !/[A-Za-z]{3}/.test(value.replace(/PAY|LYD|USD|T-|ALB-S|HH:MM|YYYY-MM-DD/g, ''));
  const meReply = value => run(`studioResetMe(); __replies['/api/studio/me'] = [{ value: ${JSON.stringify(value)} }]; studioLoadMe();`);
  // The settled value of an action's promise (microtasks run after each evaluate).
  const outcome = code => { run(`__out = null; (${code}).then(o => { __out = o; });`); return json('__out'); };
  const hours = n => new Date(Date.now() + n * 3600000).toISOString();
  const staffMe = { ui: 'classic', staffDesk: 'v2', isStaff: true, isAdmin: false, services: { help: true, stopRequest: true, tiktok: false }, serviceHours: {}, contact: {} };
  const requestsRows = () => [
    { id: 'r_sub', createdBy: 'c1', status: 'Submitted', name: 'Weekly <offer>', objective: 'messages', platforms: ['facebook'], pageName: 'Shop Page', primaryText: 'Message us today', headline: 'Offer', budgetMinorUSD: 1000, budgetType: 'daily', durationDays: 7, totalBudgetMinorUSD: 7000, schemaVersion: 2, startDate: '2099-01-10', endDate: '2099-01-16', submittedAt: hours(-3), boostType: 'boost_post', sourcePostRef: 'https://www.facebook.com/shop/posts/1', _created: 9, _lastModified: 19 },
    { id: 'r_sub2', createdBy: 'c1', status: 'Submitted', name: 'Second waiting', objective: 'messages', platforms: ['facebook'], budgetMinorUSD: 2500, budgetType: 'lifetime', durationDays: 5, startDate: '2099-02-01', endDate: '2099-02-05', _created: 8, _lastModified: 18 },
    { id: 'r_own', createdBy: 'u1', status: 'Submitted', name: 'My own request', budgetMinorUSD: 500, _created: 7, _lastModified: 17 },
    { id: 'r_app', createdBy: 'c1', status: 'Approved', name: 'Approved, not linked', paidMinorUSD: 5000, budgetMinorUSD: 5000, budgetType: 'lifetime', durationDays: 7, studioRef: 'ALB-S-AB12CD34', studioName: 'ALB-S-AB12CD34 · Approved, not linked', startDate: '2099-01-10', endDate: '2099-01-16', _created: 6, _lastModified: 16 },
    { id: 'r_lnk', createdBy: 'c1', status: 'Approved', name: 'Linked and ended', paidMinorUSD: 4000, budgetMinorUSD: 4000, budgetType: 'lifetime', durationDays: 3, studioRef: 'ALB-S-EF56GH78', studioName: 'ALB-S-EF56GH78 · Linked and ended', metaAdAccountId: '9876543210', metaCampaignId: '120200000000000001', startDate: '2026-01-01', endDate: '2026-01-03', _created: 5, _lastModified: 15 },
    { id: 'r_old', createdBy: 'c1', status: 'Approved', name: 'Never linked, past its end', paidMinorUSD: 900, budgetMinorUSD: 900, budgetType: 'lifetime', durationDays: 2, startDate: '2025-01-01', endDate: '2025-01-02', _created: 4, _lastModified: 14 },
    // Linked once, unlinked by staff since (the server keeps the link history): settled on the old campaign's row, never a "never linked" full return.
    { id: 'r_was', createdBy: 'c1', status: 'Approved', name: 'Unlinked after a link', paidMinorUSD: 3000, budgetMinorUSD: 3000, budgetType: 'lifetime', durationDays: 2, lastLinkedMetaCampaignId: '120200000000000009', lastLinkedMetaAdAccountId: '9876543210', everLinked: true, startDate: '2025-02-01', endDate: '2025-02-02', _created: 3, _lastModified: 13 }
  ];
  const endedStage = { stage: 10, stageKey: 'ended_settling', labels: { en: 'Ended — final amount being calculated', ar: 'انتهى — نحسب المبلغ النهائي' }, linked: true, checkedAt: hours(-1), checkedAgo: { en: 'checked 1 hour ago', ar: 'فُحص قبل ساعة' }, metaUsedMinor: 1234, actions: ['ask'], tracker: { step: 'ended', side: false } };
  const endedResults = { campaignId: 'r_lnk', linked: true, stage: endedStage, results: { metaUsedMinor: 1234, paidMinor: 4000 }, staff: { syncState: 'ok', deliveryEndedAt: hours(-1), settleReadDueAt: hours(47), settleReadAt: null, spendConfirmedAt: hours(-1), neverDelivered: false } };
  // The server's answer for the unlinked-after-link row: its stage logic sees no Meta id (the "never linked" variant), the staff row is the old campaign's.
  const wasResults = { campaignId: 'r_was', linked: false, stage: { stage: 10, stageKey: 'ended_settling', labels: { en: 'Ended — final amount being calculated', ar: 'انتهى — نحسب المبلغ النهائي' }, variantLabels: { en: 'Meta never showed this ad: a full return', ar: 'لم تعرض ميتا هذا الإعلان: يعود المبلغ كاملاً' }, linked: false, actions: ['ask'] },
    results: { metaUsedMinor: null, paidMinor: 3000 }, staff: { metaCampaignId: '120200000000000009', metaAdAccountId: '9876543210', syncState: 'ok', currency: 'USD', spendMinorUSD: 1500, spendConfirmedAt: hours(-50), deliveryEndedAt: hours(-60), settleReadDueAt: hours(-12), settleReadAt: hours(-11), neverDelivered: false } };
  // openTickets includes the urgent ticket of every open stop request (stopTicketsOpen is that overlap): one stop request counts once.
  const pulse = { waitingReview: 2, stopRequests: 1, openTickets: 3, stopTicketsOpen: 1, alerts: 0, updatedAt: hours(0) };
  box.state.adCampaignRequests = requestsRows();
  meReply(staffMe);
  reply('/api/studio/staff/pulse', pulse);
  openAt('/studio?tab=review&section=requests');
  run('__runTimers()');
  const queueHtml = html();
  check('Team desk requests: the loader draws the real section (no loading card), the queue lists the customers\' waiting requests (budget as daily × days, page, sent when) and never the reviewer\'s own; paging shows 20 first',
    !loadError && queueHtml.includes('data-testid="studio-desk" data-section="requests"') && !queueHtml.includes('studio-staff-bundle-loading') && !queueHtml.includes('studio-soon')
      && queueHtml.includes('studio-desk-request-r_sub') && queueHtml.includes('studio-desk-request-r_sub2') && !queueHtml.includes('studio-desk-request-r_own')
      && queueHtml.includes('Waiting for review (2)') && queueHtml.includes('$10.00/day × 7 days = $70.00') && queueHtml.includes('Shop Page') && queueHtml.includes('Weekly &lt;offer&gt;') && queueHtml.includes('Customer One')
      && json("Object.keys(_studioDesk.pulse.value || {})").length === 6 && json('studioDeskBadgeCounts()').requests === 2 && json('studioDeskBadgeCounts()').tickets === 3
      && run('document.title') === '(5) Albayan Studio' && calls('GET', '/api/studio/staff/pulse').length >= 1
      // two stop requests whose tickets were answered (queue rows open, tickets no longer 'open') still count once each
      && String(json(`(function () { const keep = _studioDesk.pulse.value; _studioDesk.pulse.value = studioDeskCleanPulse(${JSON.stringify({ ...pulse, stopRequests: 3, stopTicketsOpen: 1 })}); const out = [studioDeskBadgeCounts().tickets, studioDeskTitleCount(_studioDesk.pulse.value)]; _studioDesk.pulse.value = keep; return out; })()`)) === '5,7',
    loadError || `title ${run('document.title')} html ${queueHtml.slice(0, 300)}`);
  openAt('/studio?tab=review&section=requests&id=r_sub');
  const detailHtml = html();
  const noReason = outcome("studioDeskDecide('r_sub', 'Rejected')");
  run("studioDeskPickReason('r_sub', 'text_policy'); studioDeskNoteInput('r_sub', { value: 'Please soften the claim.' });");
  reply('/api/ad-studio/campaigns/r_sub/review', { id: 'r_sub', data: { ...requestsRows()[0], status: 'Rejected', reviewReasonCode: 'text_policy', reviewNote: 'Please soften the claim.', _lastModified: 20 }, lastModified: 20 });
  run("studioDeskDecide('r_sub', 'Rejected'); studioDeskDecide('r_sub', 'Rejected');");
  run('render()');
  const rejectCall = calls('POST', '/api/ad-studio/campaigns/r_sub/review');
  const afterReject = html();
  check('Team desk decision: the detail shows the customer\'s texts, the post link and the photos button, the 7 reason codes; send back / reject need a reason and a note (no request), then ONE review call carries the reason code and an operationId; the outcome box replaces the form',
    detailHtml.includes('data-testid="studio-desk-brief"') && detailHtml.includes('Message us today') && detailHtml.includes('studio-desk-post-link') && detailHtml.includes('View the photos (2)')
      && ADS_STUDIO_REASONS_LIST.every(code => detailHtml.includes(`data-testid="studio-desk-reason-${code}"`))
      && noReason && noReason.ok === false && /Choose a reason/.test(noReason.text)
      && rejectCall.length === 1 && rejectCall[0].body.decision === 'Rejected' && rejectCall[0].body.reviewReasonCode === 'text_policy' && rejectCall[0].body.note === 'Please soften the claim.' && /^campaign-review-\d+$/.test(rejectCall[0].body.operationId) && rejectCall[0].body.expectedLastModified === 19
      && afterReject.includes('data-testid="studio-desk-outcome" data-decision="Rejected"') && !afterReject.includes('data-testid="studio-desk-decision"'),
    `calls ${rejectCall.length} noReason ${JSON.stringify(noReason)}`);
  openAt('/studio?tab=review&section=requests&id=r_sub2');
  const pending = outcome("studioDeskDecide('r_sub2', 'Approved')");
  reply('/api/ad-studio/campaigns/r_sub2/review', { id: 'r_sub2', data: { ...requestsRows()[1], status: 'Approved', paidMinorUSD: 2500, studioRef: 'ALB-S-NEW11111', studioName: 'ALB-S-NEW11111 · Second waiting', _lastModified: 21 }, lastModified: 21 });
  run("studioDeskDecide('r_sub2', 'Approved', null, true)");
  run('render()');
  const approveCall = calls('POST', '/api/ad-studio/campaigns/r_sub2/review');
  const afterApprove = html();
  check('Team desk approval: the first tap asks for the in-page confirmation (no request), the confirmed tap sends ONE review call without a reason code; the outcome shows the studio name with Copy and the way to Launch',
    pending && pending.ok === true && pending.pending === true && approveCall.length === 1 && approveCall[0].body.decision === 'Approved' && !('reviewReasonCode' in approveCall[0].body)
      && afterApprove.includes('data-decision="Approved"') && afterApprove.includes('ALB-S-NEW11111 · Second waiting') && afterApprove.includes('studio-desk-copy-r_sub2') && afterApprove.includes('studio-desk-to-launch'),
    `pending ${JSON.stringify(pending)} calls ${approveCall.length}`);
  reply('/api/studio/campaigns/r_lnk/results', endedResults);
  openAt('/studio?tab=review&section=launch');
  run('render()');
  const launchHtml = html();
  check('Team desk launch: Approved-not-linked requests show the studio name with Copy, the checklist (studio code, budget within paid) and the classic Link sheet button; linked ones sit under "In Meta" with Check Meta now and Unlink; an ended one is not there',
    launchHtml.includes('data-testid="studio-desk-launch-r_app"') && launchHtml.includes('ALB-S-AB12CD34 · Approved, not linked') && launchHtml.includes('studio-desk-copy-r_app')
      && launchHtml.includes("openAdsStudioLinkSheet('r_app')") && launchHtml.includes('within what was paid ($50.00)') && launchHtml.includes('data-testid="studio-desk-launch-r_sub2"')
      && !launchHtml.includes('studio-desk-linked-r_lnk') && !launchHtml.includes('studio-desk-launch-r_lnk') && calls('GET', '/api/studio/campaigns/r_lnk/results').length === 1,
    launchHtml.slice(0, 200));
  reply('/api/studio/campaigns/r_was/results', wasResults);
  openAt('/studio?tab=review&section=settle');
  run('render()');  // the results read of the unlinked-after-link row answered
  const settleHtml = html();
  const settleAr = inLanguage('ar', 'render(); __html');
  const wasCard = settleHtml.slice(settleHtml.indexOf('data-testid="studio-desk-settle-r_was"'), settleHtml.indexOf('</li>', settleHtml.indexOf('data-testid="studio-desk-settle-r_was"')));
  replyError('/api/ad-studio/campaigns/r_lnk/stop', { status: 409, payload: { detail: { code: 'SETTLE_NOT_READY', message: 'The final amount is not ready until ' + hours(47), messageAr: 'المبلغ النهائي غير جاهز قبل ' + hours(47), readyAt: hours(47) } } });
  const notReady = outcome("studioDeskSettleRun('settle', 'r_lnk', 2766, '')");
  const keptReadyAt = String(json("_studioDesk.settle.get('r_lnk').readyAt") || '');
  reply('/api/ad-studio/campaigns/r_lnk/stop', { id: 'r_lnk', data: { ...requestsRows()[4], status: 'Stopped', closeReason: 'completed', refundMinorUSD: 2766, settleBasis: 'final_read', _lastModified: 30 }, lastModified: 30 });
  const settled = outcome("studioDeskSettleRun('settle', 'r_lnk', 2766, ''), studioDeskSettleRun('settle', 'r_lnk', 2766, '')");
  const stopCalls = calls('POST', '/api/ad-studio/campaigns/r_lnk/stop');
  const settleCases = [
    settleHtml.includes('data-testid="studio-desk-settle-r_lnk" data-ready="0"'), settleHtml.includes('Paid $40.00 · Meta used $12.34 · Return up to $27.66'), /Final Meta read in 4[67] h \d+ min/.test(settleHtml),
    settleHtml.includes('data-testid="studio-desk-settle-r_old" data-ready="1"'), settleHtml.includes('Never linked to Meta: the full amount goes back now.'), settleHtml.includes('studio-desk-finish-r_lnk'), !settleHtml.includes('studio-desk-override-r_lnk'),
    /قراءة ميتا النهائية بعد 4[67] س \d+ د/.test(String(settleAr)), String(settleAr).includes('مدفوع $40.00'),
    !!notReady && notReady.ok === false && String(notReady.text).startsWith('The final amount is not ready until'), /^\d{4}-\d{2}-\d{2}T/.test(keptReadyAt),
    !!settled && settled.ok === true, stopCalls.length === 2 && stopCalls.every(c => c.body.closeReason === 'completed' && c.body.refundMinorUSD === 2766 && c.body.expectedLastModified === 15), stopCalls.length === 2 && stopCalls[0].body.operationId === stopCalls[1].body.operationId,
    json("state.adCampaignRequests.find(r => r.id === 'r_lnk').status") === 'Stopped',
    // unlinked after a link: its results are read, Meta used and the cap come from the old campaign's row, no "never linked" words, no Check Meta now
    calls('GET', '/api/studio/campaigns/r_was/results').length === 1 && wasCard.includes('data-ready="1" data-was-linked="1"') && wasCard.includes('Paid $30.00 · Meta used $15.00 · Return up to $15.00')
      && wasCard.includes('Final Meta read done') && !wasCard.includes('Never linked') && !wasCard.includes('never showed') && !wasCard.includes('studio-desk-check-r_was') && wasCard.includes('studio-desk-finish-r_was'),
    !settleHtml.includes('48 h') && !String(settleAr).includes('48 ساعة') && settleHtml.includes('after the final Meta reading') && !deskSrc.includes('48 h') && !deskSrc.includes('48 ساعة')
  ];
  check('Team desk settle: the ended linked request shows paid, Meta used, the cap and the countdown to the final read (in Arabic too); the never-linked one is ready at once; one unlinked after a link is settled on the old campaign\'s row (Meta used and the cap shown, never "never linked"); no hardcoded 48 h; a SETTLE_NOT_READY 409 is shown from its bilingual shape and keeps readyAt; the settle posts closeReason completed with the amount and one operationId per version',
    settleCases.every(Boolean), `cases ${failed(settleCases)}; notReady ${JSON.stringify(notReady)} settled ${JSON.stringify(settled)} calls ${stopCalls.length}; was-linked money ${(wasCard.match(/studio-desk-settle-money">([^<]*)</) || [])[1]} ready ${(wasCard.match(/data-ready="(\d)"/) || [])[1]}`);
  check('Team desk refusals: every settle refusal prefix of the server is read through the ONE Arabic map (15c; the desk keeps no list of its own, the classic lookup gives the same words), the unknown fallback stays calm, and Arabic readers never see raw English',
    (() => {
      const actionsPy = read('server/systems/ads_studio/ad_campaign_actions.py');
      const prefixes = [...actionsPy.matchAll(/^REFUSE_(?:SETTLE|REFUND|OVERRIDE)_[A-Z_]+ = "([^"]+)"/gm)].map(m => m[1]);
      const deskText = prefix => String(inLanguage('ar', `studioDeskErrorInfo(Object.assign(new Error('x'), { status: 409, payload: { detail: ${JSON.stringify(`${prefix} ($1.00)`)} } })).text`));
      const classicText = prefix => String(inLanguage('ar', `adsStudioRefusalText(${JSON.stringify(`${prefix} ($1.00)`)})`));
      const covered = prefixes.every(prefix => arabicOnly(deskText(prefix)) && deskText(prefix) === classicText(prefix));
      const unknown = inLanguage('ar', "studioDeskErrorInfo(Object.assign(new Error('Something odd'), { status: 400, payload: { detail: 'Something odd happened' } })).text");
      // the closed month (operations.py, 423) keeps its words in both languages through the same map
      const closedMonth = language => String(inLanguage(language, "studioDeskErrorInfo(Object.assign(new Error('x'), { status: 423, payload: { detail: 'Financial period 2026-09 is closed. An Admin must unlock it before editing.' } })).text"));
      return prefixes.length >= 12 && covered && !deskSrc.includes('STUDIO_DESK_REFUSALS') && deskSrc.includes("const info = studioErrorInfo(error, 'action');") && arabicOnly(String(unknown))
        && closedMonth('en') === 'This month is closed in the books. An admin must unlock it first.' && closedMonth('ar') === 'هذا الشهر مقفل في الدفاتر. يجب أن يفتحه المدير أولاً.';
    })());
  // The pulse: a new stop request rings (when the switch is on) and the title follows; leaving the desk stops the watch and restores the title.
  run("studioDeskToggleSound()");
  const soundOn = json('studioDeskSoundOn()');
  run(`studioDeskOnPulse(${JSON.stringify({ ...pulse, stopRequests: 2, updatedAt: hours(0.01) })})`);
  const title2 = run('document.title');
  box.state.currentView = 'dashboard';
  run(`studioDeskOnPulse(${JSON.stringify(pulse)})`);
  const titleAway = run('document.title');
  const watching = json('_studioDesk.pulse.watching');
  box.state.currentView = 'ads-studio';
  check('Team desk pulse: the sound switch is a per-browser choice, the title carries the count of items waiting for the team (a stop request once, not with its ticket again) and drops it when the desk is left (the watch stops too)',
    soundOn === true && title2 === '(6) Albayan Studio' && titleAway === 'Albayan Studio' && watching === false);
  // Admin: More lists the tools and every setting; the intake form saves with expectedVersion; 409 reloads; the server's message shows.
  who.admin = true;
  meReply({ ...staffMe, isAdmin: true });
  reply('/api/studio/staff/pulse', { ...pulse, paymentsWaiting: 4 });
  openAt('/studio?tab=review&section=more');
  run('__runTimers()');
  const moreHtml = html();
  reply('/api/studio/admin/settings/intake', { key: 'intake', value: { open: true, maxSubmissionsPerDay: 5 }, version: 3, updatedAt: hours(-24) });
  openAt('/studio?tab=review&section=more&id=settings-intake');
  run('render()');
  const intakeHtml = html();
  run("studioAdminInput('intake', 'maxSubmissionsPerDay', { value: 'seven' }); studioAdminSave('intake')");
  const badNumber = json("_studioAdmin.settings.intake.error");
  const noPut = calls('PUT', '/api/studio/admin/settings/intake').length;
  replyError('/api/studio/admin/settings/intake', { status: 409, payload: { detail: { code: 'VERSION_CONFLICT', message: 'saved first' } } });
  run("studioAdminInput('intake', 'maxSubmissionsPerDay', { value: '٧' }); studioAdminInput('intake', 'open', { type: 'checkbox', checked: false }); studioAdminSave('intake')");
  run('render()');
  const conflictHtml = html();
  const putCall = calls('PUT', '/api/studio/admin/settings/intake')[0];
  reply('/api/studio/admin/settings/intake', { key: 'intake', value: { open: true, maxSubmissionsPerDay: 9 }, version: 4, updatedAt: hours(0) });
  run("studioAdminReload('intake')");
  run('render()');
  const reloadedHtml = html();
  replyError('/api/studio/admin/settings/intake', { status: 400, payload: { detail: { code: 'INVALID_VALUE', message: 'maxSubmissionsPerDay must be a whole number from 1 to 500' } } });
  run("studioAdminInput('intake', 'maxSubmissionsPerDay', { value: '400' }); studioAdminSave('intake')");
  run('render()');
  const refusedHtml = html();
  reply('/api/studio/admin/settings/intake', { key: 'intake', value: { open: true, maxSubmissionsPerDay: 12 }, version: 5, updatedAt: hours(0) });
  run("studioAdminInput('intake', 'maxSubmissionsPerDay', { value: '12' }); studioAdminSave('intake')");
  run('render()');
  const savedHtml = html();
  check('Admin More: the menu lists the tools, every setting key and the payments count; the intake form shows the explanation, the version and stable ids; a bad number never reaches the server; the PUT carries expectedVersion and typed values (Arabic digits read); a 409 opens the reload flow that drops the edits; the server\'s validation message is shown; a save shows the new version',
    moreHtml.includes('studio-admin-open-payments') && moreHtml.includes('studio-admin-open-collisions') && STUDIO_ADMIN_KEYS_LIST.every(key => moreHtml.includes(`studio-admin-open-settings-${key}`))
      && moreHtml.includes('data-testid="studio-admin-count-payments">4<') && moreHtml.includes('studio-desk-sound-toggle') && moreHtml.includes('studio-basics') && moreHtml.includes('studio-admin-alert-test-button')
      && intakeHtml.includes('data-testid="studio-admin-form-intake" data-version="3"') && intakeHtml.includes('id="studio-admin-intake-maxSubmissionsPerDay"') && intakeHtml.includes('id="studio-admin-intake-open"') && intakeHtml.includes('data-testid="studio-admin-about"')
      && /enter a whole number/.test(String(badNumber)) && noPut === 0
      && putCall && putCall.body.expectedVersion === 3 && putCall.body.value.maxSubmissionsPerDay === 7 && putCall.body.value.open === false
      && conflictHtml.includes('data-testid="studio-admin-conflict" data-code="VERSION_CONFLICT"') && conflictHtml.includes('studio-admin-reload')
      && reloadedHtml.includes('data-version="4"') && reloadedHtml.includes('value="9"') && !reloadedHtml.includes('studio-admin-conflict')
      && refusedHtml.includes('data-testid="studio-admin-server-message"') && refusedHtml.includes('maxSubmissionsPerDay must be a whole number from 1 to 500')
      && savedHtml.includes('data-testid="studio-admin-saved" data-version="5"'),
    `badNumber ${badNumber} put ${JSON.stringify(putCall && putCall.body)}`);
  reply('/api/studio/admin/settings/hours', { key: 'hours', value: { timezone: 'Africa/Tripoli', week: { sun: { open: '09:00', close: '17:00' }, mon: { open: '09:00', close: '17:00' }, tue: null, wed: null, thu: null, fri: null, sat: null }, holidays: [{ date: '2026-12-24', labelEn: 'Independence Day', labelAr: 'عيد الاستقلال' }], ramadan: null, onDutyUntil: '23:00' }, version: 1, updatedAt: hours(-5) });
  openAt('/studio?tab=review&section=more&id=settings-hours');
  run('render()');
  const hoursHtml = html();
  run("studioAdminHolidayAdd('hours'); studioAdminHolidayInput('hours', 1, 'date', { value: '2026-03-20' }); studioAdminHolidayInput('hours', 1, 'labelEn', { value: 'Eid' }); studioAdminHolidayInput('hours', 1, 'labelAr', { value: 'العيد' }); studioAdminInput('hours', 'week.tue.on', { type: 'checkbox', checked: true });");
  const hoursValue = json("studioAdminBuildValue('hours', _studioAdmin.settings.hours)");
  run("studioAdminInput('hours', 'week.sun.close', { value: '08:00' })");
  const hoursBad = json("studioAdminBuildValue('hours', _studioAdmin.settings.hours)");
  check('Admin hours form: the week with open/closed days and times, holidays (add, name in both languages) and the on-duty hour build the server\'s shape; a closing time before opening is refused in words',
    hoursHtml.includes('data-testid="studio-admin-week"') && hoursHtml.includes('data-testid="studio-admin-hours-sun-open"') && hoursHtml.includes('data-day="tue" data-open="0"') && hoursHtml.includes('Independence Day') && hoursHtml.includes('studio-admin-holiday-add')
      && hoursValue && hoursValue.value && hoursValue.value.week.tue && hoursValue.value.week.tue.open === '09:00' && hoursValue.value.week.wed === null && hoursValue.value.holidays.length === 2 && hoursValue.value.holidays[1].labelAr === 'العيد' && hoursValue.value.ramadan === null && hoursValue.value.onDutyUntil === '23:00'
      && hoursBad && /closing later than opening/.test(hoursBad.error),
    `value ${JSON.stringify(hoursValue)} bad ${JSON.stringify(hoursBad)}`);
  const alertRow = (id, extra = {}) => ({ id, kind: 'stop_request_overdue', labels: { en: 'A stop request has waited longer than the target: pause the ad in Meta now', ar: 'انتظر طلب إيقاف أكثر من الوقت المحدد: أوقف الإعلان في ميتا الآن' }, count: 2, lastAt: hours(-1), relatedType: 'adCampaignRequests', relatedId: 'r_lnk', acknowledgedAt: null, details: {}, ...extra });
  reply('/api/studio/admin/alerts?limit=20', { alerts: [alertRow('al1'), alertRow('al2', { kind: 'integrity_violation', count: 1 }), alertRow('al3', { acknowledgedAt: hours(-2), acknowledgedBy: 'u9' })], nextBefore: null, jobs: { enabled: true, late: true, lastTickAt: hours(-1) } });
  openAt('/studio?tab=review&section=more&id=alerts');
  run('render()');
  const alertsHtml = html();
  const alertsAr = inLanguage('ar', 'render(); __html');
  // Acknowledge (P3-23): single flight, the row leaves the open list, the pulse is read again; a replay is a success;
  // UNKNOWN_ALERT (archived or stale) is told in the reader's words and the list is read again.
  reply('/api/studio/admin/alerts/al1/ack', { alert: alertRow('al1', { acknowledgedAt: hours(0), acknowledgedBy: 'u1' }), replay: false });
  run("__notes.length = 0; studioAdminAlertAck('al1'); studioAdminAlertAck('al1');");
  run('render()');
  const ackedHtml = html();
  const ackCalls = calls('POST', '/api/studio/admin/alerts/al1/ack');
  const ackNotes = json('__notes') || [];
  const pulseReadsAfterAck = calls('GET', '/api/studio/staff/pulse').length;
  replyError('/api/studio/admin/alerts/al2/ack', { status: 404, message: 'x', payload: { detail: { code: 'UNKNOWN_ALERT', message: 'No studio alert has this id' } } });
  reply('/api/studio/admin/alerts?limit=20', { alerts: [alertRow('al3', { acknowledgedAt: hours(-2) })], nextBefore: null, jobs: { enabled: true, late: false, lastTickAt: hours(0) } });
  run("__notes.length = 0;");
  inLanguage('ar', "studioAdminAlertAck('al2');");
  const unknownNote = (json('__notes') || [])[0] || {};
  run('render()');
  const refreshedHtml = html();
  const alertsReads = calls('GET', '/api/studio/admin/alerts?limit=20').length;
  reply('/api/meta-ads/collisions', { generatedAt: hours(0), counts: { total: 2, open: 1, kept: 1, byReason: { studio_name: 2, studio_campaign_id: 1 }, withMoney: 1, withCustomer: 0, removable: 1, untouched: 1 }, rows: [{ adId: 'ad_1', reasons: ['studio_name'], studioRequestIds: ['r_lnk'], kept: false, hasMoney: false, hasCustomer: false, removable: true, untouched: true, importState: 'imported', spend: { metaSpendMinor: 0, metaCurrency: 'USD' } }, { adId: 'ad_2', reasons: ['studio_campaign_id'], studioRequestIds: [], kept: true, hasMoney: true, hasCustomer: false, removable: false, untouched: false, importState: 'edited', spend: { metaSpendMinor: 1500, metaCurrency: 'USD' } }] });
  openAt('/studio?tab=review&section=more&id=collisions');
  run('render()');
  const collisionsHtml = html();
  reply('/api/studio/admin/diagnostics', { generatedAt: hours(0), jobs: { enabled: true, late: false, lastTickAt: hours(-0.02) }, baselines: { B1: { value: 20.5, unit: 'hours', sample: 4 }, B3: { value: 0, unit: 'count', sample: 2 } }, operations: { window: { queueDays: 7 }, queues: { reviews: { percent: 100, met: 3, sample: 3, waitingOverdue: 0, onTarget: true }, tickets: { percent: null, met: 0, sample: 0, waitingOverdue: 1, onTarget: null }, stopRequests: { percent: 50, met: 1, sample: 2, waitingOverdue: 1, onTarget: false }, payments: { percent: 100, met: 1, sample: 1, waitingOverdue: 0, onTarget: true } }, capacity: { intake: { open: true, maxSubmissionsPerDay: 5 }, submissionsToday: 2, usedPercent: 40, sendsPerDay: { average: 1.5, max: 3 }, waitingReview: 2 }, money: { owed: { owedMinorUSD: 123400, studioFundsMinorUSD: 500000, fundsMinusOwedMinorUSD: 376600 }, studioFunds: { fundsMinorUSD: 500000, allowlistConfigured: true }, absorbedOverspend: { totalMinorUSD: 0, thisMonthMinorUSD: 0 }, reconciliation: { month: '2026-09', differenceMinorUSD: 100, toleranceMinorUSD: 500, withinTolerance: true }, openIncidents: 0 }, goNoGo: { go: { reviewsOnTarget: { ok: true, value: 100 }, tokenValid: { ok: null, value: null } }, stop: { heartbeatLate: { fired: false, ageSeconds: 30 } }, allKnownOk: true, unknown: ['tokenValid'], goVerdict: null, stopVerdict: false, consecutiveWeeksNeeded: 2 }, meta: { connection: { state: 'up' }, token: { configured: true, checked: true, isValid: true, daysLeft: 41 } }, storage: { databaseBytes: 5000000, totalRows: 1200, backup: { at: hours(-2), bytes: 100000 } } } });
  openAt('/studio?tab=review&section=more&id=diagnostics');
  run('render()');
  const diagHtml = html();
  // Scan money now (P3-24): single flight, the counts in words, the diagnostics read again; a 429 shows the wait.
  reply('/api/studio/admin/integrity/scan', { counts: { total: 2, byCode: { unreleased_hold: 2 } }, alertId: 'al9', scannedAt: hours(0), swept: { examined: 5, released: [] } });
  reply('/api/studio/admin/diagnostics', { generatedAt: hours(0), jobs: { enabled: true, late: false, lastTickAt: hours(0) }, baselines: {}, operations: {} });
  run("__notes.length = 0; studioAdminScanNow(); studioAdminScanNow();");
  run('render()');
  const scannedHtml = html();
  const scanCalls = calls('POST', '/api/studio/admin/integrity/scan');
  const diagReads = calls('GET', '/api/studio/admin/diagnostics').length;
  replyError('/api/studio/admin/integrity/scan', { status: 429, message: 'x', retryAfter: 540, payload: { detail: { code: 'RATE_LIMITED', message: 'One money scan every 10 minutes. Please wait and try again.' } } });
  run('studioAdminScanNow();');
  run('render()');
  const scanWaitHtml = html();
  const scanWaitAr = inLanguage('ar', 'render(); __html');
  const adminCases = [
    alertsHtml.includes('data-testid="studio-admin-alert" data-kind="stop_request_overdue"'), alertsHtml.includes('pause the ad in Meta now'), alertsHtml.includes('2 times'), alertsHtml.includes('data-testid="studio-admin-heartbeat" data-late="1"'),
    String(alertsAr).includes('أوقف الإعلان في ميتا الآن'), String(alertsAr).includes('متأخر'),
    // the Acknowledge button per open alert only (al3 is acknowledged), in Arabic too
    alertsHtml.includes('data-testid="studio-admin-alert-ack-al1" onclick="studioAdminAlertAck(\'al1\', this)"') && alertsHtml.includes('data-testid="studio-admin-alert-ack-al2"') && !alertsHtml.includes('studio-admin-alert-ack-al3') && alertsHtml.includes('>Acknowledge<') && String(alertsAr).includes('تأكيد الاطلاع'),
    ackCalls.length === 1 && JSON.stringify(ackCalls[0].body) === '{}' && !ackedHtml.includes('data-id="al1"') && ackedHtml.includes('data-id="al2"') && ackNotes.some(note => note.type === 'success' && note.title === 'Alert acknowledged') && pulseReadsAfterAck >= 2,
    unknownNote.type === 'error' && unknownNote.message === 'لا يوجد تنبيه بهذا المعرّف. حدّث الصفحة.' && alertsReads === 2 && !refreshedHtml.includes('data-id="al2"') && refreshedHtml.includes('data-id="al3"'),
    JSON.stringify(json('STUDIO_ERROR_TEXTS.UNKNOWN_ALERT')) === JSON.stringify(['No studio alert has this id. Refresh the page.', 'لا يوجد تنبيه بهذا المعرّف. حدّث الصفحة.']),
    // the diagnostics card's Scan money now
    diagHtml.includes('data-testid="studio-admin-scan-now" onclick="studioAdminScanNow(this)"') && diagHtml.includes('>Scan money now<'),
    scanCalls.length === 1 && JSON.stringify(scanCalls[0].body) === '{}' && scannedHtml.includes('data-testid="studio-admin-scan-note" data-total="2"') && scannedHtml.includes('Scan done: 2 findings') && diagReads === 2,
    scanWaitHtml.includes('data-testid="studio-admin-scan-note" data-total=""') && /Please wait 9 minutes/.test(scanWaitHtml) && String(scanWaitAr).includes('افحص الأموال الآن') && arabicOnly((String(scanWaitAr).match(/studio-admin-scan-note[^>]*><span class="studio-desk-line-label">([^<]*)</) || [])[1] || ''),
    collisionsHtml.includes('data-testid="studio-admin-collision-counts" data-total="2"'), collisionsHtml.includes('data-kept="0" data-removable="1"'), collisionsHtml.includes('an untouched imported copy: removable'), collisionsHtml.includes('kept by the owner&#39;s signed choice'), collisionsHtml.includes('studio_collision_repair.py'), !/apply|repair now/i.test(collisionsHtml.replace(/studio_collision_repair\.py/g, '')),
    diagHtml.includes('data-tone="green" data-testid="studio-admin-queue-reviews"'), diagHtml.includes('100% met (3 of 3), 0 waiting past the target'), diagHtml.includes('data-tone="red" data-testid="studio-admin-queue-stopRequests"'),
    diagHtml.includes('open, cap 5 a day'), diagHtml.includes('$1,234.00'), diagHtml.includes('$3,766.00'), diagHtml.includes('data-tone="green" data-testid="studio-admin-go-reviewsOnTarget"'), diagHtml.includes('data-tone="green" data-testid="studio-admin-stop-heartbeatLate"'), diagHtml.includes('data-testid="studio-admin-heartbeat" data-late="0"'), diagHtml.includes('41 days left')
  ];
  check('Admin alerts, collisions and diagnostics: the server\'s bilingual alert label (Arabic in Arabic) with the late heartbeat and an Acknowledge per open alert (single flight, the row leaves the list, UNKNOWN_ALERT in the reader\'s words); the collision counts and rows with why each is kept or removable and no apply button; the queues met %, capacity, USD owed vs funds, the go/no-go rows, the heartbeat and Scan money now (single flight, the counts, a 429 shows the wait)',
    adminCases.every(Boolean), `cases ${failed(adminCases)}; ack ${ackCalls.length} notes ${JSON.stringify(ackNotes)} pulse ${pulseReadsAfterAck} unknown ${JSON.stringify(unknownNote)} reads ${alertsReads}; scan ${scanCalls.length} diag ${diagReads} note ${(scannedHtml.match(/studio-admin-scan-note[^>]*>[^<]*<[^>]*>([^<]*)</) || [])[1]} wait ${(scanWaitHtml.match(/studio-admin-scan-note[^>]*>[^<]*<[^>]*>([^<]*)</) || [])[1]}`);
  who.admin = false;
  meReply(staffMe);
  openAt('/studio?tab=review&section=more&id=settings-rollout');
  const reviewerMore = html();
  openAt('/studio?tab=review&section=health');
  const reviewerHealth = html();
  const healthAr = inLanguage('ar', 'render(); __html');
  check('A reviewer gets no admin tool (More shows the note, the sound switch and the basics; Health shows the pulse card and the note), in Arabic too',
    reviewerMore.includes('studio-admin-reviewer') && !reviewerMore.includes('studio-admin-form') && !reviewerMore.includes('studio-admin-open-payments') && reviewerMore.includes('studio-basics')
      && reviewerHealth.includes('data-testid="studio-desk-pulse"') && reviewerHealth.includes('studio-desk-health-reviewer') && !reviewerHealth.includes('Studio health')
      && String(healthAr).includes('نبض المكتب') && String(healthAr).includes('بانتظار المراجعة'));
}

{
  // P4-06, P4-07, P5-03 (Studio v2 Pages & replies, the page-link request and the help guides, 15o): the real
  // 15c, 15f, 15g, 15h, 15j, 15k, 15n and 15o run in a sandbox (fake history and timers, a scripted apiJson keyed
  // by path) with /me answered like the server. Promises settle before each run() returns (microtaskMode
  // 'afterEvaluate'). Static checks cover the bundle, the styles, the texts, the classic map and the 15f handover.
  const vm = require('vm');
  const pagesSrc = read('src/systems/ads_studio/15o-studio-pages.js');
  const loaderSrc = read('src/systems/ads_studio/15o0-studio-staff-loader.js');  // the 15f handover and the guide links go through it
  const socialSrc = read('src/systems/ads_studio/15f-social-studio.js');
  const coreSrc = read('src/systems/ads_studio/15g-studio-core.js');
  const shellSrc = read('src/systems/ads_studio/15h-studio-shell.js');
  const homeSrc = read('src/systems/ads_studio/15j-studio-home.js');
  const adsSrc = read('src/systems/ads_studio/15k-studio-ads.js');
  const helpSrc = read('src/systems/ads_studio/15n-studio-help.js');
  const win = {
    location: { pathname: '/studio', search: '', href: 'http://localhost/studio' },
    listeners: { popstate: [] },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const list = this.listeners[type] || []; const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); },
    localStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })()
  };
  const hist = {
    entries: [], index: 0,
    get length() { return this.entries.length; },
    get state() { return this.entries[this.index] ? this.entries[this.index].state : null; },
    show() { const url = new URL(this.entries[this.index].url, 'http://localhost'); win.location.pathname = url.pathname; win.location.search = url.search; win.location.href = url.href; },
    reset(url) { this.entries = [{ url, state: null }]; this.index = 0; this.show(); },
    pushState(entryState, _title, url) { this.entries.splice(this.index + 1); this.entries.push({ url: String(url), state: JSON.parse(JSON.stringify(entryState)) }); this.index++; this.show(); },
    replaceState(entryState, _title, url) { this.entries[this.index] = { url: String(url || this.entries[this.index].url), state: JSON.parse(JSON.stringify(entryState)) }; this.show(); },
    go(delta) {
      const next = this.index + delta;
      if (!delta || next < 0 || next >= this.entries.length) return;
      this.index = next; this.show();
      for (const fn of [...win.listeners.popstate]) fn({ state: this.state });
    },
    back() { this.go(-1); }
  };
  win.history = hist;
  let secureSeq = 0;
  const box = vm.createContext({
    state: { language: 'en', theme: 'light', currentUser: { id: 'u1', name: 'Sara', email: 'sara@albayan.example' }, currentView: 'ads-studio', adCampaignRequests: [], walletTransactions: [] },
    Security: {
      escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      isValidRecordId: value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(value ?? '').trim()),
      generateSecureId: prefix => `${prefix}-${++secureSeq}`,
      sanitizeObject: value => JSON.parse(JSON.stringify(value))
    },
    window: win, history: hist, URLSearchParams, URL,
    isServerModeEnabled: () => true,
    isCurrentUserAdmin: () => false,
    currentUserHasPermission: (collection, action) => action !== 'review' && action !== 'view',
    hasSubscription: id => id === 'ad_maker',
    canActOnRecord: () => true,
    getVisibleRecords: list => (Array.isArray(list) ? list.filter(item => item && !item._deleted) : []),
    getEntityPhotoCountHint: () => 0,
    updateUrlParams: () => {}, requestViewScrollReset: () => {}, IS_STUDIO_SHELL: true,
    TIME_CONSTANTS: { API_TIMEOUT_LONG_MS: 1000 }
  }, { microtaskMode: 'afterEvaluate' });
  let loadError = '';
  try {
    const at = forms.indexOf('function normalizeDigitsAscii(');
    vm.runInContext(forms.slice(at, forms.indexOf('\n}\n', at) + 2), box);
    vm.runInContext(`
      var __calls = [];
      var __replies = Object.create(null);
      var __timers = new Map();
      var __timerSeq = 0;
      var __html = '';
      var __notes = [];
      var performance = { now: () => 100, getEntriesByType: () => [{ type: 'navigate', name: '' }] };
      var document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
      function setTimeout(fn, ms) { const id = ++__timerSeq; __timers.set(id, { fn, ms: Number(ms) || 0 }); return id; }
      function clearTimeout(id) { __timers.delete(id); }
      function getUrlParams() { return { tab: new URLSearchParams(window.location.search).get('tab') }; }
      function apiJson(path, options) {
        __calls.push({ path: String(path), method: String((options && options.method) || 'GET'), body: options && options.body ? JSON.parse(JSON.stringify(options.body)) : null });
        const next = (__replies[path] || []).shift();
        if (!next) return new Promise(() => {});
        if (next.error) return Promise.reject(Object.assign(new Error(next.error.message || 'Request failed'), next.error));
        return Promise.resolve(JSON.parse(JSON.stringify(next.value)));
      }
      function showNotification(title, message, type) { __notes.push({ title, message, type }); }
      function getServerSessionIdentity() { return 'session'; }
      function serverSessionIdentityChanged() { return false; }
      function getAuthMeIdentity() { return 'session'; }
      function makeSessionChangedError() { return new Error('session changed'); }
      function requestValidatedServerEntity(collection, context, loader) { return loader(); }
      function withRetry(fn) { return fn(); }
      function markCollectionDirty() {}
      function saveState() {}
      function appDateLocale() { return 'en-GB'; }
      function studioBuilderStart() { return true; }
      window.addEventListener('popstate', () => { restoreAdsStudioTabFromUrl(); render(); });
    `, box);
    vm.runInContext(adsStudio, box);
    vm.runInContext(socialSrc, box);
    vm.runInContext(coreSrc, box);
    vm.runInContext(shellSrc, box);
    vm.runInContext(homeSrc, box);
    vm.runInContext(adsSrc, box);
    vm.runInContext(helpSrc, box);
    vm.runInContext(loaderSrc, box);
    vm.runInContext(pagesSrc, box);
    vm.runInContext("function render() { const html = renderStudioV2View(); __html = html || '<classic>'; }", box);
  } catch (error) { loadError = String(error && error.message || error); }
  const run = code => { try { return vm.runInContext(code, box); } catch (error) { return `THREW ${error && error.message}`; } };
  const json = code => { try { return JSON.parse(String(run(`JSON.stringify(${code})`))); } catch (_) { return undefined; } };
  const html = () => String(run('__html'));
  const failed = cases => cases.map((ok, i) => ok ? '' : i).filter(String).join(',');
  const reply = (path, value) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ value: ${JSON.stringify(value)} });`);
  const replyError = (path, error) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ error: ${JSON.stringify(error)} });`);
  const calls = (method, path) => (json('__calls') || []).filter(c => c.method === method && c.path === path);
  const openAt = url => { hist.reset(url); run('_studioV2.docRendered = false; render();'); };
  const inLanguage = (language, code) => { box.state.language = language; const out = run(code); box.state.language = 'en'; return out; };
  const arabicOnly = value => /[؀-ۿ]/.test(value) && !/[A-Za-z]{3}/.test(value.replace(/PAY|LYD|USD|T-|ALB-S/g, ''));
  const meReply = value => run(`studioResetMe(); __replies['/api/studio/me'] = [{ value: ${JSON.stringify(value)} }]; studioLoadMe();`);
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  const between = (page, testId) => { const at = page.indexOf(`data-testid="${testId}"`); return at < 0 ? '' : page.slice(at, page.indexOf('</li>', at) > 0 ? page.indexOf('</li>', at) : at + 3000); };
  const PAGES = '/api/social-studio/pages';
  const RULES = '/api/social-studio/rules';
  const SETTINGS = '/api/social-studio/settings';
  const POSTS = '/api/social-studio/posts';
  const LOG = '/api/social-studio/log?days=30&limit=50';
  const labels = { on: { en: 'Working', ar: 'يعمل' }, poll: { en: 'Working, checked every 5 minutes', ar: 'يعمل — نفحص كل 5 دقائق' }, gated: { en: 'Waiting for Meta approval', ar: 'بانتظار موافقة ميتا' }, off: { en: 'Switched off', ar: 'متوقف' }, unavailable: { en: 'Not available now', ar: 'غير متاح حالياً' } };
  const pageFb = { id: 'spg_fb', platform: 'fb', name: 'Sara <Shop>', metaPageId: '1234567890', healthy: true, health: { state: 'ok', reason: '', label: { en: 'Working', ar: 'يعمل' }, fix: null, teamAction: false, checkedAt: ago(30), since: null } };
  const pageIg = { id: 'spg_ig', platform: 'ig', name: 'sara.shop', metaPageId: '99887766', healthy: false, health: { state: 'attention', reason: 'instagram_private', label: { en: 'This Instagram account is private, so comments do not reach Albayan', ar: 'حساب إنستغرام هذا خاص، لذلك لا تصل التعليقات إلى البيان' }, fix: { en: 'Make the account public in Instagram settings, then tell the team', ar: 'اجعل حسابك عاماً من إعدادات إنستغرام ثم أبلغ الفريق' }, teamAction: false, checkedAt: ago(10), since: ago(60) } };
  const pageTeam = { id: 'spg_hook', platform: 'fb', name: 'Hooked page', metaPageId: '5555', healthy: false, health: { state: 'attention', reason: 'webhook_not_subscribed', label: { en: 'Comment notifications are not switched on for this page yet', ar: 'إشعارات التعليقات غير مفعّلة لهذه الصفحة بعد' }, fix: { en: 'The Albayan team switches them on; nothing to do on your side', ar: 'فريق البيان يفعّلها؛ لا شيء مطلوب منك' }, teamAction: true, checkedAt: ago(5), since: ago(5) } };
  const meBase = { ui: 'v2', staffDesk: 'classic', isStaff: false, isAdmin: false, services: { help: true, stopRequest: true, tiktok: false },
    capabilities: { fbPublicReply: 'gated', fbPrivateReply: 'unavailable', igPublicReply: 'unavailable', igPrivateReply: 'unavailable', tiktokService: 'off' },
    serviceHours: { timezone: 'Africa/Tripoli', openNow: true, week: { sun: { open: '09:00', close: '17:00' }, mon: { open: '09:00', close: '17:00' }, tue: { open: '09:00', close: '17:00' }, wed: { open: '09:00', close: '17:00' }, thu: { open: '09:00', close: '17:00' }, fri: null, sat: null }, holidays: [{ date: '2099-03-01', labelEn: 'Spring day', labelAr: 'يوم الربيع' }], ramadan: null, onDutyUntil: null },
    contact: { whatsapp: '+218912345678', phone: '', email: '' }, metaConnection: { down: false } };
  const rules = () => ({
    rules: [
      { id: 'srule_1', name: 'Price <b>questions</b>', platform: 'fb', enabled: true, trigger: 'keywords', keywords: ['price', 'بكم'], publicReply: 'DM sent!', dmEnabled: true, dmText: 'Hi', likeComment: true, oncePerPerson: true, skipPublicAfterDm: false, pauseDms: false, quietHours: false, scope: 'all', postIds: [], pageRefs: ['spg_fb', 'spg_gone'], pages: [{ id: 'spg_fb', removed: false, name: 'Sara <Shop>', platform: 'fb' }, { id: 'spg_gone', removed: true, name: '', platform: '' }], pageRemoved: true, pageRemovedLabel: { en: 'Page removed', ar: 'الصفحة أُزيلت' } },
      { id: 'srule_2', name: 'Instagram hello', platform: 'ig', enabled: false, trigger: 'every', keywords: [], publicReply: 'Welcome', dmEnabled: true, dmText: 'Hello there', likeComment: false, oncePerPerson: false, skipPublicAfterDm: false, pauseDms: false, quietHours: true, scope: 'all', postIds: [], pageRefs: [], pages: [], pageRemoved: false, pageRemovedLabel: null }
    ],
    channels: { states: { fbPublicReply: 'on', fbPrivateReply: 'gated', igPublicReply: 'poll', igPrivateReply: 'unavailable', tiktokService: 'off' }, labels }
  });
  const settings = { id: 'sss_u1', ownerId: 'u1', masterEnabled: true, quietHours: { from: '21:00', to: '07:30' }, timezone: 'Africa/Tripoli' };
  const allHtml = [];

  // Bundle, manifest and the shell registry.
  const lazy = bundleManifestJson.lazy['studio.js'];
  const pagesBundle = bundleManifestJson.lazy['studio-pages.js'];
  const studioSize = fs.statSync(path.join(ROOT, 'studio.js')).size;
  const pagesSize = fs.statSync(path.join(ROOT, 'studio-pages.js')).size;
  check('Studio v2 Pages & replies (15o) is its own lazy bundle studio-pages.js (never in studio.js or script.js), in both built copies under 1 MiB, and registers the replies and posts screens with the shell when it arrives',
    !loadError && JSON.stringify(pagesBundle) === JSON.stringify(['systems/ads_studio/15o-studio-pages.js']) && !lazy.some(file => /15o-studio/.test(file))
      && !bundleManifestJson.files.some(file => /15o-studio/.test(file))
      && [read('studio-pages.js'), read('www/studio-pages.js')].every(bundle => bundle === pagesSrc)
      && !read('studio.js').includes('function renderStudioPagesBody(') && !read('script.js').includes('renderStudioPagesBody')
      && studioSize < 1024 * 1024 && pagesSize < 1024 * 1024
      && run("_studioV2Screens.has('replies') && _studioV2Screens.has('posts')") === true
      && pagesSrc.includes("studioV2RegisterScreen('replies', renderStudioPagesBody)"),
    loadError || `studio.js ${studioSize} bytes, studio-pages.js ${pagesSize} bytes`);

  // Pages: health from the server, checked X ago, one fix with "I did it", the team's fix, no Check now for a customer.
  meReply(meBase);
  reply('/api/studio/activity', { items: [], unreadCount: 0, nextCursor: null, seenAt: null });
  reply(PAGES, { pages: [pageFb, pageIg, pageTeam, { id: 'bad id', platform: 'fb', name: 'dropped' }] });
  openAt('/studio?tab=replies');
  const pagesHtml = html();
  allHtml.push(pagesHtml);
  const fbCard = between(pagesHtml, 'studio-pg-page-spg_fb');
  const igCard = between(pagesHtml, 'studio-pg-page-spg_ig');
  const teamCard = between(pagesHtml, 'studio-pg-page-spg_hook');
  const pagesAr = inLanguage('ar', 'render(); __html');
  const pagesCases = [
    pagesHtml.includes('data-testid="studio-screen-replies"') && pagesHtml.includes('data-testid="studio-pg" data-section="pages"') && pagesHtml.includes('data-testid="studio-pg-section-pages" onclick="studioPgGo(\'pages\')" aria-current="page"') && !pagesHtml.includes('studio-pg-section-tiktok') && !pagesHtml.includes('Coming soon'),
    fbCard.includes('data-state="ok"') && fbCard.includes('Sara &lt;Shop&gt;') && fbCard.includes('data-testid="studio-pg-health"') && fbCard.includes('Working') && fbCard.includes('checked 30 minutes ago') && fbCard.includes('1234567890') && !fbCard.includes('studio-pg-fix'),
    igCard.includes('data-state="attention" data-reason="instagram_private"') && igCard.includes('comments do not reach Albayan') && igCard.includes('Make the account public in Instagram settings') && igCard.includes('data-testid="studio-pg-fix-spg_ig" onclick="studioHelpAskAbout(\'page\', \'spg_ig\')"') && igCard.includes('data-testid="studio-ask-page-spg_ig"'),
    teamCard.includes('Our team is on it') && teamCard.includes('nothing to do on your side') && !teamCard.includes('studio-pg-fix-spg_hook'),
    !pagesHtml.includes('dropped') && !pagesHtml.includes('studio-pg-check-') && !pagesHtml.includes('studio-pg-connection'),
    pagesHtml.includes('data-testid="studio-pg-link-request" onclick="studioPgGo(\'pages\', \'link\')"') && pagesHtml.includes('data-testid="studio-guide-link-share-page"') && pagesHtml.includes('data-testid="studio-guide-link-instagram"'),
    String(pagesAr).includes('dir="rtl"') && String(pagesAr).includes('الصفحات المربوطة') && String(pagesAr).includes('حساب إنستغرام هذا خاص') && String(pagesAr).includes('اطلب منا ربط صفحة') && arabicOnly(String(pagesAr).match(/studio-pg-checked">([^<]*)</)[1]),
    calls('GET', PAGES).length === 1
  ];
  check('Studio v2 Pages (P4-06): the server\'s health per page (state, reason, label, fix step, checked X ago), one fix with "I did it, tell the team", the team\'s fixes without it, no Check now for a customer, the link request and the guides; Arabic RTL',
    !loadError && pagesCases.every(Boolean), loadError || `cases ${failed(pagesCases)}`);

  // Meta connection down: the neutral banner, per-page reasons give way (the server sends state 'connection').
  meReply({ ...meBase, metaConnection: { down: true, labels: { en: 'We are fixing the Albayan-Meta connection', ar: 'نعمل على إصلاح اتصال البيان بميتا' } } });
  run('_studioPg.slots.pages.loadedAt = 0;');
  reply(PAGES, { pages: [{ ...pageIg, health: { state: 'connection', reason: '', label: { en: 'Facebook and Instagram updates are delayed right now', ar: 'تحديثات فيسبوك وإنستغرام متأخرة حالياً' }, fix: null, teamAction: true, checkedAt: ago(10), since: null } }] });
  run('render();');
  const downHtml = html();
  allHtml.push(downHtml);
  // Admin: Check now runs the server check once per page at a time and shows the answer's health.
  meReply({ ...meBase, isAdmin: true, isStaff: true });
  run('_studioPg.slots.pages.loadedAt = 0;');
  reply(PAGES, { pages: [pageFb, pageIg] });
  run('render();');
  const adminHtml = html();
  allHtml.push(adminHtml);
  reply(`${PAGES}/spg_ig/check`, { pageId: 'spg_ig', checked: true, webhook: '', reason: '', errorCode: '', health: { state: 'ok', reason: '', label: { en: 'Working', ar: 'يعمل' }, fix: null, teamAction: false, checkedAt: ago(0), since: null } });
  run("studioPgCheck('spg_ig'); studioPgCheck('spg_ig');");
  const checkedHtml = html();
  const notes = json('__notes') || [];
  const connectionCases = [
    downHtml.includes('data-testid="studio-pg-connection"') && downHtml.includes('We are fixing the Albayan-Meta connection') && between(downHtml, 'studio-pg-page-spg_ig').includes('data-state="connection"') && !downHtml.includes('studio-pg-fix'),
    adminHtml.includes('data-testid="studio-pg-check-spg_ig" onclick="studioPgCheck(\'spg_ig\', this)"') && adminHtml.includes('data-testid="studio-pg-check-spg_fb"'),
    calls('POST', `${PAGES}/spg_ig/check`).length === 1 && between(checkedHtml, 'studio-pg-page-spg_ig').includes('data-state="ok"') && between(checkedHtml, 'studio-pg-page-spg_ig').includes('checked just now'),
    notes.some(note => note.type === 'success' && note.title === 'Page checked')
  ];
  check('Studio v2 Pages: the neutral Meta-connection banner replaces the per-page reasons; an admin\'s Check now is single flight and shows the server\'s new health',
    !loadError && connectionCases.every(Boolean), loadError || `cases ${failed(connectionCases)}`);

  // Ask us to link a page (P4-07): the form, the Instagram pre-check, the guide, one ticket with every answer.
  meReply(meBase);
  openAt('/studio?tab=replies&section=pages&id=link');
  const linkForm = html();
  allHtml.push(linkForm);
  run('studioPgLinkSend();');
  const linkProblems = html();
  const linkNoCall = calls('POST', '/api/studio/tickets').length === 0;
  run("studioPgLinkPick('platform', 'ig'); studioPgLinkSet('name', 'Sara Shop'); studioPgLinkSet('link', 'https://instagram.com/sara.shop'); studioPgLinkPick('professional', 'yes'); studioPgLinkPick('linked', 'unsure'); studioPgLinkPick('isPublic', 'no'); studioPgLinkShared(true); studioPgLinkSet('note', 'Opens <soon>');");
  run('render();');
  const linkFilled = html();
  allHtml.push(linkFilled);
  replyError('/api/studio/tickets', { status: 503, message: 'Service Unavailable' });
  run('studioPgLinkSend();');
  const linkFailed = html();
  reply('/api/studio/tickets', { ticket: { id: 'tkt_' + 'a'.repeat(40), number: 'T-000042', subject: 'Link my page: Sara Shop', category: 'page', status: 'open', dueAt: '2099-01-05T08:00:00Z' }, message: { id: 'tkm_x', text: 'x' } });
  run('studioPgLinkSend();');
  const linkDone = html();
  allHtml.push(linkDone);
  const ticketCalls = calls('POST', '/api/studio/tickets');
  const linkAr = inLanguage('ar', "_studioPg.link = null; studioPgLinkPick('platform', 'ig'); render(); __html");
  const linkCases = [
    linkForm.includes('data-testid="studio-pg-link-form"') && linkForm.includes('id="studio-pg-link-name"') && linkForm.includes('id="studio-pg-link-url"') && linkForm.includes('data-testid="studio-guide-inline-share-page"') && linkForm.includes('Assign partners') && !linkForm.includes('studio-pg-link-professional-yes') && !linkForm.includes('studio-pg-sections'),
    linkProblems.includes('data-testid="studio-pg-link-problem-platform"') && linkProblems.includes('data-testid="studio-pg-link-problem-page"') && linkNoCall,
    linkFilled.includes('data-testid="studio-pg-link-platform-ig" aria-pressed="true"') && linkFilled.includes('data-testid="studio-pg-link-professional-yes" aria-pressed="true"') && linkFilled.includes('data-testid="studio-pg-link-isPublic-no" aria-pressed="true"') && linkFilled.includes('Comments reach Albayan only from a public account') && linkFilled.includes('data-testid="studio-guide-link-instagram"') && linkFilled.includes('value="Sara Shop"') && linkFilled.includes('Opens &lt;soon&gt;'),
    linkFailed.includes('data-testid="studio-pg-link-error"') && linkFailed.includes('Refresh to see the latest state') && !linkFailed.includes('studio-pg-link-done'),
    ticketCalls.length === 2 && ticketCalls[0].body.operationId === ticketCalls[1].body.operationId && ticketCalls[1].body.category === 'page' && ticketCalls[1].body.subject === 'Link my page: Sara Shop' && !('relatedType' in ticketCalls[1].body),
    ticketCalls.length === 2 && ['Platform / المنصة: Instagram', 'Page name / اسم الصفحة: Sara Shop', 'Page link / رابط الصفحة: https://instagram.com/sara.shop', 'Professional account (business or creator) / حساب احترافي (أعمال أو صانع محتوى): Yes / نعم', 'Linked to a Facebook page / مربوط بصفحة فيسبوك: Not sure / لست متأكداً', 'Public account / حساب عام: No / لا', 'Albayan added as a partner in Meta Business Suite / أُضيف البيان كشريك في Meta Business Suite: Yes / نعم', 'Note / ملاحظة: Opens <soon>'].every(line => ticketCalls[1].body.message.includes(line)) && ticketCalls[1].body.message.length <= 2000,
    linkDone.includes('data-testid="studio-pg-link-done"') && linkDone.includes('data-testid="studio-pg-link-number">T-000042<') && linkDone.includes('We reply by') && linkDone.includes(`data-testid="studio-pg-link-open" onclick="studioHelpOpen('tkt_${'a'.repeat(40)}')"`),
    String(linkAr).includes('هل الحساب عام (غير خاص)؟') && String(linkAr).includes('اطلب منا ربط صفحة') && String(linkAr).includes('Assign partners') && String(linkAr).includes('أضفت البيان شريكاً')
  ];
  check('Studio v2 page-link request (P4-07): platform and page, the three Instagram answers as Yes / No / Not sure chips, the sharing guide with Meta\'s menu names, a lost answer replays the same operationId, one \'page\' ticket whose message carries every answer in both languages, the ticket number and a way to it',
    !loadError && linkCases.every(Boolean), loadError || `cases ${failed(linkCases)}`);
  meReply({ ...meBase, services: { help: false, stopRequest: false, tiktok: false } });
  run('_studioPg.link = null; render();');
  const linkOff = html();
  check('Studio v2 page-link request: while the Help service is off the form gives way to the contact card, and nothing is sent',
    !loadError && linkOff.includes('data-testid="studio-pg-link-off"') && !linkOff.includes('studio-pg-link-form') && linkOff.includes('data-testid="studio-help-contact"') && calls('POST', '/api/studio/tickets').length === 2);

  // Rules: master switch, honest channel labels, pageRefs with the removed page, on/off, the editor.
  meReply(meBase);
  reply(RULES, rules());
  reply(SETTINGS, settings);
  reply(PAGES, { pages: [pageFb, pageIg] });
  openAt('/studio?tab=replies&section=rules');
  const rulesHtml = html();
  allHtml.push(rulesHtml);
  const rule1 = between(rulesHtml, 'studio-pg-rule-srule_1');
  const rule2 = between(rulesHtml, 'studio-pg-rule-srule_2');
  reply(`${RULES}/srule_1`, { ...rules().rules[0], enabled: false });
  run("studioPgRuleToggle('srule_1'); studioPgRuleToggle('srule_1');");
  const toggled = html();
  reply(SETTINGS, { ...settings, masterEnabled: false });
  run('studioPgMaster();');
  const paused = html();
  const rulesCases = [
    rulesHtml.includes('data-testid="studio-pg-master" onclick="studioPgMaster()"') && rulesHtml.includes('data-testid="studio-pg-master" onclick="studioPgMaster()"') && /data-testid="studio-pg-master"[^>]*aria-checked="true"/.test(rulesHtml.replace(/aria-checked="true" aria-label="[^"]*" data-testid="studio-pg-master"/, 'data-testid="studio-pg-master" aria-checked="true"')) && rulesHtml.includes('Auto-reply is on') && rulesHtml.includes('data-testid="studio-pg-rule-new" onclick="studioPgGo(\'rules\', \'new\')"'),
    rule1.includes('Price &lt;b&gt;questions&lt;/b&gt;') && rule1.includes('Keywords: price, بكم') && rule1.includes('data-testid="studio-pg-rule-page-removed-srule_1"') && rule1.includes('Page removed') && rule1.includes('Sara &lt;Shop&gt;') && rule1.includes('data-action="public" data-state="on"') && rule1.includes('data-action="dm" data-state="gated"') && rule1.includes('Private message — Waiting for Meta approval') && rule1.includes('data-action="like" data-state="on"'),
    rule2.includes('data-enabled="0"') && rule2.includes('Every comment') && rule2.includes('All linked pages') && rule2.includes('data-action="public" data-state="poll"') && rule2.includes('data-action="dm" data-state="unavailable"') && rule2.includes('Not available now'),
    rulesHtml.includes('data-testid="studio-pg-channels"') && rulesHtml.includes('data-testid="studio-pg-channel-igPublicReply" data-state="poll"') && rulesHtml.includes('checked every 5 minutes') && rulesHtml.includes('data-testid="studio-pg-channel-fbPrivateReply" data-state="gated"'),
    calls('PATCH', `${RULES}/srule_1`).length === 1 && calls('PATCH', `${RULES}/srule_1`)[0].body.enabled === false && between(toggled, 'studio-pg-rule-srule_1').includes('data-enabled="0"'),
    calls('PUT', SETTINGS).length === 1 && calls('PUT', SETTINGS)[0].body.masterEnabled === false && paused.includes('Auto-reply is paused')
  ];
  check('Studio v2 reply rules (P4-06, P4-05): the master switch, every rule with its pages (the server\'s "Page removed" label), its actions with the honest channel state, on/off per rule as one PATCH, the channels card',
    !loadError && rulesCases.every(Boolean), loadError || `cases ${failed(rulesCases)}`);

  // The editor: a gated / unavailable channel cannot be picked and says why; validation; the saved body; a refusal in Arabic.
  openAt('/studio?tab=replies&section=rules&id=new');
  const editorNew = html();
  allHtml.push(editorNew);
  run("studioPgRulePick('platform', 'ig'); render();");
  const editorIg = html();
  allHtml.push(editorIg);
  run("studioPgRuleFlip('dmEnabled'); studioPgRuleSave();");
  const editorProblems = html();
  const editorNoCall = calls('POST', RULES).length === 0;
  run("studioPgRulePick('platform', 'fb'); studioPgRuleSet('name', 'Prices'); studioPgRuleSet('keywordInput', 'Price, بكم'); studioPgKeywordAdd(); studioPgRuleSet('publicReply', 'See the price list'); studioPgRulePage('spg_fb'); studioPgRulePage('spg_ig'); render();");
  const editorFilled = html();
  allHtml.push(editorFilled);
  replyError(RULES, { status: 400, payload: { detail: 'Public replies are not available for Facebook pages right now' } });
  inLanguage('ar', 'studioPgRuleSave();');
  const editorRefused = inLanguage('ar', 'render(); __html');
  const savedRule = { ...rules().rules[0], id: 'srule_3', name: 'Prices', keywords: ['price', 'بكم'], pageRefs: ['spg_fb'], pages: [{ id: 'spg_fb', removed: false, name: 'Sara <Shop>', platform: 'fb' }], pageRemoved: false, pageRemovedLabel: null, dmEnabled: false, dmText: '' };
  reply(RULES, savedRule);
  reply(RULES, { ...rules(), rules: rules().rules.concat([savedRule]) });
  run('studioPgRuleSave();');
  const afterSave = html();
  const saveCalls = calls('POST', RULES);
  reply(`${RULES}/srule_1`, rules().rules[0]);
  openAt('/studio?tab=replies&section=rules&id=srule_1');
  const editorExisting = html();
  allHtml.push(editorExisting);
  const editorCases = [
    editorNew.includes('data-testid="studio-pg-rule-form" data-rule="new"') && editorNew.includes('id="studio-rule-name"') && editorNew.includes('data-testid="studio-pg-rule-page-spg_fb"') && !editorNew.includes('studio-pg-rule-page-spg_ig') && editorNew.includes('data-testid="studio-pg-rule-channel-public" data-state="on"') && editorNew.includes('data-testid="studio-pg-rule-channel-dm" data-state="gated"') && editorNew.includes('sent once Meta approves private messages') && editorNew.includes('data-testid="studio-pg-rule-like"') && editorNew.includes('(21:00–07:30, Libya time)'),
    editorIg.includes('data-testid="studio-pg-rule-platform-ig" aria-pressed="true"') && editorIg.includes('data-testid="studio-pg-rule-channel-dm" data-state="unavailable"') && /data-testid="studio-pg-rule-dm" onclick="studioPgRuleFlip\('dmEnabled'\)" disabled/.test(editorIg) && editorIg.includes('data-testid="studio-pg-rule-dm-why"') && editorIg.includes('cannot be picked on this platform right now') && editorIg.includes('data-testid="studio-pg-rule-like-why"') && !editorIg.includes('studio-pg-rule-page-spg_fb'),
    editorProblems.includes('data-testid="studio-pg-rule-problem-name"') && editorProblems.includes('data-testid="studio-pg-rule-problem-keywords"') && editorProblems.includes('data-testid="studio-pg-rule-problem-reply"') && !editorProblems.includes('id="studio-rule-dm"') && editorNoCall,
    editorFilled.includes('value="Prices"') && editorFilled.includes('data-testid="studio-pg-rule-keyword-remove-1"') && editorFilled.includes('>بكم<') && editorFilled.includes('data-testid="studio-pg-rule-page-spg_fb" aria-pressed="true"') && editorFilled.includes('The rule answers on the chosen pages only'),
    String(editorRefused).includes('data-testid="studio-pg-rule-error"') && String(editorRefused).includes('الردود العامة غير متاحة لصفحات فيسبوك حالياً') && !String(editorRefused).includes('right now'),
    saveCalls.length === 2 && JSON.stringify(saveCalls[1].body) === JSON.stringify({ name: 'Prices', platform: 'fb', trigger: 'keywords', keywords: ['price', 'بكم'], pageRefs: ['spg_fb'], publicReply: 'See the price list', dmEnabled: false, dmText: '', likeComment: false, oncePerPerson: true, skipPublicAfterDm: false, quietHours: false }),
    afterSave.includes('data-testid="studio-pg" data-section="rules" data-id=""') && afterSave.includes('data-testid="studio-pg-rule-srule_3"') && calls('GET', RULES).length === 2 && (json('__notes') || []).some(note => note.title === 'Rule saved'),
    editorExisting.includes('data-rule="srule_1"') && editorExisting.includes('value="Price &lt;b&gt;questions&lt;/b&gt;"') && editorExisting.includes('data-testid="studio-pg-rule-delete" onclick="studioPgRuleDelete(this)"') && editorExisting.includes('id="studio-rule-dm"') && editorExisting.includes('data-testid="studio-pg-rule-back" onclick="studioPgGo(\'rules\')"') && run("studioPgRuleDelete()") === false
  ];
  check('Studio v2 rule editor: where (the platform\'s pages), when (keywords), the actions with their channel state (a channel that is off or unavailable cannot be picked and says why; a gated one is saved as waiting), inline validation before any call, the exact saved body (never `enabled`: the list switch owns it), a server refusal in Arabic, edit and delete of an existing rule',
    !loadError && editorCases.every(Boolean), loadError || `cases ${failed(editorCases)}`);

  // A rule whose page was removed (srule_1 keeps spg_gone): a text edit sends no pageRefs (the server keeps its stored
  // list), the editor says so; choosing the pages again sends only live pages of the platform (the removed ref is gone).
  const patchesOf = () => calls('PATCH', `${RULES}/srule_1`);
  const patchesBefore = patchesOf().length;
  run(`__replies[${JSON.stringify(`${RULES}/srule_1`)}] = [];`);  // an answer queued above for a PATCH that never came
  reply(`${RULES}/srule_1`, { ...rules().rules[0], name: 'Prices renamed' });
  reply(RULES, rules());
  run("studioPgRuleSet('name', 'Prices renamed'); render();");
  const removedEditor = html();
  run('studioPgRuleSave();');
  const renamePatch = patchesOf()[patchesBefore];
  reply(`${RULES}/srule_1`, { ...rules().rules[0], pageRefs: [], pages: [], pageRemoved: false, pageRemovedLabel: null });
  reply(RULES, rules());
  openAt('/studio?tab=replies&section=rules&id=srule_1');
  run("studioPgRulePage('spg_fb'); studioPgRuleSave();");  // the only live page unticked: every page, and spg_gone dropped
  const pagesPatch = patchesOf()[patchesBefore + 1];
  const removedCases = [
    removedEditor.includes('data-testid="studio-pg-rule-page-removed"') && removedEditor.includes('choose the pages again') && !removedEditor.includes('spg_gone'),
    !!renamePatch && renamePatch.body.name === 'Prices renamed' && !('pageRefs' in renamePatch.body) && !('enabled' in renamePatch.body),
    !!pagesPatch && JSON.stringify(pagesPatch.body.pageRefs) === '[]' && !JSON.stringify(pagesPatch.body).includes('spg_gone') && !('enabled' in pagesPatch.body),
    (json('__notes') || []).filter(note => note.title === 'Rule saved').length >= 3
  ];
  check('Studio v2 rule editor with a removed page (P4-01): the removed ref is never in the sent body (a text edit omits pageRefs, the server keeps its stored list; a touched list names live pages only), the editor explains it, and the rule stays saveable',
    !loadError && removedCases.every(Boolean), loadError || `cases ${failed(removedCases)} rename ${JSON.stringify(renamePatch && renamePatch.body)} pages ${JSON.stringify(pagesPatch && pagesPatch.body)}`);

  // fbPublicReply off (the like follows it, P4-05): a new Facebook rule starts with no like and saves with a private
  // message alone; an old rule with a like or a public reply can still be cleared and saved (the switch turns OFF, the
  // text can be emptied), and the like is sent as false while refused.
  const offStates = { fbPublicReply: 'off', fbPrivateReply: 'on', igPublicReply: 'poll', igPrivateReply: 'unavailable' };
  reply(RULES, { ...rules(), channels: { states: offStates, labels } });
  run(`_studioPg.slots.rules.loadedAt = 0; _studioPg.editor = null; __replies[${JSON.stringify(`${RULES}/srule_1`)}] = [];`);
  openAt('/studio?tab=replies&section=rules');  // the list (and the channel states) first, as the owner reaches New rule
  openAt('/studio?tab=replies&section=rules&id=new');
  const offNew = html();
  const offDraft = json('_studioPg.editor') || {};
  run("studioPgRuleFlip('likeComment'); studioPgRuleSet('name', 'DM only'); studioPgRulePick('trigger', 'every'); studioPgRuleFlip('dmEnabled'); studioPgRuleSet('dmText', 'Hello from the shop');");
  const offLikeStays = json('_studioPg.editor.likeComment');
  const dmRule = { ...rules().rules[0], id: 'srule_4', name: 'DM only', trigger: 'every', keywords: [], publicReply: '', dmEnabled: true, dmText: 'Hello from the shop', likeComment: false, pageRefs: [], pages: [], pageRemoved: false, pageRemovedLabel: null };
  reply(RULES, dmRule);
  reply(RULES, { ...rules(), rules: rules().rules.concat([dmRule]), channels: { states: offStates, labels } });
  run('studioPgRuleSave();');
  const offPost = calls('POST', RULES)[2];
  openAt('/studio?tab=replies&section=rules&id=srule_1');  // likeComment true and a public reply, saved before the channel closed
  const offExisting = html();
  const offNoPatch = patchesOf().length;
  run('studioPgRuleSave();');
  const offRefused = html();
  const offRefusedPatches = patchesOf().length;
  reply(`${RULES}/srule_1`, { ...rules().rules[0], publicReply: '', likeComment: false });
  reply(RULES, { ...rules(), channels: { states: offStates, labels } });
  run("studioPgRuleSet('publicReply', ''); studioPgRuleFlip('likeComment'); studioPgRuleSave();");
  const offPatch = patchesOf()[offNoPatch];
  const offCases = [
    offNew.includes('data-testid="studio-pg-rule-channel-public" data-state="off"') && /aria-checked="false" aria-label="Like the comment" data-testid="studio-pg-rule-like" onclick="studioPgRuleFlip\('likeComment'\)" disabled/.test(offNew) && offDraft.likeComment === false,
    offLikeStays === false,
    !!offPost && offPost.body.likeComment === false && offPost.body.publicReply === '' && offPost.body.dmEnabled === true && offPost.body.dmText === 'Hello from the shop' && !('enabled' in offPost.body),
    /aria-checked="true" aria-label="Like the comment" data-testid="studio-pg-rule-like" onclick="studioPgRuleFlip\('likeComment'\)"><\/button>/.test(offExisting.replace(/<span class="studio-pg-switch-knob"[^>]*><\/span>/g, ''))
      && /id="studio-rule-public"[^>]*oninput="studioPgRuleSet\('publicReply', this\.value\)"[^>]*>DM sent!<\/textarea>/.test(offExisting) && !/id="studio-rule-public"[^>]*disabled/.test(offExisting) && offExisting.includes('clear this text to save the rule'),
    offRefused.includes('data-testid="studio-pg-rule-problem-reply"') && offRefusedPatches === offNoPatch,
    !!offPatch && offPatch.body.likeComment === false && offPatch.body.publicReply === '' && !('pageRefs' in offPatch.body)
  ];
  check('Studio v2 rule editor while fbPublicReply is off: a new Facebook rule starts without the like (the switch cannot turn it on) and saves with a private message alone; an old rule keeps its like switch and public text operable to clear them (a public reply still set is refused inline, no call), and the like is sent as false',
    !loadError && offCases.every(Boolean), loadError || `cases ${failed(offCases)} post ${JSON.stringify(offPost && offPost.body)} patch ${JSON.stringify(offPatch && offPatch.body)} draft ${JSON.stringify(offDraft.likeComment)} refused ${offRefused.includes('studio-pg-rule-problem-reply')} patches ${offRefusedPatches}/${offNoPatch} like ${(offNew.match(/data-testid="studio-pg-rule-like"[^>]*>/) || [''])[0]} channel ${(offNew.match(/studio-pg-rule-channel-public" data-state="[a-z]+"/) || [''])[0]}`);

  // A stale draft never switches a rule back on: Back drops the draft, the list toggle owns `enabled`, the editor opened
  // again follows the rule the list knows (and a fresh list read) until the owner types; the saved body has no `enabled`.
  reply(RULES, rules());
  run(`_studioPg.slots.rules.loadedAt = 0; _studioPg.editor = null; __replies[${JSON.stringify(`${RULES}/srule_1`)}] = [];`);
  openAt('/studio?tab=replies&section=rules&id=srule_1');
  const staleOpened = !!json('_studioPg.editor && _studioPg.editor.for === "srule_1" && _studioPg.editor.enabled === true');
  run("studioPgGo('rules');");
  const staleDropped = json('_studioPg.editor') === null;
  reply(`${RULES}/srule_1`, { ...rules().rules[0], enabled: false });
  run("studioPgRuleToggle('srule_1');");
  openAt('/studio?tab=replies&section=rules&id=srule_1');
  const staleReopened = json('_studioPg.editor') || {};
  run("_studioPg.slots.rules.value.rules[0].name = 'Renamed elsewhere'; render();");  // a fresh list read landed: the untouched draft follows it
  const followed = json('_studioPg.editor.name');
  run("studioPgRuleSet('publicReply', 'Fixed typo'); _studioPg.slots.rules.value.rules[0].name = 'Renamed again'; render();");  // typed: the draft is the owner's now
  const keptTyping = json('[_studioPg.editor.name, _studioPg.editor.publicReply, _studioPg.editor.dirty]');
  reply(`${RULES}/srule_1`, { ...rules().rules[0], enabled: false, publicReply: 'Fixed typo' });
  reply(RULES, rules());
  const staleBefore = patchesOf().length;
  run('studioPgRuleSave();');
  const stalePatch = patchesOf()[staleBefore];
  const staleCases = [
    staleOpened && staleDropped,
    staleReopened.for === 'srule_1' && staleReopened.enabled === false && staleReopened.dirty === false,
    followed === 'Renamed elsewhere' && JSON.stringify(keptTyping) === JSON.stringify(['Renamed elsewhere', 'Fixed typo', true]),
    !!stalePatch && stalePatch.body.publicReply === 'Fixed typo' && !('enabled' in stalePatch.body),
    pagesSrc.includes('if (kept && !kept.sending && !(view.section === \'rules\' && view.id === kept.for)) _studioPg.editor = null;') && !pagesSrc.includes('enabled: draft.enabled')
  ];
  check('Studio v2 rule editor never re-enables a rule from a stale draft: leaving the editor drops the draft, the reopened draft follows the list (and a fresh read) until the owner types, and the saved body carries no `enabled`',
    !loadError && staleCases.every(Boolean), loadError || `cases ${failed(staleCases)} reopened ${JSON.stringify(staleReopened.enabled)} followed ${followed} typing ${JSON.stringify(keptTyping)} patch ${JSON.stringify(stalePatch && stalePatch.body)}`);
  reply(RULES, rules());
  run('_studioPg.slots.rules.loadedAt = 0; _studioPg.editor = null;');

  // Reply log: the server's outcome labels and counters, a problem in plain words, the filter and older rows.
  const logRow = (id, outcome, extra = {}) => ({ id, at: ago(90), commentAt: ago(91), platform: 'fb', pageId: 'spg_fb', pageName: 'Sara <Shop>', ruleId: 'srule_1', ruleName: 'Price questions', commentId: 'c1', postId: 'p1', actions: outcome === 'sent' ? ['public', 'like'] : [], skipped: [], outcome, problemCode: '', error: '', source: 'webhook', receivedAt: ago(91), sentAt: ago(90), latencySeconds: 42, attempts: 1, retryAfter: null, parkedReason: null, ...extra });
  const logLabels = { outcome: { sent: { en: 'Sent (server)', ar: 'أُرسل (الخادم)' }, failed: { en: 'Failed (server)', ar: 'فشل (الخادم)' }, skipped: { en: 'Not sent: channel not available', ar: 'لم يُرسل: القناة غير متاحة' }, missed: { en: 'Missed during the outage', ar: 'فات أثناء الانقطاع' } }, channelState: labels, problem: {}, pageRemoved: { en: 'Page removed', ar: 'الصفحة أُزيلت' } };
  const logPage = { rows: [logRow('log_1', 'sent'), logRow('log_2', 'skipped', { skipped: [{ action: 'dm', channel: 'fbPrivateReply', state: 'gated' }], latencySeconds: null, sentAt: null }), logRow('log_3', 'missed', { problemCode: 'missed_during_outage', latencySeconds: null }), logRow('log_4', 'failed', { error: 'Meta said no', pageName: '', platform: 'ig', latencySeconds: null })],
    nextBefore: '1700000000000:log_4', counters: { total: 12, byAction: { dm: 3, public: 9, like: 6 }, byOutcome: { sent: 8, partial: 1, failed: 2, waiting: 0, parked: 0, missed: 1, skipped: 0, sending: 0, none: 0 }, latency: {} }, windowDays: 30, windowTruncated: false, labels: logLabels };
  reply(LOG, logPage);
  openAt('/studio?tab=replies&section=log');
  const logHtml = html();
  allHtml.push(logHtml);
  reply(`${LOG}&before=1700000000000%3Alog_4`, { ...logPage, rows: [logRow('log_5', 'sent')], nextBefore: null });
  run('studioPgLogMore();');
  const logMore = html();
  reply(`${LOG}&status=failed`, { ...logPage, rows: [logRow('log_4', 'failed', { error: 'x' })], nextBefore: null });
  run("studioPgLogFilter('failed');");
  const logFailed = html();
  const logCases = [
    logHtml.includes('data-testid="studio-pg-log-counters"') && logHtml.includes('>12<') && logHtml.includes('>9<') && logHtml.includes('>3<') && logHtml.includes('comments handled'),
    between(logHtml, 'studio-pg-log-log_1').includes('data-outcome="sent"') && between(logHtml, 'studio-pg-log-log_1').includes('Sent (server)') && between(logHtml, 'studio-pg-log-log_1').includes('replied in 42 s') && between(logHtml, 'studio-pg-log-log_1').includes('Rule: Price questions') && between(logHtml, 'studio-pg-log-log_1').includes('Sara &lt;Shop&gt;'),
    between(logHtml, 'studio-pg-log-log_2').includes('Private message — Waiting for Meta approval') && between(logHtml, 'studio-pg-log-log_3').includes('Missed during the outage') && between(logHtml, 'studio-pg-log-log_3').includes('could not be sent in time') && between(logHtml, 'studio-pg-log-log_4').includes('Failed (server)') && between(logHtml, 'studio-pg-log-log_4').includes('Page removed') && between(logHtml, 'studio-pg-log-log_4').includes('Meta refused this reply') && !logHtml.includes('Meta said no'),
    logHtml.includes('data-testid="studio-pg-log-filter-all" aria-pressed="true"') && logHtml.includes('data-testid="studio-pg-log-filter-failed" aria-pressed="false"') && logHtml.includes('Failed (server)</button>') && logHtml.includes('data-testid="studio-pg-log-more"'),
    calls('GET', `${LOG}&before=1700000000000%3Alog_4`).length === 1 && logMore.includes('studio-pg-log-log_5') && logMore.includes('studio-pg-log-log_1') && !logMore.includes('studio-pg-log-more'),
    calls('GET', `${LOG}&status=failed`).length === 1 && logFailed.includes('data-testid="studio-pg-log-filter-failed" aria-pressed="true"') && logFailed.includes('studio-pg-log-log_4') && !logFailed.includes('studio-pg-log-log_1')
  ];
  check('Studio v2 reply log (P4-06 consumer of P4-02): the window counters, the server\'s outcome labels, a skipped action with its channel state, the problem in plain words (never the raw Meta error), the filter by outcome and older rows by cursor',
    !loadError && logCases.every(Boolean), loadError || `cases ${failed(logCases)}`);

  // Posts as they are, the posts tab, the classic handover and the plan-ended state.
  reply(POSTS, { posts: [{ id: 'sp_1', status: 'scheduled', caption: 'Ramadan <offer>', pageIds: ['spg_fb'], scheduledAt: '2099-03-01T10:00:00Z', mediaCount: 2 }, { id: 'sp_2', status: 'failed', caption: 'Old', pageIds: ['spg_ig'], updatedAt: ago(500), lastError: 'Meta refused <it>' }, { id: 'sp_3', status: 'published', caption: 'Done', pageIds: [], publishedAt: ago(100) },
    { id: 'sp_4', status: 'failed', caption: 'Late', pageIds: ['spg_fb'], updatedAt: ago(400), lastError: 'Meta did not answer in time; it may have published. Check the page before retrying.', errorClass: 'timeout' }] });
  openAt('/studio?tab=posts');
  const postsHtml = html();
  allHtml.push(postsHtml);
  run("studioPgPostsFilter('failed');");
  const postsFailed = html();
  const postsFailedAr = String(inLanguage('ar', 'render(); __html'));
  const failedRow = (page, id) => between(page, `studio-pg-post-${id}`);
  box.state.language = 'en';
  run("_adsStudioActiveTab = 'replies';");
  const classicV2 = run('renderSocialStudioRepliesTab()');
  const classicPostsV2 = run('renderSocialStudioPostsTab()');
  meReply({ ...meBase, ui: 'classic' });
  const classicPlain = run('renderSocialStudioRepliesTab()');
  meReply(meBase);
  box.hasSubscription = () => false;
  openAt('/studio?tab=replies');
  const ended = html();
  box.hasSubscription = id => id === 'ad_maker';
  const postsCases = [
    postsHtml.includes('data-testid="studio-screen-posts"') && postsHtml.includes('data-testid="studio-pg-posts-card"') && !postsHtml.includes('studio-pg-sections') && postsHtml.includes('data-testid="studio-pg-posts-all" onclick="studioV2Open(\'replies\')"'),
    between(postsHtml, 'studio-pg-post-sp_1').includes('data-status="scheduled"') && between(postsHtml, 'studio-pg-post-sp_1').includes('Ramadan &lt;offer&gt;') && between(postsHtml, 'studio-pg-post-sp_1').includes('2 photos') && between(postsHtml, 'studio-pg-post-sp_1').includes('Sara &lt;Shop&gt;') && !postsHtml.includes('studio-pg-post-sp_2'),
    postsHtml.includes('data-testid="studio-pg-posts-filter-failed"') && postsFailed.includes('data-testid="studio-pg-post-sp_2" data-status="failed"') && postsFailed.includes('Meta refused &lt;it&gt;'),
    // the failed reason: the server's errorClass in plain words (the neutral pair without one), Meta's raw text only in a details line, Arabic in Arabic
    failedRow(postsFailed, 'sp_4').includes('data-testid="studio-pg-post-error" data-class="timeout">Meta did not answer in time; the post may have gone out.') && failedRow(postsFailed, 'sp_4').includes('data-testid="studio-pg-post-error-details"') && failedRow(postsFailed, 'sp_4').includes('<summary>Details from Meta</summary>')
      && failedRow(postsFailed, 'sp_2').includes('data-class="">Meta refused this post; the team can see why.') && failedRow(postsFailed, 'sp_2').includes('<p class="studio-pg-note" dir="ltr">Meta refused &lt;it&gt;</p>')
      && arabicOnly((failedRow(postsFailedAr, 'sp_4').match(/data-testid="studio-pg-post-error"[^>]*>([^<]*)</) || [])[1] || '') && arabicOnly((failedRow(postsFailedAr, 'sp_2').match(/data-testid="studio-pg-post-error"[^>]*>([^<]*)</) || [])[1] || '')
      && Object.values(json('STUDIO_PG_POST_ERRORS') || {}).length >= 7 && Object.values(json('STUDIO_PG_POST_ERRORS') || {}).every(pair => /[؀-ۿ]/.test(pair[1]) && !/[A-Za-z]{4}/.test(pair[1].replace(/Meta/g, ''))),
    String(classicV2).includes('data-testid="studio-pg-classic"') && String(classicV2).includes('data-testid="studio-pg" data-section="pages"') && String(classicPostsV2).includes('data-testid="studio-pg-posts-card"'),
    !String(classicPlain).includes('studio-pg') && (socialSrc.match(/apiJson\(/g) || []).length === 1 && socialSrc.includes("typeof studioPagesClassicHandover === 'function' ? studioPagesClassicHandover('replies') : ''") && socialSrc.includes("studioPagesClassicHandover('posts')"),
    ended.includes('data-testid="studio-pg-plan-ended"') && ended.includes('data-testid="studio-pg-renew" onclick="studioV2Open(\'wallet\')"') && !ended.includes('studio-pg-pages')
  ];
  check('Studio v2 posts as they are (statuses, pages, photos, the failed reason), the posts tab, the classic Replies / Posts tabs hand over to 15o only while /me says v2 (15f keeps exactly one apiJson), the plan-ended state',
    !loadError && postsCases.every(Boolean), loadError || `cases ${failed(postsCases)}`);

  // Stage 15 hooks with the bundle here: the Help list draws the guides card right after the contact card (15n
  // renderStudioHelpExtras), the wallet's and the request detail's guide links come from the loader (15o0
  // studioGuideLinks -> 15o renderStudioGuideLinks) and open the sheet.
  meReply(meBase);
  openAt('/studio?tab=help');
  const helpWithGuides = html();
  run("state.adCampaignRequests = [{ id: 'req_g1', createdBy: 'u1', status: 'Draft', name: 'Guide me', _created: 1, _lastModified: 2 }];");
  const detailWithGuides = String(run("renderStudioAdsDetail({ tab: 'campaigns', section: '', id: 'req_g1', step: 0 })"));
  run('state.adCampaignRequests = [];');
  const walletGuides = String(run("studioGuideLinks(['money', 'settle'], 'studio-wallet-guides')"));
  const hookCases = [
    helpWithGuides.includes('data-testid="studio-help-contact"') && helpWithGuides.includes('data-testid="studio-guides"')
      && helpWithGuides.indexOf('data-testid="studio-guides"') > helpWithGuides.indexOf('data-testid="studio-help-contact"') && !helpWithGuides.includes('studio-pages-bundle-loading'),
    detailWithGuides.includes('data-testid="studio-ad-detail"') && detailWithGuides.includes('data-testid="studio-ad-guides"')
      && detailWithGuides.includes('data-testid="studio-guide-link-stages" onclick="studioGuideOpen(\'stages\', this)"') && detailWithGuides.includes('data-testid="studio-guide-link-settle"')
      && detailWithGuides.indexOf('data-testid="studio-ad-guides"') > detailWithGuides.indexOf('class="studio-ads-tracker') && detailWithGuides.indexOf('data-testid="studio-ad-guides"') < detailWithGuides.indexOf('class="studio-ads-next"'),
    walletGuides.includes('data-testid="studio-wallet-guides"') && walletGuides.includes('data-testid="studio-guide-link-money" onclick="studioGuideOpen(\'money\', this)"') && walletGuides.includes('data-testid="studio-guide-link-settle"'),
    helpSrc.includes('${renderStudioHelpContact()}${renderStudioHelpExtras()}') && helpSrc.includes("if (typeof renderStudioGuidesCard === 'function') guides = renderStudioGuidesCard();")
  ];
  check('Studio v2 guides reach the screens (stage 15 hooks): the Help list draws the guides card after the contact card, the request detail links the stages and settle guides under its tracker, the wallet links money and settle; every link opens the sheet',
    !loadError && hookCases.every(Boolean), loadError || `cases ${failed(hookCases)}`);

  // Help guides (P5-03): seven bilingual guides, the hours guide reads /me, the card and the sheet handlers.
  const guideKeys = json('studioGuideKeys()') || [];
  const STUDIO_GUIDE_STEPS_EN = key => (json(`STUDIO_GUIDES[${JSON.stringify(key)}].steps`) || []).map(pair => pair[0].slice(0, 24));
  const guideBodies = guideKeys.map(key => [key, String(run(`renderStudioGuideBody(${JSON.stringify(key)})`)), String(inLanguage('ar', `renderStudioGuideBody(${JSON.stringify(key)})`))]);
  const guidesCard = String(run('renderStudioGuidesCard()'));
  const hoursGuide = String(run("renderStudioGuideBody('hours')"));
  const guideCases = [
    JSON.stringify(guideKeys) === JSON.stringify(['money', 'stages', 'settle', 'share-page', 'instagram', 'tiktok', 'hours']),
    guideBodies.every(([, en, ar]) => en.includes('studio-guide-steps') && (en.match(/<li>/g) || []).length >= 2 && !/[؀-ۿ]/.test(en) && /[؀-ۿ]/.test(ar) && !/[A-Za-z]{4}/.test(ar.replace(/<[^>]+>|business\.facebook\.com|Meta Business Suite|Business settings|Business ID|Assign partners|Full control|Content|Messages and calls|Community activity|Assign|Add a Page|Add|Accounts|Pages|Settings and privacy|Account type and tools|Switch to professional account|Business|Creator|Linked accounts|Instagram|Connect account|Account privacy|Private account|Settings|Meta|LYD|Albayan|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Spring day/g, ''))),
    guideBodies.find(([key]) => key === 'money')[1].includes('Reserved') && guideBodies.find(([key]) => key === 'money')[1].includes('On its way back to you: shown only while a payment whose approval did not finish') && !guideBodies.find(([key]) => key === 'money')[1].includes('Being returned') && guideBodies.find(([key]) => key === 'money')[2].includes('في طريقه إليك') && !guideBodies.find(([key]) => key === 'money')[2].includes('قيد الإرجاع')
      && read('src/systems/ads_studio/15m-studio-wallet.js').includes("adsStudioText('On its way back to you', 'في طريقه إليك')") && guideBodies.find(([key]) => key === 'settle')[1].includes('48 hours') && guideBodies.find(([key]) => key === 'share-page')[1].includes('Assign partners') && guideBodies.find(([key]) => key === 'instagram')[1].includes('Switch to professional account') && guideBodies.find(([key]) => key === 'instagram')[1].includes('Private account') && guideBodies.find(([key]) => key === 'stages')[1].includes('own report, never from a button'),
    !/connected|linked|managed|automated/i.test(guideBodies.find(([key]) => key === 'tiktok')[1].replace(/not linked|is linked/g, '')) && guideBodies.find(([key]) => key === 'tiktok')[1].includes('help by hand'),
    hoursGuide.includes('data-testid="studio-guide-hours"') && hoursGuide.includes('Sunday') && hoursGuide.includes('09:00–17:00') && hoursGuide.includes('data-testid="studio-guide-open-now"') && hoursGuide.includes('Open now') && hoursGuide.includes('2099-03-01 (Spring day)'),
    guidesCard.includes('data-testid="studio-guides"') && guideKeys.every(key => guidesCard.includes(`data-testid="studio-guide-link-${key}" onclick="studioGuideOpen('${key}', this)"`)),
    run("studioGuideOpen('money')") === false && run("studioGuideOpen('nope')") === false && run("studioGuideTitle('settle')") === 'Why the final amount takes 2-3 days'
  ];
  check('Studio help guides (P5-03): seven guides in English and Arabic (money numbers, stages, why 2-3 days, sharing a page with the Meta menu names, Instagram professional + public, TikTok today in honest words, our working hours from /me), the card for Help and the sheet handlers',
    !loadError && guideCases.every(Boolean), loadError || `cases ${failed(guideCases)}`);

  // Texts, handlers, the classic map and the styles.
  const textPairs = [...pagesSrc.matchAll(/(?:adsStudioText|studioPgText)\((?:'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`),\s*((?:'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`))\)/g)].map(m => m[1]);
  const onclicks = allHtml.join('\n').match(/\son[a-z]+="[^"]*"/g) || [];
  const safeHandler = /^\son(?:click|input|change|submit|keydown)="(event\.preventDefault\(\); studioPg(LinkSend|RuleSave)\(\);|studioPg(Go|Retry|Refresh|LinkSend|LinkCancel|Master|KeywordAdd|RuleSave|DeleteConfirm|CloseSheet|LogMore)\((?:'[a-z]+'(?:, '(?:new|link|[A-Za-z0-9_.:-]+)')?)?\)|studioPg(Check|RuleDelete|RuleToggle|RulePage|LogFilter|PostsFilter|RuleFlip)\((?:'[A-Za-z0-9_.:-]*'(?:, this)?|this)?\)|studioPg(LinkSet|RuleSet)\('[A-Za-z]+', this\.value\)|studioPg(LinkPick|RulePick)\('[A-Za-z]+', '[a-z]+'\)|studioPgLinkShared\(this\.checked\)|studioPgKeywordRemove\(\d+\)|studioPgKeywordKey\(event\)|studioGuide(Open\('[a-z-]+', this\)|Close\(\))|studioHelp(AskAbout\('page', '[A-Za-z0-9_.:-]+'\)|Open\('tkt_[0-9a-f]{40}'\))|studioV2(Open|OpenSection)\('[a-z]+'\)|studioV2Go\(\{ tab: 'campaigns', id: '[A-Za-z0-9_.:-]+' \}\)|studioV2(Back|CloseBuilder)\(\)|studioV2ChooseClassic\(true\)|setAdsStudioTab\('[a-z]+'\)|toggleLanguage\(\)|toggleTheme\(\)|handleLogout\(\))"$/;
  const workspaceCss = read('assets/ads-workspace.css');
  const pagesCss = workspaceCss.slice(workspaceCss.indexOf('/* Albayan Studio v2 Pages & replies'));
  const refusalMap = json('_ADS_STUDIO_REFUSAL_AR') || [];
  const arabic = detail => String(inLanguage('ar', `adsStudioRefusalText(${JSON.stringify(detail)})`));
  const socialPy = read('server/systems/ads_studio/social_studio.py');
  const addedFrom = refusalMap.findIndex(entry => entry[0] === 'Rule name is required');
  const added = refusalMap.slice(addedFrom, refusalMap.findIndex(entry => entry[0] === 'Admin only') + 1);  // the reply-rule block (the P2-11 block moved here in stage 15 follows it)
  const staticCases = [
    textPairs.length >= 150 && textPairs.every(ar => /[؀-ۿ]/.test(ar)),
    onclicks.length > 60 && onclicks.every(attr => safeHandler.test(attr)),
    !/\b(confirm|alert|prompt)\(/.test(pagesSrc) && !/\bsetInterval\(/.test(pagesSrc),
    pagesCss.length > 4000 && read('www/assets/ads-workspace.css') === workspaceCss
      && ['html.dark :is(.studio-pg, .studio-pg-overlay)', 'min-height: 44px', 'overflow-wrap: anywhere', '.studio-pg-switch { position: relative;', '@media (max-width: 900px)', 'inset-inline-start'].every(rule => pagesCss.includes(rule))
      && !/background(-color)?:\s*#|[^-]color:\s*#/.test(pagesCss),
    addedFrom > 0 && refusalMap[addedFrom - 1][0] === 'note must be text' && added.length >= 20 && added.every(([en, ar, extra]) => /[؀-ۿ]/.test(ar) && !extra && refusalMap.filter(entry => entry[0] === en).length === 1),
    ['"Rule name"', 'is required"', 'Add at least one keyword for a keyword rule', 'A rule needs a public reply or a private message', 'is not linked to this account', "is not on this rule's platform", 'Admin only', 'You can only manage your own Social Studio'].every(needle => socialPy.includes(needle))
      && ['Private messages', 'Public replies', 'Likes'].every(action => socialPy.includes(`"${action.split(' ')[0] === 'Likes' ? 'like' : action === 'Private messages' ? 'dm' : 'public'}": "${action}"`)) && socialPy.includes('are not available for {_PLATFORM_WORDS[platform]} right now'),
    arabic('Private messages are not available for Instagram accounts right now') === 'الرسائل الخاصة غير متاحة لحسابات إنستغرام حالياً' && arabic('Page spg_x is not linked to this account') === 'هذه الصفحة لم تعد مربوطة بحسابك — حدّث الصفحة واختر صفحة أخرى' && arabic('Rule name is required') === 'اكتب اسماً للقاعدة'
  ];
  check('Studio v2 Pages & replies: every text pair has Arabic, only known handlers reach the page, no native dialog or timer loop, the styles use the tokens with dark tones and logical insets, the classic map gained (only appended) the reply-rule refusals whose English the server really sends',
    !loadError && staticCases.every(Boolean), loadError || `cases ${failed(staticCases)} pairs ${textPairs.length} handlers ${onclicks.filter(attr => !safeHandler.test(attr)).slice(0, 3).join(' | ')}`);
}

{
  // P5-02, P3-05 (client), P3-04b, P2-09, P2-11 (Studio v2 extras 15r): the real files run in a sandbox after
  // 15c/15g/15h/15j/15k/15n (the same fake browser, timers and scripted apiJson as the help-desk block above),
  // next to static checks of the TikTok wording, the startup hooks, the public contact route and the refusal
  // maps against the server files.
  const vm = require('vm');
  const extrasSrc = read('src/systems/ads_studio/15r-studio-extras.js');
  const coreSrc = read('src/systems/ads_studio/15g-studio-core.js');
  const shellSrc = read('src/systems/ads_studio/15h-studio-shell.js');
  const homeSrc = read('src/systems/ads_studio/15j-studio-home.js');
  const adsSrc = read('src/systems/ads_studio/15k-studio-ads.js');
  const helpSrc = read('src/systems/ads_studio/15n-studio-help.js');
  const studioApiPy = read('server/systems/ads_studio/studio_api.py');
  const win = {
    location: { pathname: '/studio', search: '', href: 'http://localhost/studio' },
    listeners: { popstate: [] },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const list = this.listeners[type] || []; const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); },
    localStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })()
  };
  const hist = {
    entries: [{ url: '/studio', state: null }], index: 0,
    get length() { return this.entries.length; },
    get state() { return this.entries[this.index] ? this.entries[this.index].state : null; },
    show() { const url = new URL(this.entries[this.index].url, 'http://localhost'); win.location.pathname = url.pathname; win.location.search = url.search; win.location.href = url.href; },
    reset(url) { this.entries = [{ url, state: null }]; this.index = 0; this.show(); },
    pushState(entryState, _title, url) { this.entries.splice(this.index + 1); this.entries.push({ url: String(url), state: JSON.parse(JSON.stringify(entryState)) }); this.index++; this.show(); },
    replaceState(entryState, _title, url) { this.entries[this.index] = { url: String(url || this.entries[this.index].url), state: JSON.parse(JSON.stringify(entryState)) }; this.show(); },
    go(delta) { const next = this.index + delta; if (!delta || next < 0 || next >= this.entries.length) return; this.index = next; this.show(); for (const fn of [...win.listeners.popstate]) fn({ state: this.state }); },
    back() { this.go(-1); }
  };
  win.history = hist;
  let secureSeq = 0;
  const box = vm.createContext({
    state: { language: 'en', theme: 'light', currentUser: { id: 'u1', name: 'Sara', email: 'sara@albayan.example' }, currentView: 'ads-studio', adCampaignRequests: [], walletTransactions: [] },
    Security: {
      escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      isValidRecordId: value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(value ?? '').trim()),
      generateSecureId: prefix => `${prefix}_${Date.now()}_${String(++secureSeq).padStart(12, '0')}`,
      sanitizeObject: value => JSON.parse(JSON.stringify(value))
    },
    window: win, history: hist, URLSearchParams, URL,
    isServerModeEnabled: () => true,
    isCurrentUserAdmin: () => false,
    currentUserHasPermission: (collection, action) => action !== 'review' && action !== 'view',
    hasSubscription: id => id === 'ad_maker',
    canActOnRecord: () => true,
    getVisibleRecords: list => (Array.isArray(list) ? list.filter(item => item && !item._deleted) : []),
    getEntityPhotoCountHint: () => 0,
    updateUrlParams: () => {}, requestViewScrollReset: () => {}, IS_STUDIO_SHELL: true,
    TIME_CONSTANTS: { API_TIMEOUT_LONG_MS: 1000 }
  }, { microtaskMode: 'afterEvaluate' });
  let loadError = '';
  try {
    const at = forms.indexOf('function normalizeDigitsAscii(');
    vm.runInContext(forms.slice(at, forms.indexOf('\n}\n', at) + 2), box);
    vm.runInContext(`
      var __calls = [];
      var __replies = Object.create(null);
      var __timers = new Map();
      var __timerSeq = 0;
      var __html = '';
      var __notes = [];
      var __dom = new Map();
      var performance = { now: () => 100, getEntriesByType: () => [{ type: 'navigate', name: '' }] };
      var document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, getElementById(id) { return __dom.get(id) || null; } };
      function setTimeout(fn, ms) { const id = ++__timerSeq; __timers.set(id, { fn, ms: Number(ms) || 0 }); return id; }
      function clearTimeout(id) { __timers.delete(id); }
      function __runTimers() { for (let round = 0; round < 5 && __timers.size; round++) { const due = Array.from(__timers.entries()); __timers.clear(); due.forEach(([, t]) => t.fn()); } }
      function getUrlParams() { return { tab: new URLSearchParams(window.location.search).get('tab') }; }
      function apiJson(path, options) {
        __calls.push({ path: String(path), method: String((options && options.method) || 'GET'), body: options && options.body ? JSON.parse(JSON.stringify(options.body)) : null });
        const next = (__replies[path] || []).shift();
        if (!next) return new Promise(() => {});
        if (next.error) return Promise.reject(Object.assign(new Error(next.error.message || 'Request failed'), next.error));
        return Promise.resolve(JSON.parse(JSON.stringify(next.value)));
      }
      function showNotification(title, message, type) { __notes.push({ title, message, type }); }
      function getServerSessionIdentity() { return 'session'; }
      function serverSessionIdentityChanged() { return false; }
      function makeSessionChangedError() { return new Error('session changed'); }
      function requestValidatedServerEntity(collection, context, loader) { return loader(); }
      function withRetry(fn) { return fn(); }
      function markCollectionDirty() {}
      function saveState() {}
      function studioBuilderStart() { return true; }
      window.addEventListener('popstate', () => { restoreAdsStudioTabFromUrl(); render(); });
    `, box);
    vm.runInContext(adsStudio, box);
    vm.runInContext(coreSrc, box);
    vm.runInContext(shellSrc, box);
    vm.runInContext(homeSrc, box);
    vm.runInContext(adsSrc, box);
    vm.runInContext(helpSrc, box);
    vm.runInContext(extrasSrc, box);
    // The pieces here are drawn by name; a whole-frame render would only add the shell's own reads.
    vm.runInContext('var __renders = 0; function render() { __renders++; }', box);
  } catch (error) { loadError = String(error && error.message || error); }
  const run = code => { try { return vm.runInContext(code, box); } catch (error) { return `THREW ${error && error.message}`; } };
  const json = code => { try { return JSON.parse(String(run(`JSON.stringify(${code})`))); } catch (_) { return undefined; } };
  const failed = cases => cases.map((ok, i) => ok ? '' : i).filter(String).join(',');
  const reply = (path, value) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ value: ${JSON.stringify(value)} });`);
  const replyError = (path, error) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ error: ${JSON.stringify(error)} });`);
  const calls = (method, path) => (json('__calls') || []).filter(c => c.method === method && c.path === path);
  const inLanguage = (language, code) => { box.state.language = language; const out = run(code); box.state.language = 'en'; return out; };
  const meReply = value => run(`studioResetMe(); __replies['/api/studio/me'] = [{ value: ${JSON.stringify(value)} }]; studioLoadMe();`);
  const latin = /[A-Za-z]/;
  const arabic = /[؀-ۿ]/;
  const forbiddenEn = /\b(connected|linked|managed|manages|automated)\b/i;  // server/test_studio_tiktok.py FORBIDDEN_EN
  const forbiddenAr = /(متصل|مربوط|يدير|مؤتمت)/;                             // FORBIDDEN_AR
  const T1 = 'tkt_' + 'a'.repeat(40);
  const T2 = 'tkt_' + 'b'.repeat(40);
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  const tiktokRequest = (id, number, state, extra = {}) => ({
    id, number, subject: 'TikTok service · خدمة تيك توك · @my.shop', category: 'tiktok', status: state === 'done' || state === 'declined' ? 'resolved' : 'open',
    audience: 'staff', priority: 'normal', kind: 'tiktok_request', relatedType: null, relatedId: null, createdAt: ago(120), updatedAt: ago(30),
    dueAt: state === 'open' ? new Date(Date.now() + 3600000).toISOString() : null, lastMessageAt: ago(30), resolvedAt: null, reopenUntil: null,
    tiktok: { handle: 'my.shop', profileUrl: 'https://www.tiktok.com/@my.shop', wants: ['auto_replies_help', 'advice'], state,
      stateLabels: { en: `server words for ${state}`, ar: `كلمات الخادم لحالة ${state}` }, note: state === 'in_progress' ? { en: 'We <b>called</b> you', ar: 'اتصلنا بك' } : null, stateAt: ago(10) },
    ...extra
  });
  const service = { open: true, labels: { en: 'TikTok service: hands-on help from the Albayan team, without automatic replies', ar: 'خدمة تيك توك — مساعدة يدوية من فريق البيان، بدون ردود تلقائية' },
    notice: { en: 'Albayan cannot reply on TikTok for you yet. We help you by hand.', ar: 'لا يستطيع البيان حالياً الرد تلقائياً على تيك توك. سنساعدك يدوياً.' },
    promise: { en: 'A team member contacts you within one business day.', ar: 'يتواصل معك أحد أعضاء الفريق خلال يوم عمل.' },
    wants: [{ key: 'auto_replies_help', labels: { en: "Help setting up TikTok's own built-in auto-messages (TikTok runs them, not Albayan)", ar: 'مساعدة في إعداد الرسائل التلقائية المدمجة في تيك توك' } }, { key: 'advice', labels: { en: 'Advice on answering comments by hand and on TikTok ads', ar: 'نصائح للرد على التعليقات يدوياً' } }],
    maxOpen: 3 };
  const meV2 = { ui: 'v2', staffDesk: 'classic', isStaff: false, isAdmin: false, services: { help: true, stopRequest: true, tiktok: true }, intake: { open: true },
    serviceHours: { timezone: 'Africa/Tripoli', openNow: true, week: {}, holidays: [], ramadan: null }, contact: { whatsapp: '+218912345678', phone: '', email: '' } };
  const allHtml = [];

  // Bundle and manifest.
  check('Studio extras (15r) ship after the help desk in the lazy studio bundle, in both built copies, never in the startup bundle; every studio bundle stays under 1 MiB',
    !loadError && bundleManifestJson.lazy['studio.js'].indexOf('systems/ads_studio/15r-studio-extras.js') > bundleManifestJson.lazy['studio.js'].indexOf('systems/ads_studio/15n-studio-help.js')
      && !bundleManifestJson.files.some(file => /15r-studio/.test(file))
      && [read('studio.js'), read('www/studio.js')].every(bundle => bundle.includes(extrasSrc)) && !read('script.js').includes('renderStudioTikTokSection')
      && Object.keys(bundleManifestJson.lazy).filter(name => /^studio/.test(name)).every(name => fs.statSync(path.join(ROOT, name)).size < 1024 * 1024),
    loadError);

  // P5-02 TikTok: the words. The marked block, the drawn section (EN and AR, every state) and the desk rows never
  // call TikTok connected, linked, managed or automated (server/test_studio_tiktok.py's list).
  const textsBlock = extrasSrc.slice(extrasSrc.indexOf('// TIKTOK-TEXTS-BEGIN'), extrasSrc.indexOf('// TIKTOK-TEXTS-END'));
  const pairs = [...textsBlock.matchAll(/\[(['"])((?:(?!\1)[^\\]|\\.)*)\1,\s*(['"])((?:(?!\3)[^\\]|\\.)*)\3\]/g)].map(m => [m[2], m[4]]);
  run(`studioResetMe(); _studioTikTok.forUser = '__none__';`);
  meReply(meV2);
  reply('/api/studio/tiktok/requests', { requests: [tiktokRequest(T1, 'T-000101', 'open'), tiktokRequest(T2, 'T-000102', 'in_progress')], nextCursor: null, openCount: 2, maxOpen: 3, service });
  hist.reset('/studio?tab=help&section=tiktok');
  const tiktokFirst = String(run('renderStudioTikTokSection({ tab: "help", section: "tiktok", id: "", step: 0 })'));  // the first draw reads (its answer lands after the draw)
  const tiktokEn = String(run('renderStudioTikTokSection({ tab: "help", section: "tiktok", id: "", step: 0 })'));
  const tiktokEnAfter = String(run('renderStudioTikTokSection({ tab: "help", section: "tiktok", id: "", step: 0 })'));
  const tiktokAr = String(inLanguage('ar', 'renderStudioTikTokSection({ tab: "help", section: "tiktok", id: "", step: 0 })'));
  const deskItems = [tiktokRequest(T1, 'T-000101', 'open', { ownerId: 'cust-1', overdue: true, dueAt: ago(5) }), tiktokRequest(T2, 'T-000102', 'in_progress'), { id: 'nope' }, null];
  const deskEn = String(run(`renderStudioTikTokDeskRows(${JSON.stringify(deskItems)}, { open: 'studioStaffOpen', onChange: 'studioStaffRetry' })`));
  const deskAr = String(inLanguage('ar', `renderStudioTikTokDeskRows(${JSON.stringify(deskItems)}, { actions: false })`));
  const deskEmpty = String(run('renderStudioTikTokDeskRows([])'));
  const everyState = ['open', 'in_progress', 'done', 'declined', 'cancelled'].map(state => String(inLanguage('ar', `renderStudioTikTokDeskRows([${JSON.stringify(tiktokRequest(T1, 'T-1', state, { tiktok: { handle: 'x_y', wants: ['advice'], state } }))}])`)));
  const textOf = html => html.replace(/<[^>]+>/g, ' ');
  allHtml.push(tiktokFirst, tiktokEn, tiktokEnAfter, tiktokAr, deskEn, deskAr, deskEmpty, ...everyState);
  const wordCases = [
    pairs.length >= 40 && pairs.every(([en, ar]) => en.trim() && arabic.test(ar)),
    !forbiddenEn.test(textsBlock) && !forbiddenAr.test(textsBlock),
    allHtml.every(html => !forbiddenEn.test(textOf(html)) && !forbiddenAr.test(textOf(html))),
    textsBlock.includes('by hand') && textsBlock.includes('TikTok runs them, not Albayan') && textsBlock.includes('مساعدة يدوية') && textsBlock.includes('يدوياً')
  ];
  check('Studio TikTok (P5-02): every text pair has Arabic; neither the words nor the drawn screens (EN/AR, every state, the desk rows) say connected, linked, managed or automated; the copy says "by hand" and that TikTok runs its own auto-messages',
    !loadError && wordCases.every(Boolean), loadError || `cases ${failed(wordCases)} pairs ${pairs.length}`);

  // P5-02 TikTok: the section and the form on real (scripted) server answers.
  const firstRead = calls('GET', '/api/studio/tiktok/requests').length;
  const T3 = 'tkt_' + 'c'.repeat(40);
  run('studioTikTokSet("handle", "https://www.tiktok.com/@My.Shop_1"); studioTikTokToggleWant("auto_replies_help", false); studioTikTokToggleWant("advice", true); studioTikTokSet("note", "Please call after 5 pm");');
  // The scripted replies are queued per path: the POST takes the first, the read after it the second.
  reply('/api/studio/tiktok/requests', { request: tiktokRequest(T3, 'T-000103', 'open', { tiktok: { handle: 'My.Shop_1', wants: ['advice'], state: 'open', stateLabels: { en: 'Received', ar: 'وصل الطلب' } } }), message: {} });
  reply('/api/studio/tiktok/requests', { requests: [tiktokRequest(T3, 'T-000103', 'open'), tiktokRequest(T1, 'T-000101', 'open'), tiktokRequest(T2, 'T-000102', 'in_progress')], nextCursor: null, openCount: 2, maxOpen: 3, service });
  run('var __sendOk = null; var __sendMid = ""; studioTikTokSend().then(ok => { __sendOk = ok; }); __sendMid = renderStudioTikTokSection({ tab: "help", section: "tiktok", id: "", step: 0 });');
  const sendingHtml = String(run('__sendMid'));
  const sendOk = run('__sendOk');
  const postBody = (calls('POST', '/api/studio/tiktok/requests')[0] || {}).body || {};
  const sentHtml = String(run('renderStudioTikTokSection({ tab: "help", section: "tiktok", id: "", step: 0 })'));
  run('studioTikTokSet("handle", "bad handle!"); studioTikTokToggleWant("advice", false); studioTikTokToggleWant("auto_replies_help", false);');
  run('studioTikTokSend();');
  const invalidHtml = String(run('renderStudioTikTokSection({ tab: "help", section: "tiktok", id: "", step: 0 })'));
  const handles = json("['name', '@name', 'tiktok.com/@a.b_c', 'https://www.tiktok.com/@shop99?lang=en', 'ends.', 'a', 'too_long_' + 'x'.repeat(20), 'bad handle', ''].map(studioTikTokHandle)");
  const onclicks = allHtml.concat([sendingHtml, sentHtml, invalidHtml]).join('').match(/on(click|change|input|submit)="[^"]*"/g) || [];
  const safeHandler = /^on(click|change|input|submit)="(studioTikTok(OpenTicket|Open|Retry|More|Send|DeskEdit|DeskSend)\(('[A-Za-z0-9_-]*'(, '[A-Za-z0-9_-]*')*)?\)(; return false;)?|studioTikTokSet\('(handle|note)', this\.value\)|studioTikTokToggleWant\('[a-z_]+', this\.checked\)|studioStaffOpen\('tkt_[0-9a-f]{40}'\))"$/;
  const tiktokCases = [
    firstRead === 1 && tiktokFirst.includes('data-testid="studio-tiktok-loading"') && tiktokEn.includes('data-testid="studio-tiktok"') && tiktokEn.includes(`data-testid="studio-tiktok-item-${T1}"`) && tiktokEn.includes('data-state="in_progress"') && tiktokEnAfter === tiktokEn,
    tiktokEn.includes('server words for open') && tiktokAr.includes('كلمات الخادم لحالة open') && tiktokEn.includes('href="https://www.tiktok.com/@my.shop"') && tiktokEn.includes('We &lt;b&gt;called&lt;/b&gt; you'),
    tiktokEn.includes('id="studio-tiktok-handle"') && tiktokEn.includes('id="studio-tiktok-want-advice"') && tiktokEn.includes('id="studio-tiktok-note"') && tiktokEn.includes('data-testid="studio-tiktok-send"'),
    JSON.stringify(handles) === JSON.stringify(['name', 'name', 'a.b_c', 'shop99', '', '', '', '', '']),
    sendOk === true && sendingHtml.includes('aria-busy="true"') && JSON.stringify(postBody) === JSON.stringify({ handle: 'My.Shop_1', wants: ['advice'], operationId: postBody.operationId, note: 'Please call after 5 pm' })
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(String(postBody.operationId)) && calls('POST', '/api/studio/tiktok/requests').length === 1
      && sentHtml.includes('data-testid="studio-tiktok-sent"') && sentHtml.includes(`data-testid="studio-tiktok-item-${T3}"`) && sentHtml.includes('data-testid="studio-tiktok-form"') && calls('GET', '/api/studio/tiktok/requests').length === 2,
    invalidHtml.includes('data-testid="studio-tiktok-problem-handle"') && invalidHtml.includes('data-testid="studio-tiktok-problem-wants"') && calls('POST', '/api/studio/tiktok/requests').length === 1,
    onclicks.length > 12 && onclicks.every(attr => safeHandler.test(attr)),
    deskEn.includes(`data-testid="studio-tiktok-desk-${T1}"`) && deskEn.includes(`onclick="studioStaffOpen('${T1}')"`) && deskEn.includes(`data-testid="studio-tiktok-desk-start-${T1}"`) && deskEn.includes(`data-testid="studio-tiktok-desk-done-${T2}"`)
      && !deskEn.includes('nope') && deskAr.includes('is-static') && !deskAr.includes('studio-tiktok-desk-start') && deskEmpty.includes('data-testid="studio-tiktok-desk-empty"') && deskEn.includes('Overdue since'),
    (() => {
      run(`studioTikTokDeskEdit('${T1}', 'in_progress');`);
      const form = String(run(`renderStudioTikTokDeskRows(${JSON.stringify(deskItems)}, { open: 'studioStaffOpen', onChange: 'studioStaffRetry' })`));
      run(`__dom.set('studio-tiktok-note-en-${T1}', { value: 'We called you' }); __dom.set('studio-tiktok-note-ar-${T1}', { value: '' });`);
      run(`studioTikTokDeskSend('${T1}', 'in_progress');`);  // an empty Arabic note: refused on the screen, nothing sent
      const refused = String(run(`renderStudioTikTokDeskRows(${JSON.stringify(deskItems)})`));
      run(`__dom.set('studio-tiktok-note-ar-${T1}', { value: 'اتصلنا بك' });`);
      run(`studioTikTokDeskSend('${T1}', 'in_progress'); studioTikTokDeskSend('${T1}', 'in_progress');`);  // single flight
      const posts = calls('POST', `/api/studio/staff/tiktok/${T1}/status`);
      return form.includes(`id="studio-tiktok-note-en-${T1}"`) && form.includes(`data-testid="studio-tiktok-desk-save-${T1}"`) && refused.includes('data-testid="studio-tiktok-desk-problem"')
        && posts.length === 1 && JSON.stringify(posts[0].body) === JSON.stringify({ status: 'in_progress', note: { en: 'We called you', ar: 'اتصلنا بك' }, operationId: posts[0].body.operationId })
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(String(posts[0].body.operationId));
    })(),
    !/\b(?:confirm|prompt|alert)\(/.test(extrasSrc) && !/<(input|textarea)\b(?![^>]*\bid=")/.test(extrasSrc),
    extrasSrc.includes("studioV2Go({ tab: 'help', section: 'tiktok' })") && extrasSrc.includes('function renderStudioTikTokEntry()') && extrasSrc.includes('function renderStudioTikTokDeskRows(items, options = {})')
  ];
  check('Studio TikTok (P5-02): the section reads GET /tiktok/requests once, draws the server\'s state words and the team note escaped, validates the handle rule, POSTs one request with an operationId, refuses an invalid form without sending; the desk rows open, step and note with single flight; no native dialogs; every input has an id',
    !loadError && tiktokCases.every(Boolean), loadError || `cases ${failed(tiktokCases)} handlers ${onclicks.filter(attr => !safeHandler.test(attr)).slice(0, 3).join(' | ')}`);

  // Stage 15 hooks (15n, 15j): the Help body draws the TikTok section for ?section=tiktok, the Help list its row
  // after the contact card, and Home shows the "TikTok help" goal (opening the section) only while /me says the
  // service is on for this account.
  meReply(meV2);
  const helpTiktok = String(run('renderStudioHelpBody({ tab: "help", section: "tiktok", id: "", step: 0 })'));
  const helpListWithRow = String(run('renderStudioHelpBody({ tab: "help", section: "", id: "", step: 0 })'));
  const homeOn = String(run('renderStudioHomeGoals(false)'));
  hist.reset('/studio?tab=home');
  const goalOn = run("studioHomeGoal('tiktok')");
  const goalUrl = win.location.search;
  meReply({ ...meV2, services: { ...meV2.services, tiktok: false } });
  const helpListOff = String(run('renderStudioHelpBody({ tab: "help", section: "", id: "", step: 0 })'));
  const homeOff = String(run('renderStudioHomeGoals(false)'));
  const goalOff = run("studioHomeGoal('tiktok')");
  meReply(meV2);
  const hookCases = [
    helpTiktok.includes('data-testid="studio-tiktok"') && !helpTiktok.includes('data-testid="studio-help"'),
    helpListWithRow.includes('data-testid="studio-help-contact"') && helpListWithRow.includes('data-testid="studio-tiktok-entry"') && helpListWithRow.indexOf('data-testid="studio-tiktok-entry"') > helpListWithRow.indexOf('data-testid="studio-help-contact"'),
    !helpListOff.includes('studio-tiktok-entry'),
    homeOn.includes('data-testid="studio-goal-tiktok" onclick="studioHomeGoal(\'tiktok\')"') && homeOn.includes('TikTok help') && !homeOff.includes('studio-goal-tiktok') && goalOff === false,
    goalOn === true && goalUrl === '?tab=help&section=tiktok',
    helpSrc.includes("String(route.section || '') === 'tiktok' && typeof renderStudioTikTokSection === 'function') return renderStudioTikTokSection(route);")
      && helpSrc.includes("const tiktok = typeof renderStudioTikTokEntry === 'function' ? renderStudioTikTokEntry() : '';") && homeSrc.includes("['tiktok', 'music-2', 'TikTok help', 'مساعدة تيك توك',")
      && homeSrc.includes("if (goal === 'tiktok') return studioHomeTikTokOn() && typeof studioTikTokOpen === 'function' ? studioTikTokOpen() : false;")
  ];
  check('Studio TikTok hooks (stage 15): Help draws the section for ?section=tiktok and lists its row after the contact card while the service is on; Home shows the "TikTok help" goal only then, and it opens the section',
    !loadError && hookCases.every(Boolean), loadError || `cases ${failed(hookCases)}`);

  // P3-05 (client): the bell's count follows the pulse hook while the customer layout is on.
  run("__calls.length = 0; studioPulseStop('inbox'); _studioInbox.forUser = '__none__'; studioInboxScope();");
  meReply(meV2);  // the /me listener starts the watch
  reply('/api/studio/activity', { items: [], nextCursor: null, unreadCount: 0, seenAt: null });
  run('__runTimers();');
  const firstPolls = calls('GET', '/api/studio/activity').length;
  reply('/api/studio/activity', { items: [{ id: 'act_1', kind: 'request_approved', title: { en: 'Your ad was approved', ar: 'تمت الموافقة على إعلانك' }, body: { en: '$5.00 was paid', ar: 'دُفع $5.00' }, relatedType: 'campaign', relatedId: 'r1', createdAt: ago(1), unread: true }], nextCursor: null, unreadCount: 1, seenAt: null });
  reply('/api/studio/activity', { items: [{ id: 'act_1', kind: 'request_approved', title: { en: 'Your ad was approved', ar: 'تمت الموافقة على إعلانك' }, body: { en: '$5.00 was paid', ar: 'دُفع $5.00' }, relatedType: 'campaign', relatedId: 'r1', createdAt: ago(1), unread: true }], nextCursor: null, unreadCount: 1, seenAt: null });
  run('__runTimers();');
  const afterChange = calls('GET', '/api/studio/activity').length;
  const badgeHtml = String(run("studioInboxBadge('home')"));
  run("__calls.length = 0;");
  meReply({ ...meV2, ui: 'classic' });  // classic layout: the watch stops
  run('__runTimers(); __runTimers();');
  const classicPolls = calls('GET', '/api/studio/activity').length;
  const pulseCases = [
    firstPolls === 1,
    afterChange === 3,  // the second poll saw unreadCount move: the Inbox read again (15n) and drew the badge
    badgeHtml.includes('data-testid="studio-inbox-badge"') && badgeHtml.includes('>1<'),
    classicPolls === 0,
    extrasSrc.includes("studioPulseWatch(STUDIO_INBOX_PULSE_KEY, { path: '/api/studio/activity', field: 'unreadCount', intervalMs: STUDIO_INBOX_PULSE_MS") && extrasSrc.includes('studioMeSubscribe(studioInboxPulseStart)')
      && extrasSrc.includes('const STUDIO_INBOX_PULSE_MS = 30 * 1000;') && helpSrc.includes("studioV2RegisterScreen('inbox', renderStudioInboxBody)") && helpSrc.includes("studioV2Go({ tab: 'campaigns', id: item.relatedId })")
  ];
  check('Studio inbox badge (P3-05 client): the pulse hook polls the feed only in the v2 customer layout, a moved unreadCount makes the Inbox read again and the bell shows the count; the watch stops in classic',
    !loadError && pulseCases.every(Boolean), loadError || `cases ${failed(pulseCases)} polls ${firstPolls}/${afterChange}/${classicPolls}`);
  // ONE watch across settled /me reads (its baseline reading kept, so a change since the last poll is never swallowed
  // and no extra read fires), and no poll at all while another screen of the app is on show.
  run("__calls.length = 0; studioPulseStop('inbox'); _studioInbox.forUser = '__none__'; studioInboxScope();");
  meReply(meV2);
  reply('/api/studio/activity', { items: [], nextCursor: null, unreadCount: 0, seenAt: null });
  run('__runTimers();');
  const keptBaseline = calls('GET', '/api/studio/activity').length;  // 1: the baseline reading
  run("__watchBefore = _studioPulse.watches.get('inbox');");
  meReply(meV2);  // the 5-minute /me re-read settles: the same watch goes on
  const sameWatch = run("_studioPulse.watches.get('inbox') === __watchBefore") === true;
  const noExtraRead = calls('GET', '/api/studio/activity').length === keptBaseline;
  reply('/api/studio/activity', { items: [{ id: 'act_2', kind: 'ticket_answered', title: { en: 'Answered', ar: 'تم الرد' }, body: { en: 'x', ar: 'س' }, relatedType: 'ticket', relatedId: T1, createdAt: ago(1), unread: true }], nextCursor: null, unreadCount: 1, seenAt: null });
  reply('/api/studio/activity', { items: [{ id: 'act_2', kind: 'ticket_answered', title: { en: 'Answered', ar: 'تم الرد' }, body: { en: 'x', ar: 'س' }, relatedType: 'ticket', relatedId: T1, createdAt: ago(1), unread: true }], nextCursor: null, unreadCount: 1, seenAt: null });
  run('__runTimers();');
  const afterKept = calls('GET', '/api/studio/activity').length;  // 3: the poll saw the move against the kept baseline, the Inbox read again
  run("__calls.length = 0;");
  box.state.currentView = 'dashboard';  // the manager: no bell drawn here
  run('__runTimers(); __runTimers();');
  const awayPolls = calls('GET', '/api/studio/activity').length;
  const stillWatching = run("_studioPulse.watches.has('inbox')") === true;
  box.state.currentView = 'ads-studio';
  reply('/api/studio/activity', { items: [], nextCursor: null, unreadCount: 1, seenAt: null });
  run('__runTimers();');
  const backPolls = calls('GET', '/api/studio/activity').length;
  const keptWatchCases = [
    keptBaseline === 1 && sameWatch && noExtraRead,
    afterKept === 3,
    awayPolls === 0 && stillWatching,
    backPolls === 1,
    extrasSrc.includes("if (typeof studioPulseWatching === 'function' && studioPulseWatching(STUDIO_INBOX_PULSE_KEY)) return true;") && extrasSrc.includes('while: studioInboxPulseWanted')
      && coreSrc.includes('function studioPulseWatching(key)') && coreSrc.includes("if (!wanted) { studioPulseSchedule(watch, watch.intervalMs); return; }")
  ];
  check('Studio inbox pulse: one watch per signed-in user across /me reads (the baseline is kept: a change since the last poll is reported, no extra read), and the feed is polled only while a studio screen is on show',
    !loadError && keptWatchCases.every(Boolean), loadError || `cases ${failed(keptWatchCases)} baseline ${keptBaseline} same ${sameWatch} after ${afterKept} away ${awayPolls} back ${backPolls}`);

  // P3-04b: the results card. Nothing before a link; the numbers once linked; the last good values on a failed read.
  run("__calls.length = 0; resetAdsStudioResults(); state.adCampaignRequests = [{ id: 'r_unlinked', createdBy: 'u1', status: 'Approved', name: 'A', paidMinorUSD: 5000, _created: 5, _lastModified: 15 }, { id: 'r_linked', createdBy: 'u1', status: 'Approved', name: 'B', paidMinorUSD: 5000, metaCampaignId: '120', metaAdAccountId: '9', _created: 6, _lastModified: 16 }];");
  const noLink = String(run("renderStudioResultsCard('r_unlinked')"));
  const loading = String(run("renderStudioResultsCard('r_linked')"));
  reply('/api/studio/campaigns/r_linked/results', { campaignId: 'r_linked', linked: true, stage: { stage: 8, labels: { en: 'Running', ar: 'يعمل الآن' } },
    results: { metaUsedMinor: 340, paidMinor: 5000, currency: 'USD', impressions: 1234, reach: 800, clicks: 20, resultType: 'link_click', resultCount: 20, costPerResultMinor: 17, checkedAt: ago(3), checkedAgo: { en: 'checked 3 min ago', ar: 'تحقّقنا قبل 3 دقائق' }, stale: false } });
  run("resetAdsStudioResults(); renderStudioResultsCard('r_linked');");  // the read
  const ready = String(run("renderStudioResultsCard('r_linked')"));
  const readyAr = String(inLanguage('ar', "renderStudioResultsCard('r_linked')"));
  replyError('/api/studio/campaigns/r_linked/results', { status: 503, message: 'Service Unavailable' });
  run("_adsStudioResults.byId.get('r_linked').at = 0; renderStudioResultsCard('r_linked');");  // a failed re-read
  const stale = String(run("renderStudioResultsCard('r_linked')"));
  const resultCases = [
    noLink === '' && String(run("renderStudioResultsCard('')")) === '' && String(run("renderStudioResultsCard('missing')")) === '',
    loading.includes('data-testid="studio-results-card"') && loading.includes('data-state="loading"') && loading.includes('Checking Meta'),
    ready.includes('data-state="ready"') && ready.includes('<p class="studio-ads-results-used" data-testid="studio-results-used">Meta used $3.40 of $50.00</p>')
      && ready.includes('data-testid="studio-results-stat-impressions"') && ready.includes('<dd>1,234</dd>') && ready.includes('<dd>800</dd>') && ready.includes('Link clicks') && ready.includes('<dd>20</dd>')
      && ready.includes('data-testid="studio-results-checked">checked 3 min ago<') && ready.includes('Running') && ready.includes('Reported by Meta'),
    readyAr.includes('استخدمت ميتا $3.40 من $50.00') && readyAr.includes('تحقّقنا قبل 3 دقائق') && readyAr.includes('يعمل الآن') && readyAr.includes('نقرات على الرابط') && !latin.test(readyAr.replace(/<[^>]+>/g, '').replace(/[\d$.,]/g, '')),
    stale.includes('data-state="stale"') && stale.includes('Meta used $3.40 of $50.00') && stale.includes('the last ones we read') && calls('GET', '/api/studio/campaigns/r_linked/results').length === 3,
    extrasSrc.includes('function renderStudioResultsCard(campaignId)') && extrasSrc.includes('adsStudioShowsResults(request)')
      && adsSrc.includes("${typeof renderStudioResultsCard === 'function' ? renderStudioResultsCard(request.id) : renderStudioAdsResults(request)}"),
    // the request detail (15k hook, stage 15) draws this card in place of its own results block
    (() => { const detail = String(run("renderStudioAdsDetail({ tab: 'campaigns', section: '', id: 'r_linked', step: 0 })")); return detail.includes('data-testid="studio-ad-detail"') && detail.includes('data-testid="studio-results-card" data-campaign="r_linked"') && !detail.includes('data-testid="studio-ad-results"'); })()
  ];
  check('Studio results card (P3-04b): nothing before a Meta link; "Meta used $Y of $X", impressions, reach, results and "checked X ago" from GET campaigns/{id}/results in EN/AR; the last good values stay on a failed read',
    !loadError && resultCases.every(Boolean), loadError || `cases ${failed(resultCases)}`);

  // P2-09: the login help line from the public contact (cached), and the two startup hooks within the byte budget.
  run("__calls.length = 0; window.localStorage.removeItem('albayan.studio.public.contact'); _studioPublicContact.value = null; _studioPublicContact.at = 0; _studioPublicContact.failedAt = 0; __dom.set('studio-login-help', { innerHTML: '' });");
  reply('/api/studio/public/contact', { whatsapp: '+218912345678', phone: '0913333333', email: 'help@albayan.example', urgentWhatsapp: '+218911111111' });
  const emptyHelp = String(run('renderStudioLoginHelp()'));  // nothing cached yet: the neutral line, and the read (its answer mounts the line)
  const mounted = String(run("__dom.get('studio-login-help').innerHTML"));
  const helpEn = String(run('renderStudioLoginHelp()'));
  const helpAr = String(inLanguage('ar', 'renderStudioLoginHelp()'));
  const cached = json("JSON.parse(window.localStorage.getItem('albayan.studio.public.contact'))");
  run("_studioPublicContact.value = null; _studioPublicContact.at = 0; renderStudioLoginHelp();");  // a new page: the cache answers, no second read within 6 h
  const contactReads = calls('GET', '/api/studio/public/contact').length;
  const loginHookAt = views.indexOf('<div id="studio-login-help">');
  const loginCases = [
    emptyHelp.includes('data-testid="studio-login-help"') && emptyHelp.includes('data-contact="0"') && emptyHelp.includes('Contact the Albayan team.') && calls('GET', '/api/studio/public/contact').length === 1,
    mounted.includes('data-contact="1"') && mounted.includes('href="https://wa.me/218912345678"') && mounted.includes('data-testid="studio-login-whatsapp"') && mounted.includes('href="tel:+218913333333"') && !mounted.includes('+218911111111'),
    helpEn.startsWith('<p class="mt-3') && helpEn.includes('New customer or forgot your password? message us on WhatsApp') && helpEn.includes('or call') && helpEn.includes('rel="noopener noreferrer"'),
    helpAr.includes('عميل جديد أو نسيت كلمة المرور؟ راسلنا على واتساب') && helpAr.includes('أو اتصل بنا على') && helpAr.includes('href="tel:+218913333333"'),
    cached && cached.value && cached.value.whatsapp === '+218912345678' && cached.value.phone === '+218913333333' && contactReads === 1,
    loginHookAt > 0 && views.slice(loginHookAt - 400, loginHookAt).includes("'Sign in to manage your campaigns and wallet'") && views.includes(`<div id="studio-login-help">\${typeof renderStudioLoginHelp === 'function' ? renderStudioLoginHelp() : ''}</div>`),
    mobileRuntime.includes("  if (typeof studioHandleBack === 'function' && studioHandleBack()) return;\n") && mobileRuntime.indexOf('studioHandleBack') > mobileRuntime.indexOf('async function handleAndroidBackButton(') && mobileRuntime.indexOf('studioHandleBack') < mobileRuntime.indexOf('const landingView = getMobileLandingView();'),
    fs.statSync(path.join(ROOT, 'script.js')).size <= 2516582 && shellSrc.includes('function studioHandleBack()'),
    studioApiPy.includes('@router.get("/public/contact")') && /def studio_public_contact\(request: Request\):/.test(studioApiPy) && !/def studio_public_contact\([^)]*Depends/.test(studioApiPy)
      && studioApiPy.includes('studio:public-contact:{client_ip(request)}') && studioApiPy.includes('return public_contact(read_all_settings()["contact"])') && studioApiPy.includes('PUBLIC_CONTACT_READS_PER_MINUTE = 60')
  ];
  check('Studio login help line (P2-09): the public contact is read once (no login), cached for the next visit and mounted into the login header in EN/AR (WhatsApp and phone links, never the urgent line); the Android Back and login hooks sit in the startup files inside the byte budget; the server route is public, IP-limited and returns only the public fields',
    !loadError && loginCases.every(Boolean), loadError || `cases ${failed(loginCases)}`);

  // P2-11: error-map completeness. Every plain-text refusal (400/403/409/413) of the older routes in the server files
  // has an Arabic entry in the classic map (15c) or the v2 patterns (15g); the coded ones of ad_campaign_actions are
  // in STUDIO_ERROR_TEXTS; and an Arabic reader never sees raw English for them.
  const unquote = lit => { const q = lit[0]; return lit.slice(1, -1).replace(new RegExp(`\\\\${q}`, 'g'), q).replace(/\\n/g, '\n').replace(/\\\\/g, '\\'); };
  const pyFiles = ['server/systems/ads_studio/ad_campaign_actions.py', 'server/systems/ads_studio/ad_campaign_fields.py', 'server/systems/ads_studio/social_studio.py',
    'server/systems/ads_studio/studio_stop.py', 'server/systems/ads_studio/studio_posts.py', 'server/wallet_payments.py'];
  const pySources = Object.fromEntries(pyFiles.map(file => [file, read(file)]));
  const consts = new Map();
  for (const source of Object.values(pySources)) for (const m of source.matchAll(/^([A-Z][A-Z0-9_]+)\s*=\s*\(?\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/gm)) consts.set(m[1], unquote(m[2]));
  const literalTemplate = expr => {
    let rest = expr.trim();
    let out = '';
    let any = false;
    for (let guard = 0; guard < 12; guard++) {
      const m = rest.match(/^(f?)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/);
      if (m) {
        let text = unquote(m[2]);
        if (m[1]) text = text.replace(/\{\{/g, '\u0001').replace(/\}\}/g, '\u0002').replace(/\{([^{}]*)\}/g, (_, inner) => (consts.has(inner.trim()) ? consts.get(inner.trim()) : '\u0000')).replace(/\u0001/g, '{').replace(/\u0002/g, '}');
        out += text; any = true; rest = rest.slice(m[0].length).trim();
      } else {
        const n = rest.match(/^([A-Z][A-Z0-9_]*)\b/);
        if (n && consts.has(n[1])) { out += consts.get(n[1]); any = true; rest = rest.slice(n[0].length).trim(); }
        else if (n) return { template: out, dynamic: true };
        else break;
      }
      if (rest.startsWith('+')) rest = rest.slice(1).trim();
      else if (!/^(f?)["']/.test(rest)) break;
    }
    return { template: out, dynamic: !any };
  };
  const pyRefusals = (source, file, spans = null) => {
    const out = [];
    let at = 0;
    while ((at = source.indexOf('HTTPException(', at)) !== -1) {
      let depth = 0, i = at + 'HTTPException'.length, end = -1, quote = '';
      for (; i < source.length; i++) {
        const ch = source[i];
        if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = ''; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      const start = at;
      const call = source.slice(at, end + 1);
      const line = source.slice(0, at).split('\n').length;
      at = end + 1;
      if (spans && !spans.some(([a, b]) => start >= a && start < b)) continue;
      const inner = call.slice('HTTPException('.length, -1);
      const status = (inner.match(/status_code\s*=\s*(\d{3})/) || [])[1] || (inner.match(/^\s*(\d{3})\s*,/) || [])[1] || '';
      let expr = ((inner.match(/detail\s*=\s*([\s\S]*)$/) || inner.match(/^\s*\d{3}\s*,\s*([\s\S]*)$/) || [])[1] || '').replace(/,\s*headers\s*=[\s\S]*$/, '').trim();
      const parsed = literalTemplate(expr);
      out.push({ file, line, status, template: parsed.template, dynamic: parsed.dynamic || (!parsed.template && expr !== '') });
    }
    return out;
  };
  const mainRouteSpans = source => {
    const spans = [];
    const re = /^@app\.(?:get|post|put|patch|delete|api_route)\(\s*"(\/api\/(?:ad-studio|social-studio|wallet)[^"]*)"/gm;
    let m;
    while ((m = re.exec(source))) {
      const after = source.indexOf('\n', source.indexOf('def ', m.index));
      const next = source.slice(after).search(/\n(?=@app\.|def |async def |class |[A-Za-z_]+ = )/);
      spans.push([m.index, next === -1 ? source.length : after + next]);
    }
    return spans;
  };
  const mainPySrc = read('server/main.py');
  const refusals = pyFiles.flatMap(file => pyRefusals(pySources[file], file)).concat(pyRefusals(mainPySrc, 'server/main.py', mainRouteSpans(mainPySrc)));
  const classicMapText = adsStudio.slice(adsStudio.indexOf('const _ADS_STUDIO_REFUSAL_AR = ['), adsStudio.indexOf('];', adsStudio.indexOf('const _ADS_STUDIO_REFUSAL_AR = [')) + 2);
  const classicMap = vm.runInNewContext(`${classicMapText} _ADS_STUDIO_REFUSAL_AR;`, {});
  const patternsText = coreSrc.slice(coreSrc.indexOf('const STUDIO_OPEN_REQUESTS_RE'), coreSrc.indexOf(']);', coreSrc.indexOf('const STUDIO_ERROR_PATTERNS')) + 3);
  const patterns = vm.runInNewContext(`${patternsText} STUDIO_ERROR_PATTERNS;`, {});
  const needles = classicMap.map(entry => entry[0]);
  const isRegExp = value => Object.prototype.toString.call(value) === '[object RegExp]';
  const hitsNeedle = (needle, text) => (typeof needle === 'string' ? text.includes(needle) : isRegExp(needle) && needle.test(text));
  const inScope = refusals.filter(r => ['400', '403', '409', '413'].includes(r.status));
  const plain = inScope.filter(r => !r.dynamic);
  const covered = r => { const text = r.template.replace(/\u0000/g, '0'); return needles.some(n => hitsNeedle(n, text)) || patterns.some(([re]) => re.test(text)); };
  // ONE Arabic map (stage 15): the P2-11 entries and the desk's settle refusals live in the classic map from
  // 'Meta is still delivering this ad' on, as [needle, Arabic, '', English]; the v2 list keeps only its two texts.
  const movedFrom = classicMap.findIndex(entry => entry[0] === 'Meta is still delivering this ad');
  const movedEntries = movedFrom < 0 ? [] : classicMap.slice(movedFrom);
  const deskSrcForMap = read('src/systems/ads_studio/15p-studio-desk.js');
  const uncovered = plain.filter(r => !covered(r));
  const clientTexts = json('STUDIO_ERROR_TEXTS') || {};
  const info = (message, language, status = 400) => { box.state.language = language; const out = json(`studioErrorInfo(Object.assign(new Error(${JSON.stringify(message)}), { status: ${status}, payload: { detail: ${JSON.stringify(message)} } }), 'action')`) || {}; box.state.language = 'en'; return out; };
  const samples = ['creativeImages contains invalid base64', 'Photo 2: not an image', 'name is required', 'Unsupported callToAction', 'primaryText is required before submission',
    'Public replies are not available for Instagram accounts right now', 'Payment request is confirmed', 'The wallet is charged in USD or LYD', 'Meta is still delivering this ad', 'Only Draft or Changes Requested campaigns can be submitted'];
  const sampleInfo = samples.map(text => [info(text, 'ar'), info(text, 'en')]);
  const generic = info('nobody translated this', 'ar').text;
  const coded = (code, language) => json(`(function () { state.language = ${JSON.stringify(language)}; const out = studioErrorInfo(Object.assign(new Error('x'), { status: 409, payload: { detail: { code: ${JSON.stringify(code)}, message: 'server words' } } }), 'action'); state.language = 'en'; return out; })()`) || {};
  const mapCases = [
    refusals.length >= 200 && plain.length >= 180 && inScope.filter(r => r.dynamic).length <= 6,
    uncovered.length === 0,
    patterns.length === 2 && patterns.every(([re, en, ar]) => isRegExp(re) && typeof en === 'string' && en.length > 8 && arabic.test(ar) && !latin.test(ar))
      && movedEntries.length >= 60 && movedEntries.every(([needle, ar, kind, en]) => (typeof needle === 'string' || isRegExp(needle)) && arabic.test(ar) && !latin.test(ar.replace(/https?:\/\/|HH:MM|PNG|JPEG|WebP|JPG|USD|LYD/g, '')) && kind === '' && typeof en === 'string' && en.length > 8)
      && !deskSrcForMap.includes('STUDIO_DESK_REFUSALS') && !coreSrc.includes('P2-11: every other plain-text refusal'),
    // ONE Arabic wording per server text: for every plain refusal the classic map covers (the two v2-only texts
    // aside) exactly one wording can answer (no second string needle with a different Arabic, which the first-match
    // lookup would hide), and both lookups (v2 studioErrorInfo, classic adsStudioRefusalText) give THAT entry's own
    // Arabic and its English rewording (or the server's words) — the expected wording, never a function against itself
    plain.every(r => {
      const text = r.template.replace(/\u0000/g, '0');
      if (patterns.some(([re]) => re.test(text))) return true;
      const entry = classicMap.find(([needle]) => hitsNeedle(needle, text));  // the first match, as adsStudioRefusalEntry
      if (!entry) return false;
      const stringHits = classicMap.filter(([needle]) => typeof needle === 'string' && text.includes(needle));
      if (new Set(stringHits.map(([, ar]) => ar)).size > 1) return false;
      const expectedAr = entry[2] ? null : entry[1];  // a dynamic entry adds the server's amount or days after its words
      const expectedEn = entry[3] || text;
      const classicAr = String(inLanguage('ar', `adsStudioRefusalText(${JSON.stringify(text)})`));
      const classicEn = String(run(`adsStudioRefusalText(${JSON.stringify(text)})`));
      const wordingOk = expectedAr === null ? classicAr.startsWith(entry[1].trim()) : classicAr === expectedAr;
      return classicAr !== text && wordingOk && classicEn === expectedEn && info(text, 'ar').text === classicAr && info(text, 'en').text === expectedEn;
    }),
    sampleInfo.every(([ar, en]) => arabic.test(ar.text) && !latin.test(ar.text.replace(/https?:\/\/|HH:MM|PNG|JPEG|WebP|JPG|USD|LYD/g, '')) && ar.text !== generic && en.text && !/^(creativeImages|Photo \d|name is|Unsupported|primaryText)/.test(en.text)),
    ['SETTLE_NOT_READY', 'NEEDS_MANUAL_RENAME'].every(code => Array.isArray(clientTexts[code]) && arabic.test(clientTexts[code][1]) && coded(code, 'ar').text === clientTexts[code][1] && coded(code, 'en').text === clientTexts[code][0])
      && /"code": SETTLE_NOT_READY/.test(pySources['server/systems/ads_studio/ad_campaign_actions.py']) && /"code": NEEDS_MANUAL_RENAME/.test(pySources['server/systems/ads_studio/ad_campaign_actions.py']),
    // the map's generic shapes never shadow the classic map's own words for these
    info('expectedVersion is required', 'ar').text === inLanguage('ar', "adsStudioRefusalText('expectedVersion is required')") && info('note must be text', 'ar').text === inLanguage('ar', "adsStudioRefusalText('note must be text')")
  ];
  check('Studio error map completeness (P2-11): every plain-text 400/403/409/413 refusal of /api/ad-studio, /api/social-studio and /api/wallet in the server files has an Arabic entry in the classic map or the v2 patterns; the coded settle/rename refusals are in STUDIO_ERROR_TEXTS; Arabic readers never get raw English',
    !loadError && mapCases.every(Boolean), loadError || `cases ${failed(mapCases)} uncovered ${uncovered.slice(0, 5).map(r => `${r.file}:${r.line} ${JSON.stringify(r.template.replace(/\u0000/g, '{…}'))}`).join(' | ')}`);
}

{
  // Stage 18 — P6-06 (Classic view), P5-07 (the terms links), P3-25 (Test alert channel) and P5-05 (a "What to do"
  // line under every health item): the real 15c, 15g, 15h, 15j, 15k, 15m, 15n, 15r and 15i run in ONE sandbox (fake
  // history, storage and timers, a scripted apiJson keyed by path, a fake studioDeskGo standing in for 15p) with /me
  // answered like the server. Static checks cover the one guarded hook in 15c, the styles and both built copies.
  const vm = require('vm');
  const coreSrc = read('src/systems/ads_studio/15g-studio-core.js');
  const shellSrc = read('src/systems/ads_studio/15h-studio-shell.js');
  const homeSrc = read('src/systems/ads_studio/15j-studio-home.js');
  const adsSrc = read('src/systems/ads_studio/15k-studio-ads.js');
  const walletSrc = read('src/systems/ads_studio/15m-studio-wallet.js');
  const helpSrc = read('src/systems/ads_studio/15n-studio-help.js');
  const extrasSrc = read('src/systems/ads_studio/15r-studio-extras.js');
  const healthSrc = read('src/systems/ads_studio/15i-studio-health.js');
  const adminSrc = read('src/systems/ads_studio/15q-studio-admin.js');
  const deskSrc = read('src/systems/ads_studio/15p-studio-desk.js');
  const workspaceCss = read('assets/ads-workspace.css');
  const who = { staff: false, admin: false };
  const memoryStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const win = {
    location: { pathname: '/studio', search: '', href: 'http://localhost/studio' },
    listeners: { popstate: [] },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const list = this.listeners[type] || []; const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage()
  };
  const hist = {
    entries: [{ url: '/studio', state: null }], index: 0,
    get length() { return this.entries.length; },
    get state() { return this.entries[this.index] ? this.entries[this.index].state : null; },
    show() { const url = new URL(this.entries[this.index].url, 'http://localhost'); win.location.pathname = url.pathname; win.location.search = url.search; win.location.href = url.href; },
    reset(url) { this.entries = [{ url, state: null }]; this.index = 0; this.show(); },
    pushState(entryState, _title, url) { this.entries.splice(this.index + 1); this.entries.push({ url: String(url), state: JSON.parse(JSON.stringify(entryState)) }); this.index++; this.show(); },
    replaceState(entryState, _title, url) { this.entries[this.index] = { url: String(url || this.entries[this.index].url), state: JSON.parse(JSON.stringify(entryState)) }; this.show(); },
    go(delta) { const next = this.index + delta; if (!delta || next < 0 || next >= this.entries.length) return; this.index = next; this.show(); for (const fn of [...win.listeners.popstate]) fn({ state: this.state }); },
    back() { this.go(-1); }
  };
  win.history = hist;
  let secureSeq = 0;
  const urlCalls = [];
  const box = vm.createContext({
    state: { language: 'en', theme: 'light', currentUser: { id: 'u1', name: 'Sara', email: 'sara@albayan.example' }, currentView: 'ads-studio', adCampaignRequests: [], walletTransactions: [] },
    Security: {
      escapeHtml: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      isValidRecordId: value => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(value ?? '').trim()),
      generateSecureId: prefix => `${prefix}_${Date.now()}_${String(++secureSeq).padStart(12, '0')}`,
      sanitizeObject: value => JSON.parse(JSON.stringify(value)),
      sanitizeInput: (value, options) => String(value ?? '').slice(0, (options && options.maxLength) || 10000)
    },
    window: win, history: hist, URLSearchParams, URL,
    isServerModeEnabled: () => true,
    isCurrentUserAdmin: () => who.admin,
    currentUserHasPermission: (collection, action) => (who.staff ? true : action !== 'review' && action !== 'view'),
    hasSubscription: id => id === 'ad_maker',
    canActOnRecord: () => true,
    getVisibleRecords: list => (Array.isArray(list) ? list.filter(item => item && !item._deleted) : []),
    getEntityPhotoCountHint: () => 0,
    getAuthMeIdentity: () => 'session',
    updateUrlParams: (params, replace) => { urlCalls.push({ params: JSON.parse(JSON.stringify(params)), replace: !!replace }); },
    requestViewScrollReset: () => {}, IS_STUDIO_SHELL: true,
    TIME_CONSTANTS: { API_TIMEOUT_LONG_MS: 1000 }
  }, { microtaskMode: 'afterEvaluate' });
  let loadError = '';
  try {
    const at = forms.indexOf('function normalizeDigitsAscii(');
    vm.runInContext(forms.slice(at, forms.indexOf('\n}\n', at) + 2), box);
    vm.runInContext(`
      var __calls = [];
      var __replies = Object.create(null);
      var __timers = new Map();
      var __timerSeq = 0;
      var __html = '';
      var __notes = [];
      var __dom = new Map();
      var __desk = [];
      var __scrolled = [];
      var _lastRenderedView = null;
      var performance = { now: () => 100, getEntriesByType: () => [{ type: 'navigate', name: '' }] };
      var document = { visibilityState: 'visible', title: 'Albayan Studio', addEventListener() {}, removeEventListener() {}, getElementById(id) { return __dom.get(id) || null; }, querySelectorAll: () => [] };
      var console = { warn() {}, log() {}, error() {} };
      function setTimeout(fn, ms) { const id = ++__timerSeq; __timers.set(id, { fn, ms: Number(ms) || 0 }); return id; }
      function clearTimeout(id) { __timers.delete(id); }
      function __runTimers() { for (let round = 0; round < 5 && __timers.size; round++) { const due = Array.from(__timers.entries()); __timers.clear(); due.forEach(([, t]) => t.fn()); } }
      function getUrlParams() { return { tab: new URLSearchParams(window.location.search).get('tab') }; }
      function getNavigationSignal() { return { aborted: false }; }
      function apiJson(path, options) {
        __calls.push({ path: String(path), method: String((options && options.method) || 'GET'), body: options && options.body ? JSON.parse(JSON.stringify(options.body)) : null });
        const next = (__replies[path] || []).shift();
        if (!next) return new Promise(() => {});
        if (next.error) return Promise.reject(Object.assign(new Error(next.error.message || 'Request failed'), next.error));
        return Promise.resolve(JSON.parse(JSON.stringify(next.value)));
      }
      function showNotification(title, message, type) { __notes.push({ title, message, type }); }
      function getServerSessionIdentity() { return 'session'; }
      function serverSessionIdentityChanged() { return false; }
      function makeSessionChangedError() { return new Error('session changed'); }
      function requestValidatedServerEntity(collection, context, loader) { return loader(); }
      function withRetry(fn) { return fn(); }
      function markCollectionDirty() {}
      function saveState() {}
      function studioBuilderStart() { return true; }
      function hubPlanForService() { return null; }
      function refreshSubscriptionPlans() { return Promise.resolve([]); }
      // 15p is not loaded here: the desk's navigation is recorded instead of run.
      function studioDeskGo(section, id) { __desk.push([String(section), String(id || '')]); return true; }
      window.addEventListener('popstate', () => { restoreAdsStudioTabFromUrl(); render(); });
    `, box);
    vm.runInContext(adsStudio, box);
    vm.runInContext(coreSrc, box);
    vm.runInContext(shellSrc, box);
    vm.runInContext(homeSrc, box);
    vm.runInContext(adsSrc, box);
    vm.runInContext(walletSrc, box);
    vm.runInContext(helpSrc, box);
    vm.runInContext(extrasSrc, box);
    vm.runInContext(healthSrc, box);
    vm.runInContext("function render() { const html = renderStudioV2View(); __html = html || '<classic>' + renderAdsStudioHeader(); }", box);
  } catch (error) { loadError = String(error && error.message || error); }
  const run = code => { try { return vm.runInContext(code, box); } catch (error) { return `THREW ${error && error.message}`; } };
  const json = code => { try { return JSON.parse(String(run(`JSON.stringify(${code})`))); } catch (_) { return undefined; } };
  const html = () => String(run('__html'));
  const failed = cases => cases.map((ok, i) => ok ? '' : i).filter(String).join(',');
  const reply = (path, value) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ value: ${JSON.stringify(value)} });`);
  const replyError = (path, error) => run(`(__replies[${JSON.stringify(path)}] = __replies[${JSON.stringify(path)}] || []).push({ error: ${JSON.stringify(error)} });`);
  const calls = (method, path) => (json('__calls') || []).filter(c => c.method === method && (!path || c.path === path));
  const inLanguage = (language, code) => { box.state.language = language; const out = run(code); box.state.language = 'en'; return out; };
  const meReply = value => run(`studioResetMe(); __replies['/api/studio/me'] = [{ value: ${JSON.stringify(value)} }]; studioLoadMe();`);
  const openAt = url => { hist.reset(url); run('_studioV2.docRendered = false; _studioV2.layout = null; render();'); };
  const classicKey = 'albayan.studio.v2.classic';
  const customerMe = { ui: 'v2', staffDesk: 'classic', isStaff: false, isAdmin: false, services: { help: true, stopRequest: true, tiktok: false }, capabilities: {}, intake: { open: true }, serviceHours: {}, contact: {}, metaConnection: {} };
  const staffMe = { ...customerMe, ui: 'classic', staffDesk: 'v2', isStaff: true, isAdmin: true };

  // ---- P6-06: the Classic view link and the way back
  meReply(customerMe);
  openAt('/studio?tab=wallet');
  const v2Page = html();
  const v2PageAr = String(inLanguage('ar', 'render(); __html'));
  run('__calls.length = 0;');
  const chose = run('studioV2ChooseClassic(true)');
  const classicPage = html();
  const classicState = { key: win.sessionStorage.getItem(classicKey), tab: run('_adsStudioActiveTab'), frame: run('studioV2Frame()'), said: run('studioV2FrameOf(studioV2Layout())'), shown: run('_studioV2.shown'), chosen: run('studioV2ClassicChosen()') };
  const classicSwitchAr = String(inLanguage('ar', 'renderStudioV2ClassicSwitch()'));
  const writesWhileSwitching = calls().filter(c => c.method !== 'GET').length;
  meReply(customerMe);  // the 5-minute /me re-read: the choice holds
  const afterMe = html();
  openAt('/studio?tab=campaigns');  // a reload of this tab: sessionStorage keeps the choice, no "Opening the studio…"
  const afterReload = { page: html(), shown: run('_studioV2.shown') };
  run('studioV2ChooseClassic(false)');
  const backPage = html();
  const backState = { key: win.sessionStorage.getItem(classicKey), frame: run('studioV2Frame()'), switchGone: run('renderStudioV2ClassicSwitch()') };
  // staff: the same link in the Team desk header
  who.staff = true; who.admin = true;
  meReply(staffMe);
  openAt('/studio?tab=review&section=health');
  const staffPage = html();
  run('studioV2ChooseClassic(true)');
  const staffClassic = { page: html(), tab: run('_adsStudioActiveTab'), switchOn: String(run('renderStudioV2ClassicSwitch()')) };
  run('studioV2ChooseClassic(false)');
  const staffBack = html();
  who.staff = false; who.admin = false;
  // /me says classic: the stored choice means nothing and there is no "New studio" to offer
  win.sessionStorage.setItem(classicKey, 'u1');
  meReply({ ...customerMe, ui: 'classic' });
  openAt('/studio');
  const classicMeSwitch = String(run('renderStudioV2ClassicSwitch()'));
  const classicMePage = html();
  // another user in the same tab: the choice was the first user's
  box.state.currentUser = { id: 'u2', name: 'Omar' };
  meReply(customerMe);
  openAt('/studio');
  const otherUser = { page: html(), chosen: run('studioV2ClassicChosen()') };
  box.state.currentUser = { id: 'u1', name: 'Sara', email: 'sara@albayan.example' };
  win.sessionStorage.removeItem(classicKey);
  // no storage at all (a private window): the choice lives in this page's memory, nothing throws
  const realStorage = win.sessionStorage;
  win.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  meReply(customerMe);
  openAt('/studio?tab=home');
  const noStorageChoose = run('studioV2ChooseClassic(true)');
  const noStoragePage = html();
  const noStorageBack = run('studioV2ChooseClassic(false)');
  const noStorageBackPage = html();
  win.sessionStorage = realStorage;
  const hookAt = adsStudio.indexOf("${typeof renderStudioV2ClassicSwitch === 'function' ? renderStudioV2ClassicSwitch() : ''}");
  const chooseFn = shellSrc.slice(shellSrc.indexOf('function studioV2ChooseClassic('), shellSrc.indexOf('\n}\n', shellSrc.indexOf('function studioV2ChooseClassic(')));
  const classicCases = [
    !loadError,
    v2Page.includes('data-testid="studio-v2-frame"') && v2Page.includes('<button type="button" data-testid="studio-classic-view" class="studio-v2-header-link" onclick="studioV2ChooseClassic(true)">Classic view</button>')
      && v2PageAr.includes('data-testid="studio-classic-view"') && v2PageAr.includes('>العرض القديم<'),
    chose === true && classicPage.startsWith('<classic>') && !classicPage.includes('studio-v2-frame') && classicState.key === 'u1' && classicState.chosen === true
      && classicState.frame === '' && classicState.said === 'customer' && classicState.shown === 'classic' && classicState.tab === 'dashboard',  // wallet is not a classic tab
    classicPage.includes('data-testid="studio-new-studio"') && classicPage.includes('onclick="studioV2ChooseClassic(false)"') && classicPage.includes('>New studio<')
      && classicSwitchAr.includes('>الاستوديو الجديد<') && writesWhileSwitching === 0,
    afterMe.startsWith('<classic>') && afterReload.page.startsWith('<classic>') && afterReload.shown === 'classic',
    backPage.includes('data-testid="studio-v2-frame"') && backPage.includes('data-testid="studio-screen-campaigns"') && backState.key === null && backState.frame === 'customer' && backState.switchGone === '',
    staffPage.includes('data-testid="studio-staff-frame"') && staffPage.includes('data-testid="studio-classic-view"') && staffClassic.page.startsWith('<classic>') && staffClassic.tab === 'review'
      && staffClassic.switchOn.includes('data-testid="studio-new-studio"') && staffBack.includes('data-testid="studio-staff-frame"'),
    classicMeSwitch === '' && classicMePage.startsWith('<classic>') && !classicMePage.includes('studio-new-studio'),
    otherUser.chosen === false && otherUser.page.includes('data-testid="studio-v2-frame"'),
    noStorageChoose === true && noStoragePage.startsWith('<classic>') && noStorageBack === false && noStorageBackPage.includes('data-testid="studio-v2-frame"'),
    hookAt > 0 && hookAt < adsStudio.indexOf('onclick="toggleLanguage()"') && hookAt > adsStudio.indexOf('function renderAdsStudioHeader()'),
    shellSrc.includes("const STUDIO_V2_CLASSIC_KEY = 'albayan.studio.v2.classic';") && chooseFn.includes('try {') && chooseFn.includes('window.sessionStorage.setItem(STUDIO_V2_CLASSIC_KEY, uid)')
      && !/apiJson|fetch\(|studioApi/.test(chooseFn) && shellSrc.includes('if (studioV2ClassicChosen()) return \'\';'),
    workspaceCss.includes('.studio-v2-header-link {') && /\.studio-v2-header-link \{[^}]*min-height: 44px/.test(workspaceCss) && workspaceCss.includes('.studio-v2-heading-meta {'),
    ['studio.js', 'www/studio.js'].every(file => { const built = read(file); return built.includes('data-testid="studio-classic-view"') && built.includes('function renderStudioV2ClassicSwitch()'); })
  ];
  check('Classic view (P6-06): a "Classic view / العرض القديم" link in the v2 header of both frames keeps this tab classic (sessionStorage, memory when storage is blocked; the wallet address lands on the Overview) until "New studio / الاستوديو الجديد" in the classic header, drawn only while /me says v2; a /me re-read and a reload keep the choice, another user does not inherit it, nothing is written to the server',
    !loadError && classicCases.every(Boolean), loadError || `cases ${failed(classicCases)} state ${JSON.stringify(classicState)} back ${JSON.stringify(backState)}`);

  // ---- P5-07: the customer terms from Account, Help (v2 and classic) and the login help line
  meReply(customerMe);
  openAt('/studio?tab=account');
  const accountEn = html();
  const accountAr = String(inLanguage('ar', 'renderStudioAccountScreen()'));
  const helpContact = String(run('renderStudioHelpContact()'));
  const helpContactAr = String(inLanguage('ar', 'renderStudioHelpContact()'));
  const helpClassic = String(run("_studioHelp.classic = { view: 'list', id: '', filter: 'active' }; renderStudioHelpClassic()"));
  run("window.localStorage.removeItem('albayan.studio.public.contact'); _studioPublicContact.value = null; _studioPublicContact.at = 0; _studioPublicContact.failedAt = 0; __dom.set('studio-login-help', { innerHTML: '' });");
  const loginHelp = String(run('renderStudioLoginHelp()'));
  const loginHelpAr = String(inLanguage('ar', 'renderStudioLoginHelp()'));
  const termsLink = 'href="/privacy#terms"';
  const termsCases = [
    accountEn.includes('data-testid="studio-screen-account"') && accountEn.includes(`<a class="studio-v2-row" data-testid="studio-account-terms" ${termsLink} target="_blank" rel="noopener">`)
      && accountEn.includes('>Customer terms<') && accountAr.includes('data-testid="studio-account-terms"') && accountAr.includes('>شروط العملاء<')
      && accountEn.indexOf('studio-account-terms') > accountEn.indexOf('studio-account-privacy') && accountEn.indexOf('studio-account-terms') < accountEn.indexOf('studio-account-logout'),
    helpContact.includes('data-testid="studio-help-terms"') && helpContact.includes(`<a ${termsLink} target="_blank" rel="noopener noreferrer" data-testid="studio-help-terms-link">customer terms</a>`)
      && helpContactAr.includes('>شروط العملاء</a>') && helpContactAr.includes('قواعد الخدمة في'),
    helpClassic.includes('class="studio-help studio-help-classic"') && helpClassic.includes('data-testid="studio-help-terms-link"'),
    loginHelp.includes('data-testid="studio-login-help"') && loginHelp.includes(`<a ${termsLink} data-testid="studio-login-terms" class="font-bold text-indigo-600 dark:text-indigo-300 hover:underline" target="_blank" rel="noopener noreferrer">Customer terms</a>`)
      && loginHelpAr.includes('data-testid="studio-login-terms"') && loginHelpAr.includes('>شروط العملاء</a>'),
    read('privacy.html').includes('<h2 id="terms">'),
    // the login help line is drawn by 15r (lazy studio.js), so the link costs no startup bytes: the budget holds and 12-views only keeps its hook
    fs.statSync(path.join(ROOT, 'script.js')).size <= 2516582 && !views.includes('/privacy#terms') && views.includes(`<div id="studio-login-help">\${typeof renderStudioLoginHelp === 'function' ? renderStudioLoginHelp() : ''}</div>`),
    ['studio.js', 'www/studio.js'].every(file => { const built = read(file); return built.includes('data-testid="studio-account-terms"') && built.includes('data-testid="studio-login-terms"') && built.includes('data-testid="studio-help-terms-link"'); })
  ];
  check('Customer terms (P5-07): /privacy#terms is linked from the v2 Account screen (between Privacy and Sign out), from the Help contact card in the v2 screen and the classic help tab, and from the login help line (drawn by 15r: no startup bytes), in English and Arabic; the privacy page carries the anchor',
    !loadError && termsCases.every(Boolean), loadError || `cases ${failed(termsCases)}`);

  // ---- P3-25: Test alert channel
  who.staff = true; who.admin = true;
  meReply(staffMe);
  openAt('/studio?tab=review&section=health');
  const alertPath = '/api/studio/admin/alert-channel/test';
  reply('/api/studio/admin/facts', { windowDays: 30, facts: {} });
  reply('/api/meta-ads/token-health', { configured: true, checked: true, isValid: true, daysLeft: 41, missingScopes: [], webhookCounts: { countsByObjectField: { 'page.feed': 12 } } });
  reply('/api/social-studio/pages', { pages: [{ id: 'spg_fb', name: 'Shop', platform: 'fb' }] });
  reply('/api/studio/admin/diagnostics', { jobs: { enabled: true, runningHere: true, late: true, ageSeconds: 900, lastTickAt: new Date(Date.now() - 900000).toISOString(), lastError: { job: 'sweep', error: 'boom <x>', at: new Date().toISOString() } },
    metaLanes: { appWide: { paused: true, retryAfterSeconds: 300, reason: 'usage_high' }, lanes: { admin: { paused: true, retryAfterSeconds: 300, reason: 'usage_high', usagePercent: 91, parkCount: 0, parks: [] }, studio_results: { paused: false, retryAfterSeconds: 0, reason: '', usagePercent: 40, parkCount: 2, parks: [] }, page: { paused: false, retryAfterSeconds: 0, reason: '', usagePercent: 10, parkCount: 0, parks: [] } } } });  // one ad account parked on an unpaused lane (runbook 3.4)
  run("__calls.length = 0; resetStudioHealthState(); renderStudioHealthSection();");  // the first draw asks for everything
  const diagReadsFirst = calls('GET', '/api/studio/admin/diagnostics').length;
  const healthEn = String(run('renderStudioHealthSection()'));
  const healthAr = String(inLanguage('ar', 'renderStudioHealthSection()'));
  const alertNote = () => json("_studioHealth.results['alert']") || {};
  run('__calls.length = 0;');
  reply(alertPath, { sent: true, configured: true });
  const alertInFlight = run('studioHealthTestAlertChannel(); studioHealthTestAlertChannel(); __calls.length');
  const alertCalls = calls('POST', alertPath);
  const alertSent = alertNote();
  const alertSentHtml = String(run('renderStudioHealthSection()'));
  reply(alertPath, { sent: false, configured: false });
  run('studioHealthTestAlertChannel()');
  const alertUnset = alertNote();
  reply(alertPath, { sent: false, configured: false });
  inLanguage('ar', 'studioHealthTestAlertChannel()');
  const alertUnsetAr = alertNote();
  reply(alertPath, { sent: false, configured: true });
  run('studioHealthTestAlertChannel()');
  const alertRefused = alertNote();
  replyError(alertPath, { status: 429, retryAfter: 540, message: JSON.stringify({ code: 'RATE_LIMITED', message: 'One test alert every 10 minutes. Please wait and try again.' }) });
  run('studioHealthTestAlertChannel()');
  const alertWait = alertNote();
  replyError(alertPath, { status: 429, retryAfter: 540, message: 'x' });
  inLanguage('ar', 'studioHealthTestAlertChannel()');
  const alertWaitAr = alertNote();
  replyError(alertPath, { status: 403, message: 'x', payload: { detail: { code: 'ADMIN_ONLY', message: 'Only an admin can use this' } } });
  run('studioHealthTestAlertChannel()');
  const alertAdminOnly = alertNote();
  who.admin = false;
  run('__calls.length = 0; studioHealthTestAlertChannel();');
  const reviewerPresses = calls('POST', alertPath).length;
  who.admin = true;
  const alertOutPy = read('server/systems/ads_studio/studio_alert_out.py');
  const alertCases = [
    healthEn.includes('data-testid="studio-health-alert-channel"') && healthEn.includes('<button type="button" data-testid="studio-health-alert-test" onclick="studioHealthTestAlertChannel()"') && healthEn.includes('Test alert channel</button>')
      && healthEn.includes('ALBAYAN_ALERT_WEBHOOK_URL') && healthAr.includes('اختبار قناة التنبيهات</button>') && healthAr.includes('ضغطة واحدة كل 10 دقائق'),
    alertInFlight === 1 && alertCalls.length === 1 && JSON.stringify(alertCalls[0].body) === '{}',
    alertSent.tone === 'emerald' && String(alertSent.text).startsWith('The test alert was sent.') && alertSentHtml.includes('data-testid="studio-health-alert-result" data-tone="emerald"'),
    alertUnset.tone === 'amber' && String(alertUnset.text).includes('ALBAYAN_ALERT_WEBHOOK_URL') && String(alertUnset.text).includes('nothing was sent') && alertUnsetAr.text === 'قناة تنبيهات الفريق غير مُعدّة (ALBAYAN_ALERT_WEBHOOK_URL)، لذلك لم يُرسل شيء. تبقى التنبيهات في قائمة التنبيهات فقط.',
    alertRefused.tone === 'rose' && String(alertRefused.text).includes('did not accept the test alert') && String(alertRefused.text).includes('runbook 0.5'),
    alertWait.tone === 'amber' && alertWait.text === 'One test alert every 10 minutes for the whole team. Try again in about 9 min.' && alertWaitAr.text === 'تنبيه تجريبي واحد كل 10 دقائق للفريق كله. أعد المحاولة بعد نحو 9 دقيقة.',
    alertAdminOnly.text === 'Only an admin can use this.' && reviewerPresses === 0,
    healthSrc.includes("studioHealthApi('/api/studio/admin/alert-channel/test', { method: 'POST', body: {} }") && !/\b(?:confirm|prompt|alert)\(/.test(healthSrc)
      && alertOutPy.includes('@router.post("/admin/alert-channel/test")') && alertOutPy.includes('TEST_EVERY_MS = 10 * 60 * 1000') && alertOutPy.includes('return {"sent": sent, "configured": configured}'),
    ['studio-staff.js', 'www/studio-staff.js'].every(file => read(file).includes('data-testid="studio-health-alert-test"'))
  ];
  check('Test alert channel (P3-25): an admin button in the Studio health screen POSTs the existing route once (single flight) and says {sent, configured} in words (sent; not set up: ALBAYAN_ALERT_WEBHOOK_URL; set up but refused), a 429 shows the wait in minutes, ADMIN_ONLY in words, a reviewer never presses; EN and AR',
    !loadError && alertCases.every(Boolean), loadError || `cases ${failed(alertCases)} sent ${JSON.stringify(alertSent)} wait ${JSON.stringify(alertWait)}`);

  // ---- P5-05: a "What to do" line under every item, linked into the desk (a pointer in words in classic)
  const fixIds = ['token', 'webhooks', 'heartbeat', 'lanes', 'private-replies', 'public-replies', 'daily-requests', 'allowlist', 'min-budget', 'pages', 'funds', 'spend-drift'];
  const fixLine = (page, id) => (page.match(new RegExp(`<p[^>]*data-testid="studio-health-fix-${id}"[^>]*>[\\s\\S]*?</p>`)) || [''])[0];
  const linkedEn = fixIds.map(id => fixLine(healthEn, id));
  const linkedAr = fixIds.map(id => fixLine(healthAr, id));
  // The Arabic line is Arabic apart from the names it must keep (env variables, Jelastic, Meta's own screens, "off").
  const arabicLine = line => { const text = line.replace(/<[^>]+>/g, '').replace(/ALBAYAN_[A-Z_]+|Jelastic|Meta Business Manager|Billing|Libyan Spider|\boff\b/g, ''); return /[؀-ۿ]/.test(text) && !/[A-Za-z]{3}/.test(text); };
  const fixTargets = json('STUDIO_HEALTH_FIXES') || {};
  run('__desk.length = 0;');
  const goDiag = run("studioHealthGoFix('diagnostics')");
  const goAlerts = run("studioHealthGoFix('alerts')");
  const goIntake = run("studioHealthGoFix('intake')");
  const goRequests = run("studioHealthGoFix('requests')");
  const deskMoves = json('__desk');
  run("__dom.set('studio-health-pages', { scrollIntoView(options) { __scrolled.push(options); } });");
  const goPages = run("studioHealthGoFix('pages')");
  const goUnknown = run("studioHealthGoFix('nope')");
  const scrolled = json('__scrolled');
  const healthReplies = () => { reply('/api/studio/admin/facts', { windowDays: 30, facts: {} }); reply('/api/meta-ads/token-health', { configured: true, checked: true, isValid: true, daysLeft: 41, missingScopes: [] }); reply('/api/social-studio/pages', { pages: [] }); };
  healthReplies();
  run('__calls.length = 0; _studioHealth.loadedAt = 0; renderStudioHealthSection();');  // the 60 s reload: no diagnostics read within 10 min
  const diagReadsReload = calls('GET', '/api/studio/admin/diagnostics').length;
  healthReplies();
  reply('/api/studio/admin/diagnostics', { jobs: { enabled: true, late: false, ageSeconds: 20, lastTickAt: new Date().toISOString() }, metaLanes: { appWide: { paused: false }, lanes: {} } });
  run('__calls.length = 0; _studioHealth.loadedAt = 0; _studioHealth.diagAt = Date.now() - 11 * 60000; renderStudioHealthSection();');
  const diagReadsLater = calls('GET', '/api/studio/admin/diagnostics').length;
  const healthFine = String(run('renderStudioHealthSection()'));
  // classic (the desk off, or this tab on the classic view): the same lines point in words; the pages scroll keeps its button
  run('studioV2ChooseClassic(true)');
  const healthClassic = String(run('renderStudioHealthSection()'));
  run('studioV2ChooseClassic(false)');
  const classicLines = fixIds.map(id => fixLine(healthClassic, id));
  const adminPageIds = [...adminSrc.matchAll(/^\s+\['([a-z-]+)', '[a-z-]+', '/gm)].map(m => m[1]);
  const deskSections = (deskSrc.match(/const STUDIO_DESK_SECTIONS = Object\.freeze\(\[([^\]]*)\]\)/) || ['', ''])[1];
  const fixCases = [
    linkedEn.every(line => line && line.includes('data-linked="1"') && line.includes('<strong>What to do (runbook ') && /data-testid="studio-health-fix-link-[a-z-]+" onclick="studioHealthGoFix\('[a-z]+'\)"/.test(line)),
    linkedAr.every(line => line && line.includes('<strong>ماذا تفعل (دليل التشغيل ') && arabicLine(line)),
    fixLine(healthEn, 'token').includes("studioHealthGoFix('diagnostics')") && fixLine(healthEn, 'webhooks').includes("studioHealthGoFix('pages')") && fixLine(healthEn, 'heartbeat').includes("studioHealthGoFix('diagnostics')")
      && fixLine(healthEn, 'lanes').includes("studioHealthGoFix('intake')") && fixLine(healthEn, 'funds').includes("studioHealthGoFix('alerts')") && fixLine(healthEn, 'pages').includes("studioHealthGoFix('pages')")
      && fixLine(healthEn, 'private-replies').includes("studioHealthGoFix('capabilities')") && fixLine(healthEn, 'min-budget').includes("studioHealthGoFix('limits')") && fixLine(healthEn, 'spend-drift').includes("studioHealthGoFix('settlement')")
      && fixLine(healthEn, 'daily-requests').includes("studioHealthGoFix('requests')") && fixLine(healthEn, 'allowlist').includes("studioHealthGoFix('diagnostics')"),
    fixLine(healthEn, 'token').includes('runbook 3.1 / 3.2') && fixLine(healthEn, 'heartbeat').includes('runbook 3.6') && fixLine(healthEn, 'lanes').includes('runbook 3.4') && fixLine(healthEn, 'funds').includes('runbook 3.9') && fixLine(healthEn, 'pages').includes('runbook 3.10')
      && healthEn.includes('data-testid="studio-health-fix-page-tests"') && healthEn.includes('<h3 id="studio-health-pages"'),
    healthEn.includes('data-testid="studio-health-heartbeat" data-late="1"') && healthEn.includes('>LATE<') && healthEn.includes('sweep: boom &lt;x&gt;') && healthAr.includes('>متأخر<')
      && healthEn.includes('data-testid="studio-health-lanes" data-paused="1"') && healthEn.includes('paused 5 min (usage_high)') && healthEn.includes('usage 40% · 2 parked') && healthEn.includes('usage 10%<') && healthAr.includes('متوقفة 5 دقيقة (usage_high)') && healthAr.includes('الاستخدام 40% · 2 موقوفة'),
    goDiag === true && goAlerts === true && goIntake === true && goRequests === true && JSON.stringify(deskMoves) === JSON.stringify([['more', 'diagnostics'], ['more', 'alerts'], ['more', 'settings-intake'], ['requests', '']])
      && goPages === true && goUnknown === false && Array.isArray(scrolled) && scrolled.length === 1 && scrolled[0].block === 'start',
    diagReadsFirst === 1 && diagReadsReload === 0 && diagReadsLater === 1 && healthSrc.includes('const STUDIO_HEALTH_DIAG_MAX_AGE_MS = 10 * 60000;')
      && healthFine.includes('data-testid="studio-health-heartbeat" data-late="0"') && healthFine.includes('>fine<') && healthFine.includes('data-testid="studio-health-lanes" data-paused="0"') && healthFine.includes('>running<'),
    classicLines.every((line, i) => line && (fixIds[i] === 'webhooks' || fixIds[i] === 'pages' ? line.includes('data-linked="1"') && line.includes("studioHealthGoFix('pages')") : line.includes('data-linked="0"') && !line.includes('studioHealthGoFix') && line.includes('Team desk → More → ')))
      && !healthClassic.includes('studio-health-fix-link-token'),
    Object.entries(fixTargets).every(([key, [section, id]]) => key === 'pages' ? section === '' && id === 'studio-health-pages' : (section === 'more' ? adminPageIds.includes(id) : id === '' && deskSections.includes(`'${section}'`))),
    // the runbook is not served (the API docs exist only in debug mode), which is why the lines link the desk and name the runbook page
    read('server/main.py').includes('docs_url="/docs" if DEBUG_MODE else None') && !/StaticFiles\([^)]*docs/.test(read('server/main.py')),
    ['studio-staff.js', 'www/studio-staff.js'].every(file => { const built = read(file); return built.includes('function studioHealthFix(id, key, runbook, en, ar)') && fixIds.every(id => built.includes(`studioHealthFix('${id}', '`)); })
  ];
  check('Health "What to do" (P5-05): every item (token, webhook counters, jobs heartbeat, Meta lanes, replies, daily requests, allowlist, minimum budget, page subscription, funds, spend drift, page tests) names its runbook page and links the desk section or settings form that fixes it (a real id of More, or the Requests queue; the pages link scrolls); the heartbeat and lanes come from /diagnostics at most every 10 min; in classic the lines point in words; EN and AR',
    !loadError && fixCases.every(Boolean), loadError || `cases ${failed(fixCases)} moves ${JSON.stringify(deskMoves)} diag ${diagReadsFirst}/${diagReadsReload}/${diagReadsLater} missing ${fixIds.filter((id, i) => !linkedEn[i]).join(',')}`);
  who.staff = false; who.admin = false;
}

{
  // P0-12: the public privacy page must state the server's real audit retention (main.py default).
  const mainPy = read('server/main.py');
  const privacy = read('privacy.html');
  const days = (mainPy.match(/AUDIT_LOG_RETENTION_DAYS = read_env_int\("ALBAYAN_AUDIT_LOG_RETENTION_DAYS", (\d+)\)/) || [])[1];
  check('privacy retention matches server default', Boolean(days) && privacy.includes(`${days} days`) && privacy.includes(`${days} يوماً`)
    && !privacy.includes('90 days') && privacy.includes('kept permanently'), `server default ${days}`);
  // The kept-forever list on the page (English and Arabic) names exactly the server's _AUDIT_KEEP_ACTIONS: every kept
  // action has its wording inside the list, and nothing else is left in the list once those are taken out.
  const kept = ((mainPy.match(/_AUDIT_KEEP_ACTIONS = "\(([^)]*)\)"/) || [])[1] || '').split(',').map(a => a.trim().replace(/'/g, '')).filter(Boolean);
  const keptWording = {
    close: ['closing or unlocking a month', 'إقفال شهر أو إعادة فتحه'], unlock: ['closing or unlocking a month', 'إقفال شهر أو إعادة فتحه'],
    cleanup: ['the audit-log cleanup records themselves', 'سجلات تنظيف سجل التدقيق نفسه'], import: ['backup imports', 'استيراد النسخ الاحتياطية'],
    restore: ['restores of deleted records', 'استعادة السجلات المحذوفة'], company_coverage: ['company-funded debt coverage', 'تغطية الديون من أموال الشركة'],
    wallet_release: ['returned wallet captures', 'إرجاع المبالغ المخصومة من المحفظة'],
    review: ['advertisement-request review decisions', 'قرارات مراجعة طلبات الإعلانات'],
    studio_setting: ['changes to Ads Studio settings', 'تغيير إعدادات استوديو الإعلانات'],
    collision_repair: ['owner-approved moves of Ads Studio advertisements out of the agency records', 'نقل إعلانات الاستوديو من سجلات الوكالة بموافقة المالك'],
    stop: ['stopping advertisements', 'إيقاف الإعلانات'], withdraw: ['withdrawn ad requests', 'سحب طلبات الإعلانات'],
    publish_status: ['advertisement publishing status changes', 'تغييرات حالة نشر الإعلانات'],
    stop_request: ['customer requests to stop an advertisement', 'طلبات العملاء لإيقاف إعلان'],
    settle_override: ['manual settlement decisions', 'قرارات التسوية اليدوية'],
    contact_link: ['opened customer contact links', 'فتح روابط التواصل مع العملاء'],
    subscribe_smoke_test: ['page connection tests', 'اختبارات ربط الصفحات'], ig_read_test: ['page connection tests', 'اختبارات ربط الصفحات'],
    check_comments: ['manual comment checks', 'الفحص اليدوي للتعليقات'],
  };
  const keptLists = [(privacy.match(/settings actions \(([^)]*)\) are kept permanently/) || [])[1], (privacy.match(/وعمليات الإعدادات \(([^)]*)\) فتُحفظ/) || [])[1]];
  const keptProblems = kept.filter(a => !keptWording[a]).map(a => `no wording for ${a}`);
  keptLists.forEach((list, lang) => {
    if (!list) { keptProblems.push(`kept list missing (${lang ? 'ar' : 'en'})`); return; }
    let rest = list;
    for (const phrase of new Set(kept.filter(a => keptWording[a]).map(a => keptWording[a][lang]))) {
      if (!rest.includes(phrase)) keptProblems.push(`not named: ${phrase}`);
      rest = rest.split(phrase).join('');
    }
    rest = rest.replace(/\band\b/g, '').replace(/[,،\sو]/g, '');
    if (rest) keptProblems.push(`claimed but not kept: ${rest}`);
  });
  check('privacy page names exactly the audit entries kept permanently', kept.length > 0 && !keptProblems.length
    && privacy.includes('including wallet top-ups, payment confirmations and receipt settlements, follow the retention setting')
    && privacy.includes('ومنها شحن المحفظة وتأكيد المدفوعات وتسوية الإيصالات، لمدة الاحتفاظ نفسها'), keptProblems.join('; '));
  check('privacy page covers Ads Studio comment processing', privacy.includes('Ads Studio') && privacy.includes('comment text'));
}

if (failures.length) {
  console.error(`\n${failures.length} mobile UI regression check(s) failed:`);
  failures.forEach(failure => console.error(`  - ${failure}`));
  process.exit(1);
}

console.log(`\n${passed} mobile UI regression checks passed.`);
