// ==========================================
// ALBAYAN ADS STUDIO
// Customer self-service campaign requests for Facebook and Instagram.
//
// Safety boundary:
// - This collection is NOT the internal `ads` accounting collection.
// - Customers create drafts and submit them for review.
// - Approval is server-controlled and never spends money or calls Meta.
// - A future Meta adapter must run on the backend with encrypted tokens.
// ==========================================

let _adsStudioActiveTab = 'dashboard';
let _adsStudioWizardStep = 1;
let _adsStudioEditingId = '';
let _adsStudioEditingBaseline = 0;
let _adsStudioDraft = null;
let _adsStudioSearch = '';
let _adsStudioPhotoToken = 0;
let _adsStudioConfirmationChecked = false;
let _adsStudioSavePromise = null;
let _adsStudioSaveAndSubmitPromise = null;
const _adsStudioSubmitPromises = new Map();
const _adsStudioReviewPromises = new Map();
const _adsStudioDeletePromises = new Map();
const _adsStudioStopPromises = new Map();
const _adsStudioReviewNotes = Object.create(null);
const _adsStudioReviewReasons = Object.create(null);  // campaign id -> the reason code picked in the review form (P1-12)
let _adsStudioApproveConfirmId = '';  // the request whose in-page "Confirm approval" row is open
const _adsStudioWithdrawPromises = new Map();
let _adsStudioWithdrawConfirmId = '';  // the customer's waiting request whose in-page "Withdraw" sheet is open
// Staff "Link Meta campaign" sheet (P1-09, D26): { campaignId, accountId, metaCampaignId, busy, outcome }.
let _adsStudioLinkSheet = null;
const _adsStudioLinkPromises = new Map();  // campaign id -> its link in flight (single flight per campaign)
// Staff "Unlink Meta campaign" sheet: { campaignId, reason, busy, outcome }; one unlink in flight per campaign.
let _adsStudioUnlinkSheet = null;
const _adsStudioUnlinkPromises = new Map();
const _adsStudioMetaAccounts = { forUser: '', state: '', list: [] };  // the allowlisted ad accounts (admin read)
const ADS_STUDIO_ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ADS_STUDIO_MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const ADS_STUDIO_MAX_SELECTED_SOURCE_BYTES = 40 * 1024 * 1024;
const ADS_STUDIO_MAX_TOTAL_CREATIVE_BYTES = 5 * 1024 * 1024;

function resetAdsStudioSessionState() {
  if (typeof resetSocialStudioState === 'function') resetSocialStudioState();
  if (typeof resetStudioHealthState === 'function') resetStudioHealthState();
  if (typeof studioResetMe === 'function') studioResetMe();  // Studio v2 /me (15g): the next session reads it afresh
  // Invalidate image compression still running for the previous draft/session.
  _adsStudioPhotoToken++;
  if (typeof window !== 'undefined' && window._adsStudioSearchTimer) {
    clearTimeout(window._adsStudioSearchTimer);
    window._adsStudioSearchTimer = null;
  }
  _adsStudioActiveTab = 'dashboard';
  _adsStudioWizardStep = 1;
  _adsStudioEditingId = '';
  _adsStudioEditingBaseline = 0;
  _adsStudioDraft = null;
  _adsStudioSearch = '';
  _adsStudioConfirmationChecked = false;
  _adsStudioSavePromise = null;
  _adsStudioSaveAndSubmitPromise = null;
  _adsStudioSubmitPromises.clear();
  _adsStudioReviewPromises.clear();
  _adsStudioDeletePromises.clear();
  _adsStudioStopPromises.clear();
  for (const id of Object.keys(_adsStudioReviewNotes)) delete _adsStudioReviewNotes[id];
  for (const id of Object.keys(_adsStudioReviewReasons)) delete _adsStudioReviewReasons[id];
  _adsStudioApproveConfirmId = '';
  _adsStudioWithdrawPromises.clear();
  _adsStudioWithdrawConfirmId = '';
  _adsStudioLinkSheet = null;
  _adsStudioLinkPromises.clear();
  _adsStudioUnlinkSheet = null;
  _adsStudioUnlinkPromises.clear();
  _adsStudioMetaAccounts.forUser = '';
  _adsStudioMetaAccounts.state = '';
  _adsStudioMetaAccounts.list = [];
  _adsStudioBudgetTyped = '';
  resetAdsStudioResults();
  if (typeof resetAdsStudioWalletCache === 'function') resetAdsStudioWalletCache();
  resetAdsStudioLimits();
  resetAdsStudioPostPicker();
}

// Wallet + Meta Connection live INSIDE the Overview (owner decision): no tabs.
const ADS_STUDIO_TABS = [
  { id: 'dashboard', icon: 'layout-dashboard', label: 'Overview', labelAr: 'نظرة عامة' },
  { id: 'campaigns', icon: 'megaphone', label: 'My Campaigns', labelAr: 'حملاتي' },
  { id: 'builder', icon: 'wand-sparkles', label: 'Create Campaign', labelAr: 'إنشاء حملة' },
  // Social Studio (15f-social-studio.js): scheduled posts + auto-reply rules.
  { id: 'posts', icon: 'send', label: 'Posts', labelAr: 'المنشورات' },
  { id: 'replies', icon: 'message-circle-reply', label: 'Replies', labelAr: 'الردود' }
];

const ADS_STUDIO_OBJECTIVES = [
  { id: 'messages', icon: 'message-circle', label: 'Messages', labelAr: 'الرسائل', desc: 'WhatsApp, Messenger or Instagram conversations', descAr: 'محادثات واتساب أو ماسنجر أو إنستغرام' },
  { id: 'leads', icon: 'contact', label: 'Leads', labelAr: 'عملاء محتملون', desc: 'Collect customer enquiries', descAr: 'جمع استفسارات العملاء' },
  { id: 'traffic', icon: 'mouse-pointer-click', label: 'Website Traffic', labelAr: 'زيارات الموقع', desc: 'Send people to a website or store', descAr: 'إرسال الأشخاص إلى موقع أو متجر' },
  { id: 'sales', icon: 'shopping-bag', label: 'Sales', labelAr: 'المبيعات', desc: 'Promote products or conversions', descAr: 'ترويج المنتجات أو عمليات الشراء' },
  { id: 'engagement', icon: 'heart', label: 'Engagement', labelAr: 'التفاعل', desc: 'Grow reactions, follows and video views', descAr: 'زيادة التفاعل والمتابعين والمشاهدات' }
];

const ADS_STUDIO_CTA = [
  ['Send Message', 'إرسال رسالة'],
  ['Learn More', 'معرفة المزيد'],
  ['Shop Now', 'تسوق الآن'],
  ['Contact Us', 'تواصل معنا'],
  ['Sign Up', 'سجل الآن'],
  ['Get Quote', 'اطلب عرض سعر'],
  ['Call Now', 'اتصل الآن']
];

// Review reason codes (P1-12): the server's list, stored on the request as reviewReasonCode.
// A request sent back or rejected shows the label, never the raw code; staff must pick one to
// request changes or reject. Labels are the server list's own words, copied verbatim.
const ADS_STUDIO_REVIEW_REASONS = [
  ['budget_dates', 'Budget or dates', 'الميزانية أو التواريخ'],
  ['creative_quality', 'Photo or video quality', 'جودة الصورة أو الفيديو'],
  ['text_policy', 'Text breaks ad rules', 'النص يخالف قواعد الإعلانات'],
  ['targeting', 'Audience or location', 'الجمهور أو الموقع'],
  ['page_access', 'Page access', 'صلاحية الصفحة'],
  ['payment', 'Payment', 'الدفع'],
  ['other', 'Other', 'أخرى']
];

// '' for an unknown or missing code: a value the list does not know is never shown.
function adsStudioReviewReasonLabel(code) {
  const hit = ADS_STUDIO_REVIEW_REASONS.find(([id]) => id === String(code || ''));
  return hit ? adsStudioText(hit[1], hit[2]) : '';
}

function adsStudioIsAr() {
  return state.language === 'ar';
}

function adsStudioText(en, ar) {
  return adsStudioIsAr() ? ar : en;
}

function adsStudioCanReview() {
  return isCurrentUserAdmin() || currentUserHasPermission('adCampaignRequests', 'review');
}

function adsStudioCanCreate() {
  return isCurrentUserAdmin() || currentUserHasPermission('adCampaignRequests', 'add');
}

function adsStudioCanUse() {
  // Staff reviewers operate Albayan's review queue; only customer creators
  // need to activate the customer subscription.
  return isCurrentUserAdmin() || adsStudioCanReview() || hasSubscription('ad_maker');
}

// A LAPSED customer keeps read access to their own campaigns: those rows may
// still hold captured money, and the Stop-and-refund button lives on them.
// The server agrees (reads are not subscription-gated; a self-stop skips the
// subscription check) — money must never be held hostage by an expiry.
function adsStudioCanViewOwn() {
  return adsStudioCanUse()
    || currentUserHasPermission('adCampaignRequests', 'viewOwn')
    || currentUserHasPermission('adCampaignRequests', 'view');
}

function adsStudioHasRecoverableCampaigns() {
  const uid = String(state.currentUser?.id || '');
  if (!uid) return false;
  return (Array.isArray(state.adCampaignRequests) ? state.adCampaignRequests : [])
    .some(c => c && !c._deleted && String(c.createdBy || '') === uid);
}

function openAdsStudioCustomerAccount() {
  if (!isCurrentUserAdmin()) return;
  window._newUserAccessPreset = 'adsStudioCustomer';
  state.activeModal = 'user';
  state.modalData = null;
  try { updateUrlParams({ modal: 'user', id: null }); } catch (_) {}
  renderModal();
}

function adsStudioTabsForUser() {
  const tabs = ADS_STUDIO_TABS.slice();
  // Help (P3-08, 15n-studio-help.js): tickets and our working hours, in the classic layout too, once
  // /me says the Help service is on for this user (the layout switch never hides a service, P3-20).
  if (typeof studioHelpClassicTab === 'function' && studioHelpClassicTab()) {
    tabs.push({ id: 'help', icon: 'life-buoy', label: 'Help', labelAr: 'المساعدة' });
  }
  if (adsStudioCanReview()) {
    tabs.push({ id: 'review', icon: 'badge-check', label: 'Review Queue', labelAr: 'طلبات المراجعة' });
  }
  return tabs.filter(tab => tab.id !== 'builder' || adsStudioCanCreate());
}

function setAdsStudioTab(tabId) {
  if (!adsStudioTabsForUser().some(tab => tab.id === tabId)) return;
  if (tabId === 'builder' && !_adsStudioDraft) beginAdsStudioCampaign();
  _adsStudioActiveTab = tabId;
  try { updateUrlParams({ tab: tabId }, true); } catch (_) {}
  render();
}

function restoreAdsStudioTabFromUrl() {
  try {
    const tab = getUrlParams().tab;
    if (tab && adsStudioTabsForUser().some(item => item.id === tab)) {
      _adsStudioActiveTab = tab;
      if (tab === 'builder' && !_adsStudioDraft) beginAdsStudioCampaign();
    }
  } catch (_) {}
}

function _adsStudioDateOffset(days) {
  // The server judges "today" in Libya time (Africa/Tripoli); a phone in another
  // timezone must agree with it, or the card offers a stop the server refuses.
  const date = new Date(Date.now() + Number(days || 0) * 86400000);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch (_) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
}

function newAdsStudioDraft() {
  return {
    name: '',
    objective: 'messages',
    platforms: ['facebook', 'instagram'],
    pageName: '',
    primaryText: '',
    headline: '',
    description: '',
    callToAction: 'Send Message',
    destination: '',
    locations: ['Libya'],
    ageMin: 18,
    ageMax: 65,
    genders: ['all'],
    languages: ['Arabic'],
    interests: [],
    startDate: _adsStudioDateOffset(1),
    endDate: _adsStudioDateOffset(7),  // start + durationDays - 1: both ends count, as on the server
    durationDays: 7,
    budgetMinorUSD: 1000,
    budgetType: 'lifetime',
    notes: '',
    creativeImages: [],
    creativeAssetIds: [],
    specialAdCategories: [],
    boostType: '',
    sourcePostRef: '',
    autoReply: false,
    extendsCampaignId: ''
  };
}

// Quick entries: same adCampaignRequests record, prefilled so a phone
// customer only names the campaign, picks the post, and sets a budget.
// Per kind: the default button, then the default name in English and Arabic.
const ADS_STUDIO_BOOST_DEFAULTS = {
  boost_post: ['Send Message', 'Boost a post', 'تعزيز منشور'],
  boost_page: ['Learn More', 'Boost my Page', 'تعزيز صفحتي']
};

function beginAdsStudioBoost(boostType) {
  const kind = boostType === 'boost_page' ? 'boost_page' : 'boost_post';
  beginAdsStudioCampaign();
  _adsStudioDraft.boostType = kind;
  _adsStudioDraft.objective = 'engagement';
  _adsStudioDraft.callToAction = ADS_STUDIO_BOOST_DEFAULTS[kind][0];
  _adsStudioDraft.name = adsStudioText(ADS_STUDIO_BOOST_DEFAULTS[kind][1], ADS_STUDIO_BOOST_DEFAULTS[kind][2]);
  setAdsStudioTab('builder');
}

// Owner decision D19: in the quick flow the customer either boosts one of the linked page's posts
// or makes a new ad without a post (own photo + text, the quick "boost my Page" request).
function adsStudioSetBoostKind(kind) {
  const d = _adsStudioDraft;
  if (!d || !d.boostType || !ADS_STUDIO_BOOST_DEFAULTS[kind] || d.boostType === kind) return;
  const from = ADS_STUDIO_BOOST_DEFAULTS[d.boostType];
  const to = ADS_STUDIO_BOOST_DEFAULTS[kind];
  if (from && d.callToAction === from[0]) d.callToAction = to[0];
  if (from && [from[1], from[2]].includes(String(d.name || ''))) d.name = adsStudioText(to[1], to[2]);
  d.boostType = kind;
  if (kind === 'boost_page') {
    // No post any more: the post link was only ever the destination of a boosted post.
    if (String(d.destination || '') === String(d.sourcePostRef || '')) d.destination = '';
    d.sourcePostRef = '';
    if (Object.prototype.hasOwnProperty.call(d, 'sourcePostId')) { d.sourcePostId = ''; d.sourcePostPlatform = ''; }
  }
  render();
}

function getVisibleAdsStudioCampaigns() {
  let records = getVisibleRecords(state.adCampaignRequests || []);
  if (!isCurrentUserAdmin() && !currentUserHasPermission('adCampaignRequests', 'view')) {
    const uid = String(state.currentUser?.id || '');
    records = records.filter(item => String(item?.createdBy || '') === uid);
  }
  // A review-only employee must not browse a customer's unfinished copy or
  // targeting. Only workflow-visible states belong in the staff portal.
  if (!isCurrentUserAdmin() && adsStudioCanReview()) {
    records = records.filter(item => ['Submitted', 'Approved', 'Rejected', 'Stopped'].includes(String(item?.status || 'Draft')));
  }
  return records.slice().sort((a, b) => Number(b?._created || 0) - Number(a?._created || 0));
}

function findVisibleAdsStudioCampaign(id) {
  return getVisibleAdsStudioCampaigns().find(item => String(item?.id || '') === String(id || '')) || null;
}

function adsStudioCreatorName(campaign) {
  const uid = String(campaign?.createdBy || '');
  const user = (state.users || []).find(item => String(item?.id || '') === uid);
  return user?.name || (uid === String(state.currentUser?.id || '') ? state.currentUser?.name : '') || adsStudioText('Customer', 'عميل');
}

