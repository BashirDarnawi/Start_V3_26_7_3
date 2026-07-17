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
const mobileRuntime = read('src/01b-mobile-runtime.js');
const serverApi = read('src/09-api-auth.js');
const init = read('src/17-init.js');
const liveSync = read('src/10-live-sync.js');
const routing = read('src/11-routing-cloud.js');
const views = read('src/12-views.js');
const helpers = read('src/13-filters-helpers.js');
const forms = read('src/14-forms.js');
const modals = read('src/15-modals.js');
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
check('receipt status choices become a readable phone grid',
  modals.includes('grid grid-cols-2 sm:grid-cols-4') &&
  css.includes('.receipt-filter-controls'));
check('receipt debt-source filter is available in the responsive filter bar',
  views.includes("updateReceiptFilter('debt', this.value)") &&
  ['any-debt', 'delivery-debt', 'shop-debt', 'no-debt']
    .every(value => views.includes(`option value="${value}"`)) &&
  views.includes('receipt-filter-controls'));
check('receipt and delivery cards expose a tap-sized WhatsApp dispatch action',
  views.includes('showDeliveryWhatsAppPrompt(this.dataset.receiptId, this)') &&
  views.includes('data-receipt-id=') &&
  views.includes('Share delivery information to WhatsApp') &&
  views.includes('inline-flex min-h-11') &&
  (views.match(/canShareDeliveryReceiptToWhatsApp\(/g) || []).length >= 4);
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
  init.includes('if (authCheckUnavailable && isPackagedMobileApp() && mobileRuntimeNeedsServer())') &&
  init.includes('stopForPackagedMobileConnection();'));
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
