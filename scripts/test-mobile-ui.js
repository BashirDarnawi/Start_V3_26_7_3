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
    run(`_studioV2.docRendered = false; _studioV2.layout = null; _studioV2.fromApp = false; _studioV2.popping = false; _studioV2.repin = false;
      __navType = ${JSON.stringify(navType)}; __navName = ${JSON.stringify(opened ? `http://localhost${opened}` : '')}; render();`);
  };
  const chainOf = entry => (entry && entry.state && entry.state.studioV2 && entry.state.studioV2.chain) || null;
  const failed = cases => cases.map((ok, i) => ok ? '' : i).filter(String).join(',');

  check('Studio v2 files ship last in the lazy studio bundle (core before shell) and renderAdsStudioView delegates first',
    JSON.stringify(bundleManifestJson.lazy['studio.js'].slice(-2)) === JSON.stringify(['systems/ads_studio/15g-studio-core.js', 'systems/ads_studio/15h-studio-shell.js'])
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
      && !['Insufficient wallet balance', 'Only Submitted campaigns can be withdrawn', 'Conflict: record has changed'].some(prefix => coreSrc.includes(prefix) || shellSrc.includes(prefix))
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
    onclicks.length > 20 && onclicks.every(attr => /^onclick="(studioV2(Open|OpenSection)\('[a-z]+'\)|studioV2(Back|CloseBuilder)\(\)|studioV2BuilderStep\(1\)|toggleLanguage\(\)|toggleTheme\(\)|handleLogout\(\)|showSubscriptionModal\('ad_maker', 'ad_maker'\))"$/.test(attr)),
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