function adsStudioStatusMeta(status) {
  const value = String(status || 'Draft');
  const map = {
    Draft: { label: 'Draft', labelAr: 'مسودة', icon: 'file-pen-line', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200' },
    Submitted: { label: 'Under Review', labelAr: 'قيد المراجعة', icon: 'clock-3', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200' },
    'Changes Requested': { label: 'Changes Requested', labelAr: 'مطلوب تعديل', icon: 'message-square-warning', cls: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200' },
    Approved: { label: 'Approved', labelAr: 'تمت الموافقة', icon: 'badge-check', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200' },
    Rejected: { label: 'Rejected', labelAr: 'مرفوضة', icon: 'circle-x', cls: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200' },
    Stopped: { label: 'Stopped', labelAr: 'موقفة', icon: 'circle-stop', cls: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-200' }
  };
  return map[value] || { label: value, labelAr: value, icon: 'circle-dot', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200' };
}

// publishStatus (the staff's Meta marker, P1-09) in words, English and Arabic: every value has a
// label and a value the list does not know is never shown raw. '' means nothing runs on Meta: "being
// set up" before a Meta campaign is linked, "not live" after one was (a stopped or cleared request).
const ADS_STUDIO_PUBLISH_STATUS = [
  ['meta_review', 'Meta is reviewing the ad', 'ميتا تراجع الإعلان', 'shield', 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200'],
  ['live', 'Live on Meta', 'يعمل على ميتا', 'radio', 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'],
  ['paused', 'Paused on Meta', 'متوقف مؤقتاً على ميتا', 'pause', 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200']
];

function adsStudioPublishStatusMeta(campaign) {
  const value = String(campaign?.publishStatus || '').trim();
  const linked = !!String(campaign?.metaCampaignId || '').trim();
  const hit = ADS_STUDIO_PUBLISH_STATUS.find(([id]) => id === value);
  if (hit) return { label: hit[1], labelAr: hit[2], icon: hit[3], cls: hit[4] };
  const quiet = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200';
  if (value) return { label: 'Meta status unknown', labelAr: 'حالة ميتا غير معروفة', icon: 'circle-help', cls: quiet };
  return linked
    ? { label: 'Not live on Meta', labelAr: 'غير منشور على ميتا', icon: 'circle-pause', cls: quiet }
    : { label: 'Being set up in Meta', labelAr: 'نجهّزه في ميتا', icon: 'settings-2', cls: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-200' };
}

function renderAdsStudioPublishChip(campaign) {
  const meta = adsStudioPublishStatusMeta(campaign);
  return `<span data-ads-studio-publish-status="1" class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ${meta.cls}"><i data-lucide="${meta.icon}" class="w-3.5 h-3.5"></i>${Security.escapeHtml(adsStudioText(meta.label, meta.labelAr))}</span>`;
}

function adsStudioObjectiveLabel(objective) {
  const item = ADS_STUDIO_OBJECTIVES.find(row => row.id === objective);
  return item ? adsStudioText(item.label, item.labelAr) : String(objective || '—');
}

function adsStudioMoney(minor) {
  const value = Math.max(0, Math.trunc(Number(minor) || 0));
  return `$${(value / 100).toFixed(2)}`;
}

// An amount in its own currency (P1-08a): LYD money (subscription plans) never wears "$".
// A row without a currency is USD, as on the server.
function adsStudioMoneyIn(minor, currency) {
  if (String(currency || 'USD').trim().toUpperCase() !== 'LYD') return adsStudioMoney(minor);
  const value = Math.max(0, Math.trunc(Number(minor) || 0));
  return `${(value / 100).toFixed(2)} ${adsStudioText('LYD', 'د.ل')}`;
}

// A typed money amount in minor units, or NaN when it is not a number (P1-08b). Arabic-Indic
// digits go through normalizeDigitsAscii first, so '٥٠' is 5000 ($50.00), never 0. The Arabic
// decimal sign ٫ is a point and the Arabic comma ، a comma; commas follow the money-box rule
// (sanitizeMoneyInput): "1,250" is a thousand, "12,5" is twelve and a half.
function adsStudioParseMoneyMinor(raw) {
  let text = normalizeDigitsAscii(String(raw ?? '')).replace(/،/g, ',').replace(/٫/g, '.').replace(/\s+/g, '');
  if (text.includes(',')) {
    const grouped = /^\d{1,3}(,\d{3})+(\.\d*)?$/.test(text);
    text = (text.includes('.') || grouped) ? text.split(',').join('') : text.replace(',', '.');
  }
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(text)) return NaN;
  return Math.round(parseFloat(text) * 100);
}

// "$25.00 (≈ 130 LYD)" companion — an estimate for planning, never a charge.
function adsStudioMoneyWithLyd(minor) {
  const usd = adsStudioMoney(minor);
  const rate = typeof _adsStudioUsdToLydRate === 'function' ? _adsStudioUsdToLydRate() : 0;
  if (!(rate > 1)) return usd;
  // Same arithmetic as the server's payment instruction (ceil of minor × rate),
  // so the estimate never disagrees with the LYD figure the customer is asked to pay.
  const lyd = (Math.ceil(Math.max(0, Math.trunc(Number(minor) || 0)) * Math.round(rate * 10000) / 10000) / 100).toFixed(2);
  return `${usd} (≈ ${lyd} ${adsStudioText('LYD', 'د.ل')})`;
}

function adsStudioFormatDate(value) {
  const raw = String(value || '');
  if (!raw) return '—';
  try { return new Date(`${raw}T00:00:00`).toLocaleDateString(adsStudioIsAr() ? 'ar-LY' : 'en-GB'); } catch (_) { return raw; }
}

function adsStudioBackTarget() {
  // The standalone studio site has nowhere to go "back" to.
  if (IS_STUDIO_SHELL) return '';
  if (isCurrentUserAdmin()) return 'smart-systems';
  const landing = getAlbayanManagerLandingViewForUser(state.currentUser);
  if (!landing || landing === 'ads-studio' || landing === 'no-access') return '';
  return userCanAccessView(state.currentUser, landing) ? landing : '';
}

function renderAdsStudioHeader() {
  const isAr = adsStudioIsAr();
  const backTarget = adsStudioBackTarget();
  return `
    <div class="studio-page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
      <div class="flex items-center gap-3 min-w-0">
        ${backTarget ? `
          <button type="button" onclick="navigateTo('${backTarget}')" class="touch-target w-11 h-11 flex-shrink-0 rounded-xl bg-white/70 dark:bg-slate-800/70 border border-white/60 dark:border-slate-700 flex items-center justify-center text-blue-600" aria-label="${isAr ? 'العودة' : 'Back'}">
            <i data-lucide="${isAr ? 'arrow-right' : 'arrow-left'}" class="w-5 h-5"></i>
          </button>
        ` : ''}
        <div class="w-12 h-12 sm:w-14 sm:h-14 flex-shrink-0 rounded-2xl bg-gradient-to-br from-blue-600 to-cyan-500 flex items-center justify-center shadow-lg shadow-blue-500/20">
          <i data-lucide="rocket" class="w-7 h-7 text-white"></i>
        </div>
        <div class="min-w-0">
          <h1 class="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white">${isAr ? 'استوديو إعلانات البيان' : 'Albayan Ads Studio'}</h1>
          <p class="text-sm text-slate-500 dark:text-slate-400">${isAr ? 'أنشئ حملتك بنفسك، وسنراجعها قبل النشر' : 'Build your campaign; our team reviews it before publishing'}</p>
        </div>
      </div>
      <div class="flex items-center gap-2 self-end sm:self-auto">
        <button type="button" onclick="toggleLanguage()" class="touch-target min-w-11 h-11 px-3 rounded-xl bg-white/70 dark:bg-slate-800/70 border border-white/60 dark:border-slate-700 font-bold text-sm">${state.language.toUpperCase()}</button>
        <button type="button" onclick="toggleTheme()" class="touch-target w-11 h-11 rounded-xl bg-white/70 dark:bg-slate-800/70 border border-white/60 dark:border-slate-700 flex items-center justify-center" aria-label="${isAr ? 'المظهر' : 'Theme'}"><i data-lucide="${state.theme === 'dark' ? 'moon' : 'sun'}" class="w-5 h-5"></i></button>
        <button type="button" onclick="handleLogout()" class="touch-target w-11 h-11 rounded-xl bg-rose-50 dark:bg-rose-900/20 text-rose-600 flex items-center justify-center" aria-label="${isAr ? 'تسجيل الخروج' : 'Log out'}"><i data-lucide="log-out" class="w-5 h-5"></i></button>
      </div>
    </div>
  `;
}

function renderAdsStudioTabBar() {
  const isAr = adsStudioIsAr();
  return `
    <div class="studio-section-navigation mb-6 pb-2">
      <div class="studio-section-tabs flex flex-wrap gap-2" role="tablist" aria-label="${isAr ? 'أقسام استوديو الإعلانات' : 'Ads Studio sections'}">
        ${adsStudioTabsForUser().map(tab => {
          const active = _adsStudioActiveTab === tab.id;
          return `
            <button type="button" role="tab" aria-selected="${active}" onclick="setAdsStudioTab('${tab.id}')" class="touch-target inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${active ? 'bg-gradient-to-r from-blue-600 to-cyan-500 text-white shadow-lg' : 'bg-white/70 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300 border border-white/60 dark:border-slate-700'}">
              <i data-lucide="${tab.icon}" class="w-4 h-4"></i><span>${isAr ? tab.labelAr : tab.label}</span>
              ${tab.id === 'review' ? `<span class="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px]">${adsStudioReviewQueue().length}</span>` : ''}
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderAdsStudioSubscriptionGate() {
  const isAr = adsStudioIsAr();
  return `
    <div class="max-w-2xl mx-auto py-8 sm:py-16">
      <div class="glass-panel rounded-3xl p-6 sm:p-10 text-center border border-blue-100 dark:border-blue-900/40">
        <div class="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-blue-600 to-cyan-500 flex items-center justify-center mb-6 shadow-xl"><i data-lucide="lock-keyhole" class="w-9 h-9 text-white"></i></div>
        <h2 class="text-2xl font-black text-slate-900 dark:text-white mb-3">${isAr ? 'فعّل استوديو الإعلانات' : 'Activate Ads Studio'}</h2>
        <p class="text-slate-500 dark:text-slate-400 mb-6">${isAr ? 'تحتاج إلى اشتراك نشط لإنشاء حملاتك وحفظها بأمان.' : 'An active subscription is required to create and securely save campaigns.'}</p>
        <button type="button" onclick="showSubscriptionModal('ad_maker', 'ad_maker')" class="touch-target w-full sm:w-auto min-h-12 px-8 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 text-white font-bold shadow-lg">${isAr ? 'تفعيل الخدمة' : 'Activate service'}</button>
      </div>
    </div>
  `;
}

function renderAdsStudioView() {
  // Studio v2 (P2-02a, 15h-studio-shell.js): only when GET /api/studio/me says so; '' = the classic screens below.
  const studioV2Html = typeof renderStudioV2View === 'function' ? renderStudioV2View() : '';
  if (studioV2Html) return studioV2Html;
  const isAr = adsStudioIsAr();
  if (!adsStudioCanUse()) {
    // Expired, but their campaigns may still hold their money: show those
    // read-only (Stop & refund stays available) above the activate card.
    if (adsStudioCanViewOwn() && adsStudioHasRecoverableCampaigns()) {
      return `
        <div class="max-w-7xl mx-auto" dir="${isAr ? 'rtl' : 'ltr'}">
          ${renderAdsStudioHeader()}
          <div class="mb-5 rounded-2xl bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-3">
            <i data-lucide="info" class="w-5 h-5 flex-shrink-0"></i>
            <span>${isAr
              ? 'انتهى اشتراكك. لا يزال بإمكانك رؤية حملاتك وإيقاف أي حملة لاسترداد ما لم يُصرف إلى محفظتك. فعّل الخدمة لإنشاء حملات جديدة.'
              : 'Your subscription has ended. You can still see your campaigns and stop any of them to return the unspent budget to your wallet. Activate the service to create new campaigns.'}</span>
          </div>
          ${renderAdsStudioCampaigns()}
          <div class="mt-6">${renderAdsStudioSubscriptionGate()}</div>
          ${renderAdsStudioSheets()}
        </div>`;
    }
    // In the studio shell the paywall's "Charge wallet" has nowhere else to go: keep the wallet form reachable.
    const shellWallet = IS_STUDIO_SHELL && adsStudioCanViewOwn() ? `<div class="mt-6">${renderAdsStudioWallet()}</div>` : '';
    return `<div class="max-w-7xl mx-auto" dir="${isAr ? 'rtl' : 'ltr'}">${renderAdsStudioHeader()}${renderAdsStudioSubscriptionGate()}${shellWallet}</div>`;
  }

  // The budget limits arrive long before the budget step (once per session, P1-08b). Opening the
  // campaign list or the dashboard reads /me again for the intake switch (P1-22).
  if (adsStudioCanCreate()) refreshAdsStudioLimits(adsStudioListOpened() ? ADS_STUDIO_INTAKE_RECHECK_MS : 0);
  let content = '';
  if (_adsStudioActiveTab === 'campaigns') content = renderAdsStudioCampaigns();
  else if (_adsStudioActiveTab === 'builder') content = renderAdsStudioBuilder();
  else if (_adsStudioActiveTab === 'review') content = renderAdsStudioReviewQueue() + renderAdsStudioLaunchQueue() + (typeof renderStudioStaffTicketsClassic === 'function' ? renderStudioStaffTicketsClassic() : '') + (isCurrentUserAdmin() && typeof renderStudioStaffSection === 'function' ? renderStudioStaffSection('health') : '');
  else if (_adsStudioActiveTab === 'posts') content = renderSocialStudioPostsTab();
  else if (_adsStudioActiveTab === 'replies') content = renderSocialStudioRepliesTab();
  else if (_adsStudioActiveTab === 'help' && typeof renderStudioHelpClassic === 'function') content = renderStudioHelpClassic();
  else content = renderAdsStudioDashboard();

  return `
    <div class="max-w-7xl mx-auto" dir="${isAr ? 'rtl' : 'ltr'}">
      ${renderAdsStudioHeader()}
      ${renderAdsStudioTabBar()}
      ${content}
      ${renderAdsStudioSheets()}
    </div>
  `;
}

// The in-page sheets (never a native dialog): the staff "Link Meta campaign" and "Unlink Meta
// campaign" sheets and the customer's "Withdraw" confirmation. Each draws nothing unless it is open
// and still applies.
function renderAdsStudioSheets() {
  return renderAdsStudioLinkSheet() + renderAdsStudioUnlinkSheet() + renderAdsStudioWithdrawSheet();
}

function renderAdsStudioDashboard() {
  const campaigns = getVisibleAdsStudioCampaigns();
  const draftCount = campaigns.filter(item => ['Draft', 'Changes Requested'].includes(String(item.status || 'Draft'))).length;
  const reviewCount = campaigns.filter(item => item.status === 'Submitted').length;
  const approvedCount = campaigns.filter(item => item.status === 'Approved').length;
  // Only requests that hold money (Submitted) or were paid (Approved) are budgets; drafts,
  // rejected and stopped requests hold nothing, so they never count here (P1-08a).
  const budgeted = campaigns.filter(item => ['Submitted', 'Approved'].includes(String(item.status || 'Draft')));
  const lifetimeBudget = budgeted
    .filter(item => String(item.budgetType || 'lifetime') !== 'daily')
    .reduce((sum, item) => sum + Math.max(0, Number(item.budgetMinorUSD) || 0), 0);
  const dailyBudget = budgeted
    .filter(item => String(item.budgetType || '') === 'daily')
    .reduce((sum, item) => sum + Math.max(0, Number(item.budgetMinorUSD) || 0), 0);
  const isAr = adsStudioIsAr();
  const stats = [
    ['layers-3', isAr ? 'كل الحملات' : 'All campaigns', campaigns.length, 'from-blue-600 to-indigo-500'],
    ['file-pen-line', isAr ? 'تحتاج إكمال' : 'Needs work', draftCount, 'from-slate-500 to-slate-600'],
    ['clock-3', isAr ? 'قيد المراجعة' : 'Under review', reviewCount, 'from-amber-500 to-orange-500'],
    ['badge-check', isAr ? 'تمت الموافقة' : 'Approved', approvedCount, 'from-emerald-500 to-teal-500']
  ];
  return `
    <section class="space-y-6">
      <div class="studio-dashboard-hero relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-700 via-blue-600 to-cyan-500 p-6 sm:p-8 text-white shadow-2xl">
        <div class="absolute -right-10 -top-16 h-52 w-52 rounded-full bg-white/10"></div>
        <div class="relative grid gap-6 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <span class="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-bold"><i data-lucide="shield-check" class="w-4 h-4"></i>${isAr ? 'إنشاء آمن مع مراجعة بشرية' : 'Safe creation with human review'}</span>
            <h2 class="mt-4 text-2xl sm:text-4xl font-black max-w-2xl">${isAr ? 'أنشئ إعلانك من الهاتف أو الكمبيوتر' : 'Create your next ad from phone or desktop'}</h2>
            <p class="mt-3 max-w-2xl text-blue-50">${isAr ? 'اختر الهدف والجمهور والميزانية والصور. الإرسال يحجز الميزانية والموافقة تخصمها.' : 'Choose the objective, audience, budget and creative. Submitting holds the budget; approval charges it.'}</p>
          </div>
          <div class="flex flex-col gap-2 sm:flex-row">
            ${isCurrentUserAdmin() ? `<button type="button" onclick="openAdsStudioCustomerAccount()" class="touch-target min-h-12 rounded-xl border border-white/40 bg-white/10 px-5 py-3 font-black text-white hover:bg-white/20"><span class="inline-flex items-center gap-2"><i data-lucide="user-plus" class="w-5 h-5"></i>${isAr ? 'حساب عميل' : 'Customer login'}</span></button>` : ''}
            ${adsStudioCanCreate() ? `<button type="button" onclick="beginAdsStudioCampaign(); setAdsStudioTab('builder')" class="touch-target min-h-12 rounded-xl bg-white px-6 py-3 font-black text-blue-700 shadow-xl hover:bg-blue-50"><span class="inline-flex items-center gap-2"><i data-lucide="plus" class="w-5 h-5"></i>${isAr ? 'حملة جديدة' : 'New campaign'}</span></button>` : ''}
          </div>
        </div>
        ${adsStudioCanCreate() ? `
        <div class="relative mt-5 grid grid-cols-2 gap-3 max-w-xl">
          <button type="button" onclick="beginAdsStudioBoost('boost_post')" class="touch-target min-h-12 rounded-xl border border-white/40 bg-white/10 px-4 py-3 font-black text-white hover:bg-white/20"><span class="inline-flex items-center gap-2"><i data-lucide="rocket" class="w-5 h-5"></i>${isAr ? 'تعزيز منشور' : 'Boost a post'}</span></button>
          <button type="button" onclick="beginAdsStudioBoost('boost_page')" class="touch-target min-h-12 rounded-xl border border-white/40 bg-white/10 px-4 py-3 font-black text-white hover:bg-white/20"><span class="inline-flex items-center gap-2"><i data-lucide="flag" class="w-5 h-5"></i>${isAr ? 'تعزيز صفحتي' : 'Boost my Page'}</span></button>
        </div>` : ''}
      </div>

      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        ${stats.map(([icon, label, value, gradient]) => `
          <div class="glass-panel rounded-2xl p-4 sm:p-5">
            <div class="w-10 h-10 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center text-white mb-3"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
            <div class="text-2xl font-black text-slate-900 dark:text-white">${value}</div>
            <div class="text-xs sm:text-sm text-slate-500 dark:text-slate-400">${label}</div>
          </div>
        `).join('')}
      </div>

      ${typeof renderSocialStudioOverviewSection === 'function' ? renderSocialStudioOverviewSection() : ''}

      <div class="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div class="glass-panel rounded-2xl p-4 sm:p-6">
          <div class="flex items-center justify-between gap-3 mb-4"><div><h3 class="font-black text-lg text-slate-900 dark:text-white">${isAr ? 'أحدث الحملات' : 'Recent campaigns'}</h3><p class="text-sm text-slate-500">${isAr ? 'آخر التحديثات والقرارات' : 'Latest updates and decisions'}</p></div><button type="button" onclick="setAdsStudioTab('campaigns')" class="touch-target min-h-11 px-3 text-sm font-bold text-blue-600">${isAr ? 'عرض الكل' : 'View all'}</button></div>
          <div class="space-y-3">${campaigns.length ? campaigns.slice(0, 3).map(renderAdsStudioCampaignCard).join('') : renderAdsStudioEmptyState()}</div>
        </div>
        <div class="glass-panel rounded-2xl p-5 sm:p-6">
          <h3 class="font-black text-lg text-slate-900 dark:text-white">${isAr ? 'ملخص الميزانيات' : 'Budget summary'}</h3>
          <p class="text-sm text-slate-500 mt-1">${isAr ? 'ميزانيات الحملات قيد المراجعة أو المعتمدة، وليست مصروفاً فعلياً' : 'Budgets of campaigns under review or approved, not actual spend'}</p>
          <div class="mt-6 grid gap-3 sm:grid-cols-2">
            <div class="rounded-2xl bg-blue-50 dark:bg-blue-900/20 p-5"><div class="text-sm font-bold text-blue-700 dark:text-blue-300">${isAr ? 'إجمالي ميزانيات المدة' : 'Lifetime requested'}</div><div class="mt-1 text-2xl font-black text-blue-900 dark:text-blue-100">${adsStudioMoney(lifetimeBudget)}</div></div>
            <div class="rounded-2xl bg-cyan-50 dark:bg-cyan-900/20 p-5"><div class="text-sm font-bold text-cyan-700 dark:text-cyan-300">${isAr ? 'إجمالي الميزانيات اليومية' : 'Daily requested'}</div><div class="mt-1 text-2xl font-black text-cyan-900 dark:text-cyan-100">${adsStudioMoney(dailyBudget)}<span class="ms-1 text-sm font-bold">${isAr ? 'يومياً' : '/ day'}</span></div></div>
          </div>
          <div class="mt-5 flex items-start gap-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-200"><i data-lucide="info" class="w-5 h-5 flex-shrink-0"></i><span>${isAr ? 'الميزانية هنا للتخطيط فقط. الدفع وإطلاق الإعلان يتمان بعد موافقة الإدارة وربط حساب ميتا.' : 'Budgets here are planning values. Payment and launch happen only after staff approval and Meta connection.'}</span></div>
        </div>
      </div>

      <div>
        <h3 class="font-black text-xl text-slate-900 dark:text-white mb-4 flex items-center gap-2"><i data-lucide="wallet" class="w-5 h-5"></i>${isAr ? 'المحفظة' : 'Wallet'}</h3>
        ${renderAdsStudioWallet()}
      </div>

      <div>
        <h3 class="font-black text-xl text-slate-900 dark:text-white mb-4 flex items-center gap-2"><i data-lucide="link-2" class="w-5 h-5"></i>${isAr ? 'ربط ميتا' : 'Meta Connection'}</h3>
        ${renderAdsStudioConnections()}
      </div>
    </section>
  `;
}

function renderAdsStudioEmptyState() {
  const isAr = adsStudioIsAr();
  return `<div class="rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 p-8 text-center"><i data-lucide="megaphone-off" class="w-10 h-10 mx-auto text-slate-300 mb-3"></i><p class="font-bold text-slate-700 dark:text-slate-200">${isAr ? 'لا توجد حملات بعد' : 'No campaigns yet'}</p><p class="text-sm text-slate-500 mt-1">${isAr ? 'ابدأ بمسودة جديدة عندما تكون جاهزاً.' : 'Start a new draft when you are ready.'}</p></div>`;
}

function renderAdsStudioCampaignCard(campaign) {
  const isAr = adsStudioIsAr();
  const statusValue = String(campaign.status || 'Draft');
  const status = adsStudioStatusMeta(campaign.status);
  const editableStatus = ['Draft', 'Changes Requested'].includes(statusValue);
  const canEdit = editableStatus && canActOnRecord('adCampaignRequests', 'edit', campaign.createdBy);
  const canSubmit = editableStatus && canActOnRecord('adCampaignRequests', 'submit', campaign.createdBy);
  const canDuplicate = adsStudioCanCreate() && canActOnRecord('adCampaignRequests', 'add', campaign.createdBy);
  const isLaunched = !!(String(campaign.publishStatus || '').trim() || String(campaign.metaCampaignId || '').trim());  // same predicate as the stop prompt and the server
  const photoCount = getEntityPhotoCountHint('adCampaignRequests', campaign);
  const safeId = Security.escapeHtml(String(campaign.id || ''));
  const platforms = (Array.isArray(campaign.platforms) ? campaign.platforms : []).map(item => String(item)).join(' + ');
  const paidMinorEarly = Math.max(0, parseInt(campaign.paidMinorUSD, 10) || 0);
  const spendMinorEarly = Math.max(0, parseInt(campaign.spendMinorUSD, 10) || 0);
  // Mirror of the server's owner-stop gate: instant refund only before start.
  const ownerCanInstantStop = !isLaunched && spendMinorEarly === 0 && String(campaign.startDate || '') >= _adsStudioDateOffset(0);  // the start day itself is not started (server rule)
  const mayStop = canActOnRecord('adCampaignRequests', 'stop', campaign.createdBy);
  const staffHere = adsStudioCanReview() && String(campaign.createdBy || '') !== String(state.currentUser?.id || '');  // own campaigns follow the customer rule (server)
  const canStop = statusValue === 'Approved' && (staffHere || (mayStop && ownerCanInstantStop));
  // Ask to stop (P3-10, 15n-studio-help.js): the real stop-request sheet on an Approved request of
  // the owner once the service is on; the old "message us" toast stays only while it is off. An ad
  // whose stop was already asked for shows the marker instead (the ticket, when Help is on).
  const stopRequestedAt = String(campaign.stopRequestedAt || '').trim() || (typeof studioStopRequestedAt === 'function' ? studioStopRequestedAt(campaign.id) : '');
  const askStopSheet = statusValue === 'Approved' && !staffHere && mayStop && !stopRequestedAt && typeof studioStopSheetAvailable === 'function' && studioStopSheetAvailable();
  const showAskStop = statusValue === 'Approved' && !staffHere && mayStop && !ownerCanInstantStop && !askStopSheet && !stopRequestedAt;
  const stopTicketId = /^tkt_[0-9a-f]{40}$/.test(String(campaign.stopRequestTicketId || '')) ? String(campaign.stopRequestTicketId) : '';
  const askAboutThis = String(campaign.createdBy || '') === String(state.currentUser?.id || '') && typeof studioHelpAskButton === 'function' ? studioHelpAskButton('campaign', campaign.id) : '';
  // Withdraw (P1-03): only the owner takes a waiting request back to Draft (the server answers 404 to anyone else).
  const canWithdraw = statusValue === 'Submitted' && String(campaign.createdBy || '') === String(state.currentUser?.id || '')
    && canActOnRecord('adCampaignRequests', 'submit', campaign.createdBy);
  const canLink = statusValue === 'Approved' && adsStudioCanReview() && !String(campaign.metaCampaignId || '').trim();
  const canUnlink = statusValue === 'Approved' && adsStudioCanReview() && !!String(campaign.metaCampaignId || '').trim();  // a stopped request stays linked (server)
  // Archiving an Approved campaign with captured money would forfeit it —
  // the server refuses; do not offer the dead-end button.
  const canDelete = ['Draft', 'Changes Requested', 'Approved', 'Rejected', 'Stopped'].includes(statusValue)
    && canActOnRecord('adCampaignRequests', 'delete', campaign.createdBy)
    && !(statusValue === 'Approved' && paidMinorEarly > 0);
  const boostChip = campaign.boostType === 'boost_post'
    ? `<span class="inline-flex items-center gap-1 rounded-full bg-violet-100 dark:bg-violet-900/30 px-2.5 py-1 text-[11px] font-bold text-violet-800 dark:text-violet-200"><i data-lucide="rocket" class="w-3.5 h-3.5"></i>${isAr ? 'تعزيز منشور' : 'Boost post'}</span>`
    : campaign.boostType === 'boost_page'
      ? `<span class="inline-flex items-center gap-1 rounded-full bg-violet-100 dark:bg-violet-900/30 px-2.5 py-1 text-[11px] font-bold text-violet-800 dark:text-violet-200"><i data-lucide="flag" class="w-3.5 h-3.5"></i>${isAr ? 'تعزيز صفحة' : 'Boost Page'}</span>`
      : '';
  const paidMinor = Math.max(0, parseInt(campaign.paidMinorUSD, 10) || 0);
  const refundMinor = Math.max(0, parseInt(campaign.refundMinorUSD, 10) || 0);
  const spendMinor = Math.max(0, parseInt(campaign.spendMinorUSD, 10) || 0);
  return `
    <article class="rounded-2xl border border-slate-200/80 dark:border-slate-700 bg-white/70 dark:bg-slate-900/60 p-4 sm:p-5" data-ads-studio-campaign="${safeId}">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="font-black text-slate-900 dark:text-white break-words">${Security.escapeHtml(campaign.name || (isAr ? 'حملة بدون اسم' : 'Untitled campaign'))}</h3>
            <span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ${status.cls}"><i data-lucide="${status.icon}" class="w-3.5 h-3.5"></i>${isAr ? status.labelAr : status.label}</span>
            ${boostChip}
            ${campaign.autoReply === true ? `<span class="inline-flex items-center gap-1 rounded-full bg-sky-100 dark:bg-sky-900/30 px-2.5 py-1 text-[11px] font-bold text-sky-800 dark:text-sky-200"><i data-lucide="message-circle-reply" class="w-3.5 h-3.5"></i>${isAr ? 'رد تلقائي' : 'Auto-reply'}</span>` : ''}
            ${campaign.extendsCampaignId ? (() => {
              // The id is a customer CLAIM (the server only format-checks it):
              // resolve the name only from the same customer's own campaigns.
              const ext = findVisibleAdsStudioCampaign(campaign.extendsCampaignId);
              const extName = ext && String(ext.createdBy || '') === String(campaign.createdBy || '') ? String(ext.name || '') : '';
              return `<span class="inline-flex items-center gap-1 rounded-full bg-indigo-100 dark:bg-indigo-900/30 px-2.5 py-1 text-[11px] font-bold text-indigo-800 dark:text-indigo-200"><i data-lucide="calendar-plus" class="w-3.5 h-3.5"></i>${isAr ? 'تمديد لحملة' : 'Extension of'} ${Security.escapeHtml((extName || (isAr ? 'حملة سابقة' : 'a previous campaign')).slice(0, 40))}</span>`;
            })() : ''}
            ${statusValue === 'Approved' || (isLaunched && adsStudioCanReview()) ? renderAdsStudioPublishChip(campaign) : ''}
          </div>
          <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span class="inline-flex items-center gap-1"><i data-lucide="target" class="w-3.5 h-3.5"></i>${Security.escapeHtml(adsStudioObjectiveLabel(campaign.objective))}</span>
            <span class="inline-flex items-center gap-1"><i data-lucide="wallet-cards" class="w-3.5 h-3.5"></i>${Security.escapeHtml(adsStudioBudgetLine(campaign))}</span>
            <span class="inline-flex items-center gap-1"><i data-lucide="calendar-days" class="w-3.5 h-3.5"></i>${adsStudioFormatDate(campaign.startDate)} → ${adsStudioFormatDate(campaign.endDate)}</span>
            ${adsStudioCanReview() ? `<span class="inline-flex items-center gap-1"><i data-lucide="user" class="w-3.5 h-3.5"></i>${Security.escapeHtml(adsStudioCreatorName(campaign))}</span>` : ''}
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 sm:justify-end">
          ${photoCount ? `<button type="button" onclick="openAdsStudioCreativeViewer('${safeId}', 0, this)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-cyan-50 dark:bg-cyan-900/20 px-3 text-sm font-bold text-cyan-700 dark:text-cyan-300"><i data-lucide="images" class="w-4 h-4"></i><span>${isAr ? 'الصور' : 'Creative'} ${photoCount}</span></button>` : ''}
          ${canEdit ? `<button type="button" onclick="startAdsStudioCampaign('${safeId}')" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-blue-50 dark:bg-blue-900/20 px-3 text-sm font-bold text-blue-700 dark:text-blue-300"><i data-lucide="pencil" class="w-4 h-4"></i>${isAr ? 'تعديل' : 'Edit'}</button>` : ''}
          ${canSubmit ? `<button type="button" data-ads-studio-submit="1" onclick="submitAdsStudioCampaign('${safeId}', this)"${_adsStudioIntakeOpen === false ? ` disabled title="${Security.escapeHtml(adsStudioIntakePausedText())}"` : ''} class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 px-3 text-sm font-bold text-white disabled:opacity-60"><i data-lucide="send" class="w-4 h-4"></i>${isAr ? 'إرسال' : 'Submit'}</button>` : ''}
          ${canWithdraw ? `<button type="button" data-ads-studio-withdraw="1" onclick="openAdsStudioWithdraw('${safeId}')" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-amber-50 dark:bg-amber-900/20 px-3 text-sm font-bold text-amber-800 dark:text-amber-200 disabled:opacity-60"><i data-lucide="undo-2" class="w-4 h-4"></i>${isAr ? 'سحب الطلب' : 'Withdraw'}</button>` : ''}
          ${canStop ? `<button type="button" onclick="stopAdsStudioCampaign('${safeId}', this)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-rose-100 dark:bg-rose-900/30 px-3 text-sm font-bold text-rose-700 dark:text-rose-200 disabled:opacity-60"><i data-lucide="circle-stop" class="w-4 h-4"></i>${isLaunched ? (isAr ? 'إغلاق الحملة' : 'Close campaign') : (isAr ? 'إيقاف واسترداد' : 'Stop & refund')}</button>` : ''}
          ${askStopSheet ? `<button type="button" data-ads-studio-ask-stop="1" onclick="studioStopSheetOpen('${safeId}', this)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 px-3 text-sm font-bold text-slate-600 dark:text-slate-300"><i data-lucide="hand" class="w-4 h-4"></i>${isAr ? 'اطلب الإيقاف' : 'Ask to stop'}</button>` : ''}
          ${stopRequestedAt && statusValue === 'Approved' ? `<span data-ads-studio-stop-requested="1" class="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/30 px-2.5 py-1 text-[11px] font-bold text-amber-800 dark:text-amber-200"><i data-lucide="hand" class="w-3.5 h-3.5"></i>${isAr ? 'طُلب الإيقاف — سنوقفه قريباً' : 'Stop requested — we will pause it soon'}</span>${stopTicketId && typeof studioHelpClassicTab === 'function' && studioHelpClassicTab() ? `<button type="button" data-ads-studio-stop-ticket="1" onclick="studioHelpOpen('${stopTicketId}')" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 px-3 text-sm font-bold text-slate-600 dark:text-slate-300"><i data-lucide="ticket" class="w-4 h-4"></i>${isAr ? 'افتح التذكرة' : 'Open the ticket'}</button>` : ''}` : ''}
          ${showAskStop ? `<button type="button" onclick="showNotification('${isAr ? 'الإعلان بدأ بالفعل' : 'This ad already started'}', '${isAr ? 'راسلنا لنوقفه ونعيد الجزء غير المصروف إلى محفظتك.' : 'Message us — we stop it and refund the unspent part to your wallet.'}', 'info')" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 px-3 text-sm font-bold text-slate-600 dark:text-slate-300"><i data-lucide="circle-help" class="w-4 h-4"></i>${isAr ? 'اطلب الإيقاف' : 'Ask us to stop it'}</button>` : ''}
          ${askAboutThis}
          ${canLink ? `<button type="button" data-ads-studio-link="1" onclick="openAdsStudioLinkSheet('${safeId}')" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 px-3 text-sm font-bold text-emerald-700 dark:text-emerald-300 disabled:opacity-60"><i data-lucide="link-2" class="w-4 h-4"></i>${isAr ? 'ربط حملة ميتا' : 'Link Meta campaign'}</button>` : ''}
          ${canUnlink ? `<button type="button" data-ads-studio-unlink="1" onclick="openAdsStudioUnlinkSheet('${safeId}')" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 px-3 text-sm font-bold text-rose-700 dark:text-rose-300 disabled:opacity-60"><i data-lucide="unlink" class="w-4 h-4"></i>${isAr ? 'إلغاء ربط حملة ميتا' : 'Unlink Meta campaign'}</button>` : ''}
          ${canDuplicate && ['Approved', 'Stopped'].includes(statusValue) ? `<button type="button" onclick="duplicateAdsStudioCampaign('${safeId}', this, true)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 px-3 text-sm font-bold text-indigo-700 dark:text-indigo-300 disabled:opacity-60"><i data-lucide="calendar-plus" class="w-4 h-4"></i>${isAr ? 'تمديد' : 'Extend'}</button>` : ''}
          ${canDuplicate ? `<button type="button" onclick="duplicateAdsStudioCampaign('${safeId}', this, false)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 px-3 text-sm font-bold text-slate-700 dark:text-slate-200 disabled:opacity-60"><i data-lucide="copy" class="w-4 h-4"></i>${isAr ? 'نسخ' : 'Duplicate'}</button>` : ''}
          ${canDelete ? `<button type="button" onclick="deleteAdsStudioCampaign('${safeId}', this)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-rose-50 dark:bg-rose-900/20 px-3 text-sm font-bold text-rose-700 dark:text-rose-300 disabled:opacity-60"><i data-lucide="${editableStatus ? 'trash-2' : 'archive'}" class="w-4 h-4"></i>${editableStatus ? (isAr ? 'حذف' : 'Delete') : (isAr ? 'أرشفة' : 'Archive')}</button>` : ''}
        </div>
      </div>
      ${statusValue === 'Stopped' ? `<div class="mt-4 rounded-xl bg-rose-50 dark:bg-rose-900/20 p-3 text-sm text-rose-800 dark:text-rose-200"><span class="font-bold">${isAr ? 'الأموال:' : 'Money:'}</span> ${isAr ? 'مدفوع' : 'paid'} ${adsStudioMoney(paidMinor)} · ${isAr ? 'مسترد' : 'refunded'} ${adsStudioMoney(refundMinor)}${spendMinor ? ` · ${isAr ? 'مصروف' : 'spent'} ${adsStudioMoney(spendMinor)}` : ''}${campaign.stopReason ? `<div class="mt-1">${Security.escapeHtml(String(campaign.stopReason))}</div>` : ''}</div>` : ''}
      ${renderAdsStudioResultsCard(campaign)}
      ${campaign.boostType === 'boost_post' && adsStudioIsValidBoostRef(campaign.sourcePostRef) ? `<div class="mt-3 text-xs"><a href="${Security.escapeHtml(String(campaign.sourcePostRef))}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 font-bold text-blue-600 hover:text-blue-700"><i data-lucide="external-link" class="w-3.5 h-3.5"></i>${isAr ? 'فتح المنشور الأصلي' : 'Open the boosted post'}</a></div>` : ''}
      ${renderAdsStudioReviewFeedback(campaign)}
      <details class="mt-4 border-t border-slate-200 dark:border-slate-700 pt-3">
        <summary class="touch-target min-h-11 cursor-pointer select-none text-sm font-bold text-slate-600 dark:text-slate-300 flex items-center gap-2"><i data-lucide="chevron-down" class="w-4 h-4"></i>${isAr ? 'عرض الملخص' : 'View brief'}</summary>
        <div class="grid gap-3 pt-3 sm:grid-cols-2 text-sm">
          <div><span class="text-slate-500">${isAr ? 'الصفحة:' : 'Page:'}</span> <span class="font-semibold text-slate-800 dark:text-slate-100">${Security.escapeHtml(campaign.pageName || '—')}</span></div>
          <div><span class="text-slate-500">${isAr ? 'المنصات:' : 'Platforms:'}</span> <span class="font-semibold capitalize text-slate-800 dark:text-slate-100">${Security.escapeHtml(platforms || '—')}</span></div>
          <div><span class="text-slate-500">${isAr ? 'الموقع:' : 'Location:'}</span> <span class="font-semibold text-slate-800 dark:text-slate-100">${Security.escapeHtml((campaign.locations || []).join(', ') || '—')}</span></div>
          <div><span class="text-slate-500">${isAr ? 'العمر:' : 'Age:'}</span> <span class="font-semibold text-slate-800 dark:text-slate-100">${Number(campaign.ageMin) || 18}–${Number(campaign.ageMax) || 65}</span></div>
          <div class="sm:col-span-2"><span class="text-slate-500">${isAr ? 'النص:' : 'Copy:'}</span> <span class="font-semibold whitespace-pre-wrap text-slate-800 dark:text-slate-100">${Security.escapeHtml(campaign.primaryText || '—')}</span></div>
        </div>
      </details>
      ${renderAdsStudioReviewHistory(campaign)}
    </article>
  `;
}

// ---- Meta results card (P3-04b/c) ----
// A request linked to a Meta campaign (Approved or Stopped) shows what Meta reports: "Meta used $Y of
// $X", lifetime impressions, reach and results, and "checked X ago" (amber when older than 6 hours),
// read from GET /api/studio/campaigns/{id}/results (the stored reading: after a failed Meta check it
// still shows the last good values). One read per card at a time, kept 2 minutes; a failed read is
// tried again after a minute. Staff also get "Check Meta now" (POST .../results/refresh): a second
// press within 10 minutes shows the saved reading instead of asking Meta again.
const ADS_STUDIO_RESULTS_TTL_MS = 2 * 60 * 1000;
const ADS_STUDIO_RESULTS_RETRY_MS = 60 * 1000;
const ADS_STUDIO_RESULTS_MAX_READS = 4;  // cards read at once; the render after each answer starts the next
const _adsStudioResults = { forUser: '', byId: new Map() };  // campaign id -> { state, data, at, promise }
const _adsStudioResultsChecks = new Map();  // campaign id -> its "Check Meta now" in flight
let _adsStudioResultsRenderTimer = null;

// Meta's main result types (meta_ads.get_campaign_results) in words; any other type reads "Results".
const ADS_STUDIO_RESULT_TYPES = [
  ['onsite_conversion.messaging_conversation_started_7d', 'Conversations started', 'محادثات بدأت'],
  ['messaging_conversation_started_7d', 'Conversations started', 'محادثات بدأت'],
  ['lead', 'Leads', 'عملاء محتملون'],
  ['purchase', 'Purchases', 'عمليات شراء'],
  ['link_click', 'Link clicks', 'نقرات على الرابط']
];

const ADS_STUDIO_RESULTS_ERRORS = {
  RATE_LIMITED: ['Too many requests. Please wait a minute and try again.', 'طلبات كثيرة. انتظر دقيقة ثم أعد المحاولة.'],
  STAFF_ONLY: ['Only the Albayan team can check Meta now.', 'فحص ميتا الآن متاح لفريق البيان فقط.'],
  NOT_LINKED: ['This request is not linked to a Meta campaign yet.', 'هذا الطلب غير مربوط بحملة ميتا بعد.'],
  UNKNOWN_CAMPAIGN: ['This request was not found. Refresh the page.', 'لم نجد هذا الطلب. حدّث الصفحة.'],
  CROSS_SITE: ['This change must come from the Albayan site itself.', 'يجب أن يأتي هذا الطلب من موقع البيان نفسه.']
};

function resetAdsStudioResults() {
  _adsStudioResults.forUser = '';
  _adsStudioResults.byId.clear();
  _adsStudioResultsChecks.clear();
  if (_adsStudioResultsRenderTimer && typeof clearTimeout === 'function') clearTimeout(_adsStudioResultsRenderTimer);
  _adsStudioResultsRenderTimer = null;
}

function adsStudioShowsResults(campaign) {
  return ['Approved', 'Stopped'].includes(String(campaign?.status || '')) && !!String(campaign?.metaCampaignId || '').trim();
}

// The server's answer, kept only in the shape the card reads (a count is a whole number or null).
function adsStudioCleanResults(body) {
  const src = body && typeof body === 'object' ? body : {};
  const results = src.results && typeof src.results === 'object' ? src.results : {};
  const stage = src.stage && typeof src.stage === 'object' ? src.stage : {};
  const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const labels = value => (value && typeof value === 'object' ? { en: String(value.en || ''), ar: String(value.ar || '') } : null);
  const staff = src.staff && typeof src.staff === 'object' ? src.staff : null;
  return {
    stageLabels: labels(stage.labels),
    variantLabels: labels(stage.variantLabels),
    runningPastEnd: stage.runningPastEnd === true,
    metaUsedMinor: count(results.metaUsedMinor),
    paidMinor: count(results.paidMinor),
    impressions: count(results.impressions),
    reach: count(results.reach),
    resultCount: count(results.resultCount),
    resultType: String(results.resultType || '').slice(0, 80),
    checkedAgo: results.checkedAt ? labels(results.checkedAgo) : null,
    stale: results.stale === true,
    staff: staff ? {
      syncState: String(staff.syncState || ''),
      lastErrorCode: String(staff.lastErrorCode || '').slice(0, 60),
      nextManualCheckAt: String(staff.nextManualCheckAt || '')
    } : null
  };
}

function adsStudioResultsEntry(campaignId) {
  const uid = String(state.currentUser?.id || '');
  if (_adsStudioResults.forUser !== uid) resetAdsStudioResults();
  _adsStudioResults.forUser = uid;
  let entry = _adsStudioResults.byId.get(campaignId);
  if (!entry) {
    entry = { state: '', data: null, at: 0, promise: null };
    _adsStudioResults.byId.set(campaignId, entry);
  }
  return entry;
}

// One render after a burst of card reads, not one per card.
function adsStudioScheduleResultsRender() {
  if (_adsStudioResultsRenderTimer) return;
  if (typeof setTimeout !== 'function') { render(); return; }
  _adsStudioResultsRenderTimer = setTimeout(() => { _adsStudioResultsRenderTimer = null; render(); }, 50);
}

function adsStudioLoadResults(id, force = false) {
  const campaignId = String(id || '');
  if (!campaignId || typeof isServerModeEnabled !== 'function' || !isServerModeEnabled() || typeof apiJson !== 'function') return null;
  const entry = adsStudioResultsEntry(campaignId);
  if (entry.promise) return entry.promise;
  const age = Date.now() - entry.at;
  if (!force && ((entry.state === 'done' && age < ADS_STUDIO_RESULTS_TTL_MS) || (entry.state === 'failed' && age < ADS_STUDIO_RESULTS_RETRY_MS))) return null;
  let reading = 0;
  _adsStudioResults.byId.forEach(item => { if (item.promise) reading += 1; });
  if (reading >= ADS_STUDIO_RESULTS_MAX_READS) return null;
  const uid = _adsStudioResults.forUser;
  entry.state = entry.data ? 'done' : 'loading';
  entry.promise = apiJson(`/api/studio/campaigns/${encodeURIComponent(campaignId)}/results`, { method: 'GET' })
    .then(body => {
      if (uid !== String(state.currentUser?.id || '')) return;
      entry.data = adsStudioCleanResults(body);
      entry.state = 'done';
    })
    .catch(() => { entry.state = 'failed'; })  // a card that had a reading keeps showing it
    .finally(() => {
      entry.at = Date.now();
      entry.promise = null;
      if (uid === String(state.currentUser?.id || '')) adsStudioScheduleResultsRender();
    });
  return entry.promise;
}

function adsStudioResultTypeLabel(type) {
  const hit = ADS_STUDIO_RESULT_TYPES.find(([id]) => id === String(type || ''));
  return hit ? adsStudioText(hit[1], hit[2]) : adsStudioText('Results', 'النتائج');
}

// Counts as the rest of the app writes them (1,234 in both languages; ar-LY would print 1.234).
function adsStudioCount(value) {
  try { return Number(value).toLocaleString('en-US'); } catch (_) { return String(value); }
}

function renderAdsStudioResultsCard(campaign) {
  if (!adsStudioShowsResults(campaign)) return '';
  const campaignId = String(campaign.id || '');
  adsStudioLoadResults(campaignId);
  const entry = _adsStudioResults.byId.get(campaignId);
  const data = entry ? entry.data : null;
  const isAr = adsStudioIsAr();
  const pick = labels => (labels ? (isAr ? labels.ar : labels.en) : '');
  let body = '';
  if (!data) {
    body = `<p class="mt-2 text-sm text-slate-600 dark:text-slate-300">${entry && entry.state === 'failed'
      ? adsStudioText('Meta results cannot be shown right now.', 'تعذّر عرض نتائج ميتا الآن.')
      : adsStudioText('Checking Meta…', 'نتحقق من ميتا…')}</p>`;
  } else {
    const used = data.metaUsedMinor === null ? '' : (data.paidMinor
      ? adsStudioText(`Meta used ${adsStudioMoney(data.metaUsedMinor)} of ${adsStudioMoney(data.paidMinor)}`, `استخدمت ميتا ${adsStudioMoney(data.metaUsedMinor)} من ${adsStudioMoney(data.paidMinor)}`)
      : adsStudioText(`Meta used ${adsStudioMoney(data.metaUsedMinor)} so far`, `استخدمت ميتا ${adsStudioMoney(data.metaUsedMinor)} حتى الآن`));
    const stats = [
      [adsStudioText('Impressions', 'مرات الظهور'), data.impressions],
      [adsStudioText('Reach', 'الوصول'), data.reach],
      [adsStudioResultTypeLabel(data.resultType), data.resultCount]
    ].filter(([, value]) => value !== null);
    const note = data.checkedAgo ? '' : pick(data.variantLabels) || adsStudioText('Checking Meta…', 'نتحقق من ميتا…');
    body = `${used ? `<p class="mt-2 text-base font-black text-slate-900 dark:text-white" data-ads-studio-meta-used="1">${Security.escapeHtml(used)}</p>` : ''}
      ${stats.length ? `<dl class="mt-2 grid grid-cols-3 gap-2 text-center">${stats.map(([label, value]) => `<div class="rounded-lg bg-white/80 dark:bg-slate-900/60 p-2"><dt class="text-[11px] font-bold text-slate-500">${Security.escapeHtml(label)}</dt><dd class="text-sm font-black text-slate-900 dark:text-white">${Security.escapeHtml(adsStudioCount(value))}</dd></div>`).join('')}</dl>` : ''}
      ${note ? `<p class="mt-2 text-sm text-slate-600 dark:text-slate-300">${Security.escapeHtml(note)}</p>` : ''}
      ${data.runningPastEnd ? `<p class="mt-2 text-sm font-bold text-amber-800 dark:text-amber-200">${Security.escapeHtml(adsStudioText('Running past the promised end — the team is on it', 'ما زال يعمل بعد موعد الانتهاء — الفريق يتابعه'))}</p>` : ''}`;
  }
  let staffPart = '';
  if (adsStudioCanReview()) {
    const safeId = Security.escapeHtml(campaignId);
    const busy = _adsStudioResultsChecks.has(campaignId);
    const problem = data && data.staff && ['error', 'throttled', 'not_found', 'not_allowed'].includes(data.staff.syncState)
      ? adsStudioText(`Last Meta check failed (${data.staff.lastErrorCode || data.staff.syncState})`, `فشل آخر فحص لميتا (${data.staff.lastErrorCode || data.staff.syncState})`)
      : '';
    staffPart = `<div class="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" data-ads-studio-check-meta="1" onclick="checkAdsStudioMetaNow('${safeId}', this)"${busy ? ' disabled aria-busy="true"' : ''} class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 text-sm font-bold text-white disabled:opacity-60"><i data-lucide="refresh-cw" class="w-4 h-4"></i>${Security.escapeHtml(adsStudioText('Check Meta now', 'افحص ميتا الآن'))}</button>
      ${problem ? `<span class="text-xs font-bold text-rose-700 dark:text-rose-300" dir="auto">${Security.escapeHtml(problem)}</span>` : ''}
    </div>`;
  }
  const ago = data && data.checkedAgo ? pick(data.checkedAgo) : '';
  return `<section class="mt-4 rounded-xl border border-blue-100 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10 p-3" data-ads-studio-results="${Security.escapeHtml(campaignId)}" aria-live="polite">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h4 class="inline-flex items-center gap-1.5 text-sm font-black text-blue-900 dark:text-blue-100"><i data-lucide="chart-no-axes-combined" class="w-4 h-4"></i>${Security.escapeHtml(adsStudioText('Meta results', 'نتائج ميتا'))}${data && data.stageLabels ? `<span class="font-bold text-slate-600 dark:text-slate-300">· ${Security.escapeHtml(pick(data.stageLabels))}</span>` : ''}</h4>
      ${ago ? `<span class="text-xs ${data.stale ? 'font-bold text-amber-700 dark:text-amber-300' : 'text-slate-500'}">${Security.escapeHtml(ago)}</span>` : ''}
    </div>
    ${body}
    ${staffPart}
  </section>`;
}

function adsStudioResultsErrorText(error) {
  const info = adsStudioErrorInfo(error);
  const known = Object.prototype.hasOwnProperty.call(ADS_STUDIO_RESULTS_ERRORS, info.code) ? ADS_STUDIO_RESULTS_ERRORS[info.code] : null;
  return known ? adsStudioText(known[0], known[1]) : adsStudioText('Meta could not be checked. Try again later.', 'تعذّر فحص ميتا. أعد المحاولة لاحقاً.');
}

// Staff "Check Meta now" (P3-04c): single flight per request; the answer replaces the card's reading.
function checkAdsStudioMetaNow(id, button = null) {
  const campaignId = String(id || '');
  if (!campaignId || !adsStudioCanReview()) return Promise.resolve(false);
  if (_adsStudioResultsChecks.has(campaignId)) return _adsStudioResultsChecks.get(campaignId);
  setAdsStudioActionButtonBusy(button, true);
  const uid = String(state.currentUser?.id || '');
  const operation = (async () => {
    try {
      const body = await apiJson(`/api/studio/campaigns/${encodeURIComponent(campaignId)}/results/refresh`, { method: 'POST', body: {} });
      if (uid !== String(state.currentUser?.id || '')) return false;
      const entry = adsStudioResultsEntry(campaignId);
      entry.data = adsStudioCleanResults(body);
      entry.state = 'done';
      entry.at = Date.now();
      const problem = body && body.checkError && typeof body.checkError === 'object' ? body.checkError : null;
      if (problem) {
        showNotification(adsStudioText('Saved reading shown', 'تظهر القراءة المحفوظة'), adsStudioText(String(problem.en || ''), String(problem.ar || '')), 'warning');
      } else if (body && body.cached) {
        showNotification(adsStudioText('Checked a moment ago', 'فُحصت قبل قليل'), adsStudioText('Meta was checked less than 10 minutes ago, so the saved reading is shown.', 'فُحصت ميتا قبل أقل من 10 دقائق، لذلك تظهر القراءة المحفوظة.'), 'info');
      } else {
        showNotification(adsStudioText('Meta checked', 'تم فحص ميتا'), adsStudioText('The results are up to date.', 'النتائج محدّثة الآن.'), 'success');
      }
      return true;
    } catch (error) {
      showNotification(adsStudioText('Check failed', 'تعذّر الفحص'), adsStudioResultsErrorText(error), 'error');
      return false;
    }
  })();
  _adsStudioResultsChecks.set(campaignId, operation);
  const cleanup = () => {
    if (_adsStudioResultsChecks.get(campaignId) === operation) _adsStudioResultsChecks.delete(campaignId);
    setAdsStudioActionButtonBusy(button, false);
    render();
  };
  operation.then(cleanup, cleanup);
  return operation;
}

function deleteAdsStudioCampaign(id, button = null) {
  const campaignId = String(id || '');
  if (_adsStudioDeletePromises.has(campaignId)) return _adsStudioDeletePromises.get(campaignId);
  const campaign = findVisibleAdsStudioCampaign(campaignId);
  const status = String(campaign?.status || '');
  if (!campaign || !['Draft', 'Changes Requested', 'Approved', 'Rejected', 'Stopped'].includes(status) || !canActOnRecord('adCampaignRequests', 'delete', campaign.createdBy)) return Promise.resolve(false);
  const isTerminal = status === 'Approved' || status === 'Rejected' || status === 'Stopped';
  const confirmed = confirm(adsStudioText(
    isTerminal ? 'Archive this campaign and remove its stored creative images?' : 'Delete this campaign draft?',
    isTerminal ? 'أرشفة هذه الحملة وحذف صورها الإعلانية المخزنة؟' : 'حذف مسودة هذه الحملة؟'
  ));
  if (!confirmed) return Promise.resolve(false);
  setAdsStudioActionButtonBusy(button, true);
  const operation = (async () => {
    const deleted = await deleteRecord(state.adCampaignRequests, campaignId);
    if (!deleted) return false;
    if (typeof clearTransientEntityMediaCache === 'function') clearTransientEntityMediaCache('adCampaignRequests');
    delete _adsStudioReviewNotes[campaignId];
    if (_adsStudioEditingId === campaignId) beginAdsStudioCampaign();
    showNotification(
      adsStudioText(isTerminal ? 'Campaign archived' : 'Draft deleted', isTerminal ? 'تمت أرشفة الحملة' : 'تم حذف المسودة'),
      adsStudioText(isTerminal ? 'The campaign and its stored creative images were removed.' : 'The campaign draft was removed.', isTerminal ? 'تم حذف الحملة وصورها الإعلانية المخزنة.' : 'تم حذف مسودة الحملة.'),
      'success'
    );
    return true;
  })();
  _adsStudioDeletePromises.set(campaignId, operation);
  const cleanup = () => {
    if (_adsStudioDeletePromises.get(campaignId) === operation) _adsStudioDeletePromises.delete(campaignId);
    setAdsStudioActionButtonBusy(button, false);
  };
  operation.then(cleanup, cleanup);
  return operation;
}

function stopAdsStudioCampaign(id, button = null) {
  const campaignId = String(id || '');
  if (_adsStudioStopPromises.has(campaignId)) return _adsStudioStopPromises.get(campaignId);
  setAdsStudioActionButtonBusy(button, true);
  const operation = stopAdsStudioCampaignOnce(campaignId);
  _adsStudioStopPromises.set(campaignId, operation);
  const cleanup = () => {
    if (_adsStudioStopPromises.get(campaignId) === operation) _adsStudioStopPromises.delete(campaignId);
    setAdsStudioActionButtonBusy(button, false);
  };
  operation.then(cleanup, cleanup);
  return operation;
}

// Server refusals a customer can hit in the studio, in their language.
const _ADS_STUDIO_REFUSAL_AR = [
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
  ['Only Approved campaigns can be stopped', 'لا يمكن إيقاف إلا الحملات المعتمدة'],
  // P1 refusals (P1-08c): the server's exact English prefixes. A third item keeps the dynamic part
  // the server writes after the prefix: 'money' (an amount), 'days' (a number of days) or 'aside'
  // (an optional amount in brackets). Entries are only ever added, so older bundles keep theirs.
  ['The total budget must be at least ', 'يجب ألا يقل إجمالي الميزانية عن ', 'money'],
  ['The total budget must be at most ', 'يجب ألا يزيد إجمالي الميزانية عن ', 'money'],
  ['Budget per day is below the minimum', 'الميزانية اليومية أقل من الحد الأدنى', 'aside'],
  ['The ad can run for at most ', 'أقصى مدة لتشغيل الإعلان هي ', 'days'],
  ['New ad requests are paused', 'استقبال طلبات الإعلانات الجديدة متوقف مؤقتاً'],
  ["Today's limit of new ad requests is reached", 'تم الوصول إلى الحد اليومي لطلبات الإعلانات الجديدة'],
  ['Choose a reason for this decision', 'اختر سبباً لهذا القرار'],
  ['Unknown reason code', 'رمز السبب غير معروف'],
  ['The goal detail does not match the objective', 'تفاصيل الهدف لا تتوافق مع هدف الإعلان'],
  ['Unknown location', 'موقع غير معروف'],
  ['Choose a post or add your own photo and text', 'اختر منشوراً أو أضف صورتك ونصك'],
  ['This page is not linked to your account', 'هذه الصفحة غير مرتبطة بحسابك'],
  ['This post is not from your linked page', 'هذا المنشور ليس من صفحتك المرتبطة'],
  ['durationDays must be a whole number of days', 'يجب أن تكون مدة الإعلان عدداً صحيحاً من الأيام'],
  // Submit of a picked Instagram post while Meta is busy (studio_posts.verify_source_post, 503).
  ['Meta is busy right now, so the chosen post could not be checked', 'ميتا مشغولة الآن، لذلك تعذر التحقق من المنشور المختار. حاول مرة أخرى بعد دقيقة.'],
  // Withdraw (P1-03, stage 7) and the staff link of a Meta campaign (P1-09, D26).
  ['Only Submitted campaigns can be withdrawn', 'يمكن سحب الطلبات التي تنتظر المراجعة فقط'],
  ['This request was already approved', 'تمت الموافقة على هذا الطلب بالفعل — اطلب إيقافه بدلاً من سحبه'],
  ['Campaign is missing its owner', 'هذا الطلب غير مرتبط بحساب صاحبه — تواصل مع فريق البيان'],
  ['This Meta campaign is already linked to another request', 'حملة ميتا هذه مرتبطة بطلب آخر'],
  ['Rename the campaign in Meta to the name shown, then link again', 'غيّر اسم الحملة في ميتا إلى الاسم الظاهر ثم اربطها مرة أخرى'],
  ["This Meta ad account is not one of Albayan's ad accounts", 'حساب الإعلانات هذا ليس من حسابات البيان الإعلانية'],
  ['The Meta campaign was not found', 'لم يتم العثور على حملة ميتا'],
  // The rest of the link step (REFUSE_LINK_*, the studio code; ad_campaign_actions.py), the approval and
  // publish-status texts, and the Manager link's refusals of a studio ad (meta_ads.py): exact server texts.
  ['Only Approved requests can be linked to a Meta campaign', 'يمكن ربط الطلبات المعتمدة فقط بحملة ميتا'],
  ['Invalid Meta ad account id', 'رقم حساب إعلانات ميتا غير صالح — أرقام فقط'],
  ['Invalid Meta campaign id', 'رقم حملة ميتا غير صالح — أرقام فقط'],
  ['This Meta campaign is not in the chosen ad account', 'حملة ميتا هذه ليست في حساب الإعلانات المختار'],
  ["This Meta campaign carries another request's studio code", 'اسم حملة ميتا هذه يحمل رمز الاستوديو لطلب آخر'],
  ['This request is already linked to another Meta campaign', 'هذا الطلب مرتبط بالفعل بحملة ميتا أخرى'],
  ['Meta is busy right now, so the campaign could not be linked', 'ميتا مشغولة الآن، لذلك تعذر ربط الحملة. حاول مرة أخرى بعد دقيقة.'],
  ['Meta could not return this campaign', 'لم تُرجع ميتا بيانات هذه الحملة — حاول مرة أخرى بعد قليل'],
  ['The Meta connection is not configured', 'ربط البيان مع ميتا غير مُعدّ'],
  ['Too many Meta links', 'محاولات ربط كثيرة مع ميتا — انتظر دقيقة ثم حاول مرة أخرى'],
  ['Could not assign a studio code', 'تعذر تخصيص رمز الاستوديو لهذا الطلب — حاول مرة أخرى'],
  ['Only Submitted campaigns can be reviewed', 'يمكن مراجعة الطلبات التي تنتظر المراجعة فقط'],
  ['You cannot review your own campaign', 'لا يمكنك مراجعة حملتك أنت'],
  ['Invalid review decision', 'قرار المراجعة غير صالح'],
  ['operationId was already used for another review', 'هذه العملية استُخدمت لمراجعة أخرى — حدّث الصفحة وحاول مرة أخرى'],
  ['Only Approved campaigns can be marked launched', 'يمكن تحديث حالة النشر للحملات المعتمدة فقط'],
  ['operationId was already used for another update', 'هذه العملية استُخدمت لتحديث آخر — حدّث الصفحة وحاول مرة أخرى'],
  ['expectedVersion is required', 'نسخة الطلب غير معروفة — حدّث الصفحة وحاول مرة أخرى'],
  ['A link sets publishStatus meta_review; leave publishStatus out', 'الربط يضبط حالة النشر بنفسه — حدّث الصفحة وحاول مرة أخرى'],
  ['publishStatus is required (or metaAdAccountId and metaCampaignId to link a Meta campaign)', 'اختر حالة النشر، أو حساب الإعلانات ورقم الحملة لربط حملة ميتا'],
  ['meta_review is set by linking a Meta campaign', 'حالة «ميتا تراجع الإعلان» تُضبط بربط حملة ميتا'],
  ['Campaign request not found', 'لم يتم العثور على طلب الحملة'],
  ['This Meta ad belongs to Albayan Studio (a studio request linked its campaign). It cannot be linked to an Albayan Manager ad', 'إعلان ميتا هذا تابع لاستوديو البيان (ربط طلبٌ في الاستوديو حملته)، ولا يمكن ربطه بإعلان في مدير البيان'],
  ['This Meta ad belongs to Albayan Studio (its campaign name carries the studio code ALB-S-). It cannot be linked to an Albayan Manager ad', 'إعلان ميتا هذا تابع لاستوديو البيان (اسم حملته يحمل رمز الاستوديو ALB-S-)، ولا يمكن ربطه بإعلان في مدير البيان'],
  ["Albayan could not read this ad's Meta campaign name to confirm it is not an Albayan Studio ad", 'تعذر على البيان قراءة اسم حملة هذا الإعلان في ميتا للتأكد من أنه ليس من إعلانات استوديو البيان. حاول مرة أخرى بعد دقيقة.'],
  // Instagram "Check recent comments now" (studio_ig_poll.py, {code, message}).
  ['No linked page has this id', 'لا توجد صفحة مربوطة بهذا الرقم'],
  ['This linked page is not an Instagram account', 'هذه الصفحة المربوطة ليست حساب إنستغرام'],
  ['Only an admin can use this', 'هذه الأداة للمدير فقط'],
  ['This change must come from the Albayan site itself', 'يجب أن يأتي هذا التغيير من موقع البيان نفسه — افتح البيان مباشرة ثم أعد المحاولة'],
  ['Too many requests. Please wait and try again.', 'طلبات كثيرة. انتظر قليلاً ثم أعد المحاولة.'],
  ["Albayan's Meta connection is not set up, so no comment was read", 'ربط البيان مع ميتا غير مُعدّ، لذلك لم يُقرأ أي تعليق'],
  ['Meta asked Albayan to wait, so no comment was read', 'طلبت ميتا من البيان الانتظار، لذلك لم يُقرأ أي تعليق. أعد المحاولة بعد بضع دقائق.'],
  ['This Instagram account was checked less than a minute ago', 'فُحص حساب إنستغرام هذا قبل أقل من دقيقة. أعد المحاولة بعد دقيقة.'],
  // Staff unlink of a Meta link (ad_campaign_actions.py unlink-meta).
  ['Write why the link is removed', 'اكتب سبب إلغاء الربط (من 3 إلى 300 حرف)'],
  ['Only an Approved request can be unlinked from its Meta campaign', 'لا يمكن إلغاء ربط حملة ميتا إلا لطلب معتمد'],
  ['This request is not linked to a Meta campaign', 'هذا الطلب غير مرتبط بحملة ميتا'],
  // Ask to stop (P3-10, studio_stop.py REFUSE_STOP_REQUEST_OFF); "Only Approved campaigns can be stopped" is above.
  ['Stop requests are not open yet', 'طلب إيقاف الإعلان غير متاح بعد. تواصل مع فريق البيان.'],
  ['note must be text', 'يجب أن تكون الملاحظة نصاً'],
  // Reply rules and the page check of the v2 Pages & replies screens (P4-06, social_studio.py: _clean_rule,
  // _text_field, _string_list, editor_refusal, _require_admin, _scope): the server's exact English prefixes.
  ['Rule name is required', 'اكتب اسماً للقاعدة'],
  ['Rule name must be 80 characters or fewer', 'اسم القاعدة يجب ألا يتجاوز 80 حرفاً'],
  ['publicReply must be 1000 characters or fewer', 'الرد العام يجب ألا يتجاوز 1000 حرف'],
  ['dmText must be 1000 characters or fewer', 'الرسالة الخاصة يجب ألا تتجاوز 1000 حرف'],
  ['Each keywords entry must be 40 characters or fewer', 'كل كلمة مفتاحية يجب ألا تتجاوز 40 حرفاً'],
  ['keywords supports at most 30 entries', 'الحد الأقصى 30 كلمة مفتاحية للقاعدة الواحدة'],
  ['platform must be fb or ig', 'المنصة يجب أن تكون فيسبوك أو إنستغرام'],
  ['trigger must be every or keywords', 'المُحفّز يجب أن يكون «كل تعليق» أو «كلمات مفتاحية»'],
  ['Add at least one keyword for a keyword rule', 'أضف كلمة مفتاحية واحدة على الأقل، أو اختر «كل تعليق»'],
  ['Choose at least one post for a chosen-posts rule', 'اختر منشوراً واحداً على الأقل لقاعدة المنشورات المحددة'],
  ['A rule needs a public reply or a private message', 'تحتاج القاعدة إلى رد عام أو رسالة خاصة'],
  ['is not linked to this account', 'هذه الصفحة لم تعد مربوطة بحسابك — حدّث الصفحة واختر صفحة أخرى'],
  ["is not on this rule's platform", 'هذه الصفحة ليست على منصة هذه القاعدة'],
  ['Private messages are not available for Facebook pages right now', 'الرسائل الخاصة غير متاحة لصفحات فيسبوك حالياً'],
  ['Private messages are not available for Instagram accounts right now', 'الرسائل الخاصة غير متاحة لحسابات إنستغرام حالياً'],
  ['Public replies are not available for Facebook pages right now', 'الردود العامة غير متاحة لصفحات فيسبوك حالياً'],
  ['Public replies are not available for Instagram accounts right now', 'الردود العامة غير متاحة لحسابات إنستغرام حالياً'],
  ['Likes are not available for Facebook pages right now', 'الإعجاب بالتعليقات غير متاح لصفحات فيسبوك حالياً'],
  ['You can only manage your own Social Studio', 'يمكنك إدارة صفحاتك وردودك أنت فقط'],
  ['Admin only', 'هذا الإجراء للمدير فقط'],
  // ONE Arabic map (stage 15, P2-11): the entries below came from the v2 pattern list (15g) and the
  // Team desk's own list (15p); both layouts now read every plain-English server text through this
  // map (adsStudioRefusalText, 15g studioErrorInfo). A needle may be a RegExp (an anchored shape); a
  // fourth item is the English shown instead of the server's own words (both layouts; the third item
  // stays the dynamic kind of the P1 entries above, '' here). The first match wins, so the exact
  // texts come before the generic shapes at the end. Entries are only ever added.
  // -- the settle routes of the Team desk (ad_campaign_actions.py REFUSE_SETTLE_* / REFUND_* / OVERRIDE_*)
  ['Meta is still delivering this ad', 'ما زالت ميتا تعرض هذا الإعلان. أوقفه في ميتا أولاً، ثم سوِّ الحساب بعد القراءة النهائية.', '', 'Meta is still delivering this ad. Pause it in Meta first, then settle after the final read.'],
  ['Meta has not confirmed that this ad ended', 'لم تؤكد ميتا انتهاء هذا الإعلان بعد. افحص ميتا الآن ثم أعد المحاولة.', '', 'Meta has not confirmed that this ad ended yet. Check Meta now, then try again.'],
  ['The final amount is not ready', 'المبلغ النهائي غير جاهز: قراءة ميتا النهائية لم تصل بعد.', '', 'The final amount is not ready: the final Meta read is still pending.'],
  ['This ad account does not bill in USD', 'هذا الحساب الإعلاني لا يُحاسب بالدولار، لذلك يحتاج المبلغ النهائي إلى تجاوز من المدير.', '', 'This ad account does not bill in USD, so the final amount needs an admin override.'],
  ['refundMinorUSD is above paid minus Meta spend', 'المبلغ المعاد أكبر مما تبقى بعد صرف ميتا. اخفضه (يمكن للمدير التجاوز مع كتابة السبب).', '', "The return is above what is left after Meta's spend. Lower it (an admin can override with a written reason)."],
  ['refundMinorUSD must be between 0 and the paid budget', 'يجب أن يكون المبلغ المعاد بين 0 وما دفعه العميل.', '', 'The return must be between 0 and what the customer paid.'],
  ['refundMinorUSD must be between 0 and the unspent captured budget', 'يجب أن يكون المبلغ المعاد بين 0 والميزانية غير المصروفة.', '', 'The return must be between 0 and the unspent budget.'],
  ['Only an admin can override the settlement rules', 'تجاوز قواعد التسوية للمدير فقط.', '', 'Only an admin can override the settlement rules.'],
  ['Nobody can override the settlement of their own request', 'لا يمكن لأحد تجاوز تسوية طلبه هو.', '', 'Nobody can override the settlement of their own request.'],
  ['Write why the settlement rules are lifted', 'اكتب سبب تجاوز القواعد (من 10 إلى 300 حرف).', '', 'Write why the rules are lifted (10 to 300 characters).'],
  ['Financial period', 'هذا الشهر مقفل في الدفاتر. يجب أن يفتحه المدير أولاً.', '', 'This month is closed in the books. An admin must unlock it first.'],
  // -- the ad request (ad_campaign_actions.py, ad_campaign_fields.py, studio_posts.py)
  [/^destination must be an HTTPS website/, 'يجب أن تكون الوجهة موقعاً يبدأ بـ https:// أو رابط واتساب أو ماسنجر أو رقم هاتف دولياً.', '',
    'The destination must be an https:// website, a WhatsApp or Messenger link, or an international phone number.'],
  [/^sourcePostRef (must be an HTTPS link|is required for a Boost Post)/, 'الصق رابط منشور من فيسبوك أو إنستغرام.', '', 'Paste the link of a Facebook or Instagram post.'],
  [/^sourcePost(Platform|Id) /, 'اختر المنشور مرة أخرى من صفحتك المربوطة.', '', 'Pick the post again from your linked page.'],
  [/^Only Draft or Changes Requested campaigns can be submitted/, 'لا يمكن إرسال إلا مسودة أو طلب أُعيد للتعديل.', '', 'Only a draft or a request sent back for changes can be sent.'],
  [/campaign needs a budget greater than zero/, 'حدّد ميزانية أكبر من صفر أولاً.', '', 'Set a budget above zero first.'],
  [/^Only staff can choose (a partial refund amount|how a campaign closed)/, 'فريق البيان وحده يحدد مبلغ الاسترداد وطريقة إغلاق الإعلان.', '', 'Only the Albayan team chooses the refund amount and how an ad closes.'],
  [/^Forbidden$/, 'لا تملك صلاحية الوصول إلى هذا.', '', 'You do not have access to this.'],
  [/^goalDetail must be one of/, 'اختر هدفاً من القائمة.', '', 'Choose one of the listed goals.'],
  [/^locationKeys (must be a list|must contain only text|cannot combine all of Libya)/, 'اختر حتى 25 موقعاً؛ لا يمكن الجمع بين «كل ليبيا» ومدينة.', '', 'Choose up to 25 places; "All of Libya" cannot be combined with a city.'],
  [/^(creativeImages |creativeAssetIds contains|Each campaign image must be 4 MB|Campaign image dimensions are too large|A campaign image data URL is too large|Campaign images contain too many total pixels)/,
    'الصور غير مقبولة: استخدم حتى 3 صور PNG أو JPEG أو WebP، كل واحدة أقل من 4 ميغابايت.', '', 'The photos are not accepted: use up to 3 PNG, JPEG or WebP photos, each under 4 MB.'],
  [/^Unsupported (callToAction|campaign objective|advertising platform|gender targeting value|special ad category)/, 'أحد الخيارات لم يعد في القائمة. أعد تحميل الصفحة واختر مرة أخرى.', '', 'One of the choices is not in the list any more. Reload the page and choose again.'],
  [/^specialAdCategories cannot combine none/, 'لا يمكن الجمع بين «لا شيء» وفئة خاصة أخرى.', '', '"None" cannot be combined with another special category.'],
  [/^ageMin cannot be greater than ageMax/, 'لا يمكن أن يكون أصغر عمر أكبر من أكبر عمر.', '', 'The youngest age cannot be above the oldest.'],
  [/^budgetMinorUSD must be a non-negative integer/, 'يجب أن تكون الميزانية عدداً صحيحاً من السنتات ضمن الحد.', '', 'The budget must be a whole number of cents within the limit.'],
  [/^endDate cannot be before startDate/, 'لا يمكن أن يكون تاريخ الانتهاء قبل تاريخ البدء.', '', 'The end date cannot be before the start date.'],
  [/^Campaign duration cannot exceed 366 days/, 'لا يمكن أن يعمل الإعلان أكثر من 366 يوماً.', '', 'An ad cannot run longer than 366 days.'],
  [/required before submission$/, 'ما زال شيء ناقصاً: أكمل كل الخطوات (الصفحة والنص والصورة والجمهور والتواريخ والميزانية) قبل الإرسال.', '',
    'Something is still missing: fill every step (page, text, photo, audience, dates and budget) before sending.'],
  // -- pages, reply rules and posts (social_studio.py)
  [/^This page is already linked to an account/, 'هذه الصفحة مربوطة بحساب آخر بالفعل.', '', 'This page is already linked to another account.'],
  [/^quietHours/, 'تحتاج ساعات الهدوء إلى وقت بداية ونهاية (HH:MM).', '', 'Quiet hours need a from and a to time (HH:MM).'],
  [/^Unknown timezone/, 'هذه المنطقة الزمنية غير معروفة.', '', 'This time zone is not known.'],
  [/^Choose at least one page/, 'اختر صفحة واحدة على الأقل.', '', 'Choose at least one page.'],
  [/^(media must be a list of images|A post supports at most \d+ photos|Photo \d+\b)/, 'صور المنشور غير مقبولة: PNG أو JPEG أو WebP، كل واحدة أقل من 3 ميغابايت، وبعدد معقول.', '',
    'The post photos are not accepted: PNG, JPEG or WebP, each under 3 MB, and not too many.'],
  [/^A post needs a caption or at least one photo/, 'يحتاج المنشور إلى نص أو صورة واحدة على الأقل.', '', 'A post needs a caption or at least one photo.'],
  [/^scheduledAt /, 'اختر تاريخاً ووقتاً بعد دقيقة واحدة على الأقل من الآن.', '', 'Choose a date and time at least one minute in the future.'],
  [/^autoReplyRuleId is not one of your rules/, 'قاعدة الرد المختارة ليست من قواعدك.', '', 'The chosen reply rule is not one of yours.'],
  [/^Post is not claimed for publishing/, 'هذا المنشور ليس قيد النشر الآن. حدّث الصفحة وحاول مرة أخرى.', '', 'This post is not being published right now. Refresh and try again.'],
  [/^Only draft, scheduled or failed posts can be changed/, 'لا يمكن تغيير إلا مسودة أو منشور مجدول أو منشور فشل نشره.', '', 'Only a draft, a scheduled post or a failed post can be changed.'],
  [/^A page already published this post/, 'نشرت صفحة هذا المنشور بالفعل، لذلك لا يمكن تغيير نصه وصوره هنا. أعد المحاولة للصفحات التي فشلت أو احذف المنشور (يبقى المنشور على ميتا).', '',
    'A page already published this post, so its text and photos cannot change here. Retry the failed pages or delete the post (the live post stays on Meta).'],
  [/^The post changed while publishing/, 'تغيّر المنشور أثناء نشره. حدّث الصفحة وحاول مرة أخرى.', '', 'The post changed while it was being published. Refresh and try again.'],
  [/^Only scheduled posts can be cancelled/, 'لا يمكن إلغاء إلا منشور مجدول.', '', 'Only a scheduled post can be cancelled.'],
  // -- the wallet (wallet_payments.py)
  [/^Campaign is no longer awaiting review/, 'هذا الطلب لم يعد بانتظار المراجعة. حدّث الصفحة وحاول مرة أخرى.', '', 'This request is no longer waiting for review. Refresh and try again.'],
  [/^Customer wallet can no longer cover this campaign budget/, 'لم تعد محفظة العميل تغطي هذه الميزانية.', '', "The customer's wallet no longer covers this budget."],
  [/^(No captured payment exists for this campaign cycle|The captured payment row is not refundable|This campaign cycle's payment was already returned|This campaign's payment was already reversed by an admin)/,
    'لا توجد لهذا الإعلان دفعة يمكن إعادتها.', '', 'This ad has no payment that can still be returned.'],
  [/^Refund must be between 1 cent and the captured budget/, 'يجب أن يكون المبلغ المسترد بين سنت واحد والمبلغ المدفوع.', '', 'The refund must be between one cent and the amount paid.'],
  [/^Conflict: payment request has changed/, 'تغيّر طلب الدفع هذا في الأثناء. حدّث الصفحة وحاول مرة أخرى.', '', 'This payment request changed meanwhile. Refresh and try again.'],
  [/^(The wallet is charged in USD or LYD|Unknown payment method)/, 'اختر عملة (دولار أو دينار) وطريقة دفع من القائمة.', '', 'Choose a currency (USD or LYD) and a payment method from the list.'],
  [/^Minimum wallet charge is 1\.00/, 'أقل مبلغ للشحن هو 1.00 من العملة.', '', 'The smallest top-up is 1.00 of the currency.'],
  [/^Idempotency key was already used for another operation/, 'أُرسل هذا من قبل بتفاصيل مختلفة. حدّث الصفحة وأعد المحاولة.', '', 'This was already sent with different details. Refresh and try again.'],
  [/^Too many unpaid charge requests/, 'لديك طلبات شحن غير مدفوعة كثيرة. ادفع إحداها أو ألغِها أولاً.', '', 'You have too many unpaid top-up requests. Pay or cancel one first.'],
  [/^The receipt photo is invalid or too large/, 'صورة الإيصال غير مقبولة: استخدم صورة JPG أو PNG واضحة أقل من 4 ميغابايت.', '', 'The receipt photo is not accepted: use a clear JPG or PNG under 4 MB.'],
  [/^Only a pending request can take a receipt/, 'لا يمكن إرفاق إيصال إلا بطلب ما زال بانتظار الدفع.', '', 'A receipt can be attached only to a request that is still waiting for payment.'],
  [/^Payment request is /, 'طلب الدفع هذا لم يعد مفتوحاً. حدّث الصفحة.', '', 'This payment request is no longer open. Refresh the page.'],
  [/^The customer has not attached the transfer receipt yet/, 'لم يرفق العميل إيصال التحويل بعد.', '', 'The customer has not attached the transfer receipt yet.'],
  [/^This account was deleted; cancel the request instead/, 'حُذف هذا الحساب؛ ألغِ الطلب بدلاً من ذلك.', '', 'This account was deleted; cancel the request instead.'],
  [/^Payment was already received/, 'استُلمت هذه الدفعة بالفعل؛ أكّدها بدلاً من ذلك.', '', 'This payment was already received; confirm it instead.'],
  // -- generic shapes of a field check (last, so the exact texts above win)
  [/^(?!expectedVersion )\w+ is required$/, 'إحدى الخانات المطلوبة فارغة.', '', 'A required field is empty.'],
  [/characters or fewer$/, 'أحد النصوص طويل جداً.', '', 'One of the texts is too long.'],
  [/ supports at most \d+ entries$/, 'إحدى القوائم تحوي عناصر كثيرة.', '', 'One of the lists has too many entries.'],
  [/^(?!note )\w+ (must be text|must be a list( of at most \d+ items)?|must contain only text|must be a valid ISO date|must be an integer from 18 to 65)$/,
    'إحدى الخانات تحمل قيمة من نوع غير مناسب. راجع النموذج وحاول مرة أخرى.', '', 'One of the fields has a value of the wrong kind. Check the form and try again.'],
  [/^(boostType must be|autoReply must be|extendsCampaignId is invalid|Invalid operationId|budgetType must be|connectedAssetId is invalid|Campaign data must be an object|Unsupported campaign field|platform must be fb or ig|scope must be all or chosen|trigger must be every or keywords|status must be draft or scheduled|reason must be instagram_private or empty|Unknown (log|post) status|before must be <createdAt>:<id>|metaPageId must be the numeric Meta page id|igUserId is required for an Instagram account)/,
    'أرسلت هذه الشاشة شيئاً لا يقبله الخادم. أعد تحميل الصفحة وحاول مرة أخرى.', '', 'This screen sent something the server does not accept. Reload the page and try again.'],
];
// The map entry for a server text: a string needle is a prefix or a piece of the text, a RegExp an
// anchored shape; the first match wins.
function adsStudioRefusalEntry(text) {
  const words = String(text || '');
  return _ADS_STUDIO_REFUSAL_AR.find(([needle]) => (typeof needle === 'string' ? words.includes(needle) : needle.test(words))) || null;
}
// A /api/studio refusal is {code, message}; the classic routes send a plain string (a 422 a list).
// English readers get the server's own words unless the entry carries a fourth item (its English).
function adsStudioRefusalText(detail) {
  const text = Array.isArray(detail) ? detail.map(item => String(typeof item === 'string' ? item : (item?.msg || ''))).filter(Boolean).join('; ')
    : detail && typeof detail === 'object' ? String(detail.message || '') : String(detail || '');
  const hit = adsStudioRefusalEntry(text);
  if (!adsStudioIsAr()) return hit && hit[3] ? hit[3] : text;
  if (!hit) return text;
  if (!hit[2]) return hit[1];
  const tail = text.slice(text.indexOf(hit[0]) + hit[0].length);
  if (hit[2] === 'days') {
    const days = tail.match(/\d+/);
    return days ? `${hit[1]}${adsStudioDaysText(Number(days[0]))}.` : hit[1].trim();
  }
  const amount = tail.match(/\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?/);
  if (hit[2] === 'aside') return amount ? `${hit[1]} (${amount[0]}).` : `${hit[1]}.`;
  return amount ? `${hit[1]}${amount[0]}.` : hit[1].trim();
}

async function stopAdsStudioCampaignOnce(id) {
  const campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign || String(campaign.status || '') !== 'Approved') return false;
  const own = String(campaign.createdBy || '') === String(state.currentUser?.id || '');
  const staff = adsStudioCanReview() && !own;  // the server applies the customer rule to a reviewer's own campaign
  if (!staff && !canActOnRecord('adCampaignRequests', 'stop', campaign.createdBy)) return false;
  if (!isServerModeEnabled()) {
    showNotification(
      adsStudioText('Server connection required', 'يتطلب اتصال الخادم'),
      adsStudioText('Refunds move wallet money, which needs the server connection.', 'الاسترداد يحرك أموال المحفظة، وهذا يتطلب اتصال الخادم.'),
      'error'
    );
    return false;
  }
  const paid = Math.max(0, parseInt(campaign.paidMinorUSD, 10) || 0);
  const spent = Math.min(Math.max(0, parseInt(campaign.spendMinorUSD, 10) || 0), paid);
  let refundMinor = null;
  if (staff) {
    const remaining = paid - spent;
    const launched = !!(String(campaign.publishStatus || '').trim() || String(campaign.metaCampaignId || '').trim());
    // A launched campaign has spent on Meta and nothing records that spend: never
    // pre-fill the whole budget (the server refuses a blind default too).
    const answer = prompt(
      adsStudioText(
        `${launched ? 'Close this campaign. Unspent budget to refund' : 'Refund amount'} in USD (0 to ${(remaining / 100).toFixed(2)}):`,
        `${launched ? 'إغلاق هذه الحملة. المبلغ غير المصروف المراد استرداده' : 'مبلغ الاسترداد'} بالدولار (من 0 إلى ${(remaining / 100).toFixed(2)}):`
      ),
      launched ? '0.00' : (remaining / 100).toFixed(2)
    );
    if (answer === null) return false;
    // "1,000" is a thousand, "12,50" is a decimal — never silently under-refund.
    let cleaned = normalizeDigitsAscii(String(answer)).replace(/[٫،]/g, ',').replace(/\s+/g, '');
    if (cleaned.includes(',') && cleaned.includes('.')) cleaned = cleaned.split(',').join('');
    else if (cleaned.includes(',')) cleaned = /^\d+,\d{1,2}$/.test(cleaned) ? cleaned.replace(',', '.') : cleaned.split(',').join('');
    const parsed = Math.round(parseFloat(cleaned) * 100);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > remaining) {
      showNotification(adsStudioText('Invalid amount', 'مبلغ غير صالح'), adsStudioText(`Enter a number between 0 and ${(remaining / 100).toFixed(2)}.`, `أدخل رقماً بين 0 و${(remaining / 100).toFixed(2)}.`), 'error');
      return false;
    }
    refundMinor = parsed;
  } else if (!confirm(adsStudioText(
    `Stop this campaign? ${adsStudioMoneyWithLyd(paid)} returns to your wallet.`,
    `إيقاف هذه الحملة؟ سيعود ${adsStudioMoneyWithLyd(paid)} إلى محفظتك.`
  ))) {
    return false;
  }
  try {
    const attempt = adsStudioActionAttempt('stop', campaign.id, Number(campaign._lastModified));
    let entity;
    try {
      entity = await withRetry(() => apiStopAdCampaignRequest(
        campaign.id, attempt.expectedLastModified, attempt.operationId, null, refundMinor
      ), 2, 500);
    } catch (e) {
      const fresh = e?.status === 409 ? await adsStudioReloadCampaign(campaign.id) : null;
      if (!fresh || String(fresh.data?.status || '') !== 'Stopped') throw e;
      entity = fresh;
    }
    _adsStudioActionAttempts.delete(attempt.key);
    upsertAdsStudioEntity(entity);
    resetAdsStudioWalletCache();
    refreshAdsStudioWallet();
    const refunded = Math.max(0, parseInt(entity?.data?.refundMinorUSD, 10) || 0);
    showNotification(
      adsStudioText('Campaign stopped', 'تم إيقاف الحملة'),
      refunded
        ? adsStudioText(`${adsStudioMoney(refunded)} was returned to the wallet.`, `تمت إعادة ${adsStudioMoney(refunded)} إلى المحفظة.`)
        : adsStudioText('The campaign was stopped.', 'تم إيقاف الحملة.'),
      'success'
    );
    render();
    return true;
  } catch (e) {
    const detail = (e?.payload && e.payload.detail) ? e.payload.detail : (e?.message || adsStudioText('Refresh and try again.', 'حدّث الصفحة وحاول مرة أخرى.'));
    showNotification(adsStudioText('Could not stop the campaign', 'تعذر إيقاف الحملة'), adsStudioRefusalText(detail), 'error');
    return false;
  }
}

// One operation id per campaign version: a retry after a lost reply replays
// the same action instead of minting a second one, and a 409 on a stale
// version is checked against the server before it is reported as a failure.
const _adsStudioActionAttempts = new Map();
function adsStudioActionAttempt(kind, id, expectedLastModified) {
  const key = `${kind}:${id}`;
  const prior = _adsStudioActionAttempts.get(key);
  if (prior && prior.expectedLastModified === expectedLastModified) return prior;
  const attempt = { key, expectedLastModified, operationId: Security.generateSecureId(`campaign-${kind}`) };
  _adsStudioActionAttempts.set(key, attempt);
  return attempt;
}

async function adsStudioReloadCampaign(id) {
  try {
    const entity = await apiJson(`/api/collections/adCampaignRequests/${encodeURIComponent(id)}`, { method: 'GET' });
    if (entity && entity.data) {
      upsertAdsStudioEntity(entity);
      return entity;
    }
  } catch (_) {}
  return null;
}

// One key per (amount, method) until the request is created: a retry after
// a lost reply replays the same request instead of piling up duplicates on
// the admin's pending list.
let _adsStudioChargeIdem = { fingerprint: '', key: '' };
function adsStudioOpenChargeForm() {
  // The studio shell has no wallet page: the charge form lives on the Overview
  // tab, or under the activate card for a lapsed customer.
  _adsStudioActiveTab = 'dashboard';
  if (state.currentView !== 'ads-studio') navigateTo('ads-studio'); else render();
  setTimeout(() => { try { document.getElementById('ads-studio-charge-amount')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {} }, 150);
}

function adsStudioChargeIdemKey(amountMinor, method) {
  const fingerprint = `${state.currentUser?.id || ''}|${amountMinor}|${method}`;
  if (_adsStudioChargeIdem.fingerprint !== fingerprint) {
    _adsStudioChargeIdem = { fingerprint, key: Security.generateSecureId('paycreate') };
  }
  return _adsStudioChargeIdem.key;
}

// ---- Staff: link the Meta campaign (P1-09, owner decision D26) ----
// Staff create the ad in Meta with any name, then link it here. The server checks that the ad
// account is allowlisted, that the campaign exists in it and that no other request holds it; it
// renames the campaign in Meta to the request's studio name ("ALB-S-XXXXXXXX · <name>", assigned at
// approval) and claims it for Albayan Studio. When the Meta key cannot rename (no ads_management),
// the answer is NEEDS_MANUAL_RENAME: staff copy the name, rename by hand and press Link again.

// Digits only (Arabic-Indic digits too): an id pasted as "act_123" or with spaces becomes "123".
function adsStudioDigitsOnly(raw) {
  return normalizeDigitsAscii(String(raw ?? '')).replace(/\D/g, '').slice(0, 40);
}

function adsStudioStudioName(campaign) {
  return String(campaign?.studioName || '').trim();
}

// One tap copies the studio name (the platform helper: navigator.clipboard, else a hidden textarea).
// The name comes from the request (or the server's NEEDS_MANUAL_RENAME answer), never from the page.
async function adsStudioCopyStudioName(id, button = null) {
  const campaignId = String(id || '');
  const sheet = _adsStudioLinkSheet;
  const offered = sheet && sheet.campaignId === campaignId && sheet.outcome ? String(sheet.outcome.studioName || '') : '';
  const name = offered || adsStudioStudioName(findVisibleAdsStudioCampaign(campaignId));
  if (!name) return false;
  let copied = false;
  try { copied = await copyTextToClipboard(name); } catch (_) { copied = false; }
  if (!copied) {
    showNotification(adsStudioText('Could not copy', 'تعذر النسخ'), adsStudioText('Select the name and copy it by hand.', 'حدّد الاسم وانسخه يدوياً.'), 'error');
    return false;
  }
  const label = button?.querySelector?.('span');
  if (label) {
    label.textContent = adsStudioText('Copied', 'تم النسخ');
    setTimeout(() => { label.textContent = adsStudioText('Copy', 'نسخ'); }, 2000);
  }
  return true;
}

function renderAdsStudioStudioNameRow(campaignId, name) {
  const isAr = adsStudioIsAr();
  if (!name) return `<p class="text-sm text-slate-600 dark:text-slate-300">${isAr ? 'لا يوجد اسم حملة لهذا الطلب بعد.' : 'This request has no campaign name yet.'}</p>`;
  return `<div class="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/60 p-3">
    <div class="min-w-0 flex-1"><div class="text-[11px] font-bold text-slate-500">${isAr ? 'اسم الحملة في ميتا' : 'Campaign name in Meta'}</div><div dir="ltr" data-ads-studio-name="1" class="font-mono text-sm font-bold text-slate-900 dark:text-white break-all select-all">${Security.escapeHtml(name)}</div></div>
    <button type="button" data-ads-studio-copy="1" onclick="adsStudioCopyStudioName('${Security.escapeHtml(String(campaignId || ''))}', this)" class="touch-target min-h-11 inline-flex flex-shrink-0 items-center gap-1.5 rounded-xl bg-blue-600 px-3 text-sm font-bold text-white"><i data-lucide="copy" class="w-4 h-4"></i><span aria-live="polite">${isAr ? 'نسخ' : 'Copy'}</span></button>
  </div>`;
}

// Approved requests not linked to a Meta campaign yet (PLAN §5.3, the launch section).
function adsStudioLaunchQueue() {
  return getVisibleAdsStudioCampaigns().filter(item => item.status === 'Approved' && !String(item.metaCampaignId || '').trim());
}

function renderAdsStudioLaunchQueue() {
  if (!adsStudioCanReview()) return '';
  const isAr = adsStudioIsAr();
  const queue = adsStudioLaunchQueue();
  return `<section class="mt-8" data-ads-studio-launch="1"><div class="mb-5"><h2 class="text-2xl font-black text-slate-900 dark:text-white">${isAr ? 'تمت الموافقة — اربط حملة ميتا' : 'Approved — link the Meta campaign'}</h2><p class="text-sm text-slate-500">${isAr ? 'أنشئ الإعلان في ميتا بأي اسم ثم اربطه هنا: يغيّر البيان اسم الحملة إلى الاسم الظاهر ويُبقيها خارج مدير البيان.' : 'Create the ad in Meta with any name, then link it here: Albayan renames the campaign to the name shown and keeps it out of Albayan Manager.'}</p></div><div class="space-y-5">${queue.length ? queue.map(campaign => {
    const campaignId = String(campaign.id || '');
    const safeId = Security.escapeHtml(campaignId);
    return `${renderAdsStudioCampaignCard(campaign)}<div class="-mt-3 rounded-b-2xl border border-t-0 border-emerald-200 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-900/10 p-4 space-y-3">
      ${renderAdsStudioStudioNameRow(campaignId, adsStudioStudioName(campaign))}
      <button type="button" onclick="openAdsStudioLinkSheet('${safeId}')" class="touch-target min-h-12 w-full rounded-xl bg-emerald-600 px-4 font-black text-white"><span class="inline-flex items-center gap-2"><i data-lucide="link-2" class="w-5 h-5"></i>${isAr ? 'ربط حملة ميتا' : 'Link Meta campaign'}</span></button>
    </div>`;
  }).join('') : `<div class="glass-panel rounded-2xl p-6 text-center text-sm text-slate-500">${isAr ? 'لا توجد طلبات معتمدة تنتظر الربط.' : 'No approved request is waiting for a Meta link.'}</div>`}</div></section>`;
}

function openAdsStudioLinkSheet(id) {
  if (!adsStudioCanReview()) return;
  const campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign || String(campaign.status || '') !== 'Approved') return;
  const campaignId = String(campaign.id || '');
  if (!_adsStudioLinkSheet || _adsStudioLinkSheet.campaignId !== campaignId) {
    // Opened again while this request's link still runs: busy until that link settles.
    _adsStudioLinkSheet = { campaignId, accountId: '', metaCampaignId: '', busy: _adsStudioLinkPromises.has(campaignId), outcome: null };
  }
  _adsStudioUnlinkSheet = null;  // one sheet at a time
  adsStudioLoadMetaAccounts();
  render();
}

function closeAdsStudioLinkSheet() {
  _adsStudioLinkSheet = null;
  render();
}

// The allowlisted ad accounts the Manager's Meta screens use (GET /api/meta-ads/accounts, an admin
// read). A reviewer, or an admin whose read failed, types the account id instead; the server checks it.
function adsStudioLoadMetaAccounts() {
  const cache = _adsStudioMetaAccounts;
  const uid = String(state.currentUser?.id || '');
  if (cache.forUser !== uid) { cache.forUser = uid; cache.state = ''; cache.list = []; }
  if (['loading', 'done', 'manual'].includes(cache.state)) return;
  if (!isCurrentUserAdmin() || !isServerModeEnabled() || typeof apiMetaAdsAccounts !== 'function') { cache.state = 'manual'; return; }
  cache.state = 'loading';
  apiMetaAdsAccounts().then(rows => {
    if (cache.forUser !== String(state.currentUser?.id || '')) return;
    const seen = new Set();
    cache.list = (Array.isArray(rows) ? rows : [])
      .map(row => ({ id: adsStudioDigitsOnly(row?.id), name: String(row?.name || '').slice(0, 160) }))
      .filter(row => row.id && !seen.has(row.id) && seen.add(row.id));
    cache.state = cache.list.length ? 'done' : 'failed';
  }).catch(() => {
    if (cache.forUser !== String(state.currentUser?.id || '')) return;
    cache.list = [];
    cache.state = 'failed';  // typed by hand now; the next opening of the sheet reads the list again
  }).finally(() => { if (_adsStudioLinkSheet) render(); });
}

// The account the sheet will send: the one picked or typed, else the only account in the list.
function adsStudioLinkAccountChoice(sheet) {
  if (sheet?.accountId) return sheet.accountId;
  const list = _adsStudioMetaAccounts.state === 'done' ? _adsStudioMetaAccounts.list : [];
  return list.length === 1 ? list[0].id : '';
}

function adsStudioSetLinkField(field, input) {
  const sheet = _adsStudioLinkSheet;
  if (!sheet || !['accountId', 'metaCampaignId'].includes(field)) return;
  const digits = adsStudioDigitsOnly(input?.value);
  if (input && input.value !== digits) input.value = digits;
  sheet[field] = digits;
}

function adsStudioNeedsManualRename(detail) {
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && String(detail.code || '') === 'NEEDS_MANUAL_RENAME') return true;
  const text = detail && typeof detail === 'object' ? String(detail.message || '') : String(detail || '');
  return text.includes('Rename the campaign in Meta to the name shown');
}

// Warnings the server adds to a successful link, in words; a code this list does not know is never shown raw.
const ADS_STUDIO_LINK_WARNINGS = [
  ['meta_budget_above_paid', 'The campaign budget in Meta is above what the customer paid — lower it in Meta.', 'ميزانية الحملة في ميتا أعلى مما دفعه العميل — اخفضها في ميتا.']
];

function adsStudioLinkWarningCodes(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : [])
    .map(item => String(item && typeof item === 'object' ? item.code || '' : item || '').trim().slice(0, 60))
    .filter(code => code && !seen.has(code) && seen.add(code));
}

function adsStudioLinkWarningText(code) {
  const hit = ADS_STUDIO_LINK_WARNINGS.find(([id]) => id === code);
  return hit ? adsStudioText(hit[1], hit[2]) : adsStudioText('Meta flagged something on this campaign — check it in Meta.', 'نبّهت ميتا إلى أمر في هذه الحملة — راجعها في ميتا.');
}

function adsStudioRemovedCopiesText(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (!adsStudioIsAr()) return n === 1 ? '1 copy removed from Albayan Manager.' : `${n} copies removed from Albayan Manager.`;
  if (n === 1) return 'حُذفت نسخة واحدة من مدير البيان.';
  if (n === 2) return 'حُذفت نسختان من مدير البيان.';
  return n >= 3 && n <= 10 ? `حُذفت ${n} نسخ من مدير البيان.` : `حُذفت ${n} نسخة من مدير البيان.`;
}

// D26: Manager copies that carry money or edits are never removed by a link; they are flagged for staff.
function adsStudioKeptCopiesText(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (!adsStudioIsAr()) {
    return n === 1 ? '1 copy in Albayan Manager has money or edits and was kept — check it.'
      : `${n} copies in Albayan Manager have money or edits and were kept — check them.`;
  }
  if (n === 1) return 'نسخة واحدة في مدير البيان عليها أموال أو تعديلات فبقيت كما هي — راجعها.';
  if (n === 2) return 'نسختان في مدير البيان عليهما أموال أو تعديلات فبقيتا كما هما — راجعهما.';
  return n >= 3 && n <= 10 ? `${n} نسخ في مدير البيان عليها أموال أو تعديلات فبقيت كما هي — راجعها.`
    : `${n} نسخة في مدير البيان عليها أموال أو تعديلات فبقيت كما هي — راجعها.`;
}

// A link's result from its answer, or from the result the link stored on the request (a reply lost
// after the link committed is read back from the request: its warnings are kept too).
function adsStudioLinkOutcomeFrom(reply, studioName) {
  const whole = value => Math.max(0, parseInt(value, 10) || 0);
  return {
    kind: 'linked',
    renamed: reply?.renamed === true,
    removed: whole(reply?.removedManagerCopies),
    kept: whole(reply?.keptManagerCopies),
    warnings: adsStudioLinkWarningCodes(reply?.warnings),
    studioName
  };
}

function renderAdsStudioLinkOutcome(campaign, outcome) {
  const isAr = adsStudioIsAr();
  if (!outcome) return '';
  if (outcome.kind === 'linked') {
    const amber = 'mt-2 flex items-start gap-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200';
    return `<div role="status" data-ads-studio-link-result="linked" class="mt-4 space-y-1 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 p-3 text-sm text-emerald-900 dark:text-emerald-100">
      <p class="font-bold">${isAr ? 'تم الربط. ميتا تراجع الإعلان الآن.' : 'Linked. Meta is reviewing the ad now.'}</p>
      ${outcome.renamed ? `<p>${isAr ? 'غيّر البيان اسم الحملة في ميتا إلى الاسم الظاهر.' : 'Renamed in Meta to the name shown.'}</p>` : ''}
      ${outcome.removed > 0 ? `<p data-ads-studio-link-removed="${outcome.removed}">${Security.escapeHtml(adsStudioRemovedCopiesText(outcome.removed))}</p>` : ''}
    </div>${outcome.kept > 0 ? `<p data-ads-studio-link-kept="${outcome.kept}" class="${amber} font-bold"><i data-lucide="triangle-alert" class="w-4 h-4 flex-shrink-0 mt-0.5"></i><span>${Security.escapeHtml(adsStudioKeptCopiesText(outcome.kept))}</span></p>` : ''}${outcome.warnings.map(code => `<p data-ads-studio-link-warning="1" class="${amber}"><i data-lucide="triangle-alert" class="w-4 h-4 flex-shrink-0 mt-0.5"></i><span>${Security.escapeHtml(adsStudioLinkWarningText(code))}</span></p>`).join('')}`;
  }
  if (outcome.kind === 'rename') {
    return `<div role="alert" data-ads-studio-link-result="rename" class="mt-4 space-y-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-900 dark:text-amber-100">
      <p class="font-bold">${isAr ? 'غيّر اسمها في ميتا، ثم اضغط «ربط» مرة أخرى.' : 'Rename it in Meta, then press Link again.'}</p>
      ${renderAdsStudioStudioNameRow(campaign.id, outcome.studioName)}
      <p class="text-xs">${isAr ? 'لا يستطيع البيان تغيير اسم الحملة في ميتا بنفسه بعد (مفتاح ميتا بلا صلاحية ads_management).' : 'Albayan cannot rename the campaign in Meta by itself yet (the Meta key has no ads_management permission).'}</p>
    </div>`;
  }
  return `<div role="alert" data-ads-studio-link-result="error" class="mt-4 rounded-xl bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">${Security.escapeHtml(outcome.text || '')}</div>`;
}

function renderAdsStudioLinkSheet() {
  const sheet = _adsStudioLinkSheet;
  if (!sheet || !adsStudioCanReview()) return '';
  const campaign = findVisibleAdsStudioCampaign(sheet.campaignId);
  const linked = sheet.outcome?.kind === 'linked';
  if (!campaign || (!linked && String(campaign.status || '') !== 'Approved')) return '';
  const isAr = adsStudioIsAr();
  const busy = sheet.busy;
  const cache = _adsStudioMetaAccounts;
  const choice = adsStudioLinkAccountChoice(sheet);
  const paid = Math.max(0, parseInt(campaign.paidMinorUSD, 10) || 0);
  const field = 'glass-input min-h-12 w-full rounded-xl px-4';
  const accountField = cache.state === 'done'
    ? `<select id="ads-studio-link-account" onchange="adsStudioSetLinkField('accountId', this)" class="${field}"><option value="" ${choice ? '' : 'selected'}>${isAr ? 'اختر حساب الإعلانات' : 'Choose the ad account'}</option>${cache.list.map(row => `<option value="${Security.escapeHtml(row.id)}" ${row.id === choice ? 'selected' : ''}>${Security.escapeHtml(row.name || row.id)} · ${Security.escapeHtml(row.id)}</option>`).join('')}</select>`
    : cache.state === 'loading'
      ? `<div class="min-h-12 flex items-center text-sm text-slate-500">${isAr ? 'جارٍ تحميل حسابات الإعلانات…' : 'Loading the ad accounts…'}</div>`
      : `<input id="ads-studio-link-account" type="text" inputmode="numeric" autocomplete="off" dir="ltr" maxlength="60" value="${Security.escapeHtml(sheet.accountId)}" oninput="adsStudioSetLinkField('accountId', this)" class="${field}" placeholder="1234567890" /><p class="mt-1 text-xs text-slate-500">${isAr ? 'اكتب رقم حساب الإعلانات (أرقام فقط، بدون act_).' : 'Type the ad account id (digits only, without act_).'}</p>`;
  const form = linked ? '' : `
        <ol class="mt-4 list-decimal space-y-1 ps-5 text-sm text-slate-600 dark:text-slate-300">
          <li>${isAr ? 'أنشئ الإعلان في ميتا بأي اسم.' : 'Create the ad in Meta with any name.'}</li>
          <li>${paid ? (isAr ? `اجعل ميزانية الحملة في ميتا لا تزيد عن المدفوع (${Security.escapeHtml(adsStudioMoney(paid))}).` : `Keep the campaign's budget in Meta within what was paid (${Security.escapeHtml(adsStudioMoney(paid))}).`) : (isAr ? 'اجعل ميزانية الحملة في ميتا لا تزيد عن المدفوع.' : "Keep the campaign's budget in Meta within what was paid.")}</li>
          <li>${isAr ? 'اختر حساب الإعلانات والصق رقم الحملة ثم اضغط «ربط»: يغيّر البيان اسم الحملة إلى الاسم الظاهر.' : 'Pick the ad account, paste the campaign id and press Link: Albayan renames the campaign to the name shown.'}</li>
        </ol>
        <label for="ads-studio-link-account" class="mt-4 block text-sm font-bold mb-2">${isAr ? 'حساب الإعلانات' : 'Ad account'}</label>
        ${accountField}
        <label for="ads-studio-link-campaign" class="mt-4 block text-sm font-bold mb-2">${isAr ? 'رقم حملة ميتا' : 'Meta campaign id'}</label>
        <input id="ads-studio-link-campaign" type="text" inputmode="numeric" autocomplete="off" dir="ltr" maxlength="60" value="${Security.escapeHtml(sheet.metaCampaignId)}" oninput="adsStudioSetLinkField('metaCampaignId', this)" class="${field}" placeholder="120200000000000000" />`;
  return `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 backdrop-blur-sm p-0 sm:items-center sm:p-4" onclick="closeAdsStudioLinkSheet()">
      <div data-ads-studio-link-sheet="${Security.escapeHtml(String(campaign.id || ''))}" class="w-full max-w-lg rounded-t-3xl sm:rounded-2xl bg-white dark:bg-slate-900 p-5 max-h-[90dvh] overflow-y-auto custom-scrollbar" onclick="event.stopPropagation()" role="dialog" aria-modal="true" aria-labelledby="ads-studio-link-title" dir="${isAr ? 'rtl' : 'ltr'}">
        <div class="flex items-center justify-between gap-3 mb-3"><h3 id="ads-studio-link-title" class="text-lg font-extrabold text-slate-900 dark:text-white">${isAr ? 'ربط حملة ميتا' : 'Link Meta campaign'}</h3><button type="button" onclick="closeAdsStudioLinkSheet()" class="touch-target flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800" aria-label="${isAr ? 'إغلاق' : 'Close'}"><i data-lucide="x" class="w-4 h-4"></i></button></div>
        <p class="mb-3 text-sm font-bold text-slate-600 dark:text-slate-300 break-words">${Security.escapeHtml(campaign.name || (isAr ? 'حملة بدون اسم' : 'Untitled campaign'))}</p>
        ${renderAdsStudioStudioNameRow(campaign.id, adsStudioStudioName(campaign))}
        ${form}
        ${renderAdsStudioLinkOutcome(campaign, sheet.outcome)}
        <div class="mt-5 grid gap-2 ${linked ? '' : 'sm:grid-cols-2'}">
          <button type="button" onclick="closeAdsStudioLinkSheet()" class="touch-target min-h-12 rounded-xl ${linked ? 'bg-emerald-600 text-white font-black' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-bold'}">${linked ? (isAr ? 'تم' : 'Done') : (isAr ? 'إلغاء' : 'Cancel')}</button>
          ${linked ? '' : `<button type="button" data-ads-studio-link-submit="1" onclick="linkAdsStudioMetaCampaign(this)" ${busy ? 'disabled aria-busy="true"' : ''} class="touch-target min-h-12 rounded-xl bg-emerald-600 text-white font-black disabled:opacity-60">${busy ? (isAr ? 'جارٍ الربط…' : 'Linking…') : (isAr ? 'ربط' : 'Link')}</button>`}
        </div>
      </div>
    </div>`;
}

// POST /publish-status, the LINK step: the ad account and the campaign id with this version's
// operationId (one per action and version, so a retry after a lost reply replays it). The route's
// version field is expectedLastModified; expectedVersion carries the same number. The reply is the
// request plus {renamed, removedManagerCopies, keptManagerCopies, warnings}. Never retried here: a
// retry reaches Meta.
async function adsStudioApiLinkMetaCampaign(campaignId, attempt, metaAdAccountId, metaCampaignId) {
  const identity = getServerSessionIdentity();
  const version = attempt.expectedLastModified;
  const body = { publishStatus: 'meta_review', metaAdAccountId, metaCampaignId, operationId: attempt.operationId, expectedVersion: version, expectedLastModified: version };
  const reply = await apiJson(`/api/ad-studio/campaigns/${encodeURIComponent(campaignId)}/publish-status`, {
    method: 'POST', body
  }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  validateServerEntityResponse('adCampaignRequests', reply?.entity?.data ? reply.entity : reply, 'publish-status');
  return reply;
}

// Single flight PER REQUEST: a second press on the same request joins its link in flight; a link of
// another request (its sheet opened meanwhile) runs on its own.
function linkAdsStudioMetaCampaign(button = null) {
  const campaignId = String(_adsStudioLinkSheet?.campaignId || '');
  if (!campaignId) return Promise.resolve(false);
  if (_adsStudioLinkPromises.has(campaignId)) return _adsStudioLinkPromises.get(campaignId);
  setAdsStudioActionButtonBusy(button, true);
  const operation = linkAdsStudioMetaCampaignOnce(campaignId);
  _adsStudioLinkPromises.set(campaignId, operation);
  const cleanup = () => {
    if (_adsStudioLinkPromises.get(campaignId) === operation) _adsStudioLinkPromises.delete(campaignId);
    setAdsStudioActionButtonBusy(button, false);
  };
  operation.then(cleanup, cleanup);
  return operation;
}

async function linkAdsStudioMetaCampaignOnce(campaignId) {
  const sheet = _adsStudioLinkSheet;
  if (!sheet || sheet.campaignId !== campaignId || !adsStudioCanReview()) return false;
  const campaign = findVisibleAdsStudioCampaign(campaignId);
  if (!campaign || String(campaign.status || '') !== 'Approved') return false;
  // The result reaches this sheet, and the request's sheet opened again while the link ran.
  const sheets = () => [sheet, _adsStudioLinkSheet].filter(item => item && item.campaignId === campaignId);
  const settle = outcome => { for (const item of sheets()) item.outcome = outcome; };
  const box = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);
  const accountBox = box('ads-studio-link-account');
  const campaignBox = box('ads-studio-link-campaign');
  if (accountBox) sheet.accountId = adsStudioDigitsOnly(accountBox.value);
  if (campaignBox) sheet.metaCampaignId = adsStudioDigitsOnly(campaignBox.value);
  const accountId = adsStudioLinkAccountChoice(sheet);
  const metaCampaignId = sheet.metaCampaignId;
  let problem = '';
  if (!accountId) problem = adsStudioText('Choose the ad account.', 'اختر حساب الإعلانات.');
  else if (!metaCampaignId) problem = adsStudioText('Enter the Meta campaign id (digits only).', 'أدخل رقم حملة ميتا (أرقام فقط).');
  else if (!isServerModeEnabled()) problem = adsStudioText('Linking needs the server connection.', 'الربط يتطلب اتصال الخادم.');
  if (problem) {
    sheet.outcome = { kind: 'error', text: problem };
    render();
    return false;
  }
  const attempt = adsStudioActionAttempt('publish', campaign.id, Number(campaign._lastModified));
  sheet.busy = true;
  sheet.outcome = null;
  render();
  try {
    let reply;
    try {
      reply = await adsStudioApiLinkMetaCampaign(campaign.id, attempt, accountId, metaCampaignId);
    } catch (e) {
      // A reply lost after the link committed: the request now holds this Meta campaign, and the
      // result the link stored on it (copies removed and kept, warnings) is shown as the answer.
      if (e?.status !== 409 || adsStudioNeedsManualRename(e?.payload?.detail)) throw e;
      const fresh = await adsStudioReloadCampaign(campaign.id);
      if (!fresh || String(fresh.data?.metaCampaignId || '') !== metaCampaignId) throw e;
      const stored = fresh.data?.metaLinkResult && typeof fresh.data.metaLinkResult === 'object' ? fresh.data.metaLinkResult : {};
      reply = { ...fresh, renamed: stored.renamed, removedManagerCopies: stored.removedManagerCopies, keptManagerCopies: stored.keptManagerCopies, warnings: stored.warnings };
    }
    _adsStudioActionAttempts.delete(attempt.key);
    const saved = upsertAdsStudioEntity(reply?.entity?.data ? reply.entity : reply);
    settle(adsStudioLinkOutcomeFrom(reply, adsStudioStudioName(saved) || adsStudioStudioName(campaign)));
    showNotification(adsStudioText('Meta campaign linked', 'تم ربط حملة ميتا'), adsStudioText('Meta is reviewing the ad now.', 'ميتا تراجع الإعلان الآن.'), 'success');
    return true;
  } catch (e) {
    const detail = e?.payload?.detail || e?.message || '';
    const offered = detail && typeof detail === 'object' && !Array.isArray(detail) ? String(detail.studioName || '').trim() : '';
    settle(adsStudioNeedsManualRename(detail)
      ? { kind: 'rename', studioName: offered || adsStudioStudioName(campaign) }
      : { kind: 'error', text: adsStudioRefusalText(detail) || adsStudioText('Refresh and try again.', 'حدّث الصفحة وحاول مرة أخرى.') });
    return false;
  } finally {
    for (const item of sheets()) item.busy = false;
    render();
  }
}

// ---- Staff: unlink the Meta campaign (D26) ----
// POST /api/ad-studio/campaigns/{id}/unlink-meta {operationId, expectedLastModified, reason}: the
// request lets go of its Meta campaign and goes back to the link list. The Manager copies the link
// removed come back; a campaign Albayan renamed is renamed back when Meta allows it. A Stopped
// request keeps its link (the server refuses). The answer is the request plus {restoredCopies,
// renamedBack}. In-page sheet with a required reason; never a native dialog.
const ADS_STUDIO_UNLINK_REASON_MAX = 300;

function openAdsStudioUnlinkSheet(id) {
  if (!adsStudioCanReview()) return;
  const campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign || String(campaign.status || '') !== 'Approved' || !String(campaign.metaCampaignId || '').trim()) return;
  const campaignId = String(campaign.id || '');
  if (!_adsStudioUnlinkSheet || _adsStudioUnlinkSheet.campaignId !== campaignId) {
    _adsStudioUnlinkSheet = { campaignId, reason: '', busy: _adsStudioUnlinkPromises.has(campaignId), outcome: null };
  }
  _adsStudioLinkSheet = null;  // one sheet at a time
  render();
}

function closeAdsStudioUnlinkSheet() {
  _adsStudioUnlinkSheet = null;
  render();
}

function adsStudioSetUnlinkReason(input) {
  if (_adsStudioUnlinkSheet) _adsStudioUnlinkSheet.reason = String(input?.value || '').slice(0, ADS_STUDIO_UNLINK_REASON_MAX);
}

function adsStudioRestoredCopiesText(count) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (!adsStudioIsAr()) return n === 1 ? '1 copy came back to Albayan Manager.' : `${n} copies came back to Albayan Manager.`;
  if (n === 1) return 'عادت نسخة واحدة إلى مدير البيان.';
  if (n === 2) return 'عادت نسختان إلى مدير البيان.';
  return n >= 3 && n <= 10 ? `عادت ${n} نسخ إلى مدير البيان.` : `عادت ${n} نسخة إلى مدير البيان.`;
}

function renderAdsStudioUnlinkOutcome(outcome) {
  const isAr = adsStudioIsAr();
  if (!outcome) return '';
  if (outcome.kind !== 'unlinked') {
    return `<div role="alert" data-ads-studio-unlink-result="error" class="mt-4 rounded-xl bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200">${Security.escapeHtml(outcome.text || '')}</div>`;
  }
  const amber = 'mt-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200';
  const notRenamedBack = outcome.known && outcome.wasRenamed && !outcome.renamedBack;
  return `<div role="status" data-ads-studio-unlink-result="unlinked" class="mt-4 space-y-1 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 p-3 text-sm text-emerald-900 dark:text-emerald-100">
      <p class="font-bold">${isAr ? 'تم إلغاء الربط. الطلب ينتظر ربط حملة ميتا من جديد.' : 'Unlinked. The request waits for a Meta campaign link again.'}</p>
      ${outcome.restored > 0 ? `<p data-ads-studio-unlink-restored="${outcome.restored}">${Security.escapeHtml(adsStudioRestoredCopiesText(outcome.restored))}</p>` : ''}
      ${outcome.renamedBack ? `<p data-ads-studio-unlink-renamed-back="1">${isAr ? 'أعاد البيان اسم الحملة السابق في ميتا.' : 'Renamed back in Meta.'}</p>` : ''}
    </div>${notRenamedBack ? `<p data-ads-studio-unlink-not-renamed="1" class="${amber}">${isAr ? 'لم يُعَد اسم الحملة في ميتا إلى ما كان عليه — راجعه في ميتا.' : 'The campaign name in Meta was not changed back — check it in Meta.'}</p>` : ''}${outcome.known ? '' : `<p data-ads-studio-unlink-lost="1" class="${amber}">${isAr ? 'ضاع رد الخادم، لذلك لا تظهر النسخ العائدة ولا الاسم — راجع مدير البيان واسم الحملة في ميتا.' : 'The server reply was lost, so the copies that came back and the name are not shown — check Albayan Manager and the campaign name in Meta.'}</p>`}`;
}

function renderAdsStudioUnlinkSheet() {
  const sheet = _adsStudioUnlinkSheet;
  if (!sheet || !adsStudioCanReview()) return '';
  const campaign = findVisibleAdsStudioCampaign(sheet.campaignId);
  const linkedId = String(campaign?.metaCampaignId || '').trim();
  const open = !!campaign && String(campaign.status || '') === 'Approved' && !!linkedId && sheet.outcome?.kind !== 'unlinked';
  if (!campaign || (!open && !sheet.outcome)) return '';
  const isAr = adsStudioIsAr();
  const busy = sheet.busy;
  const safeId = Security.escapeHtml(String(campaign.id || ''));
  const done = sheet.outcome?.kind === 'unlinked';
  const form = open ? `
        ${linkedId ? `<p class="mt-2 text-sm text-slate-600 dark:text-slate-300">${isAr ? 'حملة ميتا المرتبطة:' : 'Linked Meta campaign:'} <span dir="ltr" class="font-mono font-bold">${Security.escapeHtml(linkedId)}</span></p>` : ''}
        <ul class="mt-3 list-disc space-y-1 ps-5 rounded-xl bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-900 dark:text-amber-100">
          <li>${isAr ? 'تعود إلى مدير البيان نسخ هذه الحملة التي حذفها الربط.' : 'The Albayan Manager copies of this campaign that the link removed come back.'}</li>
          <li>${isAr ? 'إذا غيّر البيان اسم الحملة في ميتا فسيحاول إعادة اسمها السابق.' : 'If Albayan renamed the campaign in Meta, it tries to rename it back.'}</li>
          <li>${isAr ? 'لا يمكن إلغاء ربط طلب موقوف.' : 'A stopped request cannot be unlinked.'}</li>
        </ul>
        <label for="ads-studio-unlink-reason" class="mt-4 block text-sm font-bold mb-2">${isAr ? 'السبب (مطلوب)' : 'Reason (required)'}</label>
        <textarea id="ads-studio-unlink-reason" rows="3" maxlength="${ADS_STUDIO_UNLINK_REASON_MAX}" oninput="adsStudioSetUnlinkReason(this)" class="glass-input w-full rounded-xl px-4 py-3" placeholder="${isAr ? 'مثلاً: رُبطت حملة خاطئة' : 'For example: the wrong campaign was linked'}">${Security.escapeHtml(sheet.reason)}</textarea>` : '';
  return `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 backdrop-blur-sm p-0 sm:items-center sm:p-4" onclick="closeAdsStudioUnlinkSheet()">
      <div data-ads-studio-unlink-sheet="${safeId}" class="w-full max-w-lg rounded-t-3xl sm:rounded-2xl bg-white dark:bg-slate-900 p-5 max-h-[90dvh] overflow-y-auto custom-scrollbar" onclick="event.stopPropagation()" role="dialog" aria-modal="true" aria-labelledby="ads-studio-unlink-title" dir="${isAr ? 'rtl' : 'ltr'}">
        <div class="flex items-center justify-between gap-3 mb-3"><h3 id="ads-studio-unlink-title" class="text-lg font-extrabold text-slate-900 dark:text-white">${isAr ? 'إلغاء ربط حملة ميتا' : 'Unlink Meta campaign'}</h3><button type="button" onclick="closeAdsStudioUnlinkSheet()" class="touch-target flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800" aria-label="${isAr ? 'إغلاق' : 'Close'}"><i data-lucide="x" class="w-4 h-4"></i></button></div>
        <p class="text-sm font-bold text-slate-600 dark:text-slate-300 break-words">${Security.escapeHtml(campaign.name || (isAr ? 'حملة بدون اسم' : 'Untitled campaign'))}</p>
        ${form}
        ${renderAdsStudioUnlinkOutcome(sheet.outcome)}
        <div class="mt-5 grid gap-2 ${open ? 'sm:grid-cols-2' : ''}">
          <button type="button" onclick="closeAdsStudioUnlinkSheet()" class="touch-target min-h-12 rounded-xl ${done ? 'bg-emerald-600 text-white font-black' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-bold'}">${done ? (isAr ? 'تم' : 'Done') : open ? (isAr ? 'إلغاء' : 'Cancel') : (isAr ? 'إغلاق' : 'Close')}</button>
          ${open ? `<button type="button" data-ads-studio-unlink-submit="1" onclick="unlinkAdsStudioMetaCampaign('${safeId}', this)" ${busy ? 'disabled aria-busy="true"' : ''} class="touch-target min-h-12 rounded-xl bg-rose-600 text-white font-black disabled:opacity-60">${busy ? (isAr ? 'جارٍ إلغاء الربط…' : 'Unlinking…') : (isAr ? 'إلغاء الربط' : 'Unlink')}</button>` : ''}
        </div>
      </div>
    </div>`;
}

// Never retried here: the unlink may rename the campaign in Meta. A retry after a lost reply uses
// the same operationId (one per action and version), so the server answers it with the first result.
async function adsStudioApiUnlinkMetaCampaign(campaignId, attempt, reason) {
  const identity = getServerSessionIdentity();
  const reply = await apiJson(`/api/ad-studio/campaigns/${encodeURIComponent(campaignId)}/unlink-meta`, {
    method: 'POST', body: { operationId: attempt.operationId, expectedLastModified: attempt.expectedLastModified, reason }
  }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  validateServerEntityResponse('adCampaignRequests', reply?.entity?.data ? reply.entity : reply, 'unlink-meta');
  return reply;
}

function unlinkAdsStudioMetaCampaign(id, button = null) {
  const campaignId = String(id || '');
  if (_adsStudioUnlinkPromises.has(campaignId)) return _adsStudioUnlinkPromises.get(campaignId);
  setAdsStudioActionButtonBusy(button, true);
  const operation = unlinkAdsStudioMetaCampaignOnce(campaignId);
  _adsStudioUnlinkPromises.set(campaignId, operation);
  const cleanup = () => {
    if (_adsStudioUnlinkPromises.get(campaignId) === operation) _adsStudioUnlinkPromises.delete(campaignId);
    setAdsStudioActionButtonBusy(button, false);
  };
  operation.then(cleanup, cleanup);
  return operation;
}

async function unlinkAdsStudioMetaCampaignOnce(campaignId) {
  const sheet = _adsStudioUnlinkSheet;
  if (!sheet || sheet.campaignId !== campaignId || !adsStudioCanReview()) return false;
  const campaign = findVisibleAdsStudioCampaign(campaignId);
  if (!campaign || String(campaign.status || '') !== 'Approved' || !String(campaign.metaCampaignId || '').trim()) return false;
  // The result reaches this sheet, and the request's sheet opened again while the unlink ran.
  const sheets = () => [sheet, _adsStudioUnlinkSheet].filter(item => item && item.campaignId === campaignId);
  const settle = outcome => { for (const item of sheets()) item.outcome = outcome; };
  const reasonBox = typeof document !== 'undefined' ? document.getElementById('ads-studio-unlink-reason') : null;
  if (reasonBox) sheet.reason = String(reasonBox.value || '').slice(0, ADS_STUDIO_UNLINK_REASON_MAX);
  const reason = String(sheet.reason || '').trim();
  let problem = '';
  if (reason.length < 3) problem = adsStudioText('Write the reason for the unlink (at least 3 characters).', 'اكتب سبب إلغاء الربط (3 أحرف على الأقل).');
  else if (!isServerModeEnabled()) problem = adsStudioText('Unlinking needs the server connection.', 'إلغاء الربط يتطلب اتصال الخادم.');
  if (problem) {
    settle({ kind: 'error', text: problem });
    render();
    return false;
  }
  const attempt = adsStudioActionAttempt('unlink', campaign.id, Number(campaign._lastModified));
  const wasRenamed = campaign.metaLinkResult?.renamed === true;
  sheet.busy = true;
  sheet.outcome = null;
  render();
  try {
    let reply;
    let known = true;
    try {
      reply = await adsStudioApiUnlinkMetaCampaign(campaign.id, attempt, reason);
    } catch (e) {
      // A reply lost after the unlink committed (a 409 on the replay, or no answer at all): the
      // request, read again, no longer holds a Meta campaign.
      if ((e?.status && e.status !== 409) || e?.code === 'SERVER_SESSION_CHANGED') throw e;
      const fresh = await adsStudioReloadCampaign(campaign.id);
      if (!fresh || String(fresh.data?.metaCampaignId || '').trim()) throw e;
      reply = fresh;
      known = false;
    }
    _adsStudioActionAttempts.delete(attempt.key);
    upsertAdsStudioEntity(reply?.entity?.data ? reply.entity : reply);
    settle({
      kind: 'unlinked',
      known,
      wasRenamed,
      restored: known ? Math.max(0, parseInt(reply?.restoredCopies, 10) || 0) : 0,
      renamedBack: known && reply?.renamedBack === true
    });
    showNotification(adsStudioText('Meta campaign unlinked', 'تم إلغاء ربط حملة ميتا'), adsStudioText('The request is back in the list to link.', 'عاد الطلب إلى قائمة الربط.'), 'success');
    return true;
  } catch (e) {
    const detail = e?.payload?.detail || e?.message || '';
    settle({ kind: 'error', text: adsStudioRefusalText(detail) || adsStudioText('Refresh and try again.', 'حدّث الصفحة وحاول مرة أخرى.') });
    return false;
  } finally {
    for (const item of sheets()) item.busy = false;
    render();
  }
}

// ---- Customer: withdraw a waiting request (P1-03) ----
// Submitted -> Draft on the server in one transaction: the hold ends at once (a capture this cycle
// already had is returned). An in-page sheet confirms it; never a native dialog.
function openAdsStudioWithdraw(id) {
  const campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign || String(campaign.status || '') !== 'Submitted' || String(campaign.createdBy || '') !== String(state.currentUser?.id || '')) return;
  _adsStudioWithdrawConfirmId = String(campaign.id || '');
  render();
}

function cancelAdsStudioWithdraw() {
  _adsStudioWithdrawConfirmId = '';
  render();
}

function renderAdsStudioWithdrawSheet() {
  const campaign = _adsStudioWithdrawConfirmId ? findVisibleAdsStudioCampaign(_adsStudioWithdrawConfirmId) : null;
  if (!campaign || String(campaign.status || '') !== 'Submitted' || String(campaign.createdBy || '') !== String(state.currentUser?.id || '')) return '';
  const isAr = adsStudioIsAr();
  const safeId = Security.escapeHtml(String(campaign.id || ''));
  const held = Security.escapeHtml(adsStudioMoney(adsStudioHeldMinorFor(campaign)));
  return `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 backdrop-blur-sm p-0 sm:items-center sm:p-4" onclick="cancelAdsStudioWithdraw()">
      <div data-ads-studio-withdraw-sheet="${safeId}" class="w-full max-w-md rounded-t-3xl sm:rounded-2xl bg-white dark:bg-slate-900 p-5" onclick="event.stopPropagation()" role="dialog" aria-modal="true" aria-labelledby="ads-studio-withdraw-title" dir="${isAr ? 'rtl' : 'ltr'}">
        <h3 id="ads-studio-withdraw-title" class="text-lg font-extrabold text-slate-900 dark:text-white">${isAr ? 'سحب هذا الطلب؟' : 'Withdraw this request?'}</h3>
        <p class="mt-1 text-sm font-bold text-slate-600 dark:text-slate-300 break-words">${Security.escapeHtml(campaign.name || (isAr ? 'حملة بدون اسم' : 'Untitled campaign'))}</p>
        <p class="mt-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-900 dark:text-amber-100">${isAr ? `ينتهي حجز ${held} الآن، ويعود الطلب إلى المسودة.` : `Your ${held} reservation ends now. The request goes back to Draft.`}</p>
        <div class="mt-4 grid gap-2 sm:grid-cols-2">
          <button type="button" onclick="cancelAdsStudioWithdraw()" class="touch-target min-h-12 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-bold">${isAr ? 'أبقِ الطلب' : 'Keep it'}</button>
          <button type="button" data-ads-studio-withdraw-confirm="1" onclick="withdrawAdsStudioCampaign('${safeId}', this)" class="touch-target min-h-12 rounded-xl bg-amber-600 text-white font-black disabled:opacity-60">${isAr ? 'سحب الطلب' : 'Withdraw'}</button>
        </div>
      </div>
    </div>`;
}

async function adsStudioApiWithdraw(campaignId, expectedLastModified, operationId) {
  const identity = getServerSessionIdentity();
  const entity = await requestValidatedServerEntity('adCampaignRequests', 'withdraw', () =>
    withRetry(() => apiJson(`/api/ad-studio/campaigns/${encodeURIComponent(campaignId)}/withdraw`, {
      method: 'POST', body: { expectedLastModified, operationId }
    }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 2, 500)
  );
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  return entity;
}

function withdrawAdsStudioCampaign(id, button = null) {
  const campaignId = String(id || '');
  if (_adsStudioWithdrawPromises.has(campaignId)) return _adsStudioWithdrawPromises.get(campaignId);
  setAdsStudioActionButtonBusy(button, true);
  const operation = withdrawAdsStudioCampaignOnce(campaignId);
  _adsStudioWithdrawPromises.set(campaignId, operation);
  const cleanup = () => {
    if (_adsStudioWithdrawPromises.get(campaignId) === operation) _adsStudioWithdrawPromises.delete(campaignId);
    setAdsStudioActionButtonBusy(button, false);
  };
  operation.then(cleanup, cleanup);
  return operation;
}

async function withdrawAdsStudioCampaignOnce(id) {
  const campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign || String(campaign.status || '') !== 'Submitted' || String(campaign.createdBy || '') !== String(state.currentUser?.id || '')) return false;
  if (!isServerModeEnabled()) {
    showNotification(
      adsStudioText('Server connection required', 'يتطلب اتصال الخادم'),
      adsStudioText('The reserved budget is wallet money, which needs the server connection.', 'الميزانية المحجوزة من أموال المحفظة، وهذا يتطلب اتصال الخادم.'),
      'error'
    );
    return false;
  }
  const held = adsStudioHeldMinorFor(campaign);
  try {
    const attempt = adsStudioActionAttempt('withdraw', campaign.id, Number(campaign._lastModified));
    let entity;
    try {
      entity = await adsStudioApiWithdraw(campaign.id, attempt.expectedLastModified, attempt.operationId);
    } catch (e) {
      const fresh = e?.status === 409 ? await adsStudioReloadCampaign(campaign.id) : null;
      if (!fresh || String(fresh.data?.status || '') !== 'Draft') throw e;
      entity = fresh;  // the first tap already withdrew it
    }
    _adsStudioActionAttempts.delete(attempt.key);
    if (_adsStudioWithdrawConfirmId === String(campaign.id)) _adsStudioWithdrawConfirmId = '';
    upsertAdsStudioEntity(entity);
    resetAdsStudioWalletCache();
    refreshAdsStudioWallet();
    if (typeof serverLiveSyncTick === 'function') serverLiveSyncTick().catch(() => {});  // a returned capture reaches the ledger now
    showNotification(
      adsStudioText('Request withdrawn', 'تم سحب الطلب'),
      adsStudioText(`${adsStudioMoney(held)} is available again. The request is back in Draft.`, `عاد ${adsStudioMoney(held)} إلى رصيدك المتاح، والطلب الآن مسودة.`),
      'success'
    );
    render();
    return true;
  } catch (e) {
    const detail = (e?.payload && e.payload.detail) ? e.payload.detail : (e?.message || '');
    showNotification(adsStudioText('Could not withdraw', 'تعذر سحب الطلب'), adsStudioRefusalText(detail) || adsStudioText('Refresh and try again.', 'حدّث الصفحة وحاول مرة أخرى.'), 'error');
    render();
    return false;
  }
}

async function duplicateAdsStudioCampaign(id, button = null, extend = false) {
  if (!adsStudioCanCreate()) return;
  let campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign) return;
  setAdsStudioActionButtonBusy(button, true);
  try {
    try {
      campaign = await ensureEntityMediaLoaded('adCampaignRequests', campaign.id) || campaign;
    } catch (_) {
      showNotification(adsStudioText('Could not load creative', 'تعذر تحميل الصور'), adsStudioText('Check the connection and try again.', 'تحقق من الاتصال وحاول مرة أخرى.'), 'error');
      return;
    }
    if (campaign._mediaOmitted === true && getEntityPhotoCountHint('adCampaignRequests', campaign) > 0 && !isEntityMediaHydrated('adCampaignRequests', campaign)) {
      showNotification(adsStudioText('Could not load creative', 'تعذر تحميل الصور'), adsStudioText('Check the connection and try again.', 'تحقق من الاتصال وحاول مرة أخرى.'), 'error');
      return;
    }
    const src = Security.sanitizeObject(campaign);
    // The copy keeps the source's number of days (its durationDays, or its dates for an older request).
    const sourceDays = adsStudioCampaignDays(src);
    const durationDays = sourceDays >= 1 && sourceDays <= 366 ? sourceDays : 7;
    _adsStudioPhotoToken++;
    _adsStudioEditingId = '';
    _adsStudioEditingBaseline = 0;
    _adsStudioWizardStep = 1;
    _adsStudioConfirmationChecked = false;
    _adsStudioDraft = {
      ...newAdsStudioDraft(),
      name: `${String(src.name || '')} ${extend ? adsStudioText('— extension', '— تمديد') : adsStudioText('— copy', '— نسخة')}`.trim().slice(0, 120),
      objective: String(src.objective || 'messages'),
      platforms: Array.isArray(src.platforms) ? src.platforms.slice() : ['facebook'],
      pageName: String(src.pageName || ''),
      primaryText: String(src.primaryText || ''),
      headline: String(src.headline || ''),
      description: String(src.description || ''),
      callToAction: String(src.callToAction || 'Send Message'),
      destination: String(src.destination || ''),
      locations: Array.isArray(src.locations) ? src.locations.slice() : ['Libya'],
      ageMin: Number(src.ageMin) || 18,
      ageMax: Number(src.ageMax) || 65,
      genders: Array.isArray(src.genders) ? src.genders.slice() : ['all'],
      languages: Array.isArray(src.languages) ? src.languages.slice() : [],
      interests: Array.isArray(src.interests) ? src.interests.slice() : [],
      startDate: _adsStudioDateOffset(1),
      endDate: adsStudioEndDateFor(_adsStudioDateOffset(1), durationDays) || _adsStudioDateOffset(durationDays),
      durationDays,
      budgetMinorUSD: Math.max(0, parseInt(src.budgetMinorUSD, 10) || 0),
      budgetType: src.budgetType === 'daily' ? 'daily' : 'lifetime',
      notes: String(src.notes || ''),
      creativeImages: Array.isArray(src.creativeImages) ? src.creativeImages.slice(0, 3) : [],
      creativeAssetIds: Array.isArray(src.creativeAssetIds) ? src.creativeAssetIds.slice(0, 20) : [],
      specialAdCategories: Array.isArray(src.specialAdCategories) ? src.specialAdCategories.slice(0, 4) : [],
      boostType: ['boost_post', 'boost_page'].includes(String(src.boostType || '')) ? String(src.boostType) : '',
      sourcePostRef: String(src.sourcePostRef || ''),
      ...(String(src.sourcePostId || '') ? { sourcePostId: String(src.sourcePostId), sourcePostPlatform: String(src.sourcePostPlatform || '') } : {}),
      ...(String(src.connectedAssetId || '') ? { connectedAssetId: String(src.connectedAssetId) } : {}),
      autoReply: src.autoReply === true,
      extendsCampaignId: extend ? String(campaign.id || '') : ''
    };
    _adsStudioActiveTab = 'builder';
    try { updateUrlParams({ tab: 'builder' }, true); } catch (_) {}
    render();
  } finally {
    setAdsStudioActionButtonBusy(button, false);
  }
}

function renderAdsStudioReviewHistory(campaign) {
  const history = Array.isArray(campaign?.reviewHistory) ? campaign.reviewHistory.slice(-5).reverse() : [];
  if (!history.length) return '';
  const isAr = adsStudioIsAr();
  return `<details class="mt-3 border-t border-slate-200 dark:border-slate-700 pt-3"><summary class="touch-target min-h-11 cursor-pointer select-none text-sm font-bold text-slate-600 dark:text-slate-300 flex items-center gap-2"><i data-lucide="history" class="w-4 h-4"></i>${isAr ? 'سجل المراجعة' : 'Review history'}</summary><div class="space-y-2 pt-2">${history.map(entry => {
    const meta = adsStudioStatusMeta(entry?.decision || entry?.status || 'Reviewed');
    const when = entry?.reviewedAt ? new Date(entry.reviewedAt) : null;
    const dateText = when && Number.isFinite(when.getTime()) ? when.toLocaleString(isAr ? 'ar-LY' : 'en-GB') : '';
    const reason = adsStudioReviewReasonLabel(entry?.reasonCode || entry?.reviewReasonCode);
    return `<div class="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3 text-sm"><div class="flex flex-wrap items-center justify-between gap-2"><span class="font-bold text-slate-800 dark:text-slate-100">${Security.escapeHtml(isAr ? meta.labelAr : meta.label)}${reason ? ` · ${Security.escapeHtml(reason)}` : ''}</span>${dateText ? `<time class="text-xs text-slate-500">${Security.escapeHtml(dateText)}</time>` : ''}</div>${entry?.note ? `<p class="mt-1 whitespace-pre-wrap text-slate-600 dark:text-slate-300">${Security.escapeHtml(String(entry.note))}</p>` : ''}</div>`;
  }).join('')}</div></details>`;
}

// The reviewer's decision as the customer sees it (P1-12): a request sent back or rejected shows the
// reason's label (never the raw code) and the staff note; any other status keeps the plain note.
function renderAdsStudioReviewFeedback(campaign) {
  const isAr = adsStudioIsAr();
  const status = String(campaign?.status || '');
  const reason = ['Changes Requested', 'Rejected'].includes(status) ? adsStudioReviewReasonLabel(campaign?.reviewReasonCode) : '';
  const note = String(campaign?.reviewNote || '');
  if (!reason && !note) return '';
  const tone = status === 'Rejected' ? 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200' : 'bg-orange-50 dark:bg-orange-900/20 text-orange-800 dark:text-orange-200';
  return `<div class="mt-4 rounded-xl ${tone} p-3 text-sm space-y-1">${reason ? `<div data-ads-studio-review-reason="1"><span class="font-bold">${isAr ? 'السبب:' : 'Reason:'}</span> ${Security.escapeHtml(reason)}</div>` : ''}${note ? `<div><span class="font-bold">${isAr ? 'ملاحظة المراجع:' : 'Reviewer note:'}</span> ${Security.escapeHtml(note)}</div>` : ''}</div>`;
}

function renderAdsStudioCampaigns() {
  const isAr = adsStudioIsAr();
  // foldSearchText on BOTH sides (Arabic digits + unhamza'd spellings).
  const query = foldSearchText(_adsStudioSearch.trim());
  const campaigns = getVisibleAdsStudioCampaigns().filter(item => !query || [item.name, item.pageName, item.objective, item.status].some(value => foldSearchText(value).includes(query)));
  return `
    <section>
      <div class="glass-panel rounded-2xl p-4 mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div class="relative flex-1"><i data-lucide="search" class="absolute ${isAr ? 'right-3' : 'left-3'} top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400"></i><input type="search" value="${Security.escapeHtml(_adsStudioSearch)}" oninput="onAdsStudioSearch(this.value)" class="glass-input min-h-12 w-full rounded-xl ${isAr ? 'pr-11 pl-4' : 'pl-11 pr-4'}" placeholder="${isAr ? 'ابحث باسم الحملة أو الصفحة...' : 'Search campaign or Page...'}" /></div>
        ${adsStudioCanCreate() ? `<button type="button" onclick="beginAdsStudioCampaign(); setAdsStudioTab('builder')" class="touch-target min-h-12 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 px-5 font-bold text-white shadow-lg"><span class="inline-flex items-center gap-2"><i data-lucide="plus" class="w-5 h-5"></i>${isAr ? 'حملة جديدة' : 'New campaign'}</span></button>` : ''}
      </div>
      <div id="ads-studio-campaign-list" class="space-y-4">${campaigns.length ? campaigns.map(renderAdsStudioCampaignCard).join('') : renderAdsStudioEmptyState()}</div>
    </section>
  `;
}

function onAdsStudioSearch(value) {
  _adsStudioSearch = Security.sanitizeInput(String(value || ''), { maxLength: 160 });
  if (window._adsStudioSearchTimer) clearTimeout(window._adsStudioSearchTimer);
  window._adsStudioSearchTimer = setTimeout(() => {
    const list = document.getElementById('ads-studio-campaign-list');
    if (!list || state.currentView !== 'ads-studio' || _adsStudioActiveTab !== 'campaigns') return;
    const query = foldSearchText(_adsStudioSearch.trim());
    const campaigns = getVisibleAdsStudioCampaigns().filter(item => !query || [item.name, item.pageName, item.objective, item.status].some(value => foldSearchText(value).includes(query)));
    list.innerHTML = campaigns.length ? campaigns.map(renderAdsStudioCampaignCard).join('') : renderAdsStudioEmptyState();
    if (typeof IconQueue !== 'undefined') IconQueue.schedule(list);
  }, 100);
}

function beginAdsStudioCampaign() {
  _adsStudioPhotoToken++;
  _adsStudioEditingId = '';
  _adsStudioEditingBaseline = 0;
  _adsStudioWizardStep = 1;
  _adsStudioDraft = newAdsStudioDraft();
  _adsStudioConfirmationChecked = false;
  _adsStudioBudgetTyped = '';
}

async function startAdsStudioCampaign(id) {
  const startToken = ++_adsStudioPhotoToken;
  const startUserId = String(state.currentUser?.id || '');
  let campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign || !['Draft', 'Changes Requested'].includes(String(campaign.status || 'Draft'))) return;
  try {
    campaign = await ensureEntityMediaLoaded('adCampaignRequests', campaign.id) || campaign;
  } catch (_) {
    showNotification(adsStudioText('Could not load creative', 'تعذر تحميل الصور'), adsStudioText('Your existing images are safe. Check the connection before editing this campaign.', 'صورك الحالية آمنة. تحقق من الاتصال قبل تعديل هذه الحملة.'), 'error');
    return;
  }
  if (startToken !== _adsStudioPhotoToken || startUserId !== String(state.currentUser?.id || '')) return;
  if (campaign._mediaOmitted === true && getEntityPhotoCountHint('adCampaignRequests', campaign) > 0 && !isEntityMediaHydrated('adCampaignRequests', campaign)) {
    showNotification(adsStudioText('Could not load creative', 'تعذر تحميل الصور'), adsStudioText('Your existing images are safe. Check the connection before editing this campaign.', 'صورك الحالية آمنة. تحقق من الاتصال قبل تعديل هذه الحملة.'), 'error');
    return;
  }
  _adsStudioEditingId = String(campaign.id || '');
  _adsStudioEditingBaseline = Number(campaign._lastModified) || 0; // open-time version
  _adsStudioWizardStep = 1;
  _adsStudioConfirmationChecked = false;
  _adsStudioDraft = {
    ...newAdsStudioDraft(),
    ...Security.sanitizeObject(campaign),
    platforms: Array.isArray(campaign.platforms) ? campaign.platforms.slice() : [],
    locations: Array.isArray(campaign.locations) ? campaign.locations.slice() : [],
    genders: Array.isArray(campaign.genders) ? campaign.genders.slice() : ['all'],
    languages: Array.isArray(campaign.languages) ? campaign.languages.slice() : [],
    interests: Array.isArray(campaign.interests) ? campaign.interests.slice() : [],
    specialAdCategories: Array.isArray(campaign.specialAdCategories) ? campaign.specialAdCategories.slice() : [],
    creativeImages: Array.isArray(campaign.creativeImages) ? campaign.creativeImages.slice(0, 3) : []
  };
  // A request saved before durationDays existed: its dates give the days (both ends included).
  if (!(Number.isSafeInteger(Number(campaign.durationDays)) && Number(campaign.durationDays) > 0)) {
    _adsStudioDraft.durationDays = adsStudioCampaignDays({ startDate: campaign.startDate, endDate: campaign.endDate }) || 7;
  }
  _adsStudioBudgetTyped = '';
  _adsStudioActiveTab = 'builder';
  try { updateUrlParams({ tab: 'builder' }, true); } catch (_) {}
  render();
}

function adsStudioSetDraftField(field, value) {
  if (!_adsStudioDraft) _adsStudioDraft = newAdsStudioDraft();
  const allowed = new Set(['name', 'objective', 'pageName', 'primaryText', 'headline', 'description', 'callToAction', 'destination', 'ageMin', 'ageMax', 'startDate', 'endDate', 'durationDays', 'budgetType', 'budgetMinorUSD', 'notes', 'boostType', 'sourcePostRef', 'extendsCampaignId']);
  if (!allowed.has(field)) return;
  if (field === 'budgetMinorUSD') {
    const minor = adsStudioParseMoneyMinor(value);  // '٥٠' typed on an Arabic keyboard is $50.00
    _adsStudioDraft[field] = Number.isFinite(minor) ? Math.max(0, minor) : 0;
  } else if (field === 'durationDays') _adsStudioDraft[field] = adsStudioParseDays(value);  // 0 = not a whole number yet
  else if (field === 'ageMin' || field === 'ageMax') _adsStudioDraft[field] = Math.max(0, Math.trunc(Number(value) || 0));
  else _adsStudioDraft[field] = String(value ?? '').slice(0, 4000);
  // The end date follows the start and the number of days (the server recomputes it at approval).
  if (field === 'durationDays' || field === 'startDate') {
    const end = adsStudioEndDateFor(_adsStudioDraft.startDate, _adsStudioDraft.durationDays);
    if (end) _adsStudioDraft.endDate = end;
  }
}

// A typed number of days: a whole number (Arabic-Indic digits too), or 0 when it is not one.
function adsStudioParseDays(raw) {
  const text = normalizeDigitsAscii(String(raw ?? '')).trim();
  if (!/^\d{1,4}$/.test(text)) return 0;
  return parseInt(text, 10);
}

// The last day of an ad that starts on startDate and runs `days` days, both ends included; '' if unknown.
function adsStudioEndDateFor(startDate, days) {
  const start = Date.parse(`${String(startDate || '')}T00:00:00Z`);
  const n = Number(days);
  if (!Number.isFinite(start) || !Number.isSafeInteger(n) || n < 1 || n > 366) return '';
  return new Date(start + (n - 1) * 86400000).toISOString().slice(0, 10);
}

function adsStudioToggleDraftFlag(field, checked) {
  if (!_adsStudioDraft) _adsStudioDraft = newAdsStudioDraft();
  if (field !== 'autoReply') return;
  _adsStudioDraft[field] = checked === true;
}

function adsStudioToggleDraftArray(field, value, checked, exclusive = false) {
  if (!_adsStudioDraft) _adsStudioDraft = newAdsStudioDraft();
  if (!['platforms', 'genders', 'specialAdCategories'].includes(field)) return;
  let current = Array.isArray(_adsStudioDraft[field]) ? _adsStudioDraft[field].slice() : [];
  if (exclusive && checked) current = [value];
  else if (checked && !current.includes(value)) current.push(value);
  else if (!checked) current = current.filter(item => item !== value);
  _adsStudioDraft[field] = current;
}

function adsStudioSetListField(field, raw) {
  if (!_adsStudioDraft || !['locations', 'languages', 'interests'].includes(field)) return;
  _adsStudioDraft[field] = String(raw || '').split(',').map(item => Security.sanitizeInput(item.trim(), { maxLength: 80 })).filter(Boolean).slice(0, field === 'languages' ? 20 : 25);  // the server's limits
}

function adsStudioWizardSteps() {
  // Boost flows fold objective/audience into safe defaults: 3 phone-sized
  // steps instead of 5. "More options" switches to the full wizard.
  if (_adsStudioDraft?.boostType) {
    return [
      ['1', 'rocket', 'Post & text', 'المنشور والنص'],
      ['2', 'calendar-range', 'Budget', 'الميزانية'],
      ['3', 'clipboard-check', 'Review', 'المراجعة']
    ];
  }
  return [
    ['1', 'circle-dot', 'Campaign', 'الحملة'],
    ['2', 'image', 'Creative', 'المحتوى'],
    ['3', 'users-round', 'Audience', 'الجمهور'],
    ['4', 'calendar-range', 'Budget', 'الميزانية'],
    ['5', 'clipboard-check', 'Review', 'المراجعة']
  ];
}

function adsStudioSwitchToFullWizard() {
  if (!_adsStudioDraft) return;
  _adsStudioDraft.boostType = '';
  _adsStudioWizardStep = 1;
  render();
}

function renderAdsStudioWizardProgress() {
  const isAr = adsStudioIsAr();
  const steps = adsStudioWizardSteps();
  const current = steps.find(step => Number(step[0]) === Number(_adsStudioWizardStep)) || steps[0];
  const currentNumber = Number(current[0]);
  // Read-only progress, not jump links: Continue/Back still run the existing
  // draft validation and navigation. The boost flow keeps its three steps.
  return `<section class="studio-wizard-progress" aria-label="${isAr ? 'مراحل إنشاء الحملة' : 'Campaign setup progress'}">
    <div class="studio-wizard-current" role="status" aria-live="polite" aria-atomic="true">
      <span>${isAr ? `الخطوة ${currentNumber} من ${steps.length}` : `Step ${currentNumber} of ${steps.length}`}</span>
      <strong>${Security.escapeHtml(isAr ? current[3] : current[2])}</strong>
    </div>
    <ol class="studio-wizard-steps" role="list" style="--studio-step-count:${steps.length}">
      ${steps.map(([num, icon, en, ar]) => `<li class="studio-wizard-step ${Number(num) < currentNumber ? 'is-complete' : (Number(num) === currentNumber ? 'is-current' : '')}"${Number(num) === currentNumber ? ' aria-current="step"' : ''}>
        <span class="studio-wizard-step-number" aria-hidden="true">${Number(num) < currentNumber ? '<i data-lucide="check" class="w-4 h-4"></i>' : num}</span>
        <span class="studio-wizard-step-label"><span class="sr-only">${isAr ? 'الخطوة' : 'Step'} ${num}: </span>${Security.escapeHtml(isAr ? ar : en)}${Number(num) < currentNumber ? `<span class="sr-only"> — ${isAr ? 'مكتملة' : 'completed'}</span>` : ''}</span>
      </li>`).join('')}
    </ol>
  </section>`;
}

function renderAdsStudioBuilder() {
  if (!_adsStudioDraft) beginAdsStudioCampaign();
  const isAr = adsStudioIsAr();
  const isBoost = !!_adsStudioDraft.boostType;
  const lastStep = _adsStudioWizardStep >= adsStudioWizardSteps().length;
  // The intake switch can change while the customer fills the form: re-read /me at the last step.
  if (lastStep) refreshAdsStudioLimits(60000);
  const paused = _adsStudioIntakeOpen === false;
  const stepContent = isBoost
    ? (_adsStudioWizardStep === 1 ? renderAdsStudioBoostBasicsStep()
      : _adsStudioWizardStep === 2 ? renderAdsStudioBudgetStep()
        : renderAdsStudioReviewStep())
    : (_adsStudioWizardStep === 1 ? renderAdsStudioBasicsStep()
      : _adsStudioWizardStep === 2 ? renderAdsStudioCreativeStep()
        : _adsStudioWizardStep === 3 ? renderAdsStudioAudienceStep()
          : _adsStudioWizardStep === 4 ? renderAdsStudioBudgetStep()
            : renderAdsStudioReviewStep());
  return `
    <section class="max-w-4xl mx-auto">
      <div class="flex items-center justify-between gap-3 mb-4"><div><h2 class="text-xl sm:text-2xl font-black text-slate-900 dark:text-white">${_adsStudioEditingId ? (isAr ? 'تعديل مسودة الحملة' : 'Edit campaign draft') : (isAr ? 'حملة إعلانية جديدة' : 'New ad campaign')}</h2><p class="text-sm text-slate-500">${isAr ? 'يمكنك الحفظ والعودة في أي وقت' : 'Save now and continue at any time'}</p></div><button type="button" onclick="setAdsStudioTab('campaigns')" class="touch-target min-h-11 rounded-xl px-3 font-bold text-slate-600 dark:text-slate-300"><span class="inline-flex items-center gap-1"><i data-lucide="x" class="w-5 h-5"></i>${isAr ? 'إغلاق' : 'Close'}</span></button></div>
      <div class="glass-panel rounded-3xl p-4 sm:p-7">
        ${renderAdsStudioWizardProgress()}
        <div id="ads-studio-wizard-step">${stepContent}</div>
        <div class="mt-7 flex flex-col-reverse gap-3 border-t border-slate-200 dark:border-slate-700 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex gap-2">
            ${_adsStudioWizardStep > 1 ? `<button type="button" onclick="moveAdsStudioWizard(-1)" class="touch-target min-h-12 rounded-xl bg-slate-100 dark:bg-slate-800 px-5 font-bold text-slate-700 dark:text-slate-200"><span class="inline-flex items-center gap-2"><i data-lucide="${isAr ? 'arrow-right' : 'arrow-left'}" class="w-4 h-4"></i>${isAr ? 'السابق' : 'Back'}</span></button>` : ''}
            <button type="button" onclick="saveAdsStudioDraft(false, this)" class="touch-target min-h-12 rounded-xl border border-blue-200 dark:border-blue-800 px-5 font-bold text-blue-700 dark:text-blue-300 disabled:opacity-60"><span class="inline-flex items-center gap-2"><i data-lucide="save" class="w-4 h-4"></i>${isAr ? 'حفظ المسودة' : 'Save draft'}</span></button>
          </div>
          ${!lastStep ? `<button type="button" onclick="moveAdsStudioWizard(1)" class="touch-target min-h-12 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 px-6 font-black text-white shadow-lg"><span class="inline-flex items-center gap-2">${isAr ? 'التالي' : 'Continue'}<i data-lucide="${isAr ? 'arrow-left' : 'arrow-right'}" class="w-4 h-4"></i></span></button>` : `<div class="flex flex-col gap-2"><p id="ads-studio-intake-note" role="status" class="${paused ? '' : 'hidden '}text-sm font-bold text-amber-700 dark:text-amber-300">${Security.escapeHtml(adsStudioIntakePausedText())}</p><button type="button" id="ads-studio-submit-button" onclick="saveAndSubmitAdsStudioDraft(this)"${paused ? ' disabled' : ''} class="touch-target min-h-12 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 px-6 font-black text-white shadow-lg disabled:opacity-60"><span class="inline-flex items-center gap-2"><i data-lucide="send" class="w-4 h-4"></i>${isAr ? 'حفظ وإرسال للمراجعة' : 'Save & submit for review'}</span></button></div>`}
        </div>
      </div>
    </section>
  `;
}

function renderAdsStudioBasicsStep() {
  const d = _adsStudioDraft;
  const isAr = adsStudioIsAr();
  return `<div class="space-y-6"><div><h3 class="text-lg font-black text-slate-900 dark:text-white">${isAr ? 'ما الذي تريد تحقيقه؟' : 'What do you want to achieve?'}</h3><p class="text-sm text-slate-500">${isAr ? 'اختر هدفاً واحداً واضحاً للحملة.' : 'Choose one clear objective for this campaign.'}</p></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'اسم الحملة *' : 'Campaign name *'}</label><input type="text" maxlength="120" value="${Security.escapeHtml(d.name || '')}" id="ads-studio-field-name" oninput="adsStudioSetDraftField(\'name\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="${isAr ? 'مثال: عروض الصيف - رسائل واتساب' : 'e.g. Summer offers — WhatsApp messages'}" /></div>
    <div class="grid gap-3 sm:grid-cols-2">${ADS_STUDIO_OBJECTIVES.map(item => `<label class="cursor-pointer rounded-2xl border-2 p-4 transition-colors ${d.objective === item.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700'}"><input type="radio" name="ads-objective" class="sr-only" value="${item.id}" ${d.objective === item.id ? 'checked' : ''} onchange="adsStudioSetDraftField('objective', this.value); render()" /><span class="flex items-start gap-3"><span class="w-10 h-10 rounded-xl bg-white dark:bg-slate-800 flex items-center justify-center text-blue-600"><i data-lucide="${item.icon}" class="w-5 h-5"></i></span><span><span class="block font-black text-slate-900 dark:text-white">${isAr ? item.labelAr : item.label}</span><span class="block text-xs text-slate-500 mt-1">${isAr ? item.descAr : item.desc}</span></span></span></label>`).join('')}</div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'المنصات *' : 'Platforms *'}</label><div class="grid grid-cols-2 gap-3"><label class="touch-target min-h-12 flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-4"><input type="checkbox" ${d.platforms.includes('facebook') ? 'checked' : ''} onchange="adsStudioToggleDraftArray('platforms','facebook',this.checked)" class="w-5 h-5 accent-blue-600" /><i data-lucide="facebook" class="w-5 h-5 text-blue-600"></i><span class="font-bold">Facebook</span></label><label class="touch-target min-h-12 flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-4"><input type="checkbox" ${d.platforms.includes('instagram') ? 'checked' : ''} onchange="adsStudioToggleDraftArray('platforms','instagram',this.checked)" class="w-5 h-5 accent-fuchsia-600" /><i data-lucide="instagram" class="w-5 h-5 text-fuchsia-600"></i><span class="font-bold">Instagram</span></label></div></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'اسم صفحة فيسبوك أو حساب إنستغرام *' : 'Facebook Page or Instagram account name *'}</label><input type="text" maxlength="160" value="${Security.escapeHtml(d.pageName || '')}" id="ads-studio-field-pageName" oninput="adsStudioSetDraftField(\'pageName\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="${isAr ? 'اكتب اسم الصفحة التي تريد الإعلان منها' : 'Name of the Page that should run the ad'}" /><p class="mt-2 text-xs text-slate-500">${isAr ? 'سيتم التحقق من ملكية الصفحة عند ربط حساب ميتا.' : 'Ownership will be verified when the Meta account is connected.'}</p></div>
  </div>`;
}

function renderAdsStudioBoostBasicsStep() {
  const d = _adsStudioDraft;
  const isAr = adsStudioIsAr();
  const isPost = d.boostType === 'boost_post';
  if (isPost) adsStudioLoadPostPages();  // once per session; the list fills in place
  const kindButton = (kind, icon, en, ar) => `<button type="button" onclick="adsStudioSetBoostKind('${kind}')" aria-pressed="${d.boostType === kind}" class="touch-target min-h-12 inline-flex items-center justify-center gap-2 rounded-xl border-2 px-3 text-sm font-bold ${d.boostType === kind ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}"><i data-lucide="${icon}" class="w-4 h-4"></i><span>${isAr ? ar : en}</span></button>`;
  return `<div class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div><h3 class="text-lg font-black text-slate-900 dark:text-white">${isPost ? (isAr ? 'أي منشور تريد تعزيزه؟' : 'Which post do you want to boost?') : (isAr ? 'عرّفنا بصفحتك' : 'Tell us about your Page')}</h3><p class="text-sm text-slate-500">${isAr ? 'ثلاث خطوات فقط — نتكفل نحن بالباقي.' : 'Just three steps — we handle the rest.'}</p></div>
      <button type="button" onclick="adsStudioSwitchToFullWizard()" class="touch-target min-h-11 px-3 text-sm font-bold text-blue-600">${isAr ? 'خيارات أكثر' : 'More options'}</button>
    </div>
    <div class="grid grid-cols-2 gap-2" role="group" aria-label="${isAr ? 'ماذا تريد أن تعلن؟' : 'What do you want to advertise?'}">${kindButton('boost_post', 'rocket', 'Boost a post', 'تعزيز منشور')}${kindButton('boost_page', 'image-plus', 'New ad without a post', 'إعلان جديد بدون منشور')}</div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'اسم الحملة *' : 'Campaign name *'}</label><input type="text" maxlength="120" value="${Security.escapeHtml(d.name || '')}" id="ads-studio-field-name" oninput="adsStudioSetDraftField(\'name\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'اسم صفحتك أو حسابك *' : 'Your Page or account name *'}</label><input type="text" maxlength="160" value="${Security.escapeHtml(d.pageName || '')}" id="ads-studio-field-pageName" oninput="adsStudioSetDraftField(\'pageName\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div>
    ${isPost ? `
    <div id="ads-studio-post-picker" class="space-y-3" aria-live="polite">${renderAdsStudioPostPickerBody()}</div>
    <div id="ads-studio-post-link" class="${adsStudioShowPostLinkField(d) ? '' : 'hidden'}"><label class="block text-sm font-bold mb-2">${isAr ? 'رابط المنشور' : 'Link to your post'}</label><input type="url" maxlength="500" value="${Security.escapeHtml(d.sourcePostRef || '')}" id="ads-studio-field-sourcePostRef" oninput="adsStudioSetDraftField(\'sourcePostRef\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="https://www.facebook.com/..." /><p class="mt-2 text-xs text-slate-500">${isAr ? 'افتح المنشور على فيسبوك أو إنستغرام وانسخ رابطه هنا.' : 'Open the post on Facebook or Instagram and copy its link here.'}</p></div>
    <label class="touch-target flex items-start gap-3 rounded-2xl border border-slate-200 dark:border-slate-700 p-4"><input type="checkbox" ${d.autoReply ? 'checked' : ''} onchange="adsStudioToggleDraftFlag('autoReply', this.checked)" class="mt-0.5 w-5 h-5 accent-blue-600" /><span><span class="block font-bold text-slate-800 dark:text-slate-100">${isAr ? 'الرد التلقائي على الرسائل' : 'Auto-reply to messages'}</span><span class="block text-xs text-slate-500 mt-0.5">${isAr ? 'نرد تلقائياً على من يراسلك من الإعلان — اكتب نص الرد في الملاحظات.' : 'We reply automatically to people who message from this ad — put the reply text in the notes.'}</span></span></label>` : `
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'رابط صفحتك *' : 'Your Page link *'}</label><input type="url" maxlength="500" value="${Security.escapeHtml(d.destination || '')}" id="ads-studio-field-destination" oninput="adsStudioSetDraftField(\'destination\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="https://www.facebook.com/yourpage" /></div>`}
    <div><label class="block text-sm font-bold mb-2">${isPost ? (isAr ? 'نص قصير للإعلان (اختياري)' : 'Short ad text (optional)') : (isAr ? 'نص قصير للإعلان *' : 'Short ad text *')}</label><textarea rows="3" maxlength="2200" id="ads-studio-field-primaryText" oninput="adsStudioSetDraftField(\'primaryText\', this.value)" class="glass-input w-full rounded-xl px-4 py-3" placeholder="${isAr ? 'اكتب الرسالة التي سيقرأها العميل...' : 'Write the message customers will see...'}">${Security.escapeHtml(d.primaryText || '')}</textarea></div>
    <div data-photo-paste-target="ads-studio" tabindex="0" class="rounded-2xl border border-slate-200 dark:border-slate-700 p-3 focus:outline-none focus:ring-2 focus:ring-blue-500">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-2"><label class="block text-sm font-bold">${isPost ? (isAr ? 'صورة من المنشور (اختياري، حتى 3)' : 'A picture of the post (optional, up to 3)') : (isAr ? 'الصور (حتى 3) *' : 'Images (up to 3) *')}</label><span class="text-xs text-slate-500">${(d.creativeImages || []).length}/3</span></div>
      <div id="ads-studio-creative-preview">${renderAdsStudioCreativePreview()}</div>
      <input id="ads-studio-image-input" type="file" accept="image/png,image/jpeg,image/webp" multiple class="hidden" onchange="onAdsStudioCreativeSelected(this)" />
    </div>
  </div>`;
}

// ---- Post picker (owner decision D19) ----
// "Boost a post" lists the customer's linked pages (GET /api/studio/pages) and a page's recent posts
// (GET /api/studio/pages/{id}/recent-posts: thumbnail, excerpt, date); a tap chooses the post
// (sourcePostId + sourcePostPlatform, the page as connectedAssetId, the post's link as sourcePostRef).
// Pasting the post link stays as the fallback when no page is linked or the list cannot be read.
// Every server string is escaped; a thumbnail is used only when it is https, a link only when it is
// a Meta post link. Lists load once per session and refresh in place (the keyboard stays put).
const _adsStudioPostPicker = { forUser: '', pagesState: '', pages: [], pagesError: null, pagesFailedAt: 0, pageId: '', posts: Object.create(null), generation: 0 };

function resetAdsStudioPostPicker() {
  _adsStudioPostPicker.generation++;  // a reply still in flight belongs to the old session: dropped
  _adsStudioPostPicker.forUser = '';
  _adsStudioPostPicker.pagesState = '';
  _adsStudioPostPicker.pages = [];
  _adsStudioPostPicker.pagesError = null;
  _adsStudioPostPicker.pagesFailedAt = 0;
  _adsStudioPostPicker.pageId = '';
  _adsStudioPostPicker.posts = Object.create(null);
}

// A failed call as {code, message, retryAfterSeconds}: /api/studio sends {detail: {code, message}},
// other routes a string. apiJson's 429 branch keeps no payload: its message is that detail written
// as JSON ('{"code":"RATE_LIMITED",...}'), so a 429 (or that shape) is RATE_LIMITED with its wait.
function adsStudioErrorInfo(error) {
  const wait = Number(error?.retryAfter);
  const retryAfterSeconds = Number.isSafeInteger(wait) && wait > 0 ? Math.min(wait, 86400) : 0;
  const detail = error?.payload?.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) return { code: String(detail.code || ''), message: String(detail.message || ''), retryAfterSeconds };
  let message = typeof detail === 'string' ? detail : String(error?.message || '');
  let code = '';
  if (/^\s*\{/.test(message)) {
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { code = String(parsed.code || ''); message = String(parsed.message || ''); }
    } catch (_) { /* not JSON: the text stays as it is */ }
  }
  if (error?.status === 429) code = 'RATE_LIMITED';
  return { code, message, retryAfterSeconds };
}

// The list refusals that carry a code (studio_posts.py); anything else goes through the refusal map
// (the unknown-page refusal is T12 there).
const ADS_STUDIO_PICKER_ERRORS = {
  META_PAUSED: ['Meta is busy right now. Try again in a minute.', 'ميتا مشغولة الآن. أعد المحاولة بعد دقيقة.'],
  META_NOT_CONFIGURED: ["Albayan's Meta connection is not set up yet, so your posts cannot be listed.", 'ربط البيان مع ميتا غير مُعدّ بعد، لذلك لا يمكن عرض منشوراتك.'],
  RATE_LIMITED: ['Too many requests. Please wait a minute and try again.', 'طلبات كثيرة. انتظر دقيقة ثم أعد المحاولة.']
};

function adsStudioPickerErrorText(info) {
  const code = String(info?.code || '');
  const wait = code === 'RATE_LIMITED' ? adsStudioWaitText(info?.retryAfterSeconds) : null;
  if (wait) return adsStudioText(`Too many requests. Please wait ${wait[0]} and try again.`, `طلبات كثيرة. انتظر ${wait[1]} ثم أعد المحاولة.`);
  const known = Object.prototype.hasOwnProperty.call(ADS_STUDIO_PICKER_ERRORS, code) ? ADS_STUDIO_PICKER_ERRORS[code] : null;
  return known ? adsStudioText(known[0], known[1]) : adsStudioRefusalText(String(info?.message || ''));
}

// A wait (Retry-After seconds) as [English, Arabic] words, or null for none or exactly a minute (the
// RATE_LIMITED text already says "a minute"). From two minutes on it counts whole minutes, rounded up.
function adsStudioWaitText(seconds) {
  const s = Math.ceil(Number(seconds) || 0);
  if (!(s > 0) || s === 60) return null;
  const minutes = s >= 120 ? Math.ceil(s / 60) : 0;
  const n = minutes || s;
  const [one, two, few, many] = minutes ? ['دقيقة واحدة', 'دقيقتين', 'دقائق', 'دقيقة'] : ['ثانية واحدة', 'ثانيتين', 'ثوانٍ', 'ثانية'];
  const en = `${n} ${minutes ? (n === 1 ? 'minute' : 'minutes') : (n === 1 ? 'second' : 'seconds')}`;
  return [en, n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`];
}

function adsStudioSafeHttpsUrl(value) {
  const raw = String(value || '').trim();
  return raw.length <= 2000 && /^https:\/\/[^\s"'<>\\`]+$/i.test(raw) ? raw : '';
}

function adsStudioPagePlatforms(raw) {
  const flags = { fb: false, ig: false };
  const mark = value => {
    const v = String(value || '').toLowerCase();
    if (v === 'fb' || v === 'facebook') flags.fb = true;
    if (v === 'ig' || v === 'instagram') flags.ig = true;
  };
  mark(raw.platform);
  if (Array.isArray(raw.platforms)) raw.platforms.slice(0, 5).forEach(mark);
  if (raw.facebook === true || raw.hasFacebook === true || raw.fb === true) flags.fb = true;
  if (raw.instagram === true || raw.hasInstagram === true || raw.ig === true) flags.ig = true;
  return flags;
}

function adsStudioNormalizePostPages(payload) {
  const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.pages) ? payload.pages : []);
  const pages = [];
  const seen = new Set();
  for (const raw of list.slice(0, 50)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    pages.push({ id, name: String(raw.name ?? raw.pageName ?? '').trim().slice(0, 160), ...adsStudioPagePlatforms(raw) });
  }
  return pages;
}

function adsStudioNormalizeRecentPosts(payload) {
  const list = payload && Array.isArray(payload.posts) ? payload.posts : [];
  const posts = [];
  for (const raw of list.slice(0, 25)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id ?? '').trim();
    const kind = String(raw.platform || '').toLowerCase();
    const platform = kind === 'fb' || kind === 'facebook' ? 'fb' : (kind === 'ig' || kind === 'instagram' ? 'ig' : '');
    if (!id || id.length > 200 || /\s/.test(id) || !platform) continue;
    posts.push({
      id,
      platform,
      excerpt: String(raw.excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, 280),
      imageUrl: adsStudioSafeHttpsUrl(raw.imageUrl),
      permalink: adsStudioIsValidBoostRef(raw.permalink) ? String(raw.permalink).trim().slice(0, 500) : '',
      createdAt: String(raw.createdAt ?? '').slice(0, 40)
    });
  }
  // Per platform, what Meta answered (studio_posts.py): state 'ok', 'paused' (try again after
  // retryAfterSeconds) or 'error' (errorCode 'page_access' or 'meta_error'), and when it was read.
  const platforms = {};
  const rawPlatforms = payload && payload.platforms && typeof payload.platforms === 'object' && !Array.isArray(payload.platforms) ? payload.platforms : {};
  for (const name of ['fb', 'ig']) {
    const part = rawPlatforms[name];
    if (!part || typeof part !== 'object') continue;
    const partState = String(part.state || '');
    const errorCode = String(part.errorCode || '');
    const wait = Number(part.retryAfterSeconds);
    platforms[name] = {
      state: ['ok', 'paused', 'error'].includes(partState) ? partState : '',
      errorCode: /^[a-z_]{1,40}$/.test(errorCode) ? errorCode : '',
      retryAfterSeconds: Number.isSafeInteger(wait) && wait > 0 ? Math.min(wait, 86400) : 0,
      checkedAt: String(part.checkedAt ?? '').slice(0, 40)
    };
  }
  return { posts, checkedAt: String(payload?.checkedAt ?? '').slice(0, 40), platforms };
}

// The platforms of a page's list that Meta did not read now: 'error', or 'paused' with none of that
// platform's posts kept to show. A read that failed as a whole is entry.state 'failed'.
function adsStudioUnreadPostPlatforms(entry) {
  const platforms = entry && entry.platforms && typeof entry.platforms === 'object' ? entry.platforms : {};
  const posts = Array.isArray(entry?.posts) ? entry.posts : [];
  return ['fb', 'ig'].filter(name => {
    const part = platforms[name];
    if (!part) return false;
    return part.state === 'error' || (part.state === 'paused' && !posts.some(post => post.platform === name));
  });
}

// True when the page's list could not be read from Meta now (all of it, or one platform of it).
function adsStudioPostsUnreadable(entry) {
  return !!entry && (entry.state === 'failed' || adsStudioUnreadPostPlatforms(entry).length > 0);
}

// Why those platforms were not read: the page's access is gone, or Meta is busy (with the wait).
function adsStudioUnreadPostsDetail(entry, unread) {
  const parts = unread.map(name => entry.platforms[name]);
  if (parts.some(part => part.errorCode === 'page_access')) {
    return adsStudioText('Albayan can no longer read this page. Ask us to link it again.', 'لم يعد بإمكان البيان قراءة هذه الصفحة. اطلب منا ربطها من جديد.');
  }
  if (!parts.every(part => part.state === 'paused')) return '';
  const wait = adsStudioWaitText(Math.max(...parts.map(part => part.retryAfterSeconds)));
  return wait ? adsStudioText(`Meta is busy right now. Try again in ${wait[0]}.`, `ميتا مشغولة الآن. أعد المحاولة بعد ${wait[1]}.`)
    : adsStudioText(ADS_STUDIO_PICKER_ERRORS.META_PAUSED[0], ADS_STUDIO_PICKER_ERRORS.META_PAUSED[1]);
}

async function adsStudioLoadPostPages(force = false) {
  const picker = _adsStudioPostPicker;
  const uid = String(state.currentUser?.id || '');
  if (!uid || !isServerModeEnabled()) return;
  if (picker.forUser !== uid) { resetAdsStudioPostPicker(); picker.forUser = uid; }
  if (picker.pagesState === 'loading') return;
  if (!force && (picker.pagesState === 'done' || (picker.pagesState === 'failed' && Date.now() - picker.pagesFailedAt < 60000))) return;
  const generation = picker.generation;
  picker.pagesState = 'loading';
  picker.pagesError = null;
  adsStudioRefreshPostPicker();
  let pages = null;
  let error = null;
  try {
    pages = adsStudioNormalizePostPages(await apiJson('/api/studio/pages', { method: 'GET' }));
  } catch (e) { error = adsStudioErrorInfo(e); }
  if (generation !== picker.generation || uid !== String(state.currentUser?.id || '')) return;
  if (pages) {
    picker.pages = pages;
    picker.pagesState = 'done';
    if (!pages.some(page => page.id === picker.pageId)) {
      const linked = pages.find(page => page.id === String(_adsStudioDraft?.connectedAssetId || ''));
      picker.pageId = (linked || pages[0] || { id: '' }).id;
    }
  } else {
    picker.pagesState = 'failed';
    picker.pagesError = error;
    picker.pagesFailedAt = Date.now();
  }
  adsStudioRefreshPostPicker();
  if (picker.pageId) adsStudioLoadPagePosts(picker.pageId);
}

async function adsStudioLoadPagePosts(pageId, force = false) {
  const picker = _adsStudioPostPicker;
  const id = String(pageId || '');
  if (!id || !isServerModeEnabled()) return;
  const current = picker.posts[id];
  if (current && current.state === 'loading') return;
  if (!force && current && (current.state === 'done' || (current.state === 'failed' && Date.now() - current.at < 60000))) return;
  const generation = picker.generation;
  picker.posts[id] = { state: 'loading', posts: current?.posts || [], checkedAt: current?.checkedAt || '', platforms: current?.platforms || {}, error: null, at: Date.now() };
  adsStudioRefreshPostPicker();
  let result = null;
  let error = null;
  try {
    // "Try again" asks the server to read Meta again (it does so when its list is over a minute old).
    result = adsStudioNormalizeRecentPosts(await apiJson(`/api/studio/pages/${encodeURIComponent(id)}/recent-posts${force ? '?refresh=1' : ''}`, { method: 'GET' }));
  } catch (e) { error = adsStudioErrorInfo(e); }
  if (generation !== picker.generation) return;
  picker.posts[id] = result
    ? { state: 'done', posts: result.posts, checkedAt: result.checkedAt, platforms: result.platforms, error: null, at: Date.now() }
    : { state: 'failed', posts: current?.posts || [], checkedAt: current?.checkedAt || '', platforms: current?.platforms || {}, error, at: Date.now() };
  adsStudioRefreshPostPicker();
}

// The paste-a-link fallback: offline, no linked page, the pages or the page's posts could not be
// read (the whole list, or one platform Meta did not answer), or a draft that already holds a
// pasted link (so it stays editable).
function adsStudioShowPostLinkField(draft) {
  const picker = _adsStudioPostPicker;
  if (!isServerModeEnabled() || picker.pagesState === 'failed') return true;
  if (picker.pagesState === 'done' && !picker.pages.length) return true;
  if (picker.pagesState === 'done' && adsStudioPostsUnreadable(picker.posts[picker.pageId])) return true;
  return !String(draft?.sourcePostId || '').trim() && !!String(draft?.sourcePostRef || '').trim();
}

// True when a boost request names its post: one picked from the list, or a pasted Meta link.
function adsStudioBoostHasPost(draft) {
  return String(draft?.boostType || '') === 'boost_post'
    && (!!String(draft?.sourcePostId || '').trim() || adsStudioIsValidBoostRef(draft?.sourcePostRef));
}

function adsStudioRefreshPostPicker() {
  if (typeof document === 'undefined' || String(_adsStudioDraft?.boostType || '') !== 'boost_post') return;
  const wrap = document.getElementById('ads-studio-post-picker');
  if (wrap) {
    wrap.innerHTML = renderAdsStudioPostPickerBody();
    if (typeof IconQueue !== 'undefined') IconQueue.schedule(wrap);
  }
  const link = document.getElementById('ads-studio-post-link');
  if (link) link.classList.toggle('hidden', !adsStudioShowPostLinkField(_adsStudioDraft));
}

function adsStudioPostDateText(value, withTime = false) {
  const when = new Date(String(value || ''));
  if (!Number.isFinite(when.getTime())) return '';
  const options = withTime ? { timeZone: 'Africa/Tripoli', dateStyle: 'medium', timeStyle: 'short' } : { timeZone: 'Africa/Tripoli' };
  try { return when[withTime ? 'toLocaleString' : 'toLocaleDateString'](adsStudioIsAr() ? 'ar-LY' : 'en-GB', options); } catch (_) { return ''; }
}

function renderAdsStudioPostPickerBody() {
  const isAr = adsStudioIsAr();
  const d = _adsStudioDraft || {};
  const picker = _adsStudioPostPicker;
  const esc = value => Security.escapeHtml(String(value ?? ''));
  const note = (icon, text, tone = 'text-slate-500') => `<p class="flex items-start gap-2 text-sm ${tone}"><i data-lucide="${icon}" class="w-4 h-4 flex-shrink-0 mt-0.5"></i><span>${text}</span></p>`;
  const retry = handler => `<button type="button" onclick="${handler}" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 px-3 text-sm font-bold text-slate-700 dark:text-slate-200"><i data-lucide="refresh-cw" class="w-4 h-4"></i>${isAr ? 'أعد المحاولة' : 'Try again'}</button>`;
  const title = `<div class="text-sm font-bold">${isAr ? 'اختر المنشور من صفحتك' : 'Choose the post from your page'}</div>`;
  if (!isServerModeEnabled()) return '';
  if (picker.pagesState === '' || picker.pagesState === 'loading') {
    return title + note('loader', isAr ? 'نحمّل صفحاتك المرتبطة...' : 'Loading your linked pages...');
  }
  if (picker.pagesState === 'failed') {
    return title + note('triangle-alert', `${isAr ? 'تعذّر تحميل صفحاتك. يمكنك لصق رابط المنشور بالأسفل.' : 'Your pages could not be loaded. You can paste the post link below.'}${picker.pagesError ? ` (${esc(adsStudioPickerErrorText(picker.pagesError))})` : ''}`, 'text-amber-700 dark:text-amber-300') + retry('adsStudioLoadPostPages(true)');
  }
  if (!picker.pages.length) {
    return title + note('info', isAr ? 'لا توجد صفحة مرتبطة بحسابك بعد. الصق رابط المنشور بالأسفل، أو اطلب منا ربط صفحتك لتختار منشوراتك من قائمة.' : 'No page is linked to your account yet. Paste the post link below, or ask us to link your page so you can pick posts from a list.');
  }
  const pageChips = `<div class="flex flex-wrap gap-2" role="group" aria-label="${isAr ? 'صفحاتك المرتبطة' : 'Your linked pages'}">${picker.pages.map((page, index) => {
    const active = page.id === picker.pageId;
    return `<button type="button" onclick="adsStudioPickPostPage(${index})" aria-pressed="${active}" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl border-2 px-3 text-sm font-bold ${active ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}">${page.fb ? '<i data-lucide="facebook" class="w-4 h-4"></i>' : ''}${page.ig ? '<i data-lucide="instagram" class="w-4 h-4"></i>' : ''}<span>${esc(page.name || (isAr ? 'صفحة' : 'Page'))}</span></button>`;
  }).join('')}</div>`;
  const entry = picker.posts[picker.pageId];
  let list = '';
  if (!entry || (entry.state === 'loading' && !entry.posts.length)) {
    list = note('loader', isAr ? 'نحمّل آخر المنشورات...' : 'Loading recent posts...');
  } else {
    const chosenId = String(d.sourcePostId || '');
    const items = entry.posts.map((post, index) => {
      const chosen = post.id === chosenId;
      const date = adsStudioPostDateText(post.createdAt);
      const excerpt = post.excerpt.length > 140 ? `${post.excerpt.slice(0, 140)}…` : post.excerpt;
      return `<button type="button" data-post-id="${esc(post.id)}" onclick="adsStudioChooseBoostPost(${index}, this)" aria-pressed="${chosen}" class="touch-target w-full min-h-14 flex items-center gap-3 rounded-2xl border-2 p-2 ${isAr ? 'text-right' : 'text-left'} ${chosen ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700'}">
        ${post.imageUrl ? `<img src="${esc(post.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" class="w-14 h-14 flex-shrink-0 rounded-xl object-cover bg-slate-100" />` : `<span class="w-14 h-14 flex-shrink-0 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400"><i data-lucide="image" class="w-6 h-6"></i></span>`}
        <span class="min-w-0 flex-1"><span class="block text-sm font-bold text-slate-800 dark:text-slate-100 break-words">${esc(excerpt || (isAr ? 'منشور بدون نص' : 'Post without text'))}</span><span class="mt-1 flex items-center gap-1 text-xs text-slate-500"><i data-lucide="${post.platform === 'ig' ? 'instagram' : 'facebook'}" class="w-3.5 h-3.5"></i>${esc(date)}</span></span>
        ${chosen ? `<span class="flex-shrink-0 text-blue-600" aria-label="${isAr ? 'تم الاختيار' : 'Chosen'}"><i data-lucide="circle-check" class="w-5 h-5"></i></span>` : ''}
      </button>`;
    }).join('');
    // Meta could not be read now (the whole list, or one of its platforms): say so with Try again and
    // the link fallback below; never "no recent posts" for a list Meta did not give.
    const unread = entry.state === 'done' ? adsStudioUnreadPostPlatforms(entry) : [];
    let problem = '';
    if (entry.state === 'failed' || unread.length) {
      const platformName = unread.length === 1 ? (unread[0] === 'ig' ? (isAr ? 'إنستغرام' : 'Instagram') : (isAr ? 'فيسبوك' : 'Facebook')) : '';
      const detail = entry.state === 'failed' ? (entry.error ? adsStudioPickerErrorText(entry.error) : '') : adsStudioUnreadPostsDetail(entry, unread);
      problem = note('triangle-alert', `${isAr ? 'تعذّر علينا قراءة منشوراتك من ميتا الآن' : 'We could not read your posts from Meta right now'}${platformName ? ` (${platformName})` : ''}. ${isAr ? 'يمكنك لصق رابط المنشور بالأسفل.' : 'You can paste the post link below.'}${detail ? ` (${esc(detail)})` : ''}`, 'text-amber-700 dark:text-amber-300') + retry('adsStudioRetryPagePosts()');
    }
    const empty = entry.state === 'done' && !entry.posts.length && !problem
      ? note('info', isAr ? 'لا توجد منشورات حديثة على هذه الصفحة. انشر شيئاً ثم أعد المحاولة، أو اختر «إعلان جديد بدون منشور».' : 'No recent posts on this page. Post something and try again, or choose "New ad without a post".') + retry('adsStudioRetryPagePosts()')
      : '';
    const checkedText = adsStudioPostDateText(entry.checkedAt, true);
    const checked = checkedText ? `<p class="text-xs text-slate-400">${isAr ? 'آخر فحص:' : 'Checked:'} ${esc(checkedText)}</p>` : '';
    list = `${problem}${empty}${items ? `<div class="grid gap-2 sm:grid-cols-2">${items}</div>` : ''}${checked}`;
  }
  return `${title}${pageChips}${list}`;
}

function adsStudioPickPostPage(index) {
  const page = _adsStudioPostPicker.pages[Number(index)];
  if (!page) return;
  _adsStudioPostPicker.pageId = page.id;
  adsStudioRefreshPostPicker();
  adsStudioLoadPagePosts(page.id);
}

function adsStudioRetryPagePosts() {
  adsStudioLoadPagePosts(_adsStudioPostPicker.pageId, true);
}

function adsStudioChooseBoostPost(index, button = null) {
  const d = _adsStudioDraft;
  if (!d || String(d.boostType || '') !== 'boost_post') return;
  const picker = _adsStudioPostPicker;
  const page = picker.pages.find(item => item.id === picker.pageId);
  const post = page ? (picker.posts[page.id]?.posts || [])[Number(index)] : null;
  if (!post) return;
  // The list may have refreshed under the finger: only the post that was on the button counts.
  if (button && typeof button.getAttribute === 'function' && button.getAttribute('data-post-id') !== post.id) return;
  if (String(d.destination || '') === String(d.sourcePostRef || '')) d.destination = '';  // re-derived from the new post
  d.sourcePostId = post.id;
  d.sourcePostPlatform = post.platform;
  d.sourcePostRef = post.permalink;
  d.connectedAssetId = page.id;
  if (!String(d.pageName || '').trim() && page.name) d.pageName = page.name;
  render();
}

function renderAdsStudioCreativeStep() {
  const d = _adsStudioDraft;
  const isAr = adsStudioIsAr();
  return `<div class="space-y-5"><div><h3 class="text-lg font-black text-slate-900 dark:text-white">${isAr ? 'محتوى الإعلان' : 'Ad creative'}</h3><p class="text-sm text-slate-500">${isAr ? 'أضف النص والصور والرابط الذي سيفتحه العميل.' : 'Add the copy, images and destination customers will open.'}</p></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'النص الأساسي *' : 'Primary text *'}</label><textarea rows="5" maxlength="2200" id="ads-studio-field-primaryText" oninput="adsStudioSetDraftField(\'primaryText\', this.value); updateAdsStudioCreativeCount(this)" class="glass-input w-full rounded-xl px-4 py-3" placeholder="${isAr ? 'اكتب الرسالة التي سيقرأها العميل...' : 'Write the message customers will see...'}">${Security.escapeHtml(d.primaryText || '')}</textarea><div id="ads-studio-copy-count" class="text-end text-xs text-slate-400">${String(d.primaryText || '').length}/2200</div></div>
    <div class="grid gap-4 sm:grid-cols-2"><div><label class="block text-sm font-bold mb-2">${isAr ? 'العنوان' : 'Headline'}</label><input type="text" maxlength="255" value="${Security.escapeHtml(d.headline || '')}" id="ads-studio-field-headline" oninput="adsStudioSetDraftField(\'headline\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div><div><label class="block text-sm font-bold mb-2">${isAr ? 'زر الدعوة' : 'Call-to-action'}</label><select onchange="adsStudioSetDraftField('callToAction', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4">${ADS_STUDIO_CTA.map(([en, ar]) => `<option value="${en}" ${d.callToAction === en ? 'selected' : ''}>${isAr ? ar : en}</option>`).join('')}</select></div></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'الوصف القصير' : 'Short description'}</label><input type="text" maxlength="500" value="${Security.escapeHtml(d.description || '')}" id="ads-studio-field-description" oninput="adsStudioSetDraftField(\'description\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'الرابط أو رقم واتساب *' : 'Website, WhatsApp or Messenger destination *'}</label><input type="text" maxlength="500" value="${Security.escapeHtml(d.destination || '')}" id="ads-studio-field-destination" oninput="adsStudioSetDraftField(\'destination\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="https://... or +218..." /><p class="mt-2 text-xs text-slate-500">${isAr ? 'سنراجع الرابط قبل إطلاق الإعلان.' : 'The destination is checked during review.'}</p></div>
    <div data-photo-paste-target="ads-studio" tabindex="0" class="rounded-2xl border border-slate-200 dark:border-slate-700 p-3 focus:outline-none focus:ring-2 focus:ring-blue-500"><div class="flex flex-wrap items-center justify-between gap-3 mb-2"><label class="block text-sm font-bold">${isAr ? 'الصور (حتى 3)' : 'Images (up to 3)'}</label><div class="flex flex-wrap items-center gap-2"><span class="text-xs text-slate-500">${(d.creativeImages || []).length}/3</span><button type="button" onclick="takeNativePhoto('ads-studio')" class="min-h-11 px-3 rounded-xl border border-blue-200 dark:border-blue-800 text-xs font-bold text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center gap-1.5"><i data-lucide="camera" class="w-3.5 h-3.5"></i>${isAr ? 'الكاميرا' : 'Camera'}</button><button type="button" onclick="pastePhotoFromClipboard('ads-studio')" class="min-h-11 px-3 rounded-xl border border-blue-200 dark:border-blue-800 text-xs font-bold text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center gap-1.5"><i data-lucide="clipboard-paste" class="w-3.5 h-3.5"></i>${isAr ? 'لصق صورة' : 'Paste photo'}</button></div></div><div id="ads-studio-creative-preview">${renderAdsStudioCreativePreview()}</div><p class="mt-2 text-xs text-slate-500">${isAr ? 'انسخ صورة واضغط Ctrl+V هنا. على iPhone اختر JPEG أو إعداد «الأكثر توافقاً»؛ صور HEIC غير مدعومة حالياً.' : 'Copy an image and press Ctrl+V here. On iPhone, choose JPEG / Most Compatible; HEIC is not supported yet.'}</p><input id="ads-studio-image-input" type="file" accept="image/png,image/jpeg,image/webp" multiple class="hidden" onchange="onAdsStudioCreativeSelected(this)" /></div>
  </div>`;
}

function updateAdsStudioCreativeCount(input) {
  const node = document.getElementById('ads-studio-copy-count');
  if (node) node.textContent = `${String(input?.value || '').length}/2200`;
}

function renderAdsStudioCreativePreview() {
  const images = Array.isArray(_adsStudioDraft?.creativeImages) ? _adsStudioDraft.creativeImages : [];
  const isAr = adsStudioIsAr();
  return `<div class="grid grid-cols-2 gap-3 sm:grid-cols-3">${images.map((src, index) => `<div class="relative aspect-square overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-100"><button type="button" onclick="openReceiptPhotoViewerSources(_adsStudioDraft.creativeImages, ${index}, '${isAr ? 'معاينة الإعلان' : 'Creative preview'}')" class="absolute inset-0"><img src="${Security.escapeHtml(src)}" alt="${isAr ? 'صورة الإعلان' : 'Ad creative'} ${index + 1}" class="w-full h-full object-cover" /></button><button type="button" onclick="removeAdsStudioCreative(${index})" class="touch-target absolute top-1 ${isAr ? 'left-1' : 'right-1'} w-11 h-11 rounded-full bg-slate-950/75 text-white flex items-center justify-center" aria-label="${isAr ? 'حذف الصورة' : 'Remove image'}"><i data-lucide="trash-2" class="w-4 h-4"></i></button></div>`).join('')}${images.length < 3 ? `<button type="button" onclick="document.getElementById('ads-studio-image-input').click()" class="aspect-square min-h-32 rounded-2xl border-2 border-dashed border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10 text-blue-700 dark:text-blue-300 flex flex-col items-center justify-center gap-2 font-bold"><i data-lucide="image-plus" class="w-8 h-8"></i><span>${isAr ? 'إضافة صور' : 'Add images'}</span></button>` : ''}</div>`;
}

function onAdsStudioCreativeSelected(input) {
  const files = Array.from(input?.files || []);
  if (input) input.value = '';
  return uploadAdsStudioCreativeFiles(files);
}

async function uploadAdsStudioCreativeFiles(fileList) {
  const candidates = Array.from(fileList || []);
  // Blank/generic MIME types are real JPEG/PNGs from Android SAF pickers —
  // let compressImageToDataUrl sniff the magic bytes instead of rejecting
  // here; isSafeAdsStudioCreativeSource still gates the OUTPUT to normalized
  // png/jpeg/webp data URLs, so nothing unsupported can get through.
  const formatFiles = candidates.filter(file => {
    const t = String(file?.type || '').toLowerCase();
    return !t || t === 'application/octet-stream' || ADS_STUDIO_ALLOWED_IMAGE_MIME_TYPES.has(t);
  });
  const rejectedCount = candidates.length - formatFiles.length;
  if (rejectedCount > 0) {
    showNotification(
      adsStudioText('Unsupported image', 'صيغة صورة غير مدعومة'),
      adsStudioText('Use PNG, JPEG or WebP images only.', 'استخدم صور PNG أو JPEG أو WebP فقط.'),
      'warning'
    );
  }
  const oversizedCount = formatFiles.filter(file => Number(file?.size) > ADS_STUDIO_MAX_SOURCE_IMAGE_BYTES).length;
  const files = formatFiles.filter(file => !(Number(file?.size) > ADS_STUDIO_MAX_SOURCE_IMAGE_BYTES));
  if (oversizedCount > 0) {
    showNotification(adsStudioText('Image too large', 'الصورة كبيرة جداً'), adsStudioText('Each original image must be 20 MB or smaller.', 'يجب ألا يتجاوز حجم كل صورة أصلية 20 ميجابايت.'), 'warning');
  }
  if (!files.length) return;
  const draftRef = _adsStudioDraft;
  const uploadUserId = String(state.currentUser?.id || '');
  if (!draftRef || !uploadUserId) return;
  const existing = Array.isArray(draftRef.creativeImages) ? draftRef.creativeImages.slice() : [];
  const available = Math.max(0, 3 - existing.length);
  if (!available) return;
  const token = ++_adsStudioPhotoToken;
  const selected = files.slice(0, available);
  if (selected.reduce((sum, file) => sum + Math.max(0, Number(file?.size) || 0), 0) > ADS_STUDIO_MAX_SELECTED_SOURCE_BYTES) {
    showNotification(adsStudioText('Selection too large', 'الصور المحددة كبيرة جداً'), adsStudioText('Select up to 40 MB of original images at one time.', 'اختر صوراً أصلية بحجم إجمالي لا يتجاوز 40 ميجابايت في المرة الواحدة.'), 'warning');
    return;
  }
  try {
    const compressed = [];
    for (const file of selected) {
      const output = await compressImageToDataUrl(file);
      if (!isSafeAdsStudioCreativeSource(output)) throw new Error('Unsupported compressed image output');
      compressed.push(output);
    }
    if (
      token !== _adsStudioPhotoToken ||
      _adsStudioDraft !== draftRef ||
      uploadUserId !== String(state.currentUser?.id || '') ||
      state.currentView !== 'ads-studio' ||
      _adsStudioActiveTab !== 'builder'
    ) return;
    const next = existing.concat(compressed.filter(Boolean));
    const totalBytes = next.reduce((sum, src) => sum + adsStudioDataUrlDecodedBytes(src), 0);
    if (totalBytes > ADS_STUDIO_MAX_TOTAL_CREATIVE_BYTES) {
      showNotification(adsStudioText('Images too large', 'الصور كبيرة جداً'), adsStudioText('Combined images must be 5 MB or less after compression.', 'يجب ألا يتجاوز الحجم الإجمالي للصور 5 ميجابايت بعد الضغط.'), 'error');
      return;
    }
    draftRef.creativeImages = next;
    const wrap = document.getElementById('ads-studio-creative-preview');
    if (wrap) { wrap.innerHTML = renderAdsStudioCreativePreview(); if (typeof IconQueue !== 'undefined') IconQueue.schedule(wrap); }
  } catch (_) {
    showNotification(adsStudioText('Upload failed', 'تعذر رفع الصورة'), adsStudioText('Please choose another image.', 'يرجى اختيار صورة أخرى.'), 'error');
  }
}

function isSafeAdsStudioCreativeSource(value) {
  const source = String(value || '').trim();
  return isSafeReceiptPhotoSource(source) && /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(source);
}

function adsStudioDataUrlDecodedBytes(value) {
  const payload = String(value || '').split(',', 2)[1] || '';
  if (!payload) return 0;
  const padding = payload.endsWith('==') ? 2 : (payload.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}

function adsStudioIsValidDestination(value) {
  const raw = String(value || '').trim();
  const compactPhone = raw.replace(/[\s().-]/g, '');
  if (/^\+?[1-9][0-9]{7,14}$/.test(compactPhone)) return true;
  if (!raw || /\s/.test(raw) || raw.includes('@')) return false;
  const match = raw.match(/^https:\/\/([A-Za-z0-9.-]+)(?::[0-9]{1,5})?(?:[/?#].*)?$/i);
  return !!match && match[1].includes('.');
}

// Client mirror of the server's Meta-family host allowlist for boosted posts.
function adsStudioIsValidBoostRef(value) {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw) || raw.includes('@')) return false;
  const match = raw.match(/^https:\/\/([A-Za-z0-9.-]+)(?:[/?#].*)?$/i);
  if (!match) return false;
  const host = match[1].toLowerCase();
  return ['facebook.com', 'fb.watch', 'instagram.com'].some(h => host === h || host.endsWith('.' + h));
}

function removeAdsStudioCreative(index) {
  if (!_adsStudioDraft) return;
  _adsStudioDraft.creativeImages = (Array.isArray(_adsStudioDraft.creativeImages) ? _adsStudioDraft.creativeImages : []).filter((_, i) => i !== Number(index));
  _adsStudioPhotoToken++;
  const wrap = document.getElementById('ads-studio-creative-preview');
  if (wrap) { wrap.innerHTML = renderAdsStudioCreativePreview(); if (typeof IconQueue !== 'undefined') IconQueue.schedule(wrap); }
}

function renderAdsStudioAudienceStep() {
  const d = _adsStudioDraft;
  const isAr = adsStudioIsAr();
  const locationText = (d.locations || []).join(', ');
  const languageText = (d.languages || []).join(', ');
  const interestText = (d.interests || []).join(', ');
  return `<div class="space-y-5"><div><h3 class="text-lg font-black text-slate-900 dark:text-white">${isAr ? 'من تريد الوصول إليه؟' : 'Who should see this ad?'}</h3><p class="text-sm text-slate-500">${isAr ? 'ابدأ بجمهور واضح. سيتم التحقق من قيود ميتا أثناء المراجعة.' : 'Start with a clear audience. Meta restrictions are checked during review.'}</p></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'المدن أو الدول *' : 'Cities or countries *'}</label><input type="text" value="${Security.escapeHtml(locationText)}" id="ads-studio-list-locations" oninput="adsStudioSetListField(\'locations\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="Libya, Tripoli, Benghazi" /><p class="mt-1 text-xs text-slate-500">${isAr ? 'افصل بين المواقع بفاصلة.' : 'Separate locations with commas.'}</p></div>
    <div class="grid grid-cols-2 gap-4"><div><label class="block text-sm font-bold mb-2">${isAr ? 'أقل عمر' : 'Minimum age'}</label><input type="number" min="18" max="65" value="${Number(d.ageMin) || 18}" id="ads-studio-field-ageMin" oninput="adsStudioSetDraftField(\'ageMin\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div><div><label class="block text-sm font-bold mb-2">${isAr ? 'أعلى عمر' : 'Maximum age'}</label><input type="number" min="18" max="65" value="${Number(d.ageMax) || 65}" id="ads-studio-field-ageMax" oninput="adsStudioSetDraftField(\'ageMax\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'الجنس' : 'Gender'}</label><div class="grid grid-cols-3 gap-2">${[['all','All','الكل'],['female','Women','نساء'],['male','Men','رجال']].map(([value,en,ar]) => `<label class="touch-target min-h-12 rounded-xl border ${d.genders.includes(value) ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700'} flex items-center justify-center gap-2 font-bold"><input type="radio" name="ads-gender" value="${value}" ${d.genders.includes(value) ? 'checked' : ''} onchange="adsStudioToggleDraftArray('genders','${value}',this.checked,true); render()" class="sr-only" />${isAr ? ar : en}</label>`).join('')}</div></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'اللغات' : 'Languages'}</label><input type="text" value="${Security.escapeHtml(languageText)}" id="ads-studio-list-languages" oninput="adsStudioSetListField(\'languages\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="Arabic, English" /></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'الاهتمامات المقترحة' : 'Suggested interests'}</label><input type="text" value="${Security.escapeHtml(interestText)}" id="ads-studio-list-interests" oninput="adsStudioSetListField(\'interests\', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="Online shopping, Fashion, Technology" /><p class="mt-1 text-xs text-slate-500">${isAr ? 'اقتراحات فقط؛ ميتا تحدد الخيارات المتاحة للحساب.' : 'Suggestions only; Meta determines what is available to the account.'}</p></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'فئة إعلانية خاصة' : 'Special Ad Category'}</label><select onchange="_adsStudioDraft.specialAdCategories = this.value ? [this.value] : []" class="glass-input min-h-12 w-full rounded-xl px-4"><option value="" ${!d.specialAdCategories.length ? 'selected' : ''}>${isAr ? 'لا توجد' : 'None'}</option><option value="credit" ${d.specialAdCategories.includes('credit') ? 'selected' : ''}>${isAr ? 'الائتمان والخدمات المالية' : 'Credit / financial products'}</option><option value="employment" ${d.specialAdCategories.includes('employment') ? 'selected' : ''}>${isAr ? 'التوظيف' : 'Employment'}</option><option value="housing" ${d.specialAdCategories.includes('housing') ? 'selected' : ''}>${isAr ? 'السكن' : 'Housing'}</option><option value="social_issues_elections_politics" ${d.specialAdCategories.includes('social_issues_elections_politics') ? 'selected' : ''}>${isAr ? 'القضايا الاجتماعية أو الانتخابات أو السياسة' : 'Social issues, elections or politics'}</option></select><div class="mt-2 flex items-start gap-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-800 dark:text-amber-200"><i data-lucide="triangle-alert" class="w-4 h-4 flex-shrink-0"></i><span>${isAr ? 'اختيار الفئة الصحيحة إلزامي وقد يحد من العمر والجنس والاهتمامات.' : 'The correct category is mandatory and may restrict age, gender and interest targeting.'}</span></div></div>
  </div>`;
}

// ---- Budget limits (P1-08b; owner decisions D4 + D5) ----
// The form checks the limits the server enforces, read from GET /api/studio/me (adLimits). Until
// /me answers, or when it fails, the plan defaults stand in (the server's DEFAULTS in
// studio_settings.py: $5 - $2,000 in total, $1 per day, 90 days). A limit /me leaves out, or
// sends malformed, keeps its default. "Total" is what one request costs: the lifetime amount,
// or the daily amount x days.
const ADS_STUDIO_DEFAULT_LIMITS = Object.freeze({ minTotalMinorUSD: 500, maxTotalMinorUSD: 200000, minPerDayMinorUSD: 100, maxDays: 90 });
let _adsStudioLimits = null;
let _adsStudioLimitsFor = '';
let _adsStudioLimitsState = '';  // '' | 'loading' | 'done' | 'failed'
let _adsStudioLimitsFailedAt = 0;
let _adsStudioLimitsLoadedAt = 0;
let _adsStudioLimitsGeneration = 0;
// The intake switch from the same /me reply (P1-22): null until known (the server decides), then
// true/false. While it is false the Send buttons are disabled; drafts still save.
let _adsStudioIntakeOpen = null;
// Staff can pause or reopen intake while the studio is open, so /me is read again (unless it was
// read in the last ADS_STUDIO_INTAKE_RECHECK_MS) when a list with Send buttons is opened from another
// page or tab, and right before a submit: reopening intake enables Send again without a reload.
const ADS_STUDIO_INTAKE_RECHECK_MS = 15000;
let _adsStudioLimitsPending = null;  // settles once the /me read on its way has been applied
let _adsStudioShownTab = '';  // the studio tab the last render drew

function resetAdsStudioLimits() {
  _adsStudioLimitsGeneration++;  // a reply still in flight belongs to the old session: dropped
  _adsStudioLimits = null;
  _adsStudioLimitsFor = '';
  _adsStudioLimitsState = '';
  _adsStudioLimitsFailedAt = 0;
  _adsStudioLimitsLoadedAt = 0;
  _adsStudioIntakeOpen = null;
  _adsStudioLimitsPending = null;
  _adsStudioShownTab = '';
}

function adsStudioIntakePausedText() {
  return adsStudioText(
    'New ad requests are paused — you can still save your draft and send it later.',
    'استقبال طلبات الإعلانات الجديدة متوقف مؤقتاً — يمكنك حفظ المسودة وإرسالها لاحقاً.'
  );
}

// In place (no full render): the builder's Send button and note, and the list's Submit buttons.
function adsStudioRefreshIntakeState() {
  if (typeof document === 'undefined') return;
  const paused = _adsStudioIntakeOpen === false;
  const note = document.getElementById('ads-studio-intake-note');
  if (note) note.classList.toggle('hidden', !paused);
  const buttons = [document.getElementById('ads-studio-submit-button')]
    .concat(Array.from(document.querySelectorAll('[data-ads-studio-submit]') || []));
  buttons.forEach(button => {
    if (!button || button.getAttribute('aria-busy') === 'true') return;
    button.disabled = paused;
    if (paused) button.setAttribute('title', adsStudioIntakePausedText());
    else button.removeAttribute('title');
  });
}

function adsStudioCleanLimits(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...ADS_STUDIO_DEFAULT_LIMITS };
  for (const key of Object.keys(out)) {
    if (Number.isSafeInteger(src[key]) && src[key] > 0) out[key] = src[key];
  }
  // The server keeps minimum <= maximum and floor <= minimum; a set that breaks it is not trusted.
  if (out.minTotalMinorUSD > out.maxTotalMinorUSD) return { ...ADS_STUDIO_DEFAULT_LIMITS };
  out.minPerDayMinorUSD = Math.min(out.minPerDayMinorUSD, out.minTotalMinorUSD);
  return out;
}

function adsStudioLimits() {
  const uid = String(state.currentUser?.id || '');
  return _adsStudioLimits && uid && _adsStudioLimitsFor === uid ? _adsStudioLimits : ADS_STUDIO_DEFAULT_LIMITS;
}

// Once per session; a failed read is retried at most once a minute (the defaults hold meanwhile).
// maxAgeMs > 0 also re-reads a good answer older than that (the intake switch can change meanwhile);
// a failed re-read keeps the last good limits.
async function refreshAdsStudioLimits(maxAgeMs = 0) {
  let settle = () => {};  // tells a waiting submit that the read this call started has been applied
  try {
    const uid = String(state.currentUser?.id || '');
    if (!uid || !isServerModeEnabled()) return;
    if (_adsStudioLimitsFor === uid && _adsStudioLimitsState !== '' && (_adsStudioLimitsState !== 'failed' || Date.now() - _adsStudioLimitsFailedAt < 60000)
        && !(maxAgeMs > 0 && _adsStudioLimitsState === 'done' && Date.now() - _adsStudioLimitsLoadedAt > maxAgeMs)) return;
    if (_adsStudioLimitsFor && _adsStudioLimitsFor !== uid) { _adsStudioLimits = null; _adsStudioIntakeOpen = null; }  // another user's reading
    const generation = ++_adsStudioLimitsGeneration;
    _adsStudioLimitsFor = uid;
    _adsStudioLimitsState = 'loading';
    _adsStudioLimitsPending = new Promise(resolve => { settle = resolve; });
    let limits = null;
    let intakeOpen = null;
    try {
      const me = await apiJson('/api/studio/me', { method: 'GET' });
      if (me && me.adLimits && typeof me.adLimits === 'object') limits = adsStudioCleanLimits(me.adLimits);
      if (me && me.intake && typeof me.intake.open === 'boolean') intakeOpen = me.intake.open;
    } catch (_) { /* the plan defaults stay */ }
    if (generation !== _adsStudioLimitsGeneration || uid !== String(state.currentUser?.id || '')) return;
    if (limits) _adsStudioLimits = limits;
    _adsStudioLimitsState = _adsStudioLimits ? 'done' : 'failed';
    if (_adsStudioLimits) _adsStudioLimitsLoadedAt = Date.now();
    else _adsStudioLimitsFailedAt = Date.now();
    if (intakeOpen !== null) _adsStudioIntakeOpen = intakeOpen;
    // Update the hint in place: a full render could take the keyboard away mid-typing.
    const hint = typeof document !== 'undefined' ? document.getElementById('ads-studio-budget-limits') : null;
    if (hint) hint.textContent = adsStudioBudgetLimitsText(_adsStudioDraft?.budgetType);
    adsStudioRefreshBudgetSummary();
    adsStudioRefreshIntakeState();
  } catch (_) { /* never breaks the screen */ } finally { settle(); }
}

// Reads /me again unless it was read in the last ADS_STUDIO_INTAKE_RECHECK_MS. Returns a promise that
// settles once the reply on its way has been applied (the intake switch is then current), or null
// when no read is on its way.
function adsStudioRecheckIntake() {
  refreshAdsStudioLimits(ADS_STUDIO_INTAKE_RECHECK_MS);  // runs up to its first await right here
  return _adsStudioLimitsState === 'loading' ? _adsStudioLimitsPending : null;
}

// P1-22: the campaign list or dashboard (both carry Send buttons) was opened: another studio tab or
// another page was on screen before this render (the studio's tab bar is not in the document yet).
function adsStudioListOpened() {
  const tab = String(_adsStudioActiveTab || '');
  const onScreen = typeof document !== 'undefined' && typeof document.querySelector === 'function' && !!document.querySelector('.studio-section-tabs');
  const opened = !onScreen || tab !== _adsStudioShownTab;
  _adsStudioShownTab = tab;
  return opened && (tab === 'campaigns' || tab === 'dashboard');
}

function adsStudioDaysText(days) {
  const n = Math.max(0, Math.trunc(Number(days) || 0));
  if (!adsStudioIsAr()) return n === 1 ? '1 day' : `${n} days`;
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومان';
  return n >= 3 && n <= 10 ? `${n} أيام` : `${n} يوماً`;
}

// Days the request runs: its durationDays (P1-11; 0 while the box does not hold a whole number), or
// for an older request without one its dates, both ends included (the server's end = start + days - 1).
function adsStudioCampaignDays(draft) {
  const raw = draft?.durationDays;
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }
  const start = Date.parse(`${String(draft?.startDate || '')}T00:00:00Z`);
  const end = Date.parse(`${String(draft?.endDate || '')}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86400000) + 1;
}

// What one request costs, and what submitting it holds (owner decisions D4 + D5): the lifetime
// amount, or the daily amount x days.
function adsStudioRequestTotalMinor(draft) {
  const budget = Math.max(0, Math.trunc(Number(draft?.budgetMinorUSD) || 0));
  return String(draft?.budgetType || '') === 'daily' ? budget * adsStudioCampaignDays(draft) : budget;
}

// What a Submitted request holds now: the total the server stamped (totalBudgetMinorUSD); a request
// submitted under the old rules holds its budget field (one day's budget for a legacy daily one).
function adsStudioHeldMinorFor(campaign) {
  const total = Number(campaign?.totalBudgetMinorUSD);
  if (Number.isSafeInteger(total) && total > 0) return total;
  return Math.max(parseInt(campaign?.budgetMinorUSD, 10) || 0, 0);
}

// A daily request sent under the old rules (it held one day's budget): staff send it back with the
// reason "budget_dates" so the customer re-sends it under the total rule (owner decision D33).
// The server's own test (legacy_budget_rules): flagged legacyRules, or no schemaVersion >= 2. A
// schemaVersion 2 request holds its total even when this copy of it carries no totalBudgetMinorUSD.
function adsStudioIsLegacyDailyRequest(campaign) {
  if (String(campaign?.budgetType || '') !== 'daily') return false;
  if (campaign?.legacyRules === true) return true;
  const version = Number(campaign?.schemaVersion);
  return !(Number.isFinite(version) && version >= 2);
}

// The card's budget: "$10.00/day × 7 days = $70.00" for a daily request, the amount otherwise.
function adsStudioBudgetLine(campaign) {
  const budget = Math.max(0, Math.trunc(Number(campaign?.budgetMinorUSD) || 0));
  const days = Number(campaign?.durationDays);
  if (String(campaign?.budgetType || '') !== 'daily') return adsStudioMoneyWithLyd(budget);
  if (!(Number.isSafeInteger(days) && days > 0)) return adsStudioText(`${adsStudioMoneyWithLyd(budget)} / day`, `${adsStudioMoneyWithLyd(budget)} يومياً`);
  return adsStudioText(
    `${adsStudioMoney(budget)}/day × ${adsStudioDaysText(days)} = ${adsStudioMoneyWithLyd(budget * days)}`,
    `${adsStudioMoney(budget)} يومياً × ${adsStudioDaysText(days)} = ${adsStudioMoneyWithLyd(budget * days)}`
  );
}

function adsStudioBudgetLimitsText(budgetType) {
  const limits = adsStudioLimits();
  const range = adsStudioText(
    `${adsStudioMoney(limits.minTotalMinorUSD)} – ${adsStudioMoney(limits.maxTotalMinorUSD)}`,
    `من ${adsStudioMoney(limits.minTotalMinorUSD)} إلى ${adsStudioMoney(limits.maxTotalMinorUSD)}`
  );
  const tail = adsStudioText(
    ` · at least ${adsStudioMoney(limits.minPerDayMinorUSD)} per day · up to ${adsStudioDaysText(limits.maxDays)}`,
    ` · لا يقل عن ${adsStudioMoney(limits.minPerDayMinorUSD)} يومياً · حتى ${adsStudioDaysText(limits.maxDays)}`
  );
  return String(budgetType || '') === 'daily'
    ? adsStudioText(`Daily budget × days must total ${range}`, `الميزانية اليومية × عدد الأيام يجب أن يكون مجموعها ${range}`) + tail
    : adsStudioText(`Total for the whole campaign: ${range}`, `إجمالي الحملة كلها: ${range}`) + tail;
}

// '' when the request fits the limits, else the first problem in the customer's language. The
// sentences start with the server's own refusal prefixes (T1-T4), so both sides read the same.
function adsStudioBudgetLimitProblem(draft) {
  const limits = adsStudioLimits();
  const budget = Math.max(0, Math.trunc(Number(draft?.budgetMinorUSD) || 0));
  const days = adsStudioCampaignDays(draft);
  if (!budget || !days) return '';
  if (days > limits.maxDays) {
    return adsStudioText(
      `The ad can run for at most ${adsStudioDaysText(limits.maxDays)}. Choose fewer days.`,
      `أقصى مدة لتشغيل الإعلان هي ${adsStudioDaysText(limits.maxDays)}. اختر عدداً أقل من الأيام.`
    );
  }
  const daily = String(draft?.budgetType || '') === 'daily';
  const total = daily ? budget * days : budget;
  const sum = daily ? ` (${adsStudioMoney(budget)} × ${adsStudioDaysText(days)} = ${adsStudioMoney(total)})` : '';
  if (total < limits.minTotalMinorUSD) {
    return adsStudioText(`The total budget must be at least ${adsStudioMoney(limits.minTotalMinorUSD)}${sum}.`, `يجب ألا يقل إجمالي الميزانية عن ${adsStudioMoney(limits.minTotalMinorUSD)}${sum}.`);
  }
  if (total > limits.maxTotalMinorUSD) {
    return adsStudioText(`The total budget must be at most ${adsStudioMoney(limits.maxTotalMinorUSD)}${sum}.`, `يجب ألا يزيد إجمالي الميزانية عن ${adsStudioMoney(limits.maxTotalMinorUSD)}${sum}.`);
  }
  if (total < limits.minPerDayMinorUSD * days) {
    return daily
      ? adsStudioText(`Budget per day is below the minimum (${adsStudioMoney(limits.minPerDayMinorUSD)} a day).`, `الميزانية اليومية أقل من الحد الأدنى (${adsStudioMoney(limits.minPerDayMinorUSD)} يومياً).`)
      : adsStudioText(
        `Budget per day is below the minimum (${adsStudioMoney(limits.minPerDayMinorUSD)} a day): ${adsStudioMoney(total)} for ${adsStudioDaysText(days)}. Raise the budget or choose fewer days.`,
        `الميزانية اليومية أقل من الحد الأدنى (${adsStudioMoney(limits.minPerDayMinorUSD)} يومياً): ${adsStudioMoney(total)} لمدة ${adsStudioDaysText(days)}. ارفع الميزانية أو اختر عدداً أقل من الأيام.`
      );
  }
  return '';
}

// The live total under the budget boxes: "Total: $70.00 for 7 days ($10.00 a day)".
function adsStudioBudgetTotalText(draft) {
  const days = adsStudioCampaignDays(draft);
  const total = adsStudioRequestTotalMinor(draft);
  if (!days || !total) return adsStudioText('Enter the budget and the number of days to see the total.', 'أدخل الميزانية وعدد الأيام لترى الإجمالي.');
  const daily = String(draft?.budgetType || '') === 'daily';
  const perDay = adsStudioMoney(daily ? Math.max(0, Math.trunc(Number(draft?.budgetMinorUSD) || 0)) : Math.floor(total / days));
  return adsStudioText(
    `Total: ${adsStudioMoney(total)} for ${adsStudioDaysText(days)} (${daily ? '' : 'about '}${perDay} a day)`,
    `الإجمالي: ${adsStudioMoney(total)} لمدة ${adsStudioDaysText(days)} (${daily ? '' : 'نحو '}${perDay} يومياً)`
  );
}

function adsStudioBudgetLydText(draft) {
  const total = adsStudioRequestTotalMinor(draft);
  if (!total || !(typeof _adsStudioUsdToLydRate === 'function' && _adsStudioUsdToLydRate() > 1)) return '';
  return `${adsStudioMoneyWithLyd(total)} — ${adsStudioText('estimate', 'تقديري')}`;
}

// The wallet line: submitting holds the total, so say now whether the wallet covers it.
function adsStudioBudgetWalletText(draft) {
  if (typeof WALLET === 'undefined' || !isServerModeEnabled()) return '';
  const total = adsStudioRequestTotalMinor(draft);
  if (!total) return '';
  const available = adsStudioWalletAvailableMinor();
  return available >= total
    ? adsStudioText(`Available in your wallet: ${adsStudioMoney(available)} — enough.`, `المتاح في محفظتك: ${adsStudioMoney(available)} — يكفي.`)
    : adsStudioText(
      `Available in your wallet: ${adsStudioMoney(Math.max(0, available))} — short by ${adsStudioMoney(total - Math.max(0, available))}. Add money before you send.`,
      `المتاح في محفظتك: ${adsStudioMoney(Math.max(0, available))} — ينقصك ${adsStudioMoney(total - Math.max(0, available))}. أضف رصيداً قبل الإرسال.`
    );
}

// Review finding: the startup box cleaner (sanitizeMoneyInput) turns a lone comma into a decimal
// point, so "1,500" typed one key at a time ended as 1.50 ("1," became "1."). The budget and charge
// boxes read the raw text on every key (adsStudioParseMoneyMinor knows "1,500" from "12,5") and run
// sanitizeMoneyInput only on change. The typed text is kept so a background redraw shows it as typed.
let _adsStudioBudgetTyped = '';

function adsStudioTypedBudgetText(draft) {
  const minor = Math.max(0, Number(draft?.budgetMinorUSD) || 0);
  return _adsStudioBudgetTyped && adsStudioParseMoneyMinor(_adsStudioBudgetTyped) === minor ? _adsStudioBudgetTyped : (minor / 100).toFixed(2);
}

function adsStudioOnBudgetInput(input) {
  _adsStudioBudgetTyped = String(input?.value ?? '').slice(0, 40);
  adsStudioSetDraftField('budgetMinorUSD', _adsStudioBudgetTyped);
  adsStudioRefreshBudgetSummary();
}

function adsStudioOnDaysInput(input) {
  adsStudioSetDraftField('durationDays', input?.value);
  adsStudioRefreshBudgetSummary();
}

// In place, so the keyboard stays open while the customer types.
function adsStudioRefreshBudgetSummary() {
  if (typeof document === 'undefined' || !_adsStudioDraft) return;
  const d = _adsStudioDraft;
  const set = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
    return node;
  };
  set('ads-studio-budget-total', adsStudioBudgetTotalText(d));
  set('ads-studio-budget-lyd', adsStudioBudgetLydText(d));
  set('ads-studio-budget-wallet', adsStudioBudgetWalletText(d));
  set('ads-studio-budget-end', adsStudioFormatDate(d.endDate));
  const problem = adsStudioBudgetLimitProblem(d);
  const node = set('ads-studio-budget-problem', problem);
  if (node) node.classList.toggle('hidden', !problem);
}

function renderAdsStudioBudgetStep() {
  const d = _adsStudioDraft;
  const isAr = adsStudioIsAr();
  const daily = d.budgetType === 'daily';
  const days = adsStudioCampaignDays(d);
  const problem = adsStudioBudgetLimitProblem(d);
  return `<div class="space-y-5"><div><h3 class="text-lg font-black text-slate-900 dark:text-white">${isAr ? 'الميزانية والمدة' : 'Budget and schedule'}</h3><p class="text-sm text-slate-500">${isAr ? 'اختر ميزانية يومية أو إجمالية وعدد الأيام. عند الإرسال نحجز الإجمالي من محفظتك، وتُخصم عند الموافقة.' : 'Choose a daily or a total budget and the number of days. Sending holds the total in your wallet; approval charges it.'}</p></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'نوع الميزانية' : 'Budget type'}</label><div class="grid grid-cols-2 gap-3"><label class="touch-target min-h-14 rounded-xl border-2 px-4 flex items-center gap-3 ${d.budgetType === 'lifetime' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700'}"><input type="radio" name="budget-type" value="lifetime" ${d.budgetType === 'lifetime' ? 'checked' : ''} onchange="adsStudioSetDraftField('budgetType',this.value);render()" class="sr-only" /><i data-lucide="calendar-range" class="w-5 h-5 text-blue-600"></i><span class="font-bold">${isAr ? 'إجمالي الحملة' : 'Lifetime'}</span></label><label class="touch-target min-h-14 rounded-xl border-2 px-4 flex items-center gap-3 ${daily ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700'}"><input type="radio" name="budget-type" value="daily" ${daily ? 'checked' : ''} onchange="adsStudioSetDraftField('budgetType',this.value);render()" class="sr-only" /><i data-lucide="sun" class="w-5 h-5 text-blue-600"></i><span class="font-bold">${isAr ? 'يومي' : 'Daily'}</span></label></div></div>
    <div class="grid gap-4 sm:grid-cols-2">
      <div><label for="ads-studio-field-budgetMinorUSD" class="block text-sm font-bold mb-2">${daily ? (isAr ? 'الميزانية اليومية بالدولار *' : 'Budget per day in USD *') : (isAr ? 'إجمالي الميزانية بالدولار *' : 'Total budget in USD *')}</label><div class="relative"><span class="absolute ${isAr ? 'right-4' : 'left-4'} top-1/2 -translate-y-1/2 font-black text-blue-600">$</span><input type="text" inputmode="decimal" autocomplete="off" value="${Security.escapeHtml(adsStudioTypedBudgetText(d))}" id="ads-studio-field-budgetMinorUSD" oninput="adsStudioOnBudgetInput(this)" onchange="sanitizeMoneyInput(this); adsStudioOnBudgetInput(this)" class="glass-input min-h-14 w-full rounded-xl ${isAr ? 'pr-9 pl-4' : 'pl-9 pr-4'} text-xl font-black" /></div></div>
      <div><label for="ads-studio-field-durationDays" class="block text-sm font-bold mb-2">${isAr ? 'عدد الأيام *' : 'Number of days *'}</label><input type="text" inputmode="numeric" autocomplete="off" maxlength="4" value="${days || ''}" id="ads-studio-field-durationDays" oninput="adsStudioOnDaysInput(this)" class="glass-input min-h-14 w-full rounded-xl px-4 text-xl font-black" /></div>
    </div>
    <div class="rounded-2xl bg-blue-50 dark:bg-blue-900/20 p-4 space-y-1">
      <p id="ads-studio-budget-total" class="font-black text-blue-900 dark:text-blue-100">${Security.escapeHtml(adsStudioBudgetTotalText(d))}</p>
      <p id="ads-studio-budget-lyd" class="text-xs font-bold text-blue-700 dark:text-blue-300">${Security.escapeHtml(adsStudioBudgetLydText(d))}</p>
      <p id="ads-studio-budget-wallet" class="text-xs font-bold text-slate-600 dark:text-slate-300">${Security.escapeHtml(adsStudioBudgetWalletText(d))}</p>
      <p id="ads-studio-budget-problem" role="alert" class="${problem ? '' : 'hidden '}text-sm font-bold text-rose-700 dark:text-rose-300">${Security.escapeHtml(problem)}</p>
      <p id="ads-studio-budget-limits" class="text-xs text-slate-500">${Security.escapeHtml(adsStudioBudgetLimitsText(d.budgetType))}</p>
    </div>
    <div class="grid gap-4 sm:grid-cols-2"><div><label class="block text-sm font-bold mb-2">${isAr ? 'تاريخ البدء *' : 'Start date *'}</label><input type="date" value="${Security.escapeHtml(d.startDate || '')}" onchange="adsStudioSetDraftField('startDate',this.value); adsStudioRefreshBudgetSummary()" class="glass-input min-h-12 w-full rounded-xl px-4" /></div><div><div class="block text-sm font-bold mb-2">${isAr ? 'آخر يوم' : 'Last day'}</div><p id="ads-studio-budget-end" class="min-h-12 flex items-center font-bold text-slate-800 dark:text-slate-100">${Security.escapeHtml(adsStudioFormatDate(d.endDate))}</p></div></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'ملاحظات لفريق المراجعة' : 'Notes for the review team'}</label><textarea rows="3" maxlength="1000" id="ads-studio-field-notes" oninput="adsStudioSetDraftField(\'notes\', this.value)" class="glass-input w-full rounded-xl px-4 py-3" placeholder="${isAr ? 'وقت مفضل، عرض خاص، تفاصيل إضافية...' : 'Preferred time, special offer, extra context...'}">${Security.escapeHtml(d.notes || '')}</textarea></div>
    <div class="rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 p-4 text-sm text-emerald-800 dark:text-emerald-200 flex items-start gap-3"><i data-lucide="shield-check" class="w-5 h-5 flex-shrink-0"></i><span>${isAr ? 'لن نرفع الميزانية أو نطلق الإعلان دون تأكيد وموافقة. عند إضافة الربط المباشر، سيتم إنشاء إعلانات ميتا في وضع الإيقاف المؤقت أولاً.' : 'We will not increase the budget or launch without confirmation. Future Meta publishing will create campaigns paused first.'}</span></div>
  </div>`;
}

function adsStudioBudgetReviewText(draft) {
  const budget = Math.max(0, Math.trunc(Number(draft?.budgetMinorUSD) || 0));
  const days = adsStudioCampaignDays(draft);
  const total = adsStudioRequestTotalMinor(draft);
  if (String(draft?.budgetType || '') === 'daily') {
    return adsStudioText(`${adsStudioMoney(budget)} a day × ${adsStudioDaysText(days)} = ${adsStudioMoney(total)}`, `${adsStudioMoney(budget)} يومياً × ${adsStudioDaysText(days)} = ${adsStudioMoney(total)}`);
  }
  return adsStudioText(`${adsStudioMoney(total)} in total for ${adsStudioDaysText(days)}`, `${adsStudioMoney(total)} إجمالاً لمدة ${adsStudioDaysText(days)}`);
}

function renderAdsStudioReviewStep() {
  const d = _adsStudioDraft;
  const isAr = adsStudioIsAr();
  const objective = adsStudioObjectiveLabel(d.objective);
  const special = (d.specialAdCategories || []).join(', ') || (isAr ? 'لا توجد' : 'None');
  const rows = [
    [isAr ? 'اسم الحملة' : 'Campaign', d.name || '—'],
    [isAr ? 'الهدف' : 'Objective', objective],
    [isAr ? 'المنصات' : 'Platforms', (d.platforms || []).join(' + ') || '—'],
    [isAr ? 'الصفحة' : 'Page', d.pageName || '—'],
    ...(String(d.boostType || '') === 'boost_post'
      ? [[isAr ? 'المنشور' : 'Post', d.sourcePostRef || (String(d.sourcePostId || '') ? (isAr ? 'منشور من صفحتك' : 'A post from your page') : '—')]]
      : []),
    [isAr ? 'الوجهة' : 'Destination', d.destination || '—'],
    [isAr ? 'الجمهور' : 'Audience', `${(d.locations || []).join(', ') || '—'} · ${d.ageMin || 18}–${d.ageMax || 65}`],
    [isAr ? 'الميزانية' : 'Budget', adsStudioBudgetReviewText(d)],
    [isAr ? 'المدة' : 'Schedule', `${adsStudioFormatDate(d.startDate)} → ${adsStudioFormatDate(d.endDate)}`],
    [isAr ? 'الفئة الخاصة' : 'Special category', special]
  ];
  return `<div class="space-y-5"><div><h3 class="text-lg font-black text-slate-900 dark:text-white">${isAr ? 'راجع طلبك قبل الإرسال' : 'Review before submitting'}</h3><p class="text-sm text-slate-500">${isAr ? 'يمكن لفريقنا طلب تعديلات قبل الموافقة.' : 'Our team may request changes before approval.'}</p></div><div class="grid gap-3 sm:grid-cols-2">${rows.map(([label,value]) => `<div class="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-4"><div class="text-xs font-bold uppercase tracking-wide text-slate-400">${label}</div><div class="mt-1 break-words font-bold text-slate-800 dark:text-slate-100">${Security.escapeHtml(String(value))}</div></div>`).join('')}</div><div class="rounded-2xl border border-slate-200 dark:border-slate-700 p-4"><div class="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2">${isAr ? 'معاينة النص' : 'Copy preview'}</div><p class="whitespace-pre-wrap text-slate-800 dark:text-slate-100">${Security.escapeHtml(d.primaryText || '—')}</p></div><label class="flex items-start gap-3 rounded-2xl bg-blue-50 dark:bg-blue-900/20 p-4 text-sm text-blue-900 dark:text-blue-100"><input id="ads-studio-confirm-accurate" type="checkbox" ${_adsStudioConfirmationChecked ? 'checked' : ''} onchange="_adsStudioConfirmationChecked = this.checked" class="mt-0.5 w-5 h-5 accent-blue-600" /><span>${isAr ? 'أؤكد أن المعلومات صحيحة، وأنني أملك حق استخدام الصور والنص والصفحة، وأن الفئة الإعلانية الخاصة محددة بشكل صحيح.' : 'I confirm the information is accurate, I have the right to use this copy, media and Page, and the Special Ad Category is correct.'}</span></label></div>`;
}

function adsStudioValidateStep(step, draft = _adsStudioDraft) {
  const errors = [];
  const d = draft || {};
  if (step >= 1) {
    if (!String(d.name || '').trim()) errors.push(adsStudioText('Campaign name is required.', 'اسم الحملة مطلوب.'));
    if (!ADS_STUDIO_OBJECTIVES.some(item => item.id === d.objective)) errors.push(adsStudioText('Choose a campaign objective.', 'اختر هدف الحملة.'));
    if (!Array.isArray(d.platforms) || !d.platforms.length) errors.push(adsStudioText('Choose Facebook or Instagram.', 'اختر فيسبوك أو إنستغرام.'));
    if (!String(d.pageName || '').trim()) errors.push(adsStudioText('Page or account name is required.', 'اسم الصفحة أو الحساب مطلوب.'));
  }
  if (step >= 2) {
    // Boosting an existing post (picked from the list or a pasted link) needs no text or photo of its
    // own: the post is the ad (D19; the server's link-only boost rule, P1-13).
    const boostsPost = adsStudioBoostHasPost(d);
    if (!boostsPost && !String(d.primaryText || '').trim()) errors.push(adsStudioText('Primary ad text is required.', 'النص الأساسي للإعلان مطلوب.'));
    if (!String(d.destination || '').trim()) {
      // A boosted post's destination is derived from the post link at save
      // time — the boost-ref check below covers it; no invisible field error.
      if (String(d.boostType || '') !== 'boost_post') errors.push(adsStudioText('A website, WhatsApp or Messenger destination is required.', 'رابط الموقع أو واتساب أو ماسنجر مطلوب.'));
    } else if (!adsStudioIsValidDestination(d.destination)) errors.push(adsStudioText('Use an HTTPS website/link or an international phone number.', 'استخدم رابط HTTPS أو رقم هاتف دولي صحيح.'));
    const hasSafeCreative = (Array.isArray(d.creativeImages) && d.creativeImages.some(isSafeAdsStudioCreativeSource)) ||
      (d._mediaOmitted === true && getEntityPhotoCountHint('adCampaignRequests', d) > 0);
    if (!boostsPost && !hasSafeCreative) errors.push(adsStudioText('Add at least one PNG, JPEG or WebP creative image.', 'أضف صورة إعلانية واحدة على الأقل بصيغة PNG أو JPEG أو WebP.'));
  }
  if (step >= 3) {
    if (!Array.isArray(d.locations) || !d.locations.length) errors.push(adsStudioText('Add at least one location.', 'أضف موقعاً واحداً على الأقل.'));
    const min = Number(d.ageMin), max = Number(d.ageMax);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 18 || max > 65 || min > max) errors.push(adsStudioText('Age range must be between 18 and 65.', 'يجب أن يكون العمر بين 18 و65.'));
  }
  if (step >= 4) {
    const budgetSet = Number(d.budgetMinorUSD) > 0;
    if (!budgetSet) errors.push(adsStudioText('Budget must be greater than zero.', 'يجب أن تكون الميزانية أكبر من صفر.'));
    const hasDays = d.durationDays !== undefined && d.durationDays !== null && d.durationDays !== '';
    const daysBad = hasDays && !adsStudioCampaignDays(d);
    if (daysBad) errors.push(adsStudioText('Enter the number of days as a whole number (1 or more).', 'أدخل عدد الأيام رقماً صحيحاً (1 أو أكثر).'));
    const datesBad = !String(d.startDate || '') || !String(d.endDate || '') || String(d.startDate) < _adsStudioDateOffset(0) || String(d.endDate) < String(d.startDate);
    if (datesBad) errors.push(adsStudioText('Choose a start date from today onward and a valid end date.', 'اختر تاريخ بداية من اليوم فصاعداً وتاريخ نهاية صحيحاً.'));
    // The server's limits (GET /api/studio/me adLimits): total, per-day floor and days (P1-08b), in
    // the server's own refusal words (T1-T4).
    const limitProblem = budgetSet && !datesBad && !daysBad ? adsStudioBudgetLimitProblem(d) : '';
    if (limitProblem) errors.push(limitProblem);
  }
  if (String(d.boostType || '') === 'boost_post' && !adsStudioBoostHasPost(d)) {
    errors.unshift(adsStudioText('Choose a post or add your own photo and text.', 'اختر منشوراً أو أضف صورتك ونصك.')
      + (adsStudioShowPostLinkField(d) ? adsStudioText(' You can also paste the post link.', ' يمكنك أيضاً لصق رابط المنشور.') : ''));
  }
  return errors;
}

function moveAdsStudioWizard(delta) {
  const direction = Number(delta) || 0;
  const total = adsStudioWizardSteps().length;
  if (direction > 0) {
    // Boost steps compress the classic wizard: their step 1 must satisfy
    // classic steps 1-3 (audience is prefilled) and step 2 classic step 4.
    const isBoost = !!_adsStudioDraft?.boostType;
    const classicStep = isBoost ? (_adsStudioWizardStep === 1 ? 3 : 4) : _adsStudioWizardStep;
    const errors = adsStudioValidateStep(classicStep);
    if (errors.length) { showNotification(adsStudioText('Complete this step', 'أكمل هذه الخطوة'), errors[0], 'error'); return; }
  }
  _adsStudioWizardStep = Math.min(total, Math.max(1, _adsStudioWizardStep + direction));
  render();
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) {}
}

function sanitizedAdsStudioDraft() {
  const d = _adsStudioDraft || newAdsStudioDraft();
  const text = (value, max) => Security.sanitizeInput(String(value || ''), { maxLength: max }).trim();
  const list = (values, maxItems = 30) => Array.from(new Set((Array.isArray(values) ? values : []).map(value => text(value, 80)).filter(Boolean))).slice(0, maxItems);
  const boostType = ['boost_post', 'boost_page'].includes(String(d.boostType || '')) ? String(d.boostType) : '';
  // A half-typed post link must never brick "Save draft": only a link the
  // server would accept is sent; anything else stays local until fixed.
  const sourcePostRef = adsStudioIsValidBoostRef(d.sourcePostRef) ? text(d.sourcePostRef, 500) : '';
  let destination = text(d.destination, 500);
  // Boosted posts open the post itself unless a destination was typed.
  if (!destination && boostType === 'boost_post' && sourcePostRef) destination = sourcePostRef;
  // durationDays (P1-11) only when it is a whole number within the limits: a half-typed box never
  // bricks "Save draft" (the step check names the problem). totalBudgetMinorUSD is the server's.
  const days = Number(d.durationDays);
  const durationDays = Number.isSafeInteger(days) && days >= 1 && days <= adsStudioLimits().maxDays ? { durationDays: days } : {};
  // The picked post (D19). Sent once the draft has the fields (so switching away clears them); a
  // draft that never had a picked post does not send them at all.
  const postId = boostType === 'boost_post' ? text(d.sourcePostId, 200) : '';
  const pickedPost = Object.prototype.hasOwnProperty.call(d, 'sourcePostId')
    ? { sourcePostId: postId, sourcePostPlatform: postId && ['fb', 'ig'].includes(String(d.sourcePostPlatform || '')) ? String(d.sourcePostPlatform) : '' }
    : {};
  const connectedAssetId = text(d.connectedAssetId, 80);
  return {
    ...durationDays,
    ...pickedPost,
    ...(connectedAssetId ? { connectedAssetId } : {}),
    name: text(d.name, 120),
    objective: text(d.objective, 40),
    platforms: list(d.platforms, 3),
    pageName: text(d.pageName, 160),
    primaryText: text(d.primaryText, 2200),
    headline: text(d.headline, 255),
    description: text(d.description, 500),
    callToAction: text(d.callToAction, 80),
    destination,
    locations: list(d.locations),
    ageMin: Math.max(18, Math.min(65, Math.trunc(Number(d.ageMin) || 18))),
    ageMax: Math.max(18, Math.min(65, Math.trunc(Number(d.ageMax) || 65))),
    genders: list(d.genders, 3),
    languages: list(d.languages),
    interests: list(d.interests),
    startDate: text(d.startDate, 10),
    endDate: text(d.endDate, 10),
    budgetMinorUSD: Math.max(0, Math.min(100000000, Math.trunc(Number(d.budgetMinorUSD) || 0))),
    budgetType: d.budgetType === 'daily' ? 'daily' : 'lifetime',
    notes: text(d.notes, 1000),
    creativeImages: (Array.isArray(d.creativeImages) ? d.creativeImages : []).filter(isSafeAdsStudioCreativeSource).slice(0, 3),
    creativeAssetIds: list(d.creativeAssetIds, 20),
    specialAdCategories: list(d.specialAdCategories, 4),
    boostType,
    sourcePostRef,
    autoReply: d.autoReply === true,
    extendsCampaignId: text(d.extendsCampaignId, 80)
  };
}

function setAdsStudioActionButtonBusy(button, busy) {
  if (!button) return;
  button.disabled = !!busy;
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

function saveAdsStudioDraft(closeAfter = true, button = null) {
  if (_adsStudioSavePromise) return _adsStudioSavePromise;
  setAdsStudioActionButtonBusy(button, true);
  const operation = saveAdsStudioDraftOnce(closeAfter);
  _adsStudioSavePromise = operation;
  const cleanup = () => {
    if (_adsStudioSavePromise === operation) _adsStudioSavePromise = null;
    setAdsStudioActionButtonBusy(button, false);
  };
  operation.then(cleanup, cleanup);
  return operation;
}

async function saveAdsStudioDraftOnce(closeAfter = true, stabilityAttempt = 0) {
  if (!adsStudioCanCreate()) return null;
  const draftAtSaveStart = _adsStudioDraft;
  const saveUserId = String(state.currentUser?.id || '');
  const payload = sanitizedAdsStudioDraft();
  const payloadFingerprint = JSON.stringify(payload);
  if (!payload.name) {
    showNotification(adsStudioText('Name required', 'الاسم مطلوب'), adsStudioText('Enter a campaign name before saving.', 'اكتب اسم الحملة قبل الحفظ.'), 'error');
    return null;
  }
  let saved = false;
  let id = _adsStudioEditingId;
  if (id) {
    const current = findVisibleAdsStudioCampaign(id);
    if (!current || !['Draft', 'Changes Requested'].includes(String(current.status || 'Draft'))) {
      showNotification(adsStudioText('Cannot save', 'تعذر الحفظ'), adsStudioText('This campaign is no longer editable. Refresh the list.', 'لم تعد هذه الحملة قابلة للتعديل. حدّث القائمة.'), 'error');
      return null;
    }
    saved = await updateRecord(state.adCampaignRequests, id, payload, _adsStudioEditingBaseline || current._lastModified);
  } else {
    id = Security.generateSecureId('campaign');
    saved = await addRecord(state.adCampaignRequests, { id, ...payload, status: 'Draft', createdAt: new Date().toISOString() });
  }
  if (!saved) {
    // A real conflict installed the other device's version in memory (updateRecord says
    // "We loaded the latest version") while the form still held this device's text.
    // Reload the form from it, like the modal path does — bumping only the baseline would
    // let the next Save overwrite that version. A plain failure leaves the form alone.
    const fresh = id ? findVisibleAdsStudioCampaign(id) : null;
    if (fresh && _adsStudioEditingBaseline > 0 && _adsStudioEditingId === String(id) && (Number(fresh._lastModified) || 0) !== _adsStudioEditingBaseline) {
      await startAdsStudioCampaign(id);
      showNotification(adsStudioText('Draft reloaded', 'أعيد تحميل المسودة'), adsStudioText('This draft was changed on another device. The form now shows that version; re-apply your edits.', 'تغيّرت هذه المسودة على جهاز آخر. يعرض النموذج الآن تلك النسخة؛ أعد إدخال تعديلاتك.'), 'warning');
    }
    return null;
  }
  // The echo installed the new server version: the next save must build on it.
  _adsStudioEditingBaseline = Number(findVisibleAdsStudioCampaign(id)?._lastModified) || 0;
  const current = findVisibleAdsStudioCampaign(id);
  // Network completion must not overwrite fields typed while this save was in
  // flight, and must never resurrect a draft after an auth/session reset.
  const sameSaveContext = _adsStudioDraft === draftAtSaveStart
    && saveUserId === String(state.currentUser?.id || '');
  if (!sameSaveContext) return null;
  _adsStudioEditingId = id;
  if (current) {
    const liveDraft = _adsStudioDraft;
    _adsStudioDraft = {
      ...current,
      ...liveDraft,
      creativeImages: Array.isArray(liveDraft?.creativeImages) ? liveDraft.creativeImages.slice(0, 3) : payload.creativeImages
    };
  }
  // A customer can continue typing while a slow mobile upload is in flight.
  // Save the newest revision before closing or submitting; after three rapid
  // changes, keep the builder open instead of ever submitting stale content.
  if (JSON.stringify(sanitizedAdsStudioDraft()) !== payloadFingerprint) {
    if (stabilityAttempt < 2) return saveAdsStudioDraftOnce(closeAfter, stabilityAttempt + 1);
    showNotification(
      adsStudioText('Draft kept open', 'تم إبقاء المسودة مفتوحة'),
      adsStudioText('Your latest edits are safe here. Pause typing and press Save again.', 'تعديلاتك الأخيرة آمنة هنا. توقف عن الكتابة واضغط حفظ مرة أخرى.'),
      'warning'
    );
    return null;
  }
  showNotification(adsStudioText('Draft saved', 'تم حفظ المسودة'), adsStudioText('Your campaign is saved safely.', 'تم حفظ حملتك بأمان.'), 'success');
  if (closeAfter) setAdsStudioTab('campaigns');
  return current || findVisibleAdsStudioCampaign(id);
}

function upsertAdsStudioEntity(entity) {
  let data = entity?.data ? Security.sanitizeObject(entity.data) : null;
  if (!data?.id) return null;
  if (isServerModeEnabled() && typeof makeLightweightMediaRecord === 'function') {
    data = makeLightweightMediaRecord('adCampaignRequests', data);
  }
  const existingIndex = (state.adCampaignRequests || []).findIndex(item => String(item?.id || '') === String(data.id));
  if (existingIndex === -1) state.adCampaignRequests.unshift(data);
  else state.adCampaignRequests[existingIndex] = data;
  clearCollectionCorruption('adCampaignRequests');
  markCollectionDirty('adCampaignRequests');
  saveState();
  return data;
}

function submitAdsStudioCampaign(id, button = null) {
  const campaignId = String(id || '');
  if (_adsStudioSubmitPromises.has(campaignId)) return _adsStudioSubmitPromises.get(campaignId);
  setAdsStudioActionButtonBusy(button, true);
  const operation = submitAdsStudioCampaignOnce(campaignId);
  _adsStudioSubmitPromises.set(campaignId, operation);
  const cleanup = () => {
    if (_adsStudioSubmitPromises.get(campaignId) === operation) _adsStudioSubmitPromises.delete(campaignId);
    setAdsStudioActionButtonBusy(button, false);
  };
  operation.then(cleanup, cleanup);
  return operation;
}

async function submitAdsStudioCampaignOnce(id) {
  const campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign || !['Draft', 'Changes Requested'].includes(String(campaign.status || 'Draft'))) return false;
  const errors = adsStudioValidateStep(4, campaign);
  if (errors.length) {
    showNotification(adsStudioText('Campaign incomplete', 'الحملة غير مكتملة'), errors[0], 'error');
    await startAdsStudioCampaign(id);
    return false;
  }
  // Intake paused (P1-22): the draft stays saved; the server refuses the submit anyway. /me is read
  // again first (unless it was read moments ago). While intake is seen as paused the submit waits for
  // that answer, so a reopened intake sends at once; otherwise the server decides.
  const submitUid = String(state.currentUser?.id || '');
  const intakeRead = adsStudioRecheckIntake();
  if (intakeRead && _adsStudioIntakeOpen === false) {
    await intakeRead;
    if (String(state.currentUser?.id || '') !== submitUid) return false;
  }
  if (_adsStudioIntakeOpen === false) {
    showNotification(adsStudioText('Not sent', 'لم يُرسل'), adsStudioIntakePausedText(), 'warning');
    return false;
  }
  // Client mirror of the server money gate: the hold is the TOTAL (lifetime amount, or daily x days).
  const _budgetMinor = adsStudioRequestTotalMinor(campaign);
  if (String(campaign.createdBy || '') === String(state.currentUser?.id || '')
      && adsStudioWalletAvailableMinor() < _budgetMinor) {
    showNotification(
      adsStudioText('Not enough wallet balance', 'رصيد المحفظة غير كافٍ'),
      adsStudioText(
        `Charge your wallet first — the total budget (${adsStudioMoney(_budgetMinor)}) is held from it when you submit.`,
        `اشحن محفظتك أولاً — إجمالي الميزانية (${adsStudioMoney(_budgetMinor)}) يُحجز منها عند الإرسال.`
      ),
      'error'
    );
    _adsStudioActiveTab = 'dashboard';
    try { updateUrlParams({ tab: 'dashboard' }, true); } catch (_) {}
    render();
    return false;
  }
  try {
    if (isServerModeEnabled()) {
      const attempt = adsStudioActionAttempt('submit', campaign.id, Number(campaign._lastModified));
      let entity;
      try {
        entity = await apiSubmitAdCampaignRequest(campaign.id, attempt.expectedLastModified, attempt.operationId);
      } catch (e) {
        const fresh = e?.status === 409 ? await adsStudioReloadCampaign(campaign.id) : null;
        if (!fresh || String(fresh.data?.status || '') !== 'Submitted') throw e;
        entity = fresh;  // the first tap already submitted it
      }
      upsertAdsStudioEntity(entity);
    } else {
      // No server -> no wallet holds/captures: refuse instead of pretending.
      showNotification(
        adsStudioText('Server connection required', 'يتطلب اتصال الخادم'),
        adsStudioText('Campaign budgets are held from the wallet, which needs the server connection.', 'ميزانية الحملة تُحجز من المحفظة، وهذا يتطلب اتصال الخادم.'),
        'error'
      );
      return false;
    }
    showNotification(adsStudioText('Sent for review', 'تم الإرسال للمراجعة'), adsStudioText('Your team can now review this campaign.', 'يمكن للفريق الآن مراجعة هذه الحملة.'), 'success');
    _adsStudioDraft = null;
    _adsStudioEditingId = '';
    _adsStudioEditingBaseline = 0;
    _adsStudioConfirmationChecked = false;
    _adsStudioActiveTab = 'campaigns';
    try { updateUrlParams({ tab: 'campaigns' }, true); } catch (_) {}
    render();
    return true;
  } catch (error) {
    const detail = error?.payload?.detail || error?.message;
    if (String(detail?.message || detail || '').includes('New ad requests are paused')) {
      _adsStudioIntakeOpen = false;  // the switch changed since /me was read: redraw the Send buttons disabled
      render();
    }
    showNotification(adsStudioText('Could not submit', 'تعذر الإرسال'), adsStudioRefusalText(detail) || adsStudioText('Refresh and try again.', 'حدّث الصفحة وحاول مرة أخرى.'), 'error');
    return false;
  }
}

function saveAndSubmitAdsStudioDraft(button = null) {
  if (_adsStudioSaveAndSubmitPromise) return _adsStudioSaveAndSubmitPromise;
  setAdsStudioActionButtonBusy(button, true);
  const operation = saveAndSubmitAdsStudioDraftOnce();
  _adsStudioSaveAndSubmitPromise = operation;
  const cleanup = () => {
    if (_adsStudioSaveAndSubmitPromise === operation) _adsStudioSaveAndSubmitPromise = null;
    setAdsStudioActionButtonBusy(button, false);
  };
  operation.then(cleanup, cleanup);
  return operation;
}

async function saveAndSubmitAdsStudioDraftOnce() {
  const errors = adsStudioValidateStep(4);
  if (errors.length) { showNotification(adsStudioText('Campaign incomplete', 'الحملة غير مكتملة'), errors[0], 'error'); return; }
  const confirmation = document.getElementById('ads-studio-confirm-accurate');
  if (confirmation) _adsStudioConfirmationChecked = !!confirmation.checked;
  if (!_adsStudioConfirmationChecked) {
    showNotification(adsStudioText('Confirmation required', 'التأكيد مطلوب'), adsStudioText('Confirm the information and media rights before submitting.', 'أكد صحة المعلومات وحقوق استخدام الصور قبل الإرسال.'), 'warning');
    return;
  }
  const saved = await saveAdsStudioDraft(false);
  if (saved?.id) await submitAdsStudioCampaign(saved.id);
}

async function openAdsStudioCreativeViewer(id, index = 0, button = null) {
  let campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign) return;
  const label = button?.querySelector?.('span');
  const previous = label?.textContent || '';
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
  if (label) label.textContent = adsStudioText('Loading...', 'جارٍ التحميل...');
  try {
    campaign = await ensureEntityMediaLoaded('adCampaignRequests', id) || campaign;
    openReceiptPhotoViewerSources(Array.isArray(campaign.creativeImages) ? campaign.creativeImages : [], index, adsStudioText('Campaign creative', 'صور الحملة'));
  } catch (_) {
    showNotification(adsStudioText('Images unavailable', 'الصور غير متاحة'), adsStudioText('Check the connection and try again.', 'تحقق من الاتصال وحاول مرة أخرى.'), 'error');
  } finally {
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
    if (label) label.textContent = previous;
  }
}

function adsStudioReviewQueue() {  // the server refuses self-review: a reviewer's own Submitted campaign is not a queue item
  return getVisibleAdsStudioCampaigns().filter(item => item.status === 'Submitted'
    && (isCurrentUserAdmin() || String(item.createdBy || '') !== String(state.currentUser?.id || '')));
}

// The prepared note for a legacy daily request sent back under owner decision D33.
function adsStudioLegacyDailyNote() {
  return adsStudioText(
    'Our budgets changed: choose Daily or Total again and set the number of days, then send the request again. The amount held for it goes back to your available balance.',
    'تغيّر نظام الميزانيات: اختر «يومي» أو «إجمالي» من جديد وحدّد عدد الأيام، ثم أرسل الطلب مرة أخرى. المبلغ المحجوز له يعود إلى رصيدك المتاح.'
  );
}

// The reason picked for a request: the staff's choice, else "budget_dates" for a legacy daily
// request (D33), else none (changes and reject then ask for one, T7).
function adsStudioReviewReasonFor(campaign) {
  const id = String(campaign?.id || '');
  if (Object.prototype.hasOwnProperty.call(_adsStudioReviewReasons, id)) return _adsStudioReviewReasons[id];
  return adsStudioIsLegacyDailyRequest(campaign) ? 'budget_dates' : '';
}

function renderAdsStudioReviewQueue() {
  const isAr = adsStudioIsAr();
  if (!adsStudioCanReview()) return renderAdsStudioEmptyState();
  const queue = adsStudioReviewQueue();
  return `<section><div class="mb-5"><h2 class="text-2xl font-black text-slate-900 dark:text-white">${isAr ? 'طلبات تحتاج المراجعة' : 'Campaign review queue'}</h2><p class="text-sm text-slate-500">${isAr ? 'الموافقة تخصم الميزانية المحجوزة من محفظة العميل؛ النشر على ميتا خطوة منفصلة.' : 'Approval charges the held budget of the customer; publishing on Meta is a separate step.'}</p></div><div class="space-y-5">${queue.length ? queue.map(campaign => {
    const campaignId = String(campaign.id || '');
    const safeId = Security.escapeHtml(campaignId);
    const note = Security.escapeHtml(String(_adsStudioReviewNotes[String(campaign.id || '')] || ''));
    const reason = adsStudioReviewReasonFor(campaign);
    const legacyDaily = adsStudioIsLegacyDailyRequest(campaign);
    const confirming = _adsStudioApproveConfirmId === campaignId;
    const held = adsStudioHeldMinorFor(campaign);
    return `${renderAdsStudioCampaignCard(campaign)}<div class="-mt-3 rounded-b-2xl border border-t-0 border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-900/10 p-4">
      ${legacyDaily ? `<div class="mb-3 flex items-start gap-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200"><i data-lucide="triangle-alert" class="w-4 h-4 flex-shrink-0 mt-0.5"></i><span>${isAr ? 'طلب يومي قديم: يحجز ميزانية يوم واحد فقط. أعده للعميل بسبب «الميزانية أو التواريخ» ليعيد إرساله بالإجمالي.' : 'Old daily request: it holds one day\'s budget only. Send it back with the reason "Budget or dates" so the customer re-sends it with the total.'} <button type="button" onclick="adsStudioUseLegacyDailyNote('${safeId}')" class="font-bold underline">${isAr ? 'استخدم الملاحظة الجاهزة' : 'Use the prepared note'}</button></span></div>` : ''}
      <label for="ads-review-reason-${safeId}" class="block text-sm font-bold mb-2">${isAr ? 'سبب القرار' : 'Reason'}</label>
      <select id="ads-review-reason-${safeId}" onchange="setAdsStudioReviewReason('${safeId}', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4 mb-3"><option value="" ${reason ? '' : 'selected'}>${isAr ? 'اختر سبباً (مطلوب لطلب التعديل أو الرفض)' : 'Choose a reason (needed to send back or reject)'}</option>${ADS_STUDIO_REVIEW_REASONS.map(([code, en, ar]) => `<option value="${code}" ${reason === code ? 'selected' : ''}>${isAr ? ar : en}</option>`).join('')}</select>
      <label class="block text-sm font-bold mb-2">${isAr ? 'ملاحظة القرار' : 'Decision note'}</label><textarea id="ads-review-note-${safeId}" rows="2" maxlength="1000" oninput="setAdsStudioReviewNote('${safeId}', this.value)" class="glass-input w-full rounded-xl px-4 py-3" placeholder="${isAr ? 'اشرح أي تعديل مطلوب...' : 'Explain any requested change...'}">${note}</textarea>
      ${confirming ? `<div class="mt-3 rounded-xl border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 p-3 text-sm text-emerald-900 dark:text-emerald-100" role="alert"><p class="font-bold">${isAr ? `الموافقة على هذا الطلب؟ تخصم ${Security.escapeHtml(adsStudioMoney(held))} المحجوزة من محفظة العميل؛ النشر على ميتا خطوة منفصلة.` : `Approve this request? It charges the held ${Security.escapeHtml(adsStudioMoney(held))} from the customer's wallet; publishing on Meta is a separate step.`}</p><div class="mt-3 grid gap-2 sm:grid-cols-2"><button type="button" onclick="cancelAdsStudioApproval()" class="touch-target min-h-12 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-bold">${isAr ? 'إلغاء' : 'Cancel'}</button><button type="button" onclick="reviewAdsStudioCampaign('${safeId}','Approved', this, true)" class="touch-target min-h-12 rounded-xl bg-emerald-600 text-white font-black disabled:opacity-60">${isAr ? 'تأكيد الموافقة' : 'Confirm approval'}</button></div></div>` : ''}
      <div class="mt-3 grid gap-2 sm:grid-cols-3"><button type="button" onclick="reviewAdsStudioCampaign('${safeId}','Changes Requested', this)" class="touch-target min-h-12 rounded-xl bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-200 font-bold disabled:opacity-60">${isAr ? 'طلب تعديلات' : 'Request changes'}</button><button type="button" onclick="reviewAdsStudioCampaign('${safeId}','Rejected', this)" class="touch-target min-h-12 rounded-xl bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200 font-bold disabled:opacity-60">${isAr ? 'رفض' : 'Reject'}</button><button type="button" onclick="reviewAdsStudioCampaign('${safeId}','Approved', this)" class="touch-target min-h-12 rounded-xl bg-emerald-600 text-white font-black disabled:opacity-60">${isAr ? 'موافقة' : 'Approve'}</button></div></div>`;
  }).join('') : `<div class="glass-panel rounded-2xl p-10 text-center"><i data-lucide="badge-check" class="w-12 h-12 mx-auto text-emerald-400 mb-3"></i><h3 class="font-black text-lg text-slate-900 dark:text-white">${isAr ? 'تمت مراجعة كل الطلبات' : 'Review queue is clear'}</h3><p class="text-sm text-slate-500 mt-1">${isAr ? 'ستظهر الحملات الجديدة هنا بعد الإرسال.' : 'New submitted campaigns will appear here.'}</p></div>`}</div></section>`;
}

function setAdsStudioReviewNote(id, value) {
  const campaignId = String(id || '');
  if (!campaignId) return;
  _adsStudioReviewNotes[campaignId] = String(value || '').slice(0, 1000);
}

function setAdsStudioReviewReason(id, value) {
  const campaignId = String(id || '');
  if (!campaignId) return;
  const code = String(value || '');
  _adsStudioReviewReasons[campaignId] = ADS_STUDIO_REVIEW_REASONS.some(([known]) => known === code) ? code : '';
}

function adsStudioUseLegacyDailyNote(id) {
  const campaignId = String(id || '');
  if (!campaignId) return;
  setAdsStudioReviewNote(campaignId, adsStudioLegacyDailyNote());
  setAdsStudioReviewReason(campaignId, 'budget_dates');
  const field = typeof document !== 'undefined' ? document.getElementById(`ads-review-note-${campaignId}`) : null;
  if (field) field.value = _adsStudioReviewNotes[campaignId];
  const select = typeof document !== 'undefined' ? document.getElementById(`ads-review-reason-${campaignId}`) : null;
  if (select) select.value = 'budget_dates';
}

function cancelAdsStudioApproval() {
  _adsStudioApproveConfirmId = '';
  render();
}

// POST /review with the reason code (P1-12). Same request as apiReviewAdCampaignRequest (startup
// bundle, left unchanged) plus reviewReasonCode, the field the server stores on the request.
async function adsStudioApiReview(campaignId, expectedLastModified, decision, note, operationId, reasonCode) {
  const identity = getServerSessionIdentity();
  const body = { expectedLastModified, decision, note, operationId };
  if (reasonCode) body.reviewReasonCode = reasonCode;
  const entity = await requestValidatedServerEntity('adCampaignRequests', 'review', () =>
    withRetry(() => apiJson(`/api/ad-studio/campaigns/${encodeURIComponent(campaignId)}/review`, {
      method: 'POST', body
    }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 2, 500)
  );
  if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
  return entity;
}

function reviewAdsStudioCampaign(id, decision, button = null, confirmed = false) {
  const campaignId = String(id || '');
  if (_adsStudioReviewPromises.has(campaignId)) return _adsStudioReviewPromises.get(campaignId);
  setAdsStudioActionButtonBusy(button, true);
  const operation = reviewAdsStudioCampaignOnce(campaignId, decision, confirmed === true);
  _adsStudioReviewPromises.set(campaignId, operation);
  const cleanup = () => {
    if (_adsStudioReviewPromises.get(campaignId) === operation) _adsStudioReviewPromises.delete(campaignId);
    setAdsStudioActionButtonBusy(button, false);
  };
  operation.then(cleanup, cleanup);
  return operation;
}

async function reviewAdsStudioCampaignOnce(id, decision, confirmed = false) {
  if (!adsStudioCanReview() || !['Approved', 'Changes Requested', 'Rejected'].includes(decision)) return;
  const campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign || campaign.status !== 'Submitted') return;
  const inputValue = typeof document !== 'undefined' ? document.getElementById(`ads-review-note-${id}`)?.value : undefined;
  if (inputValue !== undefined) setAdsStudioReviewNote(id, inputValue);
  const reasonValue = typeof document !== 'undefined' ? document.getElementById(`ads-review-reason-${id}`)?.value : undefined;
  if (reasonValue !== undefined) setAdsStudioReviewReason(id, reasonValue);
  const note = Security.sanitizeInput(String(_adsStudioReviewNotes[id] || ''), { maxLength: 1000 }).trim();
  const reasonCode = decision === 'Approved' ? '' : adsStudioReviewReasonFor(campaign);
  if (decision !== 'Approved' && !reasonCode) {
    showNotification(adsStudioText('Choose a reason', 'اختر سبباً'), adsStudioText('Choose a reason for this decision.', 'اختر سبباً لهذا القرار.'), 'warning');
    return;
  }
  if (decision !== 'Approved' && !note) {
    showNotification(adsStudioText('Add a note', 'أضف ملاحظة'), adsStudioText('Explain what the customer should change.', 'اشرح للعميل ما الذي يجب تعديله.'), 'warning');
    return;
  }
  // Approval moves the customer's money: an in-page confirmation row, never a native dialog.
  if (decision === 'Approved' && !confirmed) {
    _adsStudioApproveConfirmId = String(id);
    render();
    return;
  }
  _adsStudioApproveConfirmId = '';
  try {
    if (isServerModeEnabled()) {
      const attempt = adsStudioActionAttempt('review', campaign.id, Number(campaign._lastModified));
      let entity;
      try {
        entity = await adsStudioApiReview(campaign.id, attempt.expectedLastModified, decision, note, attempt.operationId, reasonCode);
      } catch (e) {
        const fresh = e?.status === 409 ? await adsStudioReloadCampaign(campaign.id) : null;
        if (!fresh || String(fresh.data?.status || '') !== decision) throw e;
        entity = fresh;  // the first tap already recorded this decision
      }
      upsertAdsStudioEntity(entity);
    } else {
      const saved = await updateRecord(state.adCampaignRequests, campaign.id, { status: decision, reviewNote: note, reviewReasonCode: reasonCode, reviewedAt: new Date().toISOString(), reviewedBy: state.currentUser?.id }, campaign._lastModified);
      if (!saved) return;
    }
    delete _adsStudioReviewNotes[id];
    delete _adsStudioReviewReasons[id];
    showNotification(adsStudioText('Decision saved', 'تم حفظ القرار'), adsStudioText(`Campaign marked ${decision}.`, `تم تحديث حالة الحملة: ${adsStudioStatusMeta(decision).labelAr}.`), 'success');
    render();
  } catch (error) {
    showNotification(adsStudioText('Review failed', 'تعذر حفظ المراجعة'), adsStudioRefusalText(error?.payload?.detail || error?.message) || adsStudioText('Refresh and try again.', 'حدّث الصفحة وحاول مرة أخرى.'), 'error');
  }
}

// ---- Wallet ----
let _adsStudioWalletMine = null;
let _adsStudioWalletPendingAll = null;
let _adsStudioWalletBusy = false;
let _adsStudioWalletForUser = '';
// Server-owned Libyan payment catalog + today's USD→LYD rate.
let _adsStudioPayMethods = null;
let _adsStudioPayRate = null;
// Which method the customer tapped — survives background re-renders.
let _adsStudioChargeMethodSel = '';

function resetAdsStudioWalletCache() {
  _adsStudioWalletMine = null;
  _adsStudioWalletPendingAll = null;
  _adsStudioWalletForUser = '';
  _adsStudioPayMethods = null;
  _adsStudioPayRate = null;
  _adsStudioChargeMethodSel = '';
}

function _adsStudioPayMethod(id) {
  const list = Array.isArray(_adsStudioPayMethods) ? _adsStudioPayMethods : [];
  return list.find(m => m && m.id === String(id || '')) || null;
}

function _adsStudioUsdToLydRate() {
  const r = Number(_adsStudioPayRate?.usdToLyd || 0);
  if (r > 0) return r;
  return Number(state.defaultExchangeRate) > 0 ? Number(state.defaultExchangeRate) : 0;
}

// Runs on every key with the raw text; the charge box is cleaned (sanitizeMoneyInput) only on change,
// so "1,500" typed key by key stays fifteen hundred (see adsStudioOnBudgetInput).
function adsStudioUpdateLydPreview() {
  const el = document.getElementById('ads-studio-lyd-preview');
  if (!el) return;
  const usd = adsStudioParseMoneyMinor(document.getElementById('ads-studio-charge-amount')?.value || '') / 100;  // '٥٠' is 50
  const rate = _adsStudioUsdToLydRate();
  const lydMode = String(document.getElementById('ads-studio-charge-currency')?.value || 'USD') === 'LYD';
  el.textContent = (!lydMode && Number.isFinite(usd) && usd > 0 && rate > 0)
    ? `≈ ${(Math.ceil(Math.round(usd * 100) * Math.round(rate * 10000) / 10000) / 100).toFixed(2)} LYD @ ${rate}`
    : '';
}

function adsStudioWalletHeldMinor() {
  const uid = String(state.currentUser?.id || '');
  return (Array.isArray(state.adCampaignRequests) ? state.adCampaignRequests : [])
    .filter(c => c && !c._deleted && String(c.createdBy || '') === uid && String(c.status || '') === 'Submitted')
    .reduce((sum, c) => sum + adsStudioHeldMinorFor(c), 0);  // the total, or a legacy row's budget field
}

function adsStudioWalletBalanceMinor() {
  return WALLET.getBalanceMinor(String(state.currentUser?.id || ''), 'USD');
}

function adsStudioWalletAvailableMinor() {
  return adsStudioWalletBalanceMinor() - adsStudioWalletHeldMinor();
}

async function refreshAdsStudioWallet() {
  if (_adsStudioWalletBusy) return;
  _adsStudioWalletBusy = true;
  const forUser = String(state.currentUser?.id || '');
  try {
    if (_adsStudioPayMethods === null) {
      try {
        const catalog = await apiWalletPaymentMethods();
        _adsStudioPayMethods = Array.isArray(catalog?.methods) ? catalog.methods : [];
        _adsStudioPayRate = catalog?.rate || null;
      } catch (_) { /* stays null so the next refresh retries */ }
    }
    const mine = await apiWalletPaymentRequestList('mine');
    let pendingAll = null;
    if (isCurrentUserAdmin()) {
      const pending = await apiWalletPaymentRequestList('pending');
      pendingAll = Array.isArray(pending?.requests) ? pending.requests : [];
    }
    // Never show one account's wallet rows to another after a user switch.
    if (forUser === String(state.currentUser?.id || '')) {
      _adsStudioWalletMine = Array.isArray(mine?.requests) ? mine.requests : [];
      _adsStudioWalletPendingAll = pendingAll;
      _adsStudioWalletForUser = forUser;
    }
  } catch (_) {
    if (forUser === String(state.currentUser?.id || '')) {
      // Stamp the user even on failure or every render would reset the cache
      // and refetch forever; the Refresh button retries on demand.
      _adsStudioWalletMine = _adsStudioWalletMine || [];
      _adsStudioWalletForUser = forUser;
    }
  } finally {
    _adsStudioWalletBusy = false;
  }
  if (state.currentView === 'ads-studio') render();
}

let _adsStudioChargeBusy = false;
async function adsStudioCreateWalletCharge() {
  if (_adsStudioChargeBusy) return;
  const input = document.getElementById('ads-studio-charge-amount');
  const method = String(document.querySelector('input[name="ads-studio-charge-method"]:checked')?.value || '');
  const currency = String(document.getElementById('ads-studio-charge-currency')?.value || 'USD') === 'LYD' ? 'LYD' : 'USD';
  const parsedMinor = adsStudioParseMoneyMinor(input?.value || '');  // Arabic-Indic digits count (P1-08b)
  const amountMinor = Number.isFinite(parsedMinor) ? parsedMinor : 0;
  if (amountMinor < 100) {
    showNotification(adsStudioText('Invalid amount', 'مبلغ غير صالح'), currency === 'LYD' ? adsStudioText('Minimum charge is 1.00 LYD', 'أقل مبلغ للشحن هو دينار واحد') : adsStudioText('Minimum charge is $1.00', 'أقل مبلغ للشحن هو 1 دولار'), 'error');
    return;
  }
  if (!method || !_adsStudioPayMethod(method)) {
    showNotification(adsStudioText('Pick a payment method', 'اختر طريقة الدفع'), adsStudioText('Choose how you will pay, then create the request.', 'اختر كيف ستدفع ثم أنشئ الطلب.'), 'warning');
    return;
  }
  _adsStudioChargeBusy = true;
  try {
    const created = await apiWalletPaymentRequestCreate(amountMinor, method, adsStudioChargeIdemKey(amountMinor, `${method}|${currency}`), currency);
    _adsStudioChargeIdem = { fingerprint: '', key: '' };
    const d = created?.data || {};
    const entry = _adsStudioPayMethod(d.method);
    const template = entry && entry.instructions ? String(adsStudioIsAr() ? entry.instructions.ar : entry.instructions.en) : '';
    let message;
    if (template) {
      message = template
        .split('{reference}').join(String(d.reference || ''))
        .split('{amountLYD}').join(d.amountMinorLYD ? (d.amountMinorLYD / 100).toFixed(2) : '—')
        .split('{amountUSD}').join(`${(Number(d.amountMinor || 0) / 100).toFixed(2)}${String(d.currency || 'USD').toUpperCase() === 'LYD' ? ' LYD' : ''}`)
        .split('{rate}').join(String(d.lydRate || ''));
    } else {
      message = adsStudioText(
        `Pay with reference ${d.reference || ''} — the wallet fills up as soon as the payment is confirmed.`,
        `ادفع بذكر الرمز ${d.reference || ''} — تتعبأ المحفظة فور تأكيد الدفع.`
      );
    }
    showNotification(adsStudioText('Charge request created', 'تم إنشاء طلب الشحن'), message, 'success');
  } catch (e) {
    const detail = (e?.payload && e.payload.detail) ? e.payload.detail : (e?.message || 'Request failed');
    showNotification(adsStudioText('Could not create the charge', 'تعذر إنشاء طلب الشحن'), String(detail), 'error');
  } finally {
    _adsStudioChargeBusy = false;
  }
  refreshAdsStudioWallet();
}

async function adsStudioDecideWalletCharge(requestId, action, overrideMissingReceipt) {
  if (overrideMissingReceipt) {
    // The row on screen may be stale: the customer might have attached the
    // receipt after this admin list was rendered. Re-check before overriding.
    try {
      const fresh = await apiWalletPaymentRequestGet(requestId);
      const fd = fresh?.data || {};
      if (fd.receiptPhoto || fd.receiptPhotoAt) {
        showNotification(
          adsStudioText('Receipt was attached', 'تم إرفاق الإيصال'),
          adsStudioText('The customer attached a receipt — review it, then confirm normally.', 'أرفق العميل الإيصال — راجعه ثم أكّد بشكل عادي.'),
          'info'
        );
        resetAdsStudioWalletCache();
        refreshAdsStudioWallet();
        return;
      }
    } catch (_) { /* server still enforces the receipt rule on confirm */ }
  }
  try {
    await apiWalletPaymentRequestDecide(requestId, action, null, overrideMissingReceipt);
    showNotification(
      adsStudioText(action === 'confirm' ? 'Payment confirmed' : 'Request canceled', action === 'confirm' ? 'تم تأكيد الدفع' : 'تم إلغاء الطلب'),
      adsStudioText(action === 'confirm' ? 'The wallet has been credited.' : 'The charge request was canceled.', action === 'confirm' ? 'تمت تعبئة المحفظة.' : 'تم إلغاء طلب الشحن.'),
      'success'
    );
  } catch (e) {
    const detail = (e?.payload && e.payload.detail) ? e.payload.detail : (e?.message || 'Request failed');
    showNotification(adsStudioText('Action failed', 'فشل الإجراء'), String(detail), 'error');
  }
  refreshAdsStudioWallet();
}

// JS mirror of has-[:checked] for old WebViews without :has().
function adsStudioMarkWalletMethod(input) {
  if (input && input.value) _adsStudioChargeMethodSel = String(input.value);
  document.querySelectorAll('label.ads-studio-method-label').forEach(l => {
    l.classList.remove('border-purple-500', 'bg-purple-50', 'dark:bg-purple-900/20');
    l.classList.add('border-slate-200', 'dark:border-slate-700');
  });
  const label = input && input.closest ? input.closest('label') : null;
  if (label) {
    label.classList.remove('border-slate-200', 'dark:border-slate-700');
    label.classList.add('border-purple-500', 'bg-purple-50', 'dark:bg-purple-900/20');
  }
}

function _adsStudioWalletMethodLabel(method) {
  const entry = _adsStudioPayMethod(method);
  const entryName = entry && entry.name ? (adsStudioIsAr() ? entry.name.ar : entry.name.en) : '';
  if (entryName) return String(entryName);
  // Legacy rows created before the catalog existed keep a readable label.
  if (method === 'card') return adsStudioText('Libyan card', 'بطاقة ليبية');
  if (method === 'qr') return adsStudioText('QR payment', 'دفع QR');
  if (method === 'bank_transfer') return adsStudioText('Bank transfer', 'حوالة مصرفية');
  return String(method || '');
}

async function adsStudioAttachReceipt(requestId, inputEl) {
  const file = inputEl?.files?.[0];
  if (!file) return;
  try {
    const photo = await compressImageToDataUrl(file);
    await apiWalletPaymentRequestAttachReceipt(requestId, photo);
    showNotification(
      adsStudioText('Receipt attached', 'تم إرفاق الإيصال'),
      adsStudioText('We will confirm your payment shortly.', 'سنؤكد دفعتك قريباً.'),
      'success'
    );
  } catch (e) {
    const detail = (e?.payload && e.payload.detail) ? e.payload.detail : (e?.message || 'Upload failed');
    showNotification(adsStudioText('Could not attach', 'تعذر الإرفاق'), String(detail), 'error');
  } finally {
    // Clear the picker so choosing the same file again re-fires onchange.
    try { if (inputEl) inputEl.value = ''; } catch (_) {}
  }
  resetAdsStudioWalletCache();
  refreshAdsStudioWallet();
}

async function adsStudioViewPaymentReceipt(requestId) {
  try {
    const full = await apiWalletPaymentRequestGet(requestId);
    const src = String(full?.data?.receiptPhoto || '');
    if (src.indexOf('data:image/') === 0 && typeof openReceiptPhotoViewerSources === 'function') {
      openReceiptPhotoViewerSources([src], 0, adsStudioText('Transfer receipt', 'إيصال الحوالة'));
    }
  } catch (e) {
    showNotification(adsStudioText('Could not load receipt', 'تعذر تحميل الإيصال'), String(e?.message || ''), 'error');
  }
}

function _adsStudioWalletRequestRow(entity, adminView) {
  const d = entity?.data || {};
  const rid = Security.escapeHtml(String(entity.id));
  const isPending = String(d.status || '') === 'pending';
  const statusColor = isPending ? 'text-amber-600' : (String(d.status) === 'confirmed' ? 'text-emerald-600' : 'text-slate-400');
  const entry = _adsStudioPayMethod(d.method);
  const hasPhoto = Number(d._photoCount || 0) > 0 || !!d.receiptPhotoAt;
  // An LYD request (plan money) IS the cash: shown in LYD, never "$", and with no "≈" line (P1-08a).
  const currency = String(d.currency || 'USD').trim().toUpperCase() === 'LYD' ? 'LYD' : 'USD';
  const lyd = currency === 'USD' && d.amountMinorLYD ? ` • ≈ ${(d.amountMinorLYD / 100).toFixed(2)} LYD` : '';
  return `
    <div class="studio-wallet-request flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40">
      <div class="min-w-0">
        <div class="font-mono font-bold text-slate-800 dark:text-white">${Security.escapeHtml(String(d.reference || ''))} ${hasPhoto ? '<i data-lucide="paperclip" class="inline w-3.5 h-3.5 text-emerald-600"></i>' : ''}</div>
        <div class="text-xs text-slate-500">${adsStudioMoneyIn(parseInt(d.amountMinor, 10) || 0, currency)}${lyd} • ${Security.escapeHtml(_adsStudioWalletMethodLabel(String(d.method || '')))}</div>
      </div>
      <div class="studio-wallet-request-actions flex flex-wrap items-center gap-2">
        <span class="text-xs font-bold ${statusColor}">${Security.escapeHtml(String(d.status || ''))}</span>
        ${isPending && !adminView && entry && entry.requiresReceiptPhoto ? `
          <label class="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-100 hover:bg-blue-200 text-blue-700 cursor-pointer">
            <input type="file" accept="image/*" class="hidden" onchange="adsStudioAttachReceipt('${rid}', this)" />
            ${hasPhoto ? adsStudioText('Replace receipt', 'استبدال الإيصال') : adsStudioText('Attach receipt', 'إرفاق الإيصال')}
          </label>` : ''}
        ${adminView && hasPhoto ? `<button onclick="adsStudioViewPaymentReceipt('${rid}')" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-100 hover:bg-blue-200 text-blue-700">${adsStudioText('View receipt', 'عرض الإيصال')}</button>` : ''}
        ${isPending && adminView ? `<button onclick="adsStudioDecideWalletCharge('${rid}', 'confirm')" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-100 hover:bg-emerald-200 text-emerald-700">${adsStudioText('Confirm received', 'تأكيد الاستلام')}</button>` : ''}
        ${isPending && adminView && entry && entry.requiresReceiptPhoto && !hasPhoto ? `<button onclick="adsStudioDecideWalletCharge('${rid}', 'confirm', true)" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-100 hover:bg-amber-200 text-amber-700" title="${adsStudioText('Bank verified the transfer without a photo', 'تحقق المصرف من الحوالة دون صورة')}">${adsStudioText('Confirm w/o receipt', 'تأكيد بدون إيصال')}</button>` : ''}
        ${isPending ? `<button onclick="adsStudioDecideWalletCharge('${rid}', 'cancel')" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300">${adsStudioText('Cancel', 'إلغاء')}</button>` : ''}
        ${!adminView && typeof studioHelpAskButton === 'function' && /^PAY-[A-Z0-9]{4,16}$/.test(String(d.reference || '')) ? studioHelpAskButton('payment', String(d.reference), true) : ''}
      </div>
    </div>`;
}

function renderAdsStudioWallet() {
  if (_adsStudioWalletForUser !== String(state.currentUser?.id || '')) resetAdsStudioWalletCache();
  if (_adsStudioWalletMine === null) refreshAdsStudioWallet();
  const balance = adsStudioWalletBalanceMinor();
  const held = adsStudioWalletHeldMinor();
  const available = balance - held;
  const mine = Array.isArray(_adsStudioWalletMine) ? _adsStudioWalletMine : [];
  const pendingAll = Array.isArray(_adsStudioWalletPendingAll) ? _adsStudioWalletPendingAll : [];
  const uid = String(state.currentUser?.id || '');
  const history = (Array.isArray(state.walletTransactions) ? state.walletTransactions : [])
    .filter(tx => tx && !tx._deleted && String(tx.currency || '').toUpperCase() === 'USD'
      && (String(tx.toUserId || '') === uid || String(tx.fromUserId || '') === uid))
    .slice(0, 8);  // newest first: the ledger array is newest-first in server mode
  return `
    <div class="space-y-6">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="glass-panel rounded-2xl p-5"><div class="text-xs text-slate-500 mb-1">${adsStudioText('Wallet balance', 'رصيد المحفظة')}</div><div class="workspace-money-value text-2xl font-bold text-slate-800 dark:text-white">${adsStudioMoney(balance)}</div></div>
        <div class="glass-panel rounded-2xl p-5"><div class="text-xs text-slate-500 mb-1">${adsStudioText('Held for submitted campaigns', 'محجوز للحملات المُرسلة')}</div><div class="workspace-money-value text-2xl font-bold text-amber-600">${adsStudioMoney(held)}</div></div>
        <div class="glass-panel rounded-2xl p-5"><div class="text-xs text-slate-500 mb-1">${adsStudioText('Available to spend', 'متاح للصرف')}</div><div class="workspace-money-value text-2xl font-bold text-emerald-600">${adsStudioMoney(available)}</div></div>
      </div>

      <div class="glass-panel rounded-2xl p-6">
        <h3 class="font-bold text-slate-800 dark:text-white mb-1">${adsStudioText('Add money', 'إضافة رصيد')}</h3>
        <p class="text-xs text-slate-500 mb-4">${adsStudioText('Choose how you pay. You get a reference code; the wallet fills up the moment the payment is confirmed — automatically once the payment company is connected.', 'اختر طريقة الدفع. ستحصل على رمز مرجعي، وتتعبأ المحفظة فور تأكيد الدفع — تلقائياً بعد ربط شركة الدفع.')}</p>
        <div class="mb-4">
          <label class="text-xs text-slate-500 block mb-1">${adsStudioText('Amount', 'المبلغ')}
            <select id="ads-studio-charge-currency" onchange="adsStudioUpdateLydPreview()" class="ml-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-xs font-bold text-slate-700 dark:text-slate-200"><option value="USD">${adsStudioText('USD (campaigns)', 'دولار (الحملات)')}</option><option value="LYD">${adsStudioText('LYD (subscription plans)', 'دينار (باقات الاشتراك)')}</option></select>
          </label>
          <div class="studio-wallet-charge-preview flex flex-wrap items-center gap-3">
            <input id="ads-studio-charge-amount" type="text" inputmode="decimal" autocomplete="off" placeholder="50.00" oninput="adsStudioUpdateLydPreview()" onchange="sanitizeMoneyInput(this); adsStudioUpdateLydPreview()"
              class="w-36 px-3 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-white font-mono" />
            <span id="ads-studio-lyd-preview" class="text-sm font-bold text-blue-700 dark:text-blue-300"></span>
          </div>
        </div>
        ${Array.isArray(_adsStudioPayMethods) && _adsStudioPayMethods.length ? `
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          ${_adsStudioPayMethods.map((m, i) => {
            const name = m.name || {};
            const desc = m.desc || {};
            const picked = _adsStudioChargeMethodSel && _adsStudioPayMethod(_adsStudioChargeMethodSel)
              ? String(m.id) === _adsStudioChargeMethodSel
              : i === 0;
            return `
            <label class="ads-studio-method-label flex items-start gap-2 p-3 rounded-xl border-2 cursor-pointer has-[:checked]:border-purple-500 has-[:checked]:bg-purple-50 dark:has-[:checked]:bg-purple-900/20 ${picked ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : 'border-slate-200 dark:border-slate-700'}">
              <input type="radio" id="ads-studio-method-${Security.escapeHtml(String(m.id))}" name="ads-studio-charge-method" value="${Security.escapeHtml(String(m.id))}" ${picked ? 'checked' : ''} class="accent-purple-600 mt-0.5" onchange="adsStudioMarkWalletMethod(this)" />
              <span class="min-w-0">
                <span class="flex items-center gap-1.5 text-sm font-bold text-slate-800 dark:text-white"><i data-lucide="${Security.escapeHtml(String(m.icon || 'wallet'))}" class="w-4 h-4"></i>${Security.escapeHtml(String((adsStudioIsAr() ? name.ar : name.en) || m.id || ''))}</span>
                <span class="block text-[11px] text-slate-500 leading-tight mt-0.5">${Security.escapeHtml(String((adsStudioIsAr() ? desc.ar : desc.en) || ''))}</span>
              </span>
            </label>`;
          }).join('')}
        </div>
        <button onclick="adsStudioCreateWalletCharge()" class="px-5 py-2.5 rounded-xl font-bold text-white bg-purple-600 hover:bg-purple-700 transition-all">${adsStudioText('Create charge request', 'إنشاء طلب شحن')}</button>` : `
        <div class="rounded-xl bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-200">
          ${adsStudioText('Payment methods did not load — check your connection and tap Refresh below.', 'لم يتم تحميل طرق الدفع — تأكد من الاتصال ثم اضغط "تحديث" بالأسفل.')}
        </div>`}
      </div>

      ${isCurrentUserAdmin() && pendingAll.length ? `
      <div class="glass-panel rounded-2xl p-6">
        <h3 class="font-bold text-slate-800 dark:text-white mb-3">${adsStudioText('Payments waiting for confirmation (all customers)', 'مدفوعات بانتظار التأكيد (كل العملاء)')}</h3>
        <div class="space-y-2">${pendingAll.map(r => _adsStudioWalletRequestRow(r, true)).join('')}</div>
      </div>` : ''}

      <div class="glass-panel rounded-2xl p-6">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-bold text-slate-800 dark:text-white">${adsStudioText('My charge requests', 'طلبات الشحن الخاصة بي')}</h3>
          <button onclick="resetAdsStudioWalletCache(); refreshAdsStudioWallet();" class="inline-flex items-center gap-1 text-xs font-bold text-purple-600 hover:text-purple-700"><i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>${adsStudioText('Refresh', 'تحديث')}</button>
        </div>
        ${mine.length ? `<div class="space-y-2">${mine.map(r => _adsStudioWalletRequestRow(r, false)).join('')}</div>`
          : `<p class="text-sm text-slate-500">${adsStudioText('No charge requests yet.', 'لا توجد طلبات شحن بعد.')}</p>`}
      </div>

      <div class="glass-panel rounded-2xl p-6">
        <h3 class="font-bold text-slate-800 dark:text-white mb-3">${adsStudioText('Recent wallet activity', 'آخر حركات المحفظة')}</h3>
        ${history.length ? `<div class="space-y-1">${history.map(tx => {
          const incoming = String(tx.toUserId || '') === uid;
          return `<div class="workspace-wallet-row text-sm py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
            <span class="text-slate-600 dark:text-slate-300">${Security.escapeHtml(String(tx.memo || tx.type || ''))}</span>
            <span class="workspace-wallet-amount font-mono font-bold ${incoming ? 'text-emerald-600' : 'text-rose-600'}" dir="ltr">${incoming ? '+' : '−'}${adsStudioMoney(Math.abs(parseInt(tx.amountMinor, 10) || 0))}</span>
          </div>`;
        }).join('')}</div>`
          : `<p class="text-sm text-slate-500">${adsStudioText('No wallet activity yet.', 'لا توجد حركات بعد.')}</p>`}
      </div>
    </div>`;
}

function renderAdsStudioConnections() {
  const isAr = adsStudioIsAr();
  const checklist = [
    ['building-2', isAr ? 'التحقق من نشاط البيان التجاري لدى ميتا' : 'Albayan business verification with Meta'],
    ['shield-check', isAr ? 'مراجعة التطبيق والوصول المتقدم' : 'App Review and Advanced Access'],
    ['key-round', isAr ? 'تخزين الرموز مشفرة على الخادم فقط' : 'Encrypted server-only token storage'],
    ['link-2', isAr ? 'ربط العميل لحسابه وصفحته بنفسه' : 'Customer-owned account and Page connection'],
    ['pause-circle', isAr ? 'إنشاء الحملات الجديدة متوقفة مؤقتاً' : 'Create every new Meta campaign paused'],
    ['activity', isAr ? 'مزامنة الحالة والأخطاء والنتائج' : 'Status, issue and performance synchronization']
  ];
  return `<section class="grid gap-6 lg:grid-cols-[1.1fr_1fr]"><div class="glass-panel rounded-3xl p-5 sm:p-7"><div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-600 to-cyan-500 flex items-center justify-center text-white mb-5"><i data-lucide="facebook" class="w-7 h-7"></i></div><span class="inline-flex rounded-full bg-emerald-100 dark:bg-emerald-900/30 px-3 py-1 text-xs font-bold text-emerald-800 dark:text-emerald-200">${isAr ? 'تتبع Meta للقراءة فقط متاح' : 'Read-only Meta tracking available'}</span><h2 class="mt-4 text-2xl font-black text-slate-900 dark:text-white">${isAr ? 'نربط الإعلان الحقيقي ونتابع تغيّراته' : 'We link the real ad and track its changes'}</h2><p class="mt-3 text-slate-500 dark:text-slate-400">${isAr ? 'الربط يقوم به فريق البيان وليس من هذه الشاشة: بعد الموافقة ينشئ الفريق حملتك في ميتا ويربطها بطلبك. تبقى الوصل والأموال والصور داخل Albayan دون تغيير. النشر المباشر سيبقى مغلقاً حتى اكتمال موافقات ميتا.' : 'Linking is done by the Albayan team, not from this screen: after approval, the team creates your campaign in Meta and links it to your request. Albayan receipts, money and photos stay unchanged. Direct publishing remains locked until Meta approvals are complete.'}</p><div class="mt-5 rounded-2xl bg-blue-50 dark:bg-blue-900/20 p-4 text-sm text-blue-900 dark:text-blue-100 flex items-start gap-3"><i data-lucide="info" class="w-5 h-5 flex-shrink-0"></i><span>${isAr ? 'لا يلزمك ربط أي شيء من جهتك. تابع كل حملة من بطاقتها في «حملاتي».' : 'There is nothing for you to connect. Follow each campaign on its card in My Campaigns.'}</span></div><div class="mt-5 rounded-2xl bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-800 dark:text-red-200 flex items-start gap-3"><i data-lucide="shield-alert" class="w-5 h-5 flex-shrink-0"></i><span>${isAr ? 'لن نطلب كلمة مرور فيسبوك ولن نخزن رمز ميتا داخل تطبيق الهاتف أو بيانات الحملة.' : 'We will never ask for a Facebook password or store a Meta token in the mobile app or campaign records.'}</span></div></div><div class="glass-panel rounded-3xl p-5 sm:p-7"><h3 class="text-lg font-black text-slate-900 dark:text-white">${isAr ? 'خطة النشر المباشر لاحقاً' : 'Future direct-publishing checklist'}</h3><div class="mt-5 space-y-3">${checklist.map(([icon,label], index) => `<div class="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3"><span class="w-9 h-9 rounded-xl ${index < 2 ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-200' : 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'} flex items-center justify-center"><i data-lucide="${icon}" class="w-4 h-4"></i></span><span class="flex-1 text-sm font-bold text-slate-700 dark:text-slate-200">${label}</span><i data-lucide="${index < 2 ? 'clock-3' : 'circle-dashed'}" class="w-4 h-4 text-slate-400"></i></div>`).join('')}</div></div></section>`;
}
