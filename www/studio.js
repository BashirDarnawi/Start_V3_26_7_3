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
  else if (_adsStudioActiveTab === 'review') content = renderAdsStudioReviewQueue() + renderAdsStudioLaunchQueue() + (isCurrentUserAdmin() && typeof renderStudioHealthSection === 'function' ? renderStudioHealthSection() : '');
  else if (_adsStudioActiveTab === 'posts') content = renderSocialStudioPostsTab();
  else if (_adsStudioActiveTab === 'replies') content = renderSocialStudioRepliesTab();
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
  const showAskStop = statusValue === 'Approved' && !staffHere && mayStop && !ownerCanInstantStop;
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
          ${showAskStop ? `<button type="button" onclick="showNotification('${isAr ? 'الإعلان بدأ بالفعل' : 'This ad already started'}', '${isAr ? 'راسلنا لنوقفه ونعيد الجزء غير المصروف إلى محفظتك.' : 'Message us — we stop it and refund the unspent part to your wallet.'}', 'info')" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 px-3 text-sm font-bold text-slate-600 dark:text-slate-300"><i data-lucide="circle-help" class="w-4 h-4"></i>${isAr ? 'اطلب الإيقاف' : 'Ask us to stop it'}</button>` : ''}
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
];
// A /api/studio refusal is {code, message}; the classic routes send a plain string (a 422 a list).
function adsStudioRefusalText(detail) {
  const text = Array.isArray(detail) ? detail.map(item => String(typeof item === 'string' ? item : (item?.msg || ''))).filter(Boolean).join('; ')
    : detail && typeof detail === 'object' ? String(detail.message || '') : String(detail || '');
  if (!adsStudioIsAr()) return text;
  const hit = _ADS_STUDIO_REFUSAL_AR.find(([needle]) => text.includes(needle));
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
// ==========================================
// SOCIAL STUDIO — POSTS SCHEDULER + AUTO-REPLY RULES (studio.js lazy bundle)
// ==========================================
// The "Albayan Studio" screens from the 2026-09 design: linked Facebook /
// Instagram pages, a 24-hour activity card, a post composer with scheduling,
// and a reply-rules engine (keywords, public reply, private message, quiet
// hours, master switch). Everything talks to /api/social-studio; the Meta
// adapter, tokens and the scheduler live on the backend only — this bundle
// never sees an access token and never asks for social-account credentials.
//
// Rendering follows the Ads Studio conventions: bilingual strings through
// adsStudioText(), glass-panel cards, touch-target buttons, RTL-safe logical
// spacing. Form fields carry stable ids and mirror their value into _social so
// the 3-second live-sync re-render never loses what the user is typing.

const SOCIAL_MAX_CAPTION = 2200;
const SOCIAL_MAX_MEDIA = 4;
const SOCIAL_MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const SOCIAL_MAX_KEYWORDS = 30;
const SOCIAL_REFRESH_MS = 30000;
let _socialSessionGeneration = 0;
let _socialComposerGeneration = 0;

const _social = {
  forUser: '',
  loading: false,
  loadedAt: 0,
  error: '',
  settings: null,
  rules: [],
  pages: [],
  posts: [],
  stats: null,
  availablePages: null,
  availableBusy: false,
  linkSheetOpen: false,
  linkOwnerId: '',
  screen: '', // '' | 'compose' | 'post-done' | 'rule'
  postsFilter: 'scheduled',
  platformFilter: 'fb',
  composer: null,
  ruleDraft: null,
  lastDone: null,
  busy: false,
  mediaToken: 0
};

function socialText(en, ar) {
  return adsStudioText(en, ar);
}

function socialEsc(value) {
  return Security.escapeHtml(String(value === null || value === undefined ? '' : value));
}

function captureSocialStudioContext() {
  return { generation: _socialSessionGeneration, identity: getAuthMeIdentity() };
}

function socialStudioContextIsCurrent(context) {
  return context.generation === _socialSessionGeneration && context.identity === getAuthMeIdentity();
}

async function socialApi(path, options = {}, extra = {}) {
  const context = captureSocialStudioContext();
  try {
    const result = await apiJson('/api/social-studio' + path, options, extra);
    if (!socialStudioContextIsCurrent(context)) throw makeSessionChangedError();
    return result;
  } catch (error) {
    if (!socialStudioContextIsCurrent(context)) throw makeSessionChangedError();
    throw error;
  }
}

function socialUnwrap(payload, key) {
  if (!payload) return null;
  if (key && payload[key] !== undefined) return payload[key];
  if (payload.data !== undefined && payload.data !== null && typeof payload.data === 'object' && !Array.isArray(payload.data) && payload.data.id) return payload.data;
  return payload;
}

function socialErrorDetail(error, fallbackEn, fallbackAr) {
  const detail = (error?.payload && error.payload.detail) ? error.payload.detail : (error?.message || '');
  return String(detail || socialText(fallbackEn, fallbackAr));
}

function resetSocialStudioState() {
  _socialSessionGeneration++;
  _socialComposerGeneration++;
  _social.forUser = '';
  _social.loading = false;
  _social.loadedAt = 0;
  _social.error = '';
  _social.settings = null;
  _social.rules = [];
  _social.pages = [];
  _social.posts = [];
  _social.stats = null;
  _social.availablePages = null;
  _social.availableBusy = false;
  _social.linkOwnerId = '';
  _social.linkSheetOpen = false;
  _social.screen = '';
  _social.composer = null;
  _social.ruleDraft = null;
  _social.lastDone = null;
  _social.busy = false;
  _social.mediaToken++;
}

// ---------- loading ----------

function socialStudioAvailable() {
  return isServerModeEnabled() && typeof adsStudioCanUse === 'function' && adsStudioCanUse();
}

async function socialStudioEnsureLoaded(force = false) {
  if (!socialStudioAvailable()) return;
  const uid = String(state.currentUser?.id || '');
  if (!uid) return;
  if (_social.forUser !== uid) { resetSocialStudioState(); _social.forUser = uid; }
  if (_social.loading) return;
  if (!force && _social.loadedAt && Date.now() - _social.loadedAt < SOCIAL_REFRESH_MS) return;
  const context = captureSocialStudioContext();
  _social.loading = true;
  try {
    const [settings, rules, pages, posts, stats] = await Promise.allSettled([
      socialApi('/settings'), socialApi('/rules'), socialApi('/pages'), socialApi('/posts'), socialApi('/stats')
    ]);
    if (!socialStudioContextIsCurrent(context)) return;
    if (settings.status === 'fulfilled') _social.settings = socialUnwrap(settings.value, 'settings') || settings.value;
    if (rules.status === 'fulfilled') _social.rules = Array.isArray(rules.value?.rules) ? rules.value.rules : (Array.isArray(rules.value) ? rules.value : []);
    if (pages.status === 'fulfilled') _social.pages = Array.isArray(pages.value?.pages) ? pages.value.pages : (Array.isArray(pages.value) ? pages.value : []);
    if (posts.status === 'fulfilled') _social.posts = Array.isArray(posts.value?.posts) ? posts.value.posts : (Array.isArray(posts.value) ? posts.value : []);
    if (stats.status === 'fulfilled') _social.stats = stats.value || null;
    const failed = [settings, rules, pages, posts, stats].find(r => r.status === 'rejected');
    _social.error = failed ? socialErrorDetail(failed.reason, 'Some studio data did not load.', 'لم يتم تحميل بعض بيانات الاستوديو.') : '';
    _social.loadedAt = Date.now();
  } finally {
    if (socialStudioContextIsCurrent(context)) {
      _social.loading = false;
      if (state.currentView === 'ads-studio') { try { render(); } catch (_) {} }
    }
  }
}

function socialRefreshNow() {
  _social.loadedAt = 0;
  socialStudioEnsureLoaded(true);
}

// ---------- shared pieces ----------

function socialPlatformShort(platform) {
  return String(platform || '').toLowerCase() === 'ig' ? 'IG' : 'FB';
}

function socialPlatformName(platform) {
  return String(platform || '').toLowerCase() === 'ig' ? 'Instagram' : 'Facebook';
}

function socialPlatformBadge(platform) {
  const ig = String(platform || '').toLowerCase() === 'ig';
  return `<span class="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-extrabold ${ig ? 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'}">${ig ? 'IG' : 'FB'}</span>`;
}

function socialPageById(id) {
  return _social.pages.find(p => p && String(p.id) === String(id)) || null;
}

function socialPageInitial(page) {
  const name = String(page?.name || '?').trim();
  return name ? name.charAt(0).toUpperCase() : '?';
}

function socialPill(label, tone = 'slate') {
  const tones = {
    emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    rose: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
  };
  return `<span class="inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-bold ${tones[tone] || tones.slate}">${label}</span>`;
}

function socialToggle(on, onclick, label) {
  return `<button type="button" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${socialEsc(label || '')}" onclick="${onclick}" class="touch-target relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition-colors ${on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}"><span class="absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'ltr:left-6 rtl:right-6' : 'ltr:left-1 rtl:right-1'}"></span></button>`;
}

function socialFormatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try { return d.toLocaleString(appDateLocale(), { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return d.toLocaleString(); }
}

function socialPostStatusMeta(status) {
  const s = String(status || 'draft');
  if (s === 'scheduled') return { label: socialText('Scheduled', 'مجدول'), tone: 'amber' };
  if (s === 'published') return { label: socialText('Published', 'منشور'), tone: 'emerald' };
  if (s === 'publishing') return { label: socialText('Publishing…', 'جاري النشر…'), tone: 'blue' };
  if (s === 'failed') return { label: socialText('Failed', 'فشل'), tone: 'rose' };
  return { label: socialText('Draft', 'مسودة'), tone: 'slate' };
}

function socialConnectionPill() {
  const stats = _social.stats || {};
  if (stats.connected && stats.webhookConfigured) return socialPill(socialText('Connected', 'متصل'), 'emerald');
  if (stats.connected) return socialPill(socialText('Connected · replies need the Meta webhook', 'متصل · الردود تحتاج ربط الويب هوك'), 'amber');
  return socialPill(socialText('Not connected to Meta yet', 'غير متصل بميتا بعد'), 'slate');
}

function socialRuleTriggerLabel(rule) {
  if (String(rule.trigger || '') === 'keywords') {
    const kws = Array.isArray(rule.keywords) ? rule.keywords : [];
    return `${socialText('Keywords', 'كلمات مفتاحية')}: ${kws.slice(0, 4).map(socialEsc).join(', ')}${kws.length > 4 ? '…' : ''}`;
  }
  return socialText('Every comment', 'كل تعليق');
}

function socialRuleTags(rule) {
  const tags = [];
  if (String(rule.publicReply || '').trim()) tags.push(socialText('Public reply', 'رد عام'));
  if (rule.dmEnabled) tags.push(socialText('Private message', 'رسالة خاصة'));
  if (rule.likeComment) tags.push(socialText('Like', 'إعجاب'));
  if (rule.oncePerPerson) tags.push(socialText('Once per person', 'مرة لكل شخص'));
  if (rule.quietHours) tags.push(socialText('Quiet hours', 'ساعات الهدوء'));
  if (String(rule.scope || 'all') === 'chosen') tags.push(socialText('Chosen posts', 'منشورات محددة'));
  return tags;
}

function socialQuietHoursLabel() {
  const q = _social.settings?.quietHours || {};
  const from = String(q.from || '22:00');
  const to = String(q.to || '08:00');
  return socialText(`Quiet hours ${from} – ${to}`, `ساعات الهدوء ${from} – ${to}`);
}

// ---------- overview section (inside the Ads Studio dashboard) ----------

function renderSocialStudioOverviewSection() {
  if (!socialStudioAvailable()) return '';
  socialStudioEnsureLoaded();
  const isAr = adsStudioIsAr();
  const stats24 = _social.stats?.last24h || {};
  const scheduled = _social.posts.filter(p => String(p.status) === 'scheduled')
    .sort((a, b) => String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || '')));
  const activeRules = _social.rules.filter(r => r && r.enabled !== false).length;
  const master = _social.settings ? _social.settings.masterEnabled !== false : true;
  const isAdmin = isCurrentUserAdmin();
  const pagesHtml = _social.pages.length
    ? _social.pages.map(pg => `
        <div class="flex items-center gap-2 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-800/70 px-3 py-2">
          <span class="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br ${String(pg.platform) === 'ig' ? 'from-pink-500 to-orange-400' : 'from-blue-600 to-cyan-500'} text-white font-bold">${socialEsc(socialPageInitial(pg))}<span class="absolute -bottom-1 -end-1 h-3 w-3 rounded-full border-2 border-white dark:border-slate-800 ${pg.healthy === false ? 'bg-rose-500' : 'bg-emerald-500'}"></span></span>
          <span class="min-w-0"><span class="block max-w-[9rem] truncate text-sm font-bold text-slate-800 dark:text-white">${socialEsc(pg.name || pg.metaPageId)}</span><span class="block text-[11px] text-slate-500">${socialPlatformName(pg.platform)}${pg.healthy === false ? ` · ${socialText('needs attention', 'يحتاج مراجعة')}` : ''}</span></span>
          ${isAdmin ? `<button type="button" onclick="socialUnlinkPage('${socialEsc(pg.id)}')" class="touch-target flex h-9 w-9 items-center justify-center rounded-full text-slate-400 hover:text-rose-600" aria-label="${socialText('Unlink page', 'إلغاء ربط الصفحة')}"><i data-lucide="x" class="w-4 h-4"></i></button>` : ''}
        </div>`).join('')
    : `<div class="text-sm text-slate-500 dark:text-slate-400">${isAdmin
        ? socialText('No pages linked yet. Link a Facebook or Instagram page to start posting and auto-replying.', 'لا توجد صفحات مرتبطة بعد. اربط صفحة فيسبوك أو إنستغرام لبدء النشر والرد التلقائي.')
        : socialText('No pages linked yet. Albayan links your Facebook or Instagram page for you — ask your account manager.', 'لا توجد صفحات مرتبطة بعد. يقوم البيان بربط صفحتك على فيسبوك أو إنستغرام — تواصل مع مدير حسابك.')}</div>`;
  const statCards = [
    [stats24.commentsAnswered, socialText('Comments answered', 'تعليقات تم الرد عليها')],
    [stats24.dmsSent, socialText('Private replies sent', 'رسائل خاصة أُرسلت')],
    [stats24.postsPublished, socialText('Posts published', 'منشورات نُشرت')],
    [stats24.scheduledInQueue ?? scheduled.length, socialText('Scheduled in queue', 'مجدولة في الانتظار')]
  ];
  return `
    <section class="space-y-4" data-social-studio-overview>
      <div class="glass-panel rounded-2xl p-4 sm:p-6">
        <div class="flex items-center justify-between gap-3 mb-3">
          <div><h3 class="font-black text-lg text-slate-900 dark:text-white">${socialText('Linked pages', 'الصفحات المرتبطة')}</h3><p class="text-sm text-slate-500">${socialText('Albayan only reads comments and publishes what you approve.', 'يقرأ البيان التعليقات وينشر ما توافق عليه فقط.')}</p></div>
          ${isAdmin ? `<button type="button" onclick="socialOpenLinkSheet()" class="touch-target min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-700">+ ${socialText('Link a page', 'ربط صفحة')}</button>` : ''}
        </div>
        <div class="flex flex-wrap gap-2">${pagesHtml}</div>
        ${_social.error ? `<div class="mt-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-800 dark:text-amber-200">${socialEsc(_social.error)} <button type="button" onclick="socialRefreshNow()" class="underline font-bold">${socialText('Retry', 'إعادة المحاولة')}</button></div>` : ''}
      </div>

      <div class="glass-panel rounded-2xl p-4 sm:p-6">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h3 class="font-black text-lg text-slate-900 dark:text-white">${socialText('Last 24 hours', 'آخر 24 ساعة')}</h3>
          <div class="flex items-center gap-2">${socialConnectionPill()}<button type="button" onclick="socialRefreshNow()" class="touch-target flex h-10 w-10 items-center justify-center rounded-full text-slate-500 hover:text-blue-600" aria-label="${socialText('Refresh', 'تحديث')}"><i data-lucide="refresh-cw" class="w-4 h-4"></i></button></div>
        </div>
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          ${statCards.map(([value, label]) => `<div class="rounded-2xl bg-slate-50 dark:bg-slate-800/60 p-4"><div class="text-2xl font-black text-slate-900 dark:text-white" dir="ltr">${Number(value) || 0}</div><div class="text-xs text-slate-500 dark:text-slate-400">${label}</div></div>`).join('')}
        </div>
        <div class="mt-3 flex items-center gap-3 text-xs font-bold text-slate-500" dir="ltr">
          <span class="text-blue-600">Facebook · ${Number(stats24.fbShare ?? 50)}%</span>
          <span class="flex-1 h-1.5 rounded-full bg-pink-200 dark:bg-pink-900/40 overflow-hidden"><span class="block h-full bg-blue-500" style="width:${Math.max(0, Math.min(100, Number(stats24.fbShare ?? 50)))}%"></span></span>
          <span class="text-pink-600">Instagram · ${Number(stats24.igShare ?? 50)}%</span>
        </div>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="glass-panel rounded-2xl p-4 sm:p-6">
          <div class="flex items-center justify-between gap-3 mb-3"><h3 class="font-black text-lg text-slate-900 dark:text-white">${socialText('Up next', 'التالي')}</h3><button type="button" onclick="socialOpenPostsTab('scheduled')" class="touch-target min-h-10 px-2 text-sm font-bold text-blue-600">${socialText('See all', 'عرض الكل')}</button></div>
          ${scheduled.length ? `<div class="space-y-2">${scheduled.slice(0, 3).map(po => {
            const pageNames = (Array.isArray(po.pageIds) ? po.pageIds : []).map(id => socialPageById(id)?.name || '').filter(Boolean).join(', ');
            return `<button type="button" onclick="socialOpenPostsTab('scheduled')" class="w-full flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3 text-start touch-target">
              <span class="h-10 w-10 flex-shrink-0 rounded-lg bg-slate-100 dark:bg-slate-800 overflow-hidden flex items-center justify-center text-slate-400">${po.thumbnail ? `<img src="${socialEsc(po.thumbnail)}" alt="" class="h-full w-full object-cover" />` : '<i data-lucide="image" class="w-4 h-4"></i>'}</span>
              <span class="min-w-0 flex-1"><span class="block truncate text-sm font-bold text-slate-800 dark:text-white">${socialEsc(po.caption || socialText('(no caption)', '(بدون نص)'))}</span><span class="block truncate text-[11px] text-slate-500">${socialEsc(pageNames)} · ${socialEsc(socialFormatWhen(po.scheduledAt))}</span></span>
            </button>`;
          }).join('')}</div>` : `<p class="text-sm text-slate-500">${socialText('Nothing scheduled. Create a post and pick a time.', 'لا يوجد شيء مجدول. أنشئ منشوراً واختر وقتاً.')}</p>`}
          <button type="button" onclick="socialBeginCompose()" class="touch-target mt-3 w-full min-h-11 rounded-xl border border-dashed border-blue-300 text-sm font-bold text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20">+ ${socialText('New post', 'منشور جديد')}</button>
        </div>
        <button type="button" onclick="socialOpenRepliesTab()" class="glass-panel rounded-2xl p-4 sm:p-6 text-start flex items-center gap-4 touch-target">
          <span class="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white"><i data-lucide="message-circle-reply" class="w-6 h-6"></i></span>
          <span class="min-w-0 flex-1">
            <span class="block font-black text-lg text-slate-900 dark:text-white">${socialText('Reply rules', 'قواعد الرد')}</span>
            <span class="block text-sm text-slate-500">${master
              ? socialText(`${activeRules} active · auto-reply is on`, `${activeRules} نشطة · الرد التلقائي مفعّل`)
              : socialText('Auto-reply is paused', 'الرد التلقائي متوقف')}</span>
          </span>
          <i data-lucide="${isAr ? 'chevron-left' : 'chevron-right'}" class="w-5 h-5 text-slate-400"></i>
        </button>
      </div>
      ${_social.linkSheetOpen ? renderSocialLinkSheet() : ''}
    </section>`;
}

// ---------- link page sheet (Admin) ----------

function socialOpenLinkSheet() {
  if (!isCurrentUserAdmin()) return;
  const context = captureSocialStudioContext();
  _social.linkSheetOpen = true;
  _social.linkOwnerId = _social.linkOwnerId || String(state.currentUser?.id || '');
  if (_social.availablePages === null && !_social.availableBusy) {
    _social.availableBusy = true;
    socialApi('/pages/available').then(res => {
      if (!socialStudioContextIsCurrent(context)) return;
      _social.availablePages = Array.isArray(res?.pages) ? res.pages : [];
    }).catch(e => {
      if (!socialStudioContextIsCurrent(context)) return;
      _social.availablePages = [];
      showNotification(socialText('Meta pages unavailable', 'صفحات ميتا غير متاحة'), socialErrorDetail(e, 'Connect Meta on the server first.', 'اربط ميتا على الخادم أولاً.'), 'warning');
    }).finally(() => { if (socialStudioContextIsCurrent(context)) { _social.availableBusy = false; render(); } });
  }
  render();
}

function socialCloseLinkSheet() {
  _social.linkSheetOpen = false;
  render();
}

function socialSetLinkOwner(value) {
  _social.linkOwnerId = String(value || '');
}

function socialLinkOwnerOptions() {
  const users = Array.isArray(state.users) ? state.users : [];
  const me = String(state.currentUser?.id || '');
  const rows = users.filter(u => u && !u._deleted && u.id && (String(u.id) === me || (typeof SUBSCRIPTIONS !== 'undefined' && SUBSCRIPTIONS.isActive(String(u.id), 'ad_maker'))));
  if (!rows.some(u => String(u.id) === me) && state.currentUser) rows.unshift(state.currentUser);
  return rows;
}

function renderSocialLinkSheet() {
  const isAr = adsStudioIsAr();
  const available = Array.isArray(_social.availablePages) ? _social.availablePages.filter(p => !p.alreadyLinked) : [];
  const owners = socialLinkOwnerOptions();
  return `
    <div class="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 backdrop-blur-sm p-0 sm:items-center sm:p-4" onclick="socialCloseLinkSheet()">
      <div class="w-full max-w-lg rounded-t-3xl sm:rounded-2xl bg-white dark:bg-slate-900 p-5 max-h-[90dvh] overflow-y-auto custom-scrollbar" onclick="event.stopPropagation()" role="dialog" aria-modal="true" dir="${isAr ? 'rtl' : 'ltr'}">
        <div class="flex items-center justify-between gap-3 mb-4"><h3 class="text-lg font-extrabold text-slate-900 dark:text-white">${socialText('Link a page', 'ربط صفحة')}</h3><button type="button" onclick="socialCloseLinkSheet()" class="touch-target flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800" aria-label="${socialText('Close', 'إغلاق')}"><i data-lucide="x" class="w-4 h-4"></i></button></div>
        <label class="block text-xs font-bold text-slate-500 mb-1" for="social-link-owner">${socialText('Link for customer', 'الربط لصالح العميل')}</label>
        <select id="social-link-owner" onchange="socialSetLinkOwner(this.value)" class="w-full glass-input rounded-xl px-3 py-2.5 mb-4 text-sm">
          ${owners.map(u => `<option value="${socialEsc(u.id)}" ${String(u.id) === _social.linkOwnerId ? 'selected' : ''}>${socialEsc(u.name || u.email || u.id)}</option>`).join('')}
        </select>
        <div class="text-xs font-bold uppercase tracking-[0.06em] text-slate-400 mb-2">${socialText('Pages on the Albayan Meta account', 'الصفحات في حساب ميتا الخاص بالبيان')}</div>
        ${_social.availableBusy || _social.availablePages === null ? `<div class="py-6 text-center text-sm text-slate-500"><div class="w-6 h-6 mx-auto mb-2 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>${socialText('Loading pages…', 'جاري تحميل الصفحات…')}</div>`
          : available.length ? `<div class="space-y-2">${available.map(pg => `
            <div class="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3">
              <span class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${String(pg.platform) === 'ig' ? 'from-pink-500 to-orange-400' : 'from-blue-600 to-cyan-500'} text-white font-bold">${socialEsc(String(pg.name || '?').charAt(0).toUpperCase())}</span>
              <span class="min-w-0 flex-1"><span class="block truncate text-sm font-bold text-slate-800 dark:text-white">${socialEsc(pg.name || pg.metaPageId)}</span><span class="block text-[11px] text-slate-500">${socialPlatformName(pg.platform)} · <span dir="ltr">${socialEsc(pg.metaPageId)}</span></span></span>
              <button type="button" data-meta-page-id="${socialEsc(pg.metaPageId)}" data-platform="${socialEsc(pg.platform)}" data-ig-user-id="${socialEsc(pg.igUserId || '')}" onclick="socialLinkPage(this.dataset.metaPageId, this.dataset.platform, this.dataset.igUserId)" ${_social.busy ? 'disabled' : ''} class="touch-target min-h-10 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50">${socialText('Link', 'ربط')}</button>
            </div>`).join('')}</div>`
          : `<div class="py-6 text-center text-sm text-slate-500">${socialText('All available pages are linked, or Meta is not connected on the server yet.', 'كل الصفحات المتاحة مرتبطة، أو أن ميتا غير متصلة على الخادم بعد.')}</div>`}
        <p class="mt-4 text-[11px] text-slate-500">${socialText('Albayan only reads comments and publishes what you approve. Unlink any time.', 'يقرأ البيان التعليقات وينشر ما توافق عليه فقط. يمكنك إلغاء الربط في أي وقت.')}</p>
      </div>
    </div>`;
}

async function socialLinkPage(metaPageId, platform, igUserId) {
  if (_social.busy) return;
  const context = captureSocialStudioContext();
  const entry = (Array.isArray(_social.availablePages) ? _social.availablePages : []).find(p => String(p.metaPageId) === String(metaPageId) && String(p.platform) === String(platform));
  _social.busy = true;
  render();
  try {
    await socialApi('/pages/link', { method: 'POST', body: { ownerId: _social.linkOwnerId || String(state.currentUser?.id || ''), metaPageId: String(metaPageId), platform: String(platform), name: entry?.name || '', igUserId: String(igUserId || '') } });
    if (!socialStudioContextIsCurrent(context)) return;
    showNotification(socialText('Page linked', 'تم ربط الصفحة'), entry?.name || '', 'success');
    _social.availablePages = null;
    _social.linkSheetOpen = false;
    socialRefreshNow();
  } catch (e) {
    if (!socialStudioContextIsCurrent(context)) return;
    showNotification(socialText('Could not link the page', 'تعذر ربط الصفحة'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    if (socialStudioContextIsCurrent(context)) { _social.busy = false; render(); }
  }
}

async function socialUnlinkPage(pageId) {
  const context = captureSocialStudioContext();
  const page = socialPageById(pageId);
  if (!page) return;
  const ok = confirm(socialText(`Unlink "${page.name}"? Scheduled posts for this page will stop and its reply rules will no longer run.`, `إلغاء ربط "${page.name}"؟ ستتوقف المنشورات المجدولة لهذه الصفحة ولن تعمل قواعد الرد الخاصة بها.`));
  if (!ok) return;
  try {
    await socialApi(`/pages/${encodeURIComponent(pageId)}/unlink`, { method: 'POST', body: {} });
    if (!socialStudioContextIsCurrent(context)) return;
    showNotification(socialText('Page unlinked', 'تم إلغاء ربط الصفحة'), '', 'success');
    socialRefreshNow();
  } catch (e) {
    if (!socialStudioContextIsCurrent(context)) return;
    showNotification(socialText('Could not unlink', 'تعذر إلغاء الربط'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  }
}

// ---------- posts tab ----------

function socialOpenPostsTab(filter) {
  _socialComposerGeneration++;
  if (filter) _social.postsFilter = filter;
  _social.screen = '';
  setAdsStudioTab('posts');
}

function socialOpenRepliesTab() {
  _socialComposerGeneration++;
  _social.screen = '';
  setAdsStudioTab('replies');
}

function socialSetPostsFilter(filter) {
  _social.postsFilter = String(filter || 'scheduled');
  render();
}

function renderSocialStudioPostsTab() {
  if (!socialStudioAvailable()) return renderSocialStudioUnavailable();
  socialStudioEnsureLoaded();
  if (_social.screen === 'compose') return renderSocialComposer();
  if (_social.screen === 'post-done') return renderSocialPostDone();
  const isAr = adsStudioIsAr();
  const chips = [
    ['scheduled', socialText('Scheduled', 'مجدولة')],
    ['published', socialText('Published', 'منشورة')],
    ['draft', socialText('Drafts', 'مسودات')]
  ];
  const failedCount = _social.posts.filter(p => String(p.status) === 'failed').length;
  if (failedCount) chips.push(['failed', socialText(`Failed (${failedCount})`, `فشلت (${failedCount})`)]);
  const filter = _social.postsFilter;
  const rows = _social.posts.filter(p => {
    const s = String(p.status || 'draft');
    if (filter === 'scheduled') return s === 'scheduled' || s === 'publishing';
    return s === filter;
  }).sort((a, b) => {
    const ka = String(a.scheduledAt || a.publishedAt || a.updatedAt || '');
    const kb = String(b.scheduledAt || b.publishedAt || b.updatedAt || '');
    return filter === 'scheduled' ? ka.localeCompare(kb) : kb.localeCompare(ka);
  });
  return `
    <section class="max-w-3xl mx-auto space-y-4">
      <div class="flex items-center justify-between gap-3">
        <div class="flex gap-2 overflow-x-auto custom-scrollbar pb-1">
          ${chips.map(([id, label]) => `<button type="button" onclick="socialSetPostsFilter('${id}')" class="touch-target min-h-10 whitespace-nowrap rounded-full px-4 text-sm font-bold ${filter === id ? 'bg-blue-600 text-white' : 'bg-white/70 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300 border border-white/60 dark:border-slate-700'}">${label}</button>`).join('')}
        </div>
        <button type="button" onclick="socialBeginCompose()" class="touch-target min-h-11 flex-shrink-0 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-700">+ ${socialText('New post', 'منشور جديد')}</button>
      </div>
      ${_social.loading && !_social.loadedAt ? `<div class="glass-panel rounded-2xl p-8 text-center text-sm text-slate-500"><div class="w-6 h-6 mx-auto mb-2 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>${socialText('Loading posts…', 'جاري تحميل المنشورات…')}</div>`
        : rows.length ? `<div class="space-y-3">${rows.map(renderSocialPostCard).join('')}</div>`
        : `<div class="glass-panel rounded-2xl p-8 text-center"><i data-lucide="send" class="w-10 h-10 mx-auto text-slate-300 mb-3"></i><p class="font-bold text-slate-800 dark:text-white">${socialText('No posts here yet', 'لا توجد منشورات هنا بعد')}</p><p class="text-sm text-slate-500 mt-1">${socialText('Write a post, pick your pages and publish now or schedule it.', 'اكتب منشوراً واختر صفحاتك وانشره الآن أو جدوله.')}</p></div>`}
    </section>`;
}

function renderSocialPostCard(po) {
  const isAr = adsStudioIsAr();
  const status = String(po.status || 'draft');
  const meta = socialPostStatusMeta(status);
  const pages = (Array.isArray(po.pageIds) ? po.pageIds : []).map(id => socialPageById(id)).filter(Boolean);
  const editable = ['draft', 'scheduled', 'failed'].includes(status);
  const when = status === 'published' ? socialFormatWhen(po.publishedAt) : status === 'scheduled' ? socialFormatWhen(po.scheduledAt) : socialFormatWhen(po.updatedAt || po.createdAt);
  const results = Array.isArray(po.results) ? po.results : [];
  const okResults = results.filter(r => r && r.metaPostId);
  const safeId = socialEsc(po.id);
  return `
    <div class="glass-panel rounded-2xl p-4">
      <div class="flex items-start gap-3">
        <span class="h-14 w-14 flex-shrink-0 rounded-xl bg-slate-100 dark:bg-slate-800 overflow-hidden flex items-center justify-center text-slate-400">${po.thumbnail ? `<img src="${socialEsc(po.thumbnail)}" alt="" class="h-full w-full object-cover" />` : '<i data-lucide="image" class="w-5 h-5"></i>'}</span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-1.5 mb-1">${pages.map(pg => `<span class="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 dark:text-slate-300">${socialPlatformBadge(pg.platform)}${socialEsc(pg.name)}</span>`).join('') || `<span class="text-[11px] text-slate-400">${socialText('No page', 'بدون صفحة')}</span>`}</div>
          <p class="text-sm text-slate-800 dark:text-white whitespace-pre-line line-clamp-3">${socialEsc(po.caption || socialText('(no caption)', '(بدون نص)'))}</p>
          <div class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span>${socialEsc(when)}</span>
            ${Number(po.mediaCount) > 0 ? `<span>· ${Number(po.mediaCount)} ${socialText('photos', 'صور')}</span>` : ''}
            ${po.autoReplyRuleId ? socialPill(socialText('Auto-reply', 'رد تلقائي'), 'blue') : ''}
            ${socialPill(meta.label, meta.tone)}
          </div>
          ${status === 'failed' && po.lastError ? `<div class="mt-2 rounded-lg bg-rose-50 dark:bg-rose-900/20 p-2 text-[11px] text-rose-700 dark:text-rose-300">${socialEsc(po.lastError)}</div>` : ''}
          ${status === 'scheduled' && po.lastError ? `<div class="mt-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 p-2 text-[11px] text-amber-700 dark:text-amber-300">${socialText('Retrying automatically', 'إعادة المحاولة تلقائياً')} · ${socialEsc(po.lastError)}</div>` : ''}
          ${status === 'published' && okResults.length ? `<div class="mt-2 flex flex-wrap gap-2">${okResults.map(r => { const pg = socialPageById(r.pageId); return String(pg?.platform) === 'ig' ? '' : `<a href="https://www.facebook.com/${encodeURIComponent(String(r.metaPostId))}" target="_blank" rel="noopener noreferrer" class="text-[11px] font-bold text-blue-600 underline">${socialText('View on Facebook', 'عرض على فيسبوك')}${pg ? ` · ${socialEsc(pg.name)}` : ''}</a>`; }).join('')}</div>` : ''}
        </div>
      </div>
      ${editable ? `<div class="mt-3 flex flex-wrap gap-2">
        <button type="button" onclick="socialEditPost('${safeId}')" class="touch-target min-h-10 rounded-lg bg-slate-100 dark:bg-slate-800 px-3 text-xs font-bold text-slate-700 dark:text-slate-200">${socialText('Edit', 'تعديل')}</button>
        ${status === 'scheduled' ? `<button type="button" onclick="socialCancelPost('${safeId}')" class="touch-target min-h-10 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 text-xs font-bold text-amber-700 dark:text-amber-300">${socialText('Cancel schedule', 'إلغاء الجدولة')}</button>` : `<button type="button" onclick="socialPublishPost('${safeId}')" class="touch-target min-h-10 rounded-lg bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-700">${socialText('Publish now', 'انشر الآن')}</button>`}
        <button type="button" onclick="socialDeletePost('${safeId}')" class="touch-target min-h-10 rounded-lg bg-rose-50 dark:bg-rose-900/20 px-3 text-xs font-bold text-rose-600">${socialText('Delete', 'حذف')}</button>
      </div>` : ''}
    </div>`;
}

// ---------- composer ----------

function socialNewComposer() {
  const firstPage = _social.pages[0];
  return { id: '', pageIds: firstPage ? [String(firstPage.id)] : [], caption: '', media: [], mode: 'now', scheduledAt: '', autoReply: false, autoReplyRuleId: '' };
}

function socialBeginCompose() {
  _socialComposerGeneration++;
  _social.composer = socialNewComposer();
  _social.screen = 'compose';
  if (_adsStudioActiveTab !== 'posts') setAdsStudioTab('posts'); else render();
}

async function socialEditPost(postId) {
  const summary = _social.posts.find(p => String(p.id) === String(postId));
  if (!summary) return;
  const context = captureSocialStudioContext();
  const generation = ++_socialComposerGeneration;
  const isCurrent = () => socialStudioContextIsCurrent(context) && generation === _socialComposerGeneration;
  let full = summary;
  let mediaUnknown = false;
  try {
    const res = await socialApi(`/posts/${encodeURIComponent(postId)}`);
    full = socialUnwrap(res, 'post') || summary;
  } catch (_) { mediaUnknown = true; /* Same-session network failure may use the lightweight summary. */ }
  if (!isCurrent()) return;
  const scheduled = String(full.status) === 'scheduled' && full.scheduledAt;
  _social.composer = {
    id: String(full.id),
    pageIds: (Array.isArray(full.pageIds) ? full.pageIds : []).map(String),
    caption: String(full.caption || ''),
    media: Array.isArray(full.media) ? full.media.slice() : [],
    // The summary carries no photos; a save from it must not erase them.
    mediaUnknown: mediaUnknown && !(Array.isArray(full.media) && full.media.length),
    mode: scheduled ? 'schedule' : 'now',
    scheduledAt: scheduled ? socialIsoToLocalInput(full.scheduledAt) : '',
    autoReply: !!full.autoReplyRuleId,
    autoReplyRuleId: String(full.autoReplyRuleId || '')
  };
  _social.screen = 'compose';
  render();
}

function socialIsoToLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function socialMinScheduleInput() {
  return socialIsoToLocalInput(new Date(Date.now() + 5 * 60000).toISOString());
}

function socialComposerSet(field, value) {
  if (!_social.composer) return;
  _social.composer[field] = value;
  if (field === 'caption') {
    const counter = document.getElementById('social-caption-count');
    if (counter) counter.textContent = `${String(value || '').length} / ${SOCIAL_MAX_CAPTION}`;
  }
}

function socialComposerTogglePage(pageId) {
  if (!_social.composer) return;
  const id = String(pageId);
  const set = new Set(_social.composer.pageIds);
  if (set.has(id)) set.delete(id); else set.add(id);
  _social.composer.pageIds = Array.from(set);
  render();
}

function socialComposerMode(mode) {
  if (!_social.composer) return;
  _social.composer.mode = mode === 'schedule' ? 'schedule' : 'now';
  if (_social.composer.mode === 'schedule' && !_social.composer.scheduledAt) _social.composer.scheduledAt = socialIsoToLocalInput(new Date(Date.now() + 60 * 60000).toISOString());
  render();
}

function socialComposerToggleAutoReply() {
  if (!_social.composer) return;
  _social.composer.autoReply = !_social.composer.autoReply;
  if (_social.composer.autoReply && !_social.composer.autoReplyRuleId) {
    const first = socialRulesForComposer()[0];
    _social.composer.autoReplyRuleId = first ? String(first.id) : '';
  }
  render();
}

function socialRulesForComposer() {
  const platforms = new Set((_social.composer?.pageIds || []).map(id => String(socialPageById(id)?.platform || 'fb')));
  return _social.rules.filter(r => r && r.enabled !== false && (!platforms.size || platforms.has(String(r.platform || 'fb'))));
}

function socialComposerRemoveMedia(index) {
  if (!_social.composer) return;
  _social.composer.media.splice(index, 1);
  render();
}

async function socialComposerAddFiles(fileList) {
  const context = captureSocialStudioContext();
  const draft = _social.composer;
  if (!draft) return;
  const files = Array.from(fileList || []).filter(file => {
    const t = String(file?.type || '').toLowerCase();
    return !t || t === 'application/octet-stream' || ADS_STUDIO_ALLOWED_IMAGE_MIME_TYPES.has(t);
  });
  if (!files.length) {
    showNotification(socialText('Unsupported image', 'صيغة صورة غير مدعومة'), socialText('Use PNG, JPEG or WebP images only.', 'استخدم صور PNG أو JPEG أو WebP فقط.'), 'warning');
    return;
  }
  const room = Math.max(0, SOCIAL_MAX_MEDIA - draft.media.length);
  if (!room) {
    showNotification(socialText('Photo limit', 'حد الصور'), socialText(`Up to ${SOCIAL_MAX_MEDIA} photos per post.`, `حتى ${SOCIAL_MAX_MEDIA} صور لكل منشور.`), 'warning');
    return;
  }
  const token = ++_social.mediaToken;
  try {
    const out = [];
    for (const file of files.slice(0, room)) {
      const dataUrl = await compressImageToDataUrl(file);
      if (!socialStudioContextIsCurrent(context) || token !== _social.mediaToken || _social.composer !== draft) return;
      if (!isSafeAdsStudioCreativeSource(dataUrl)) throw new Error('unsupported output');
      out.push(dataUrl);
    }
    if (token !== _social.mediaToken || _social.composer !== draft) return;
    const next = draft.media.concat(out);
    const total = next.reduce((sum, src) => sum + adsStudioDataUrlDecodedBytes(src), 0);
    if (total > SOCIAL_MAX_MEDIA_BYTES) {
      showNotification(socialText('Images too large', 'الصور كبيرة جداً'), socialText('Combined photos must be 5 MB or less after compression.', 'يجب ألا يتجاوز الحجم الإجمالي للصور 5 ميجابايت بعد الضغط.'), 'error');
      return;
    }
    draft.media = next;
    render();
  } catch (_) {
    if (!socialStudioContextIsCurrent(context) || token !== _social.mediaToken || _social.composer !== draft) return;
    showNotification(socialText('Upload failed', 'تعذر رفع الصورة'), socialText('Please choose another image.', 'يرجى اختيار صورة أخرى.'), 'error');
  }
}

function socialComposerValidate() {
  const c = _social.composer;
  if (!c) return socialText('Nothing to save.', 'لا يوجد ما يُحفظ.');
  if (!c.pageIds.length) return socialText('Pick at least one page.', 'اختر صفحة واحدة على الأقل.');
  if (!String(c.caption || '').trim() && !c.media.length) return socialText('Write a caption or add a photo.', 'اكتب نصاً أو أضف صورة.');
  if (String(c.caption || '').length > SOCIAL_MAX_CAPTION) return socialText(`Caption is over ${SOCIAL_MAX_CAPTION} characters.`, `النص يتجاوز ${SOCIAL_MAX_CAPTION} حرفاً.`);
  const igPages = c.pageIds.map(id => socialPageById(id)).filter(pg => pg && String(pg.platform) === 'ig');
  if (igPages.length && !c.media.length) return socialText('Instagram posts need at least one photo.', 'منشورات إنستغرام تحتاج صورة واحدة على الأقل.');
  if (c.mode === 'schedule') {
    const t = new Date(c.scheduledAt).getTime();
    if (!c.scheduledAt || Number.isNaN(t)) return socialText('Pick a date and time.', 'اختر التاريخ والوقت.');
    if (t < Date.now() + 60000) return socialText('The scheduled time must be in the future.', 'يجب أن يكون وقت الجدولة في المستقبل.');
  }
  return '';
}

function socialComposerBody(statusWanted, c = _social.composer) {
  const body = {
    pageIds: c.pageIds.slice(),
    caption: String(c.caption || ''),
    status: statusWanted,
    scheduledAt: statusWanted === 'scheduled' ? new Date(c.scheduledAt).toISOString() : '',
    autoReplyRuleId: c.autoReply ? String(c.autoReplyRuleId || '') : ''
  };
  // Omitting `media` keeps the server's photos; sending [] would delete them.
  if (!(c.mediaUnknown && !c.media.length)) body.media = c.media.slice();
  return body;
}

function socialComposerFingerprint(c) {
  return JSON.stringify([c.pageIds, c.caption, c.media, c.mode, c.scheduledAt, c.autoReply, c.autoReplyRuleId]);
}

async function socialComposerSave(action) {
  // action: 'draft' | 'schedule' | 'now'
  if (_social.busy || !_social.composer) return;
  const context = captureSocialStudioContext();
  const draft = _social.composer;
  const generation = _socialComposerGeneration;
  const fingerprint = socialComposerFingerprint(draft);
  const sameDraft = () => socialStudioContextIsCurrent(context) && _social.composer === draft && generation === _socialComposerGeneration;
  const isCurrent = () => sameDraft() && fingerprint === socialComposerFingerprint(draft);
  const problem = action === 'draft' && !_social.composer.pageIds.length ? '' : socialComposerValidate();
  if (problem) { showNotification(socialText('Check the post', 'راجع المنشور'), problem, 'warning'); return; }
  const wanted = action === 'schedule' ? 'scheduled' : 'draft';
  _social.busy = true;
  render();
  try {
    const body = socialComposerBody(wanted, draft);
    let saved;
    if (draft.id) {
      saved = socialUnwrap(await socialApi(`/posts/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 'post');
    } else {
      saved = socialUnwrap(await socialApi('/posts', { method: 'POST', body }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 'post');
    }
    if (!sameDraft()) return;
    const postId = String(saved?.id || draft.id || '');
    // If publishing fails after creation, retry the same saved post rather
    // than creating another copy from a draft that still has an empty id.
    if (postId) draft.id = postId;
    if (!isCurrent()) {
      // The user kept editing while the save was in flight. The server holds
      // the pre-edit body; say so instead of vanishing, and keep the newer
      // text in the editor so one more Save sends it (and publishes, if asked).
      if (sameDraft()) showNotification(socialText('Saved as a draft', 'تم الحفظ كمسودة'), socialText('You kept typing while it was saving, so your newer edits are still here. Save again to send them.', 'واصلت الكتابة أثناء الحفظ، فبقيت تعديلاتك الأحدث هنا. احفظ مرة أخرى لإرسالها.'), 'info');
      return;
    }
    if (action === 'now' && postId) {
      saved = socialUnwrap(await socialApi(`/posts/${encodeURIComponent(postId)}/publish`, { method: 'POST', body: {} }, { timeoutMs: 120000 /* a multi-page publish under Meta pacing takes longer than 20 s */ }), 'post') || saved;
    }
    // The post is saved (and published when asked): show the result even if a
    // keystroke landed meanwhile — hiding a publish that happened is worse.
    if (!sameDraft()) return;
    _social.lastDone = { action, post: saved || {}, pageNames: draft.pageIds.map(id => socialPageById(id)?.name || '').filter(Boolean), mediaCount: draft.media.length, ruleName: draft.autoReply ? (_social.rules.find(r => String(r.id) === String(draft.autoReplyRuleId))?.name || '') : '' };
    _social.composer = null;
    _social.screen = 'post-done';
    socialRefreshNow();
  } catch (e) {
    if (!isCurrent()) return;
    showNotification(socialText('Could not save the post', 'تعذر حفظ المنشور'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    if (socialStudioContextIsCurrent(context)) { _social.busy = false; render(); }
  }
}

function socialComposerClose() {
  _socialComposerGeneration++;
  _social.composer = null;
  _social.screen = '';
  render();
}

function renderSocialComposer() {
  const c = _social.composer || socialNewComposer();
  const isAr = adsStudioIsAr();
  const rules = socialRulesForComposer();
  const ruleName = rules.find(r => String(r.id) === String(c.autoReplyRuleId))?.name || '';
  return `
    <section class="max-w-2xl mx-auto space-y-5">
      <div class="flex items-center gap-3">
        <button type="button" onclick="socialComposerClose()" class="touch-target flex h-11 w-11 items-center justify-center rounded-full bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700" aria-label="${socialText('Back', 'رجوع')}"><i data-lucide="${isAr ? 'chevron-right' : 'chevron-left'}" class="w-5 h-5"></i></button>
        <h2 class="text-2xl font-extrabold text-slate-900 dark:text-white">${c.id ? socialText('Edit post', 'تعديل المنشور') : socialText('New post', 'منشور جديد')}</h2>
      </div>

      <div class="glass-panel rounded-2xl p-4 sm:p-5 space-y-5">
        <div>
          <div class="text-xs font-bold uppercase tracking-[0.06em] text-slate-400 mb-2">${socialText('Publish to', 'النشر على')}</div>
          ${_social.pages.length ? `<div class="flex flex-wrap gap-2">${_social.pages.map(pg => { const on = c.pageIds.includes(String(pg.id)); return `<button type="button" onclick="socialComposerTogglePage('${socialEsc(pg.id)}')" aria-pressed="${on}" class="touch-target inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-bold ${on ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'}">${socialPlatformBadge(pg.platform)}${socialEsc(pg.name)}</button>`; }).join('')}</div>`
            : `<div class="rounded-xl bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200">${socialText('No linked pages yet — link a page from the Overview first.', 'لا توجد صفحات مرتبطة — اربط صفحة من نظرة عامة أولاً.')}</div>`}
        </div>

        <div>
          <label for="social-caption" class="block text-xs font-bold uppercase tracking-[0.06em] text-slate-400 mb-2">${socialText('Caption', 'النص')}</label>
          <textarea id="social-caption" rows="5" maxlength="${SOCIAL_MAX_CAPTION}" oninput="socialComposerSet('caption', this.value)" placeholder="${socialText('Write your post…', 'اكتب منشورك…')}" class="w-full glass-input rounded-xl px-4 py-3 text-sm leading-6">${socialEsc(c.caption)}</textarea>
          <div id="social-caption-count" class="mt-1 text-end text-[11px] text-slate-400" dir="ltr">${String(c.caption || '').length} / ${SOCIAL_MAX_CAPTION}</div>
        </div>

        <div>
          <div class="text-xs font-bold uppercase tracking-[0.06em] text-slate-400 mb-2">${socialText('Media', 'الوسائط')}</div>
          <div class="flex flex-wrap gap-2">
            ${c.media.map((src, i) => `<span class="relative h-20 w-20 rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-800"><img src="${socialEsc(src)}" alt="" class="h-full w-full object-cover" /><button type="button" onclick="socialComposerRemoveMedia(${i})" class="touch-target absolute top-1 end-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white" aria-label="${socialText('Remove photo', 'إزالة الصورة')}"><i data-lucide="x" class="w-3.5 h-3.5"></i></button></span>`).join('')}
            ${c.media.length < SOCIAL_MAX_MEDIA ? `<label class="touch-target flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 text-xs font-bold text-slate-500"><i data-lucide="plus" class="w-5 h-5"></i>${socialText('Add', 'إضافة')}<input type="file" accept="image/png,image/jpeg,image/webp" multiple class="hidden" onchange="socialComposerAddFiles(this.files); this.value = '';" /></label>` : ''}
          </div>
          <p class="mt-1 text-[11px] text-slate-400">${socialText(`Up to ${SOCIAL_MAX_MEDIA} photos · PNG, JPEG or WebP. Instagram needs at least one photo.`, `حتى ${SOCIAL_MAX_MEDIA} صور · PNG أو JPEG أو WebP. إنستغرام يحتاج صورة واحدة على الأقل.`)}</p>
        </div>

        <div>
          <div class="text-xs font-bold uppercase tracking-[0.06em] text-slate-400 mb-2">${socialText('When', 'التوقيت')}</div>
          <div class="grid grid-cols-2 gap-2">
            <button type="button" onclick="socialComposerMode('now')" class="touch-target min-h-11 rounded-xl text-sm font-bold ${c.mode === 'now' ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'}">${socialText('Publish now', 'انشر الآن')}</button>
            <button type="button" onclick="socialComposerMode('schedule')" class="touch-target min-h-11 rounded-xl text-sm font-bold ${c.mode === 'schedule' ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'}">${socialText('Schedule', 'جدولة')}</button>
          </div>
          ${c.mode === 'schedule' ? `<div class="mt-3"><label for="social-schedule-at" class="block text-xs text-slate-500 mb-1">${socialText('Date & time', 'التاريخ والوقت')}</label><input id="social-schedule-at" type="datetime-local" value="${socialEsc(c.scheduledAt)}" min="${socialMinScheduleInput()}" oninput="socialComposerSet('scheduledAt', this.value)" class="w-full glass-input rounded-xl px-4 py-3 text-sm" dir="ltr" /></div>` : ''}
        </div>

        <div class="rounded-2xl border border-slate-200 dark:border-slate-700 p-3">
          <div class="flex items-center justify-between gap-3">
            <div><div class="text-sm font-bold text-slate-800 dark:text-white">${socialText('Auto-reply on this post', 'رد تلقائي على هذا المنشور')}</div><div class="text-[11px] text-slate-500">${socialText('Comments on this post follow the chosen rule.', 'تعليقات هذا المنشور تتبع القاعدة المختارة.')}</div></div>
            ${socialToggle(c.autoReply, 'socialComposerToggleAutoReply()', socialText('Auto-reply on this post', 'رد تلقائي على هذا المنشور'))}
          </div>
          ${c.autoReply ? (rules.length ? `<div class="mt-3"><label for="social-post-rule" class="block text-xs text-slate-500 mb-1">${socialText('Rule', 'القاعدة')}</label><select id="social-post-rule" onchange="socialComposerSet('autoReplyRuleId', this.value)" class="w-full glass-input rounded-xl px-3 py-2.5 text-sm">${rules.map(r => `<option value="${socialEsc(r.id)}" ${String(r.id) === String(c.autoReplyRuleId) ? 'selected' : ''}>${socialPlatformShort(r.platform)} · ${socialEsc(r.name)}</option>`).join('')}</select></div>`
            : `<div class="mt-3 text-xs text-amber-700 dark:text-amber-300">${socialText('No rules for these pages yet — create one in Replies.', 'لا توجد قواعد لهذه الصفحات بعد — أنشئ واحدة في الردود.')}</div>`) : ''}
          ${c.autoReply && ruleName ? `<div class="mt-2 text-[11px] text-slate-500">${socialEsc(ruleName)}</div>` : ''}
        </div>
      </div>

      <div class="grid gap-2 sm:grid-cols-[1fr_auto]">
        <button type="button" onclick="socialComposerSave('${c.mode === 'schedule' ? 'schedule' : 'now'}')" ${_social.busy || !_social.pages.length ? 'disabled' : ''} class="touch-target min-h-14 rounded-2xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-base font-bold text-white btn-shine">${_social.busy ? socialText('Working…', 'جاري العمل…') : (c.mode === 'schedule' ? socialText('Schedule post', 'جدولة المنشور') : socialText('Publish now', 'انشر الآن'))}</button>
        <button type="button" onclick="socialComposerSave('draft')" ${_social.busy ? 'disabled' : ''} class="touch-target min-h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 px-6 text-sm font-bold text-slate-700 dark:text-slate-200 disabled:opacity-50">${socialText('Save draft', 'حفظ كمسودة')}</button>
      </div>
    </section>`;
}

function renderSocialPostDone() {
  const done = _social.lastDone || {};
  const isAr = adsStudioIsAr();
  const post = done.post || {};
  const status = String(post.status || (done.action === 'schedule' ? 'scheduled' : done.action === 'now' ? 'published' : 'draft'));
  const failed = status === 'failed';
  const title = failed ? socialText('Publishing failed', 'فشل النشر') : status === 'scheduled' ? socialText('Post scheduled', 'تمت جدولة المنشور') : status === 'published' ? socialText('Post published', 'تم نشر المنشور') : status === 'publishing' ? socialText('Publishing…', 'جاري النشر…') : socialText('Draft saved', 'تم حفظ المسودة');
  return `
    <section class="max-w-md mx-auto text-center py-6">
      <span class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full ${failed ? 'bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-300' : 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300'}"><i data-lucide="${failed ? 'alert-triangle' : 'check'}" class="w-8 h-8"></i></span>
      <h2 class="text-2xl font-extrabold text-slate-900 dark:text-white">${title}</h2>
      <p class="mt-1 text-sm text-slate-500">${socialEsc((done.pageNames || []).join(', '))}</p>
      ${failed && post.lastError ? `<p class="mt-3 rounded-xl bg-rose-50 dark:bg-rose-900/20 p-3 text-xs text-rose-700 dark:text-rose-300 text-start">${socialEsc(post.lastError)}</p>` : ''}
      <div class="mt-5 rounded-2xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700 text-sm text-start">
        <div class="flex items-center justify-between gap-3 px-4 py-3"><span class="text-slate-500">${socialText('When', 'التوقيت')}</span><span class="font-bold text-slate-900 dark:text-white">${status === 'scheduled' ? socialEsc(socialFormatWhen(post.scheduledAt)) : status === 'published' ? socialText('Now', 'الآن') : '—'}</span></div>
        <div class="flex items-center justify-between gap-3 px-4 py-3"><span class="text-slate-500">${socialText('Auto-reply', 'رد تلقائي')}</span><span class="font-bold text-slate-900 dark:text-white">${done.ruleName ? socialEsc(done.ruleName) : socialText('Off', 'متوقف')}</span></div>
        <div class="flex items-center justify-between gap-3 px-4 py-3"><span class="text-slate-500">${socialText('Media', 'الوسائط')}</span><span class="font-bold text-slate-900 dark:text-white">${Number(done.mediaCount) > 0 ? `${Number(done.mediaCount)} ${socialText('photos', 'صور')}` : socialText('No media', 'بدون وسائط')}</span></div>
      </div>
      <button type="button" onclick="socialOpenPostsTab('${failed ? 'failed' : status === 'draft' ? 'draft' : status === 'published' ? 'published' : 'scheduled'}')" class="touch-target mt-5 w-full min-h-12 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold">${socialText('View posts', 'عرض المنشورات')}</button>
      <button type="button" onclick="_social.screen = ''; setAdsStudioTab('dashboard');" class="touch-target mt-2 w-full min-h-12 rounded-xl bg-slate-100 dark:bg-slate-800 font-bold text-slate-700 dark:text-slate-200">${socialText('Done', 'تم')}</button>
    </section>`;
}

async function socialPublishPost(postId) {
  if (_social.busy) return;
  const context = captureSocialStudioContext();
  const ok = confirm(socialText('Publish this post now?', 'نشر هذا المنشور الآن؟'));
  if (!ok) return;
  _social.busy = true;
  render();
  try {
    const res = socialUnwrap(await socialApi(`/posts/${encodeURIComponent(postId)}/publish`, { method: 'POST', body: {} }, { timeoutMs: 120000 /* a multi-page publish under Meta pacing takes longer than 20 s */ }), 'post') || {};
    if (!socialStudioContextIsCurrent(context)) return;
    const failed = String(res.status) === 'failed';
    showNotification(failed ? socialText('Publishing failed', 'فشل النشر') : socialText('Post published', 'تم نشر المنشور'), failed ? String(res.lastError || '') : '', failed ? 'error' : 'success');
    socialRefreshNow();
  } catch (e) {
    if (!socialStudioContextIsCurrent(context)) return;
    showNotification(socialText('Could not publish', 'تعذر النشر'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    if (socialStudioContextIsCurrent(context)) { _social.busy = false; render(); }
  }
}

async function socialCancelPost(postId) {
  const context = captureSocialStudioContext();
  try {
    await socialApi(`/posts/${encodeURIComponent(postId)}/cancel`, { method: 'POST', body: {} });
    if (!socialStudioContextIsCurrent(context)) return;
    showNotification(socialText('Schedule cancelled', 'تم إلغاء الجدولة'), socialText('The post is back in Drafts.', 'عاد المنشور إلى المسودات.'), 'success');
    socialRefreshNow();
  } catch (e) {
    if (!socialStudioContextIsCurrent(context)) return;
    showNotification(socialText('Could not cancel', 'تعذر الإلغاء'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  }
}

async function socialDeletePost(postId) {
  const context = captureSocialStudioContext();
  const ok = confirm(socialText('Delete this post?', 'حذف هذا المنشور؟'));
  if (!ok) return;
  try {
    const res = await socialApi(`/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' });
    if (!socialStudioContextIsCurrent(context)) return;
    showNotification(socialText('Post deleted', 'تم حذف المنشور'), res?.metaLive ? socialText('Removed from Albayan; the published post stays live on Meta.', 'أزيل من البيان؛ المنشور المنشور يبقى على ميتا.') : '', 'success');
    socialRefreshNow();
  } catch (e) {
    if (!socialStudioContextIsCurrent(context)) return;
    showNotification(socialText('Could not delete', 'تعذر الحذف'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  }
}

// ---------- replies tab ----------

function socialSetPlatformFilter(platform) {
  _social.platformFilter = platform === 'ig' ? 'ig' : 'fb';
  render();
}

async function socialToggleMaster() {
  if (_social.busy) return;
  const context = captureSocialStudioContext();
  const next = !(_social.settings ? _social.settings.masterEnabled !== false : true);
  _social.busy = true;
  try {
    const res = await socialApi('/settings', { method: 'PUT', body: { masterEnabled: next } });
    if (!socialStudioContextIsCurrent(context)) return;
    _social.settings = socialUnwrap(res, 'settings') || { ...(_social.settings || {}), masterEnabled: next };
    showNotification(next ? socialText('Auto-reply is on', 'الرد التلقائي مفعّل') : socialText('Auto-reply is paused', 'الرد التلقائي متوقف'), '', 'success');
  } catch (e) {
    if (!socialStudioContextIsCurrent(context)) return;
    showNotification(socialText('Could not update', 'تعذر التحديث'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    if (socialStudioContextIsCurrent(context)) { _social.busy = false; render(); }
  }
}

async function socialToggleRule(ruleId) {
  const rule = _social.rules.find(r => String(r.id) === String(ruleId));
  if (!rule || _social.busy) return;
  const context = captureSocialStudioContext();
  const next = rule.enabled === false;
  _social.busy = true;
  try {
    const res = await socialApi(`/rules/${encodeURIComponent(ruleId)}`, { method: 'PATCH', body: { enabled: next } });
    if (!socialStudioContextIsCurrent(context)) return;
    const saved = socialUnwrap(res, 'rule');
    Object.assign(rule, saved && saved.id ? saved : { enabled: next });
  } catch (e) {
    if (!socialStudioContextIsCurrent(context)) return;
    showNotification(socialText('Could not update the rule', 'تعذر تحديث القاعدة'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    if (socialStudioContextIsCurrent(context)) { _social.busy = false; render(); }
  }
}

function renderSocialStudioRepliesTab() {
  if (!socialStudioAvailable()) return renderSocialStudioUnavailable();
  socialStudioEnsureLoaded();
  if (_social.screen === 'rule') return renderSocialRuleEditor();
  const isAr = adsStudioIsAr();
  const platform = _social.platformFilter;
  const master = _social.settings ? _social.settings.masterEnabled !== false : true;
  const rules = _social.rules.filter(r => r && String(r.platform || 'fb') === platform);
  return `
    <section class="max-w-3xl mx-auto space-y-4">
      <div class="flex gap-2">
        ${[['fb', 'Facebook'], ['ig', 'Instagram']].map(([id, label]) => `<button type="button" onclick="socialSetPlatformFilter('${id}')" class="touch-target min-h-10 rounded-full px-4 text-sm font-bold ${platform === id ? 'bg-blue-600 text-white' : 'bg-white/70 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300 border border-white/60 dark:border-slate-700'}">${label}</button>`).join('')}
      </div>

      <div class="glass-panel rounded-2xl p-4 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="font-bold text-slate-900 dark:text-white">${master ? socialText('Auto-reply is on', 'الرد التلقائي مفعّل') : socialText('Auto-reply is paused', 'الرد التلقائي متوقف')}</div>
          <div class="text-xs text-slate-500">${master ? socialText('Rules below run on every new comment', 'القواعد أدناه تعمل على كل تعليق جديد') : socialText('No replies will be sent', 'لن يتم إرسال أي ردود')}</div>
        </div>
        ${socialToggle(master, 'socialToggleMaster()', socialText('Auto-reply master switch', 'مفتاح الرد التلقائي'))}
      </div>

      <div class="flex items-center justify-between gap-3">
        <div class="text-xs font-bold uppercase tracking-[0.06em] text-slate-400">${socialText('Rules', 'القواعد')}</div>
        <button type="button" onclick="socialBeginRule()" class="touch-target min-h-10 px-2 text-sm font-bold text-blue-600">+ ${socialText('New rule', 'قاعدة جديدة')}</button>
      </div>
      ${rules.length ? `<div class="space-y-2">${rules.map(ru => {
        const on = ru.enabled !== false;
        return `<div class="glass-panel rounded-2xl p-4 flex items-center gap-3 ${on ? '' : 'opacity-70'}">
          <button type="button" onclick="socialEditRule('${socialEsc(ru.id)}')" class="min-w-0 flex-1 text-start touch-target">
            <span class="block truncate font-bold text-slate-900 dark:text-white">${socialEsc(ru.name)}</span>
            <span class="block truncate text-xs text-slate-500">${socialRuleTriggerLabel(ru)}</span>
            <span class="mt-1.5 flex flex-wrap gap-1">${socialRuleTags(ru).map(tag => socialPill(tag, 'slate')).join('')}</span>
          </button>
          ${socialToggle(on, `socialToggleRule('${socialEsc(ru.id)}')`, socialEsc(ru.name))}
        </div>`;
      }).join('')}</div>` : `<div class="glass-panel rounded-2xl p-8 text-center"><i data-lucide="message-circle-reply" class="w-10 h-10 mx-auto text-slate-300 mb-3"></i><p class="font-bold text-slate-800 dark:text-white">${socialText('No rules yet', 'لا توجد قواعد بعد')}</p><p class="text-sm text-slate-500 mt-1">${socialText('Create a rule to answer comments automatically — in public, by private message, or both.', 'أنشئ قاعدة للرد على التعليقات تلقائياً — علناً أو برسالة خاصة أو كليهما.')}</p></div>`}
      <p class="text-[11px] text-slate-500">${socialConnectionPill()} <span class="ms-2">${socialText('Replies run on the Albayan server as soon as Meta delivers a comment.', 'تعمل الردود على خادم البيان فور وصول التعليق من ميتا.')}</span></p>
    </section>`;
}

// ---------- rule editor ----------

function socialNewRule() {
  return { id: '', name: '', platform: _social.platformFilter || 'fb', enabled: true, scope: 'all', postIds: [], trigger: 'keywords', keywords: [], publicReply: '', dmEnabled: false, dmText: '', likeComment: true, oncePerPerson: true, skipPublicAfterDm: false, pauseDms: false, quietHours: false, keywordInput: '' };
}

function socialBeginRule() {
  _socialComposerGeneration++;
  _social.ruleDraft = socialNewRule();
  _social.screen = 'rule';
  render();
}

function socialEditRule(ruleId) {
  const rule = _social.rules.find(r => String(r.id) === String(ruleId));
  if (!rule) return;
  _socialComposerGeneration++;
  _social.ruleDraft = { ...socialNewRule(), ...JSON.parse(JSON.stringify(rule)), keywords: Array.isArray(rule.keywords) ? rule.keywords.slice() : [], postIds: Array.isArray(rule.postIds) ? rule.postIds.slice() : [], keywordInput: '' };
  _social.screen = 'rule';
  render();
}

function socialRuleSet(field, value) {
  if (!_social.ruleDraft) return;
  _social.ruleDraft[field] = value;
}

function socialRuleChoose(field, value) {
  if (!_social.ruleDraft) return;
  _social.ruleDraft[field] = value;
  render();
}

function socialRuleToggle(field) {
  if (!_social.ruleDraft) return;
  _social.ruleDraft[field] = !_social.ruleDraft[field];
  render();
}

function socialRuleTogglePost(postId) {
  if (!_social.ruleDraft) return;
  const set = new Set(_social.ruleDraft.postIds.map(String));
  const id = String(postId);
  if (set.has(id)) set.delete(id); else set.add(id);
  _social.ruleDraft.postIds = Array.from(set);
  render();
}

function socialRuleAddKeyword() {
  if (!_social.ruleDraft) return;
  const input = document.getElementById('social-rule-keyword');
  const raw = String((input ? input.value : _social.ruleDraft.keywordInput) || '');
  const parts = raw.split(/[,\n،]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return;
  const next = Array.from(new Set(_social.ruleDraft.keywords.concat(parts))).slice(0, SOCIAL_MAX_KEYWORDS);
  _social.ruleDraft.keywords = next;
  _social.ruleDraft.keywordInput = '';
  render();
}

function socialRuleRemoveKeyword(index) {
  if (!_social.ruleDraft) return;
  _social.ruleDraft.keywords.splice(index, 1);
  render();
}

function socialRuleKeywordKeydown(event) {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    socialRuleAddKeyword();
  }
}

function socialRuleValidate() {
  const r = _social.ruleDraft;
  if (!r) return socialText('Nothing to save.', 'لا يوجد ما يُحفظ.');
  if (!String(r.name || '').trim()) return socialText('Give the rule a name.', 'أعطِ القاعدة اسماً.');
  if (r.trigger === 'keywords' && !r.keywords.length) return socialText('Add at least one keyword, or trigger on every comment.', 'أضف كلمة مفتاحية واحدة على الأقل، أو اختر "كل تعليق".');
  if (r.scope === 'chosen' && !r.postIds.length) return socialText('Choose at least one post.', 'اختر منشوراً واحداً على الأقل.');
  const pub = String(r.publicReply || '').trim();
  const dm = r.dmEnabled ? String(r.dmText || '').trim() : '';
  if (!pub && !dm) return socialText('Write a public reply or a private message.', 'اكتب رداً عاماً أو رسالة خاصة.');
  return '';
}

async function socialRuleSave() {
  if (_social.busy || !_social.ruleDraft) return;
  const problem = socialRuleValidate();
  if (problem) { showNotification(socialText('Check the rule', 'راجع القاعدة'), problem, 'warning'); return; }
  const r = _social.ruleDraft;
  const context = captureSocialStudioContext();
  const isCurrent = () => socialStudioContextIsCurrent(context) && _social.ruleDraft === r;
  const body = {
    name: String(r.name || '').trim(), platform: r.platform === 'ig' ? 'ig' : 'fb', enabled: r.enabled !== false,
    scope: r.scope === 'chosen' ? 'chosen' : 'all', postIds: r.scope === 'chosen' ? r.postIds.map(String) : [],
    trigger: r.trigger === 'every' ? 'every' : 'keywords', keywords: r.trigger === 'every' ? [] : r.keywords,
    publicReply: String(r.publicReply || ''), dmEnabled: !!r.dmEnabled, dmText: r.dmEnabled ? String(r.dmText || '') : '',
    likeComment: r.platform !== 'ig' && !!r.likeComment, oncePerPerson: !!r.oncePerPerson, skipPublicAfterDm: !!r.skipPublicAfterDm,
    pauseDms: !!r.pauseDms, quietHours: !!r.quietHours
  };
  _social.busy = true;
  render();
  try {
    if (r.id) await socialApi(`/rules/${encodeURIComponent(r.id)}`, { method: 'PATCH', body });
    else await socialApi('/rules', { method: 'POST', body });
    if (!isCurrent()) return;
    showNotification(socialText('Rule saved', 'تم حفظ القاعدة'), body.name, 'success');
    _social.platformFilter = body.platform;
    _social.ruleDraft = null;
    _social.screen = '';
    socialRefreshNow();
  } catch (e) {
    if (!isCurrent()) return;
    showNotification(socialText('Could not save the rule', 'تعذر حفظ القاعدة'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    if (socialStudioContextIsCurrent(context)) { _social.busy = false; render(); }
  }
}

async function socialRuleDelete() {
  const r = _social.ruleDraft;
  if (!r || !r.id || _social.busy) return;
  const context = captureSocialStudioContext();
  const isCurrent = () => socialStudioContextIsCurrent(context) && _social.ruleDraft === r;
  const ok = confirm(socialText(`Delete the rule "${r.name}"?`, `حذف القاعدة "${r.name}"؟`));
  if (!ok) return;
  _social.busy = true;
  try {
    await socialApi(`/rules/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
    if (!isCurrent()) return;
    showNotification(socialText('Rule deleted', 'تم حذف القاعدة'), '', 'success');
    _social.ruleDraft = null;
    _social.screen = '';
    socialRefreshNow();
  } catch (e) {
    if (!isCurrent()) return;
    showNotification(socialText('Could not delete the rule', 'تعذر حذف القاعدة'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    if (socialStudioContextIsCurrent(context)) { _social.busy = false; render(); }
  }
}

function socialRuleClose() {
  _social.ruleDraft = null;
  _social.screen = '';
  render();
}

function renderSocialRuleEditor() {
  const r = _social.ruleDraft || socialNewRule();
  const isAr = adsStudioIsAr();
  const isIg = r.platform === 'ig';
  const choice = (label, on, onclick) => `<button type="button" onclick="${onclick}" aria-pressed="${on}" class="touch-target min-h-11 rounded-xl px-3 text-sm font-bold ${on ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'}">${label}</button>`;
  const section = (label) => `<div class="text-xs font-bold uppercase tracking-[0.06em] text-slate-400 mb-2">${label}</div>`;
  const behaviorRow = (label, field, disabled = false, hint = '') => `
    <div class="flex items-center justify-between gap-3 py-2.5 ${disabled ? 'opacity-50' : ''}">
      <span class="min-w-0"><span class="block text-sm font-semibold text-slate-800 dark:text-white">${label}</span>${hint ? `<span class="block text-[11px] text-slate-500">${hint}</span>` : ''}</span>
      ${disabled ? `<span class="text-[11px] text-slate-400">${socialText('Facebook only', 'فيسبوك فقط')}</span>` : socialToggle(!!r[field], `socialRuleToggle('${field}')`, label)}
    </div>`;
  const candidatePosts = _social.posts.filter(p => ['published', 'scheduled'].includes(String(p.status)) && (Array.isArray(p.pageIds) ? p.pageIds : []).some(id => String(socialPageById(id)?.platform || 'fb') === r.platform));
  return `
    <section class="max-w-2xl mx-auto space-y-5">
      <div class="flex items-center gap-3">
        <button type="button" onclick="socialRuleClose()" class="touch-target flex h-11 w-11 items-center justify-center rounded-full bg-white/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700" aria-label="${socialText('Back', 'رجوع')}"><i data-lucide="${isAr ? 'chevron-right' : 'chevron-left'}" class="w-5 h-5"></i></button>
        <h2 class="flex-1 text-2xl font-extrabold text-slate-900 dark:text-white">${r.id ? socialText('Edit rule', 'تعديل القاعدة') : socialText('New rule', 'قاعدة جديدة')}</h2>
        ${socialPlatformBadge(r.platform)}
      </div>

      <div class="glass-panel rounded-2xl p-4 sm:p-5 space-y-5">
        <div>
          <label for="social-rule-name" class="block text-xs font-bold uppercase tracking-[0.06em] text-slate-400 mb-2">${socialText('Rule name', 'اسم القاعدة')}</label>
          <input id="social-rule-name" type="text" maxlength="80" value="${socialEsc(r.name)}" oninput="socialRuleSet('name', this.value)" placeholder="${socialText('e.g. Price questions', 'مثال: أسئلة الأسعار')}" class="w-full glass-input rounded-xl px-4 py-3 text-sm" />
        </div>

        <div>
          ${section(socialText('Platform', 'المنصة'))}
          <div class="grid grid-cols-2 gap-2">${choice('Facebook', !isIg, "socialRuleChoose('platform', 'fb')")}${choice('Instagram', isIg, "socialRuleChoose('platform', 'ig')")}</div>
        </div>

        <div>
          ${section(socialText('Applies to', 'تنطبق على'))}
          <div class="grid grid-cols-2 gap-2">${choice(socialText('All posts', 'كل المنشورات'), r.scope !== 'chosen', "socialRuleChoose('scope', 'all')")}${choice(socialText('Chosen posts', 'منشورات محددة'), r.scope === 'chosen', "socialRuleChoose('scope', 'chosen')")}</div>
          ${r.scope === 'chosen' ? (candidatePosts.length ? `<div class="mt-2 space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar">${candidatePosts.map(p => { const on = r.postIds.map(String).includes(String(p.id)); return `<button type="button" onclick="socialRuleTogglePost('${socialEsc(p.id)}')" aria-pressed="${on}" class="touch-target w-full flex items-center gap-2 rounded-xl border p-2 text-start text-xs ${on ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700'}"><i data-lucide="${on ? 'check-circle-2' : 'circle'}" class="w-4 h-4 flex-shrink-0 ${on ? 'text-blue-600' : 'text-slate-400'}"></i><span class="truncate text-slate-700 dark:text-slate-200">${socialEsc(p.caption || socialText('(no caption)', '(بدون نص)'))}</span></button>`; }).join('')}</div>` : `<p class="mt-2 text-xs text-amber-700 dark:text-amber-300">${socialText('No published or scheduled posts for this platform yet.', 'لا توجد منشورات منشورة أو مجدولة لهذه المنصة بعد.')}</p>`) : ''}
        </div>

        <div>
          ${section(socialText('Trigger', 'المُحفّز'))}
          <div class="grid grid-cols-2 gap-2">${choice(socialText('Every comment', 'كل تعليق'), r.trigger === 'every', "socialRuleChoose('trigger', 'every')")}${choice(socialText('Keywords', 'كلمات مفتاحية'), r.trigger !== 'every', "socialRuleChoose('trigger', 'keywords')")}</div>
          ${r.trigger !== 'every' ? `
            <div class="mt-2 flex flex-wrap gap-1.5">${r.keywords.map((kw, i) => `<span class="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 ps-3 pe-1 py-1 text-xs font-bold text-slate-700 dark:text-slate-200">${socialEsc(kw)}<button type="button" onclick="socialRuleRemoveKeyword(${i})" class="touch-target flex h-6 w-6 items-center justify-center rounded-full hover:bg-slate-200 dark:hover:bg-slate-700" aria-label="${socialText('Remove keyword', 'إزالة الكلمة')}"><i data-lucide="x" class="w-3 h-3"></i></button></span>`).join('')}</div>
            <div class="mt-2 flex gap-2">
              <input id="social-rule-keyword" type="text" maxlength="40" value="${socialEsc(r.keywordInput || '')}" oninput="socialRuleSet('keywordInput', this.value)" onkeydown="socialRuleKeywordKeydown(event)" placeholder="${socialText('price, how much, السعر', 'السعر، بكم، price')}" class="flex-1 glass-input rounded-xl px-4 py-2.5 text-sm" />
              <button type="button" onclick="socialRuleAddKeyword()" class="touch-target min-h-11 rounded-xl bg-slate-100 dark:bg-slate-800 px-4 text-sm font-bold text-slate-700 dark:text-slate-200">+ ${socialText('Add', 'إضافة')}</button>
            </div>
            <p class="mt-1 text-[11px] text-slate-400">${socialText('Matching ignores case and Arabic diacritics. Separate several with commas.', 'المطابقة تتجاهل حالة الأحرف والتشكيل. افصل بين الكلمات بفاصلة.')}</p>` : ''}
        </div>

        <div>
          <label for="social-rule-public" class="block text-xs font-bold uppercase tracking-[0.06em] text-slate-400 mb-2">${socialText('Public reply', 'رد عام')}</label>
          <textarea id="social-rule-public" rows="3" maxlength="1000" oninput="socialRuleSet('publicReply', this.value)" placeholder="${socialText('What everyone sees under the comment', 'ما يراه الجميع تحت التعليق')}" class="w-full glass-input rounded-xl px-4 py-3 text-sm leading-6">${socialEsc(r.publicReply)}</textarea>
        </div>

        <div class="rounded-2xl border border-slate-200 dark:border-slate-700 p-3">
          <div class="flex items-center justify-between gap-3">
            <div><div class="text-sm font-bold text-slate-800 dark:text-white">${socialText('Private message', 'رسالة خاصة')}</div><div class="text-[11px] text-slate-500">${socialText('Also DM the person who commented', 'أرسل أيضاً رسالة خاصة لصاحب التعليق')}</div></div>
            ${socialToggle(!!r.dmEnabled, "socialRuleToggle('dmEnabled')", socialText('Private message', 'رسالة خاصة'))}
          </div>
          ${r.dmEnabled ? `<textarea id="social-rule-dm" rows="3" maxlength="1000" oninput="socialRuleSet('dmText', this.value)" placeholder="${socialText('What only the commenter receives', 'ما يستلمه صاحب التعليق فقط')}" class="mt-3 w-full glass-input rounded-xl px-4 py-3 text-sm leading-6">${socialEsc(r.dmText)}</textarea>` : ''}
        </div>

        <div>
          ${section(socialText('Behavior', 'السلوك'))}
          <div class="divide-y divide-slate-200 dark:divide-slate-700">
            ${behaviorRow(socialText('Like the comment', 'الإعجاب بالتعليق'), 'likeComment', isIg)}
            ${behaviorRow(socialText('One reply per person', 'رد واحد لكل شخص'), 'oncePerPerson')}
            ${behaviorRow(socialText('Skip the public reply once a DM is sent', 'تجاوز الرد العام بعد إرسال رسالة خاصة'), 'skipPublicAfterDm')}
            ${behaviorRow(socialText('Pause private replies', 'إيقاف الردود الخاصة مؤقتاً'), 'pauseDms')}
            ${behaviorRow(socialQuietHoursLabel(), 'quietHours', false, socialText('Stay silent during the quiet window (Libya time).', 'التزم الصمت خلال ساعات الهدوء (بتوقيت ليبيا).'))}
          </div>
        </div>
      </div>

      <button type="button" onclick="socialRuleSave()" ${_social.busy ? 'disabled' : ''} class="touch-target w-full min-h-14 rounded-2xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-base font-bold text-white btn-shine">${_social.busy ? socialText('Saving…', 'جاري الحفظ…') : socialText('Save rule', 'حفظ القاعدة')}</button>
      ${r.id ? `<button type="button" onclick="socialRuleDelete()" ${_social.busy ? 'disabled' : ''} class="touch-target w-full min-h-11 text-sm font-bold text-rose-600">${socialText('Delete rule', 'حذف القاعدة')}</button>` : ''}
    </section>`;
}

// ---------- fallbacks ----------

function renderSocialStudioUnavailable() {
  return `
    <div class="max-w-xl mx-auto glass-panel rounded-2xl p-8 text-center">
      <i data-lucide="cloud-off" class="w-10 h-10 mx-auto text-slate-300 mb-3"></i>
      <p class="font-bold text-slate-800 dark:text-white">${socialText('Posts and replies need the server connection', 'المنشورات والردود تحتاج إلى اتصال الخادم')}</p>
      <p class="text-sm text-slate-500 mt-1">${socialText('Sign in to the online Albayan workspace to schedule posts and manage auto-replies.', 'سجّل الدخول إلى مساحة عمل البيان عبر الإنترنت لجدولة المنشورات وإدارة الردود التلقائية.')}</p>
    </div>`;
}
// ==========================================
// STUDIO HEALTH — admin fact checks (plan tasks P0-05c/d/e, studio.js lazy bundle)
// ==========================================
// An admin-only section under the Ads Studio review queue:
// - the P0-01 facts from GET /api/studio/admin/facts (counts and flags only; the two Meta
//   readings are kept 24 h on the server, "Refresh from Meta" re-reads them: 2 per 10 min;
//   while Meta is paused, or for a row Meta did not answer, the last good reading is shown);
// - the Meta token summary from GET /api/meta-ads/token-health;
// - a "Test subscription" button per linked page and an Instagram "Read test" per linked
//   Instagram account (each once per Tripoli day; the result shows inline, no dialogs);
// - "Check recent comments now" per linked Instagram account (P1-23): the owner's rules answer the
//   new comments as the webhook would; once a minute per account; counts only.
// The page list comes from /api/social-studio/pages (admins see every linked page). This file
// never sees a Meta token: the server does every Meta call.

const STUDIO_HEALTH_RELOAD_MS = 60000;
const STUDIO_HEALTH_META_TIMEOUT_MS = 45000; // a Meta refresh or test makes several paced calls
let _studioHealthGeneration = 0;

const _studioHealth = {
  forUser: '',
  loading: false,
  loadedAt: 0,
  facts: null,
  factsError: '',
  token: null,
  tokenError: '',
  pages: [],
  refreshing: false,
  refreshNote: null,
  busy: Object.create(null),
  results: Object.create(null),
  igForm: Object.create(null)
};

// Meta error codes the server reports (MetaAdsError codes, which are also the (b) error
// classes, and the check's own). Any other code shows the generic label with the code (LTR).
const STUDIO_HEALTH_META_CODES = {
  authorization: ['Meta refused access (token or page role)', 'رفضت ميتا الوصول (الرمز أو صلاحية الصفحة)'],
  not_found: ['Meta could not find it', 'لم تجده ميتا'],
  rate_limited: ['Meta asked Albayan to wait', 'طلبت ميتا من البيان الانتظار'],
  temporary: ['Meta was temporarily unavailable', 'ميتا غير متاحة مؤقتاً'],
  timeout: ['Meta did not answer in time', 'لم تردّ ميتا في الوقت المحدد'],
  network: ['Meta could not be reached', 'تعذّر الوصول إلى ميتا'],
  request_failed: ['Meta refused the request', 'رفضت ميتا الطلب'],
  invalid_response: ['Meta sent an unreadable answer', 'أرسلت ميتا رداً غير مقروء'],
  invalid_request: ['The request was not valid', 'الطلب غير صالح'],
  invalid_path: ['Albayan refused an unsafe Meta request', 'رفض البيان طلباً غير آمن إلى ميتا'],
  invalid_id: ['The Meta id is not valid', 'معرّف ميتا غير صالح'],
  response_too_large: ['Meta sent more data than Albayan accepts', 'أرسلت ميتا بيانات أكثر مما يقبله البيان'],
  not_configured: ["Albayan's Meta connection is not set up", 'ربط البيان مع ميتا غير مُعدّ'],
  account_not_allowed: ["This ad account is not on Albayan's allowed list", 'هذا الحساب الإعلاني ليس ضمن القائمة المسموحة'],
  not_allowed: ['Not linked to this Albayan Studio request', 'غير مربوطة بهذا الطلب في استوديو البيان'],
  meta_error: ['Meta returned an error', 'أعادت ميتا خطأ'],
  unexpected: ['Meta sent an unexpected answer', 'أرسلت ميتا رداً غير متوقع'],
  not_confirmed: ['Meta did not confirm it', 'لم تؤكد ميتا ذلك'],
  comment_not_found: ['That comment is not among the recent comments read', 'هذا التعليق ليس ضمن التعليقات الأخيرة المقروءة'],
  comments_not_read: ['The comments could not be read', 'تعذّرت قراءة التعليقات'],
  ambiguous_match: ['More than one recent comment holds this code, so nothing was sent. Use a more distinctive code or the comment id', 'أكثر من تعليق حديث يحتوي هذا الرمز، لذلك لم يُرسل شيء. استخدم رمزاً أوضح أو رقم التعليق'],
  unreadable: ['Meta sent an unreadable answer', 'أرسلت ميتا رداً غير مقروء']
};

// /api/studio refusal codes (studio_errors.py).
const STUDIO_HEALTH_REFUSALS = {
  ALREADY_TESTED_TODAY: ['Already tested today. Try again tomorrow (Tripoli time).', 'تم الاختبار اليوم. أعد المحاولة غداً (بتوقيت طرابلس).'],
  META_NOT_CONFIGURED: ["Albayan's Meta connection is not set up, so nothing was tested.", 'ربط البيان مع ميتا غير مُعدّ، لذلك لم يُختبر شيء.'],
  META_PAUSED: ["Meta is paused, so nothing was tested and today's test is still free. Try again in a few minutes.", 'ميتا متوقفة مؤقتاً، لذلك لم يُختبر شيء وما زال اختبار اليوم متاحاً. أعد المحاولة بعد بضع دقائق.'],
  NOT_INSTAGRAM: ['This linked page is not an Instagram account.', 'هذه الصفحة المربوطة ليست حساب إنستغرام.'],
  UNKNOWN_PAGE: ['This page is no longer linked.', 'هذه الصفحة لم تعد مربوطة.'],
  ADMIN_ONLY: ['Only an admin can use this.', 'هذه الأداة للمدير فقط.'],
  CROSS_SITE: ['Open Albayan directly and try again.', 'افتح البيان مباشرة ثم أعد المحاولة.'],
  INVALID_REQUEST: ['Name the comment and write the reply, or leave both empty.', 'حدّد التعليق واكتب الرد، أو اترك الحقلين فارغين.'],
  INVALID_VALUE: ['Check the comment and the reply: the reply up to 300 characters; a code of 6-40 characters with at least one digit, or a comment id of 15+ digits.', 'راجع التعليق والرد: الرد حتى 300 حرف؛ والرمز من 6 إلى 40 حرفاً وفيه رقم واحد على الأقل، أو رقم تعليق من 15 خانة أو أكثر.'],
  UNKNOWN_FIELD: ['The request was not valid.', 'الطلب غير صالح.']
};

function studioHealthText(en, ar) {
  return adsStudioText(en, ar);
}

function studioHealthEsc(value) {
  return Security.escapeHtml(String(value === null || value === undefined ? '' : value));
}

function captureStudioHealthContext() {
  return { generation: _studioHealthGeneration, identity: getAuthMeIdentity() };
}

function studioHealthContextIsCurrent(context) {
  return context.generation === _studioHealthGeneration && context.identity === getAuthMeIdentity();
}

// The flags (loading, refreshing, busy) belong to the request generation that set them: a
// reset starts a new generation and clears them; a request of the same generation always
// clears its own, even when the session changed under it (its result is then dropped).
function studioHealthGenerationIsCurrent(context) {
  return context.generation === _studioHealthGeneration;
}

async function studioHealthApi(path, options = {}, extra = {}) {
  const context = captureStudioHealthContext();
  try {
    const result = await apiJson(path, options, extra);
    if (!studioHealthContextIsCurrent(context)) throw makeSessionChangedError();
    return result;
  } catch (error) {
    if (!studioHealthContextIsCurrent(context)) throw makeSessionChangedError();
    throw error;
  }
}

function resetStudioHealthState() {
  _studioHealthGeneration++;
  _studioHealth.forUser = '';
  _studioHealth.loading = false;
  _studioHealth.loadedAt = 0;
  _studioHealth.facts = null;
  _studioHealth.factsError = '';
  _studioHealth.token = null;
  _studioHealth.tokenError = '';
  _studioHealth.pages = [];
  _studioHealth.refreshing = false;
  _studioHealth.refreshNote = null;
  for (const bag of [_studioHealth.busy, _studioHealth.results, _studioHealth.igForm]) {
    for (const key of Object.keys(bag)) delete bag[key];
  }
}

function studioHealthRerender() {
  if (state.currentView === 'ads-studio') { try { render(); } catch (_) {} }
}

function studioHealthErrorText(error) {
  const code = String(error?.payload?.detail?.code || '');
  if (STUDIO_HEALTH_REFUSALS[code]) return studioHealthText(...STUDIO_HEALTH_REFUSALS[code]);
  if (Number(error?.status) === 429) return studioHealthText('Too many tries. Wait a few minutes and try again.', 'محاولات كثيرة. انتظر بضع دقائق ثم أعد المحاولة.');
  if (Number(error?.status) === 403) return studioHealthText('Only an admin can use this.', 'هذه الأداة للمدير فقط.');
  return studioHealthText('The check did not finish. Try again.', 'لم يكتمل الفحص. أعد المحاولة.');
}

function studioHealthCodeLabel(code) {
  const key = String(code || '');
  if (Object.prototype.hasOwnProperty.call(STUDIO_HEALTH_META_CODES, key)) return studioHealthText(...STUDIO_HEALTH_META_CODES[key]);
  return `${studioHealthText('Meta error', 'خطأ من ميتا')} <span dir="ltr">${studioHealthEsc(key || '—')}</span>`;
}

function studioHealthMetaCode(code, providerCode) {
  const label = studioHealthCodeLabel(code);
  return providerCode ? `${label} (${studioHealthText('Meta code', 'رمز ميتا')} <span dir="ltr">${studioHealthEsc(providerCode)}</span>)` : label;
}

// Meta's own numeric codes (fact b): "none" when the failure carried no code.
function studioHealthProviderCodeLabel(code) {
  if (String(code) === 'none') return studioHealthText('No Meta code', 'دون رمز ميتا');
  return `${studioHealthText('Meta code', 'رمز ميتا')} <span dir="ltr">${studioHealthEsc(code)}</span>`;
}

// Ad request statuses (fact c): the Ads Studio labels, "other" for anything else.
function studioHealthStatusLabel(status) {
  if (String(status) === 'other') return studioHealthText('Other status', 'حالة أخرى');
  if (typeof adsStudioStatusMeta === 'function') {
    const meta = adsStudioStatusMeta(status);
    return studioHealthEsc(studioHealthText(meta.label, meta.labelAr));
  }
  return `<span dir="ltr">${studioHealthEsc(status)}</span>`;
}

function studioHealthAge(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return studioHealthText('never read', 'لم تُقرأ بعد');
  if (s < 3600) return studioHealthText(`${Math.max(1, Math.round(s / 60))} min ago`, `قبل ${Math.max(1, Math.round(s / 60))} دقيقة`);
  if (s < 172800) return studioHealthText(`${Math.round(s / 3600)} h ago`, `قبل ${Math.round(s / 3600)} ساعة`);
  return studioHealthText(`${Math.round(s / 86400)} days ago`, `قبل ${Math.round(s / 86400)} يوم`);
}

// ---------- loading ----------

async function studioHealthEnsureLoaded(force = false) {
  if (!isCurrentUserAdmin() || !isServerModeEnabled()) return;
  const uid = String(state.currentUser?.id || '');
  if (!uid) return;
  if (_studioHealth.forUser !== uid) { resetStudioHealthState(); _studioHealth.forUser = uid; }
  if (_studioHealth.loading) return;
  if (!force && _studioHealth.loadedAt && Date.now() - _studioHealth.loadedAt < STUDIO_HEALTH_RELOAD_MS) return;
  const context = captureStudioHealthContext();
  _studioHealth.loading = true;
  try {
    const [facts, token, pages] = await Promise.allSettled([
      studioHealthApi('/api/studio/admin/facts'),
      studioHealthApi('/api/meta-ads/token-health'),
      studioHealthApi('/api/social-studio/pages')
    ]);
    if (!studioHealthContextIsCurrent(context)) return;
    _studioHealth.facts = facts.status === 'fulfilled' ? facts.value : _studioHealth.facts;
    _studioHealth.factsError = facts.status === 'fulfilled' ? '' : studioHealthErrorText(facts.reason);
    _studioHealth.token = token.status === 'fulfilled' ? token.value : null;
    _studioHealth.tokenError = token.status === 'fulfilled' ? '' : studioHealthErrorText(token.reason);
    if (pages.status === 'fulfilled') _studioHealth.pages = Array.isArray(pages.value?.pages) ? pages.value.pages : [];
  } finally {
    if (studioHealthGenerationIsCurrent(context)) {
      _studioHealth.loading = false;
      // a failed load waits like a good one (no request loop); a load dropped by a session change does not
      if (studioHealthContextIsCurrent(context)) _studioHealth.loadedAt = Date.now();
      studioHealthRerender();
    }
  }
}

function studioHealthRefreshNote(report) {
  const meta = report?.meta || {};
  const facts = report?.facts || {};
  const kept = (facts.f?.accounts || []).filter(row => row && row.kept).length + (Number(facts.i?.kept) || 0);
  if (meta.refreshed) {
    return kept
      ? { tone: 'amber', text: studioHealthText(`Read from Meta just now. ${kept} rows could not be read again: their last good values are shown with the error.`, `قُرئت من ميتا الآن. تعذّرت إعادة قراءة ${kept} من الصفوف: تظهر آخر قيم سليمة لها مع الخطأ.`) }
      : { tone: 'emerald', text: studioHealthText('Read from Meta just now.', 'قُرئت من ميتا الآن.') };
  }
  if (meta.paused) {
    const minutes = Math.max(1, Math.ceil((Number(meta.retryAfterSeconds) || 0) / 60));
    return { tone: 'amber', text: studioHealthText(`Meta is paused; showing the last reading. Try again in about ${minutes} min.`, `ميتا متوقفة مؤقتاً؛ تظهر آخر قراءة. أعد المحاولة بعد نحو ${minutes} دقيقة.`) };
  }
  if (meta.busy) return { tone: 'amber', text: studioHealthText('Another admin is refreshing. The saved reading is shown.', 'مدير آخر يحدّث الآن. تظهر القراءة المحفوظة.') };
  if (meta.configured === false) return { tone: 'amber', text: studioHealthText('Meta is not connected, so nothing was read.', 'ميتا غير مربوطة، لذلك لم يُقرأ شيء.') };
  return { tone: 'amber', text: studioHealthText('Nothing new was read from Meta. The last good values are kept and the errors are shown beside them.', 'لم يُقرأ شيء جديد من ميتا. بقيت آخر قيم سليمة وتظهر الأخطاء بجانبها.') };
}

async function studioHealthRefreshFacts() {
  if (!isCurrentUserAdmin() || _studioHealth.refreshing) return;
  const context = captureStudioHealthContext();
  _studioHealth.refreshing = true;
  _studioHealth.refreshNote = null;
  studioHealthRerender();
  try {
    const facts = await studioHealthApi('/api/studio/admin/facts?refresh=1', {}, { timeoutMs: STUDIO_HEALTH_META_TIMEOUT_MS });
    if (!studioHealthContextIsCurrent(context)) return;
    _studioHealth.facts = facts;
    _studioHealth.refreshNote = studioHealthRefreshNote(facts);
  } catch (error) {
    if (!studioHealthContextIsCurrent(context)) return;
    _studioHealth.refreshNote = { tone: 'rose', text: studioHealthErrorText(error) };
  } finally {
    if (studioHealthGenerationIsCurrent(context)) { _studioHealth.refreshing = false; studioHealthRerender(); }
  }
}

// ---------- the two test buttons ----------

async function studioHealthSubscribeTest(pageId) {
  const key = `sub:${pageId}`;
  if (!isCurrentUserAdmin() || _studioHealth.busy[key]) return;
  const context = captureStudioHealthContext();
  _studioHealth.busy[key] = true;
  delete _studioHealth.results[key];
  studioHealthRerender();
  try {
    const result = await studioHealthApi(`/api/studio/admin/pages/${encodeURIComponent(pageId)}/subscribe-test`, { method: 'POST', body: {} }, { timeoutMs: STUDIO_HEALTH_META_TIMEOUT_MS });
    if (!studioHealthContextIsCurrent(context)) return;
    _studioHealth.results[key] = result?.ok
      ? { tone: 'emerald', text: studioHealthText('Subscribed: Facebook comments will reach Albayan.', 'تم الاشتراك: ستصل تعليقات فيسبوك إلى البيان.') }
      : { tone: 'rose', text: `${studioHealthText('Not subscribed', 'لم يتم الاشتراك')}: ${studioHealthMetaCode(result?.errorCode, result?.providerCode)}` };
  } catch (error) {
    if (!studioHealthContextIsCurrent(context)) return;
    _studioHealth.results[key] = { tone: 'amber', text: studioHealthErrorText(error) };
  } finally {
    if (studioHealthGenerationIsCurrent(context)) { delete _studioHealth.busy[key]; studioHealthRerender(); }
  }
}

function studioHealthSetIgField(pageId, field, value) {
  const form = _studioHealth.igForm[pageId] || (_studioHealth.igForm[pageId] = { target: '', text: '' });
  form[field] = String(value || '');
}

function studioHealthIgBody(pageId) {
  const form = _studioHealth.igForm[pageId] || {};
  const target = String(form.target || '').trim();
  const text = String(form.text || '').trim();
  if (!target && !text) return undefined;
  const body = { text };
  // Only a 15+ digit number is an Instagram comment id; anything else is a code written in it.
  if (/^\d{15,40}$/.test(target)) body.replyToCommentId = target;
  else body.replyToCommentContaining = target;
  return body;
}

function studioHealthIgResultText(result) {
  const read = result?.errorCode
    ? `${studioHealthText('Reading stopped', 'توقفت القراءة')}: ${studioHealthMetaCode(result.errorCode, result.providerCode)}`
    : studioHealthText(`Read ${result?.commentsRead || 0} comments from ${result?.mediaWithComments || 0} recent posts (${result?.mediaRead || 0} posts checked).`,
      `قُرئ ${result?.commentsRead || 0} تعليقاً من ${result?.mediaWithComments || 0} منشورات حديثة (فُحص ${result?.mediaRead || 0} منشوراً).`);
  if (!result?.replyRequested) return read;
  let reply;
  if (result.replySent) reply = studioHealthText('The reply was sent.', 'أُرسل الرد.');
  else if (result.alreadyReplied) reply = studioHealthText('This comment was already answered by a test; nothing was sent again.', 'سبق الرد على هذا التعليق في اختبار؛ لم يُرسل شيء مرة أخرى.');
  else if (result.replyState === 'unknown') reply = studioHealthText('The reply may have been sent. Check the comment on Instagram; it will not be sent again.', 'ربما أُرسل الرد. تحقّق من التعليق على إنستغرام؛ لن يُرسل مرة أخرى.');
  else {
    const matches = Number(result.replyMatchCount) || 0;
    const count = result.replyErrorCode === 'ambiguous_match' ? ` (${studioHealthText(`${matches} comments match`, `${matches} تعليقات مطابقة`)})` : '';
    reply = `${studioHealthText('No reply sent', 'لم يُرسل رد')}: ${studioHealthMetaCode(result.replyErrorCode || 'not_confirmed', '')}${count}`;
  }
  return `${read} ${reply}`;
}

async function studioHealthIgReadTest(pageId) {
  const key = `ig:${pageId}`;
  if (!isCurrentUserAdmin() || _studioHealth.busy[key]) return;
  const context = captureStudioHealthContext();
  const body = studioHealthIgBody(pageId);
  _studioHealth.busy[key] = true;
  delete _studioHealth.results[key];
  studioHealthRerender();
  try {
    const result = await studioHealthApi(`/api/studio/admin/instagram/${encodeURIComponent(pageId)}/read-test`, { method: 'POST', body: body || {} }, { timeoutMs: STUDIO_HEALTH_META_TIMEOUT_MS });
    if (!studioHealthContextIsCurrent(context)) return;
    const good = !result?.errorCode && (!result?.replyRequested || result?.replySent);
    _studioHealth.results[key] = { tone: good ? 'emerald' : 'amber', text: studioHealthIgResultText(result) };
  } catch (error) {
    if (!studioHealthContextIsCurrent(context)) return;
    _studioHealth.results[key] = { tone: 'amber', text: studioHealthErrorText(error) };
  } finally {
    if (studioHealthGenerationIsCurrent(context)) { delete _studioHealth.busy[key]; studioHealthRerender(); }
  }
}

// ---------- "Check recent comments now" (P1-23) ----------

// {read, new, replied, skipped} (+ errorCode: Meta's error class when the read stopped early).
function studioHealthCheckResultText(result) {
  const n = key => Math.max(0, Math.trunc(Number(result?.[key]) || 0));
  const counts = studioHealthText(
    `Read ${n('read')} comments: ${n('new')} new, ${n('replied')} answered, ${n('skipped')} skipped (already seen, too old or the account's own).`,
    `قُرئ ${n('read')} تعليقاً: ${n('new')} جديدة، و${n('replied')} رُدّ عليها، و${n('skipped')} تُخطّيت (سبقت قراءتها أو قديمة أو من الحساب نفسه).`);
  if (!result?.errorCode) return counts;
  return `${counts} ${studioHealthText('Reading stopped early', 'توقفت القراءة مبكراً')}: ${studioHealthMetaCode(result.errorCode, '')}`;
}

// A refused check: a 429 or 409 {code, message} in the viewer's language through the studio's
// Arabic map (a 429 carries no payload: apiJson puts the detail, as JSON, in the message).
function studioHealthCheckErrorText(error) {
  const status = Number(error?.status);
  if (status === 429 || status === 409) {
    let detail = error?.payload?.detail || String(error?.message || '');
    if (typeof detail === 'string' && detail.startsWith('{')) { try { detail = JSON.parse(detail); } catch (_) {} }
    const text = adsStudioRefusalText(detail);
    if (text && !text.startsWith('{')) return studioHealthEsc(text);
  }
  return studioHealthErrorText(error);
}

async function studioHealthCheckComments(pageId) {
  const key = `chk:${pageId}`;
  if (!isCurrentUserAdmin() || _studioHealth.busy[key]) return;
  const context = captureStudioHealthContext();
  _studioHealth.busy[key] = true;
  delete _studioHealth.results[key];
  studioHealthRerender();
  try {
    const result = await studioHealthApi(`/api/studio/admin/pages/${encodeURIComponent(pageId)}/check-comments`, { method: 'POST', body: {} }, { timeoutMs: STUDIO_HEALTH_META_TIMEOUT_MS });
    if (!studioHealthContextIsCurrent(context)) return;
    _studioHealth.results[key] = { tone: result?.errorCode ? 'amber' : 'emerald', text: studioHealthCheckResultText(result) };
  } catch (error) {
    if (!studioHealthContextIsCurrent(context)) return;
    _studioHealth.results[key] = { tone: 'amber', text: studioHealthCheckErrorText(error) };
  } finally {
    if (studioHealthGenerationIsCurrent(context)) { delete _studioHealth.busy[key]; studioHealthRerender(); }
  }
}

// ---------- rendering ----------

function studioHealthTone(tone) {
  const tones = {
    emerald: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-200',
    amber: 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200',
    rose: 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200'
  };
  return tones[tone] || tones.amber;
}

function studioHealthNote(note) {
  return note ? `<p class="mt-2 rounded-xl ${studioHealthTone(note.tone)} p-3 text-sm" role="status">${note.text}</p>` : '';
}

function studioHealthCard(icon, title, body) {
  return `<div class="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-800/70 p-4"><div class="flex items-center gap-2 mb-2"><i data-lucide="${icon}" class="w-4 h-4 text-blue-600"></i><h4 class="text-sm font-black text-slate-900 dark:text-white">${title}</h4></div><div class="space-y-1 text-sm text-slate-600 dark:text-slate-300">${body}</div></div>`;
}

function studioHealthLine(label, value) {
  return `<div class="flex items-center justify-between gap-3"><span>${label}</span><span class="font-bold text-slate-900 dark:text-white" dir="ltr">${value}</span></div>`;
}

// A {key: count} map as lines; ``label`` turns each key into bilingual HTML (never the raw key).
function studioHealthCounts(map, label) {
  const entries = Object.entries(map || {}).filter(([, n]) => Number(n) > 0);
  return entries.map(([name, n]) => studioHealthLine(label(name), studioHealthEsc(n))).join('');
}

function studioHealthSecondsSince(stamp) {
  const at = Date.parse(String(stamp || ''));
  return Number.isFinite(at) ? Math.max(0, (Date.now() - at) / 1000) : NaN;
}

// One ad account's minimum daily budget: its values, and beside them the error of a later
// read that failed (the server keeps the last good values of a row Meta did not answer).
function studioHealthBudgetRow(row) {
  const hasValues = row.readAt ? true : !row.errorCode;
  const error = row.errorCode ? studioHealthMetaCode(row.errorCode, row.providerCode) : '';
  if (!hasValues) return studioHealthLine(studioHealthEsc(row.account), error);
  const values = `${studioHealthEsc(row.currency)} ${studioHealthEsc(row.minDailyBudget ?? '—')} <span class="text-[11px] text-slate-500">${studioHealthText('(smallest unit, e.g. cents)', '(أصغر وحدة، مثل السنت)')}</span>`;
  if (!error) return studioHealthLine(studioHealthEsc(row.account), values);
  const age = studioHealthSecondsSince(row.readAt);
  const earlier = Number.isFinite(age) ? ` (${studioHealthAge(age)})` : '';
  return studioHealthLine(studioHealthEsc(row.account), `${values} <span class="block text-[11px] font-normal text-amber-700 dark:text-amber-300">${studioHealthText('Earlier reading', 'قراءة سابقة')}${earlier} · ${studioHealthText('last try', 'آخر محاولة')}: ${error}</span>`);
}

function studioHealthPercentiles(values, unit) {
  if (!values) return studioHealthText('no data yet', 'لا بيانات بعد');
  return studioHealthText(`median ${values.p50}${unit}, 95% ≤ ${values.p95}${unit}, max ${values.max}${unit} (${values.sample})`,
    `الوسيط ${values.p50}${unit}، و95% ≤ ${values.p95}${unit}، والأعلى ${values.max}${unit} (${values.sample})`);
}

function studioHealthYesNo(value) {
  if (value === true) return studioHealthText('yes', 'نعم');
  if (value === false) return studioHealthText('no', 'لا');
  return studioHealthText('unknown', 'غير معروف');
}

function renderStudioHealthToken() {
  const t = _studioHealth.token;
  if (!t) return studioHealthCard('key-round', studioHealthText('Meta token', 'رمز ميتا'), studioHealthEsc(_studioHealth.tokenError || studioHealthText('Loading…', 'جارٍ التحميل…')));
  const webhooks = Object.values(t.webhookCounts?.countsByObjectField || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
  let body;
  if (t.configured === false) body = `<p>${studioHealthText('The token check is not set up (ALBAYAN_META_APP_ID).', 'فحص الرمز غير مُعدّ (ALBAYAN_META_APP_ID).')}</p>`;
  else if (!t.checked) body = `<p>${studioHealthText('Not checked yet for the current token.', 'لم يُفحص الرمز الحالي بعد.')}</p>`;
  else body = [
    studioHealthLine(studioHealthText('Valid', 'صالح'), studioHealthYesNo(t.isValid === true)),
    studioHealthLine(studioHealthText('Days left', 'الأيام المتبقية'), t.expiresNever ? studioHealthText('never expires', 'لا ينتهي') : studioHealthEsc(t.daysLeft ?? '—')),
    studioHealthLine(studioHealthText('Missing permissions', 'صلاحيات ناقصة'), studioHealthEsc((t.missingScopes || []).length))
  ].join('');
  body += studioHealthLine(studioHealthText('Webhook deliveries counted', 'تسليمات الويب هوك المحسوبة'), studioHealthEsc(webhooks));
  return studioHealthCard('key-round', studioHealthText('Meta token', 'رمز ميتا'), body);
}

function renderStudioHealthFacts() {
  const report = _studioHealth.facts;
  if (!report) {
    return `<p class="text-sm text-slate-500">${studioHealthEsc(_studioHealth.factsError || studioHealthText('Loading…', 'جارٍ التحميل…'))}</p>`;
  }
  const f = report.facts || {};
  const b = f.b || {};
  const c = f.c || {};
  const g = f.g || {};
  const i = f.i || {};
  const s = f.s || {};
  const days = Number(report.windowDays || 30);
  const budget = f.f || {};
  const cards = [
    studioHealthCard('message-square-x', studioHealthText(`Facebook private replies (${days} days)`, `الردود الخاصة على فيسبوك (${days} يوماً)`),
      studioHealthLine(studioHealthText('Sent', 'أُرسلت'), studioHealthEsc(b.privateRepliesSent || 0))
      + studioHealthLine(studioHealthText('Failed', 'فشلت'), studioHealthEsc(b.failures || 0))
      + studioHealthCounts(b.byClass, studioHealthCodeLabel) + studioHealthCounts(b.byCode, studioHealthProviderCodeLabel)),
    studioHealthCard('message-circle-reply', studioHealthText(`Facebook public replies without error (${days} days)`, `الردود العامة على فيسبوك دون خطأ (${days} يوماً)`),
      studioHealthLine(studioHealthText('Replies', 'ردود'), studioHealthEsc(g.publicRepliesWithoutError || 0))
      + studioHealthLine(studioHealthText('Different commenters', 'معلّقون مختلفون'), studioHealthEsc(g.distinctCommenters || 0))
      + `<p class="text-[11px] text-slate-500">${studioHealthText('Staff and test accounts cannot be told apart, so every commenter is counted.', 'لا يمكن تمييز حسابات الفريق أو الاختبار، لذلك يُحسب كل المعلّقين.')}</p>`),
    studioHealthCard('calendar-days', studioHealthText('Requests with a daily budget', 'طلبات بميزانية يومية'),
      studioHealthLine(studioHealthText('Now', 'الآن'), studioHealthEsc(c.total || 0))
      + studioHealthCounts(c.byStatus, studioHealthStatusLabel)
      + studioHealthLine(studioHealthText('Archived', 'مؤرشفة'), studioHealthEsc(c.archived || 0))),
    studioHealthCard('list-checks', studioHealthText('Ad-account allowlist', 'قائمة الحسابات الإعلانية المسموحة'),
      studioHealthLine(studioHealthText('Configured', 'مُعدّة'), studioHealthYesNo(f.d?.allowlistConfigured === true))),
    studioHealthCard('wallet', studioHealthText('Meta minimum daily budget', 'الحد الأدنى اليومي لميزانية ميتا'),
      `<p class="text-[11px] text-slate-500">${budget.checked ? studioHealthAge(budget.ageSeconds) : studioHealthText('Not read yet: press Refresh from Meta.', 'لم تُقرأ بعد: اضغط تحديث من ميتا.')}${budget.stale && budget.checked ? ` · ${studioHealthText('older than 24 h', 'أقدم من 24 ساعة')}` : ''}</p>`
      + (budget.accounts || []).filter(a => a && typeof a === 'object').map(studioHealthBudgetRow).join('')),
    studioHealthCard('webhook', studioHealthText('Page webhook subscription', 'اشتراك الصفحات في الويب هوك'),
      `<p class="text-[11px] text-slate-500">${i.checked ? studioHealthAge(i.ageSeconds) : studioHealthText('Not read yet: press Refresh from Meta.', 'لم تُقرأ بعد: اضغط تحديث من ميتا.')}</p>`
      + studioHealthLine(studioHealthText('Linked pages', 'الصفحات المربوطة'), studioHealthEsc(i.linkedPages || 0))
      + (i.checked ? studioHealthLine(studioHealthText('Subscribed', 'مشتركة'), studioHealthEsc(i.subscribed || 0))
        + studioHealthLine(studioHealthText('Not subscribed', 'غير مشتركة'), studioHealthEsc(i.notSubscribed || 0))
        + studioHealthLine(studioHealthText('Could not check', 'تعذّر الفحص'), studioHealthEsc((i.error || 0) + (i.notChecked || 0)))
        + (Number(i.kept) > 0 ? studioHealthLine(studioHealthText('Earlier value kept (the last try failed)', 'قيمة سابقة محفوظة (فشلت آخر محاولة)'), studioHealthEsc(i.kept)) : '') : '')
      + studioHealthCounts(i.errorCodes, studioHealthCodeLabel)
      + (i.checked && !i.appIdConfigured ? `<p class="text-[11px] text-slate-500">${studioHealthText('ALBAYAN_META_APP_ID is not set: any app with the feed field counted.', 'ALBAYAN_META_APP_ID غير مُعدّ: احتُسب أي تطبيق يشترك في feed.')}</p>` : '')),
    studioHealthCard('landmark', studioHealthText('Ad account funds (last reading)', 'أموال الحسابات الإعلانية (آخر قراءة)'),
      (f.n1?.accounts || []).map(a => studioHealthLine(studioHealthEsc(a.account), a.readError
        ? studioHealthText('not readable', 'غير مقروء')
        : `${studioHealthEsc(a.currency)} · ${studioHealthText('prepaid', 'مسبق الدفع')}: ${studioHealthYesNo(a.isPrepay)} · ${studioHealthText('funds shown', 'الأموال ظاهرة')}: ${studioHealthYesNo(a.fundsHidden ? false : a.fundsTextPresent)}`)).join('')
      || `<p>${studioHealthText('No reading stored yet.', 'لا توجد قراءة محفوظة بعد.')}</p>`),
    studioHealthCard('trending-up', studioHealthText('Meta spend after confirmation (Manager ads)', 'إنفاق ميتا بعد التأكيد (إعلانات المدير)'),
      studioHealthLine(studioHealthText('Confirmed ads', 'إعلانات مؤكدة'), studioHealthEsc(s.confirmed || 0))
      + studioHealthLine(studioHealthText('Compared later', 'قورنت لاحقاً'), studioHealthEsc(s.compared || 0))
      + studioHealthLine(studioHealthText('Higher / lower / same', 'أعلى / أقل / نفسه'), `${studioHealthEsc(s.higher || 0)} / ${studioHealthEsc(s.lower || 0)} / ${studioHealthEsc(s.unchanged || 0)}`)
      + `<p class="text-[11px] text-slate-500">${studioHealthText('Change (cents)', 'التغيّر (سنت)')}: ${studioHealthPercentiles(s.driftMinor, '')}</p>`
      + `<p class="text-[11px] text-slate-500">${studioHealthText('Hours from planned end to confirmation', 'الساعات من النهاية المخططة حتى التأكيد')}: ${studioHealthPercentiles(s.hoursEndToConfirmation, studioHealthText('h', 'س'))}</p>`)
  ];
  return `<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${renderStudioHealthToken()}${cards.join('')}</div>`;
}

function renderStudioHealthPage(page) {
  const id = String(page?.id || '');
  if (!id) return '';
  const safeId = studioHealthEsc(id);
  const ig = String(page.platform || '') === 'ig';
  const subKey = `sub:${id}`;
  const igKey = `ig:${id}`;
  const checkKey = `chk:${id}`;
  const form = _studioHealth.igForm[id] || { target: '', text: '' };
  const button = (key, onclick, icon, label) => `<button type="button" onclick="${onclick}" ${_studioHealth.busy[key] ? 'disabled' : ''} class="touch-target min-h-11 rounded-xl border border-blue-200 dark:border-blue-800 px-3 text-xs font-bold text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-60 inline-flex items-center gap-1.5"><i data-lucide="${icon}" class="w-3.5 h-3.5"></i>${_studioHealth.busy[key] ? studioHealthText('Checking…', 'جارٍ الفحص…') : label}</button>`;
  return `<div class="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-800/70 p-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="min-w-0"><span class="block truncate text-sm font-bold text-slate-800 dark:text-white">${studioHealthEsc(page.name || studioHealthText('Linked page', 'صفحة مربوطة'))}</span><span class="block text-[11px] text-slate-500">${ig ? 'Instagram' : 'Facebook'}</span></span>
        <div class="flex flex-wrap items-center gap-2">
          ${button(subKey, `studioHealthSubscribeTest('${safeId}')`, 'webhook', studioHealthText('Test subscription', 'اختبار الاشتراك'))}
          ${ig ? button(igKey, `studioHealthIgReadTest('${safeId}')`, 'scan-search', studioHealthText('Read test', 'اختبار القراءة')) : ''}
          ${ig ? button(checkKey, `studioHealthCheckComments('${safeId}')`, 'message-circle-reply', studioHealthText('Check recent comments now', 'افحص التعليقات الأخيرة الآن')) : ''}
        </div>
      </div>
      ${ig ? `<div class="mt-3 grid gap-2 sm:grid-cols-2">
        <input id="studio-health-ig-target-${safeId}" type="text" maxlength="40" value="${studioHealthEsc(form.target)}" oninput="studioHealthSetIgField('${safeId}', 'target', this.value)" class="glass-input min-h-11 w-full rounded-xl px-3 text-sm" placeholder="${studioHealthText('Optional: comment id, or a code written in it', 'اختياري: رقم التعليق أو رمز مكتوب فيه')}" />
        <input id="studio-health-ig-text-${safeId}" type="text" maxlength="300" value="${studioHealthEsc(form.text)}" oninput="studioHealthSetIgField('${safeId}', 'text', this.value)" class="glass-input min-h-11 w-full rounded-xl px-3 text-sm" placeholder="${studioHealthText('Optional: one public reply to send', 'اختياري: رد عام واحد للإرسال')}" />
      </div>
      <p class="mt-1 text-[11px] text-slate-500">${studioHealthText('One read test per account per day. Fill both fields before pressing to also send one reply; the same comment is never answered twice.', 'اختبار قراءة واحد لكل حساب يومياً. املأ الحقلين قبل الضغط لإرسال رد واحد أيضاً؛ لا يُرد على التعليق نفسه مرتين.')}</p>
      <p class="mt-1 text-[11px] text-slate-500">${studioHealthText('Check recent comments now: the owner\'s rules answer the new comments as the webhook would. Once a minute per account; old comments are never answered.', 'افحص التعليقات الأخيرة الآن: تردّ قواعد المالك على التعليقات الجديدة كما يفعل الويب هوك. مرة كل دقيقة لكل حساب؛ لا يُرد على التعليقات القديمة أبداً.')}</p>` : ''}
      ${studioHealthNote(_studioHealth.results[subKey])}
      ${studioHealthNote(_studioHealth.results[igKey])}
      ${studioHealthNote(_studioHealth.results[checkKey])}
    </div>`;
}

function renderStudioHealthSection() {
  if (!isCurrentUserAdmin()) return '';
  studioHealthEnsureLoaded();
  const report = _studioHealth.facts;
  const pages = (_studioHealth.pages || []).filter(p => p && p.id);
  return `<section class="mt-6" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}">
    <div class="glass-panel rounded-3xl p-5 sm:p-7">
      <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div><h2 class="text-2xl font-black text-slate-900 dark:text-white">${studioHealthText('Studio health', 'صحة الاستوديو')}</h2><p class="text-sm text-slate-500">${studioHealthText('Admin checks for Meta and the studio. Counts only, no customer data.', 'فحوص المدير لميتا والاستوديو. أرقام فقط، دون بيانات العملاء.')}</p></div>
        <button type="button" onclick="studioHealthRefreshFacts()" ${_studioHealth.refreshing ? 'disabled' : ''} class="touch-target min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-black text-white hover:bg-blue-700 disabled:opacity-60 inline-flex items-center gap-2"><i data-lucide="refresh-cw" class="w-4 h-4"></i>${_studioHealth.refreshing ? studioHealthText('Reading from Meta…', 'جارٍ القراءة من ميتا…') : studioHealthText('Refresh from Meta', 'تحديث من ميتا')}</button>
      </div>
      ${report ? `<p class="mb-3 text-[11px] text-slate-500">${studioHealthText('Meta readings are kept 24 h; refresh at most twice in 10 minutes.', 'تُحفظ قراءات ميتا 24 ساعة؛ التحديث مرتان كحد أقصى كل 10 دقائق.')}</p>` : ''}
      ${studioHealthNote(_studioHealth.refreshNote)}
      <div class="mt-3">${renderStudioHealthFacts()}</div>
      <h3 class="mt-6 mb-3 text-lg font-black text-slate-900 dark:text-white">${studioHealthText('Linked pages: Meta tests', 'الصفحات المربوطة: اختبارات ميتا')}</h3>
      <div class="space-y-3">${pages.length ? pages.map(renderStudioHealthPage).join('') : `<p class="text-sm text-slate-500">${studioHealthText('No linked pages yet.', 'لا توجد صفحات مربوطة بعد.')}</p>`}</div>
    </div>
  </section>`;
}
// ==========================================
// ALBAYAN STUDIO v2 — CORE (plan task P2-01, studio.js lazy bundle)
// ==========================================
// Shared helpers for the v2 screens (the 15h shell and the screens after it). Nothing in this file
// draws a screen, and nothing runs while the bundle loads: every helper waits to be called.
// - studioApi(): apiJson with the studio error map attached (error.studio = studioErrorInfo(error)).
//   ONE lookup for every refusal: the /api/studio codes (studio_errors.py) in STUDIO_ERROR_TEXTS,
//   the older routes' English prefixes through the classic map (adsStudioRefusalText, 15c, reused,
//   never copied), 429 by its status (it has no body), and a calm fallback that never shows raw
//   English to an Arabic reader.
// - studioMe() / studioLoadMe(): GET /api/studio/me, cleaned, kept per user; a reply younger than
//   maxAge is reused and a read already on its way is joined (one request at a time).
// - studioPulseWatch(): a light poller hook for a {changedAt} route: it polls only while the page is
//   visible and keeps no timer at all while the tab is hidden.
// - studioStageView(): the server's display stage (derive_display_stage) made safe to show. The
//   stage keys, looks and flag labels are checked against server/systems/ads_studio/stage_cases.json.
// - studioUsd() / studioLyd(): money in its own currency (LYD never wears "$").
// - studioParseAmount() / studioParsePhone(): typed amounts (Arabic digits, ٫ and , decimals,
//   thousands separators; a mix that could mean two amounts is refused) and phone numbers (E.164;
//   the Libyan 09x / 218 / 00218 forms, a mobile with all nine digits).

function studioEsc(value) {
  return Security.escapeHtml(String(value === null || value === undefined ? '' : value));
}

// A short piece of text left to right inside Arabic (amounts, phone numbers), escaped.
function studioLtr(text) {
  return `<bdi dir="ltr">${studioEsc(text)}</bdi>`;
}

// The {en, ar} pair the server sends, in the reader's language (the other language when one is
// missing); '' when neither is a usable string. Control characters are dropped; callers escape.
function studioPickText(labels, max = 300) {
  if (!labels || typeof labels !== 'object') return '';
  const pick = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
  const first = adsStudioIsAr() ? pick(labels.ar) : pick(labels.en);
  return first || pick(labels.en) || pick(labels.ar);
}

// ------------------------------------------------------------------ refusals (P2-01, P2-11)

// Every /api/studio code (studio_errors.py STUDIO_ERROR_CODES; a check keeps the two in step) and the
// client's own cases (no server code: by HTTP status or a lost connection). [English, Arabic].
const STUDIO_ERROR_TEXTS = Object.freeze({
  INVALID_REQUEST: ['Something in this form is not valid. Check it and try again.', 'في هذا النموذج شيء غير صالح. راجعه وأعد المحاولة.'],
  UNKNOWN_FIELD: ['This screen is out of date. Reload the page and try again.', 'هذه الشاشة قديمة. أعد تحميل الصفحة ثم حاول مرة أخرى.'],
  INVALID_VALUE: ['One of the values is not allowed. Check it and try again.', 'إحدى القيم غير مسموح بها. راجعها وأعد المحاولة.'],
  CROSS_SITE: ['Open Albayan directly and try again.', 'افتح البيان مباشرة ثم أعد المحاولة.'],
  ADMIN_ONLY: ['Only an admin can do this.', 'هذا الإجراء للمدير فقط.'],
  UNKNOWN_SETTING: ['This setting does not exist. Reload the page.', 'هذا الإعداد غير موجود. أعد تحميل الصفحة.'],
  VERSION_CONFLICT: ['Someone saved a newer version first. Reload and try again.', 'حفظ شخص آخر نسخة أحدث أولاً. أعد التحميل وحاول مرة أخرى.'],
  RATE_LIMITED: ['Too many requests. Please wait a minute and try again.', 'طلبات كثيرة. انتظر دقيقة ثم أعد المحاولة.'],
  UNKNOWN_PAGE: ['This page is no longer linked.', 'هذه الصفحة لم تعد مربوطة.'],
  NOT_INSTAGRAM: ['This linked page is not an Instagram account.', 'هذه الصفحة المربوطة ليست حساب إنستغرام.'],
  ALREADY_TESTED_TODAY: ['Already tested today. Try again tomorrow (Tripoli time).', 'تم الاختبار اليوم. أعد المحاولة غداً (بتوقيت طرابلس).'],
  META_NOT_CONFIGURED: ["Albayan's Meta connection is not set up yet.", 'ربط البيان مع ميتا غير مُعدّ بعد.'],
  META_PAUSED: ['Meta asked Albayan to wait. Try again in a few minutes.', 'طلبت ميتا من البيان الانتظار. أعد المحاولة بعد بضع دقائق.'],
  UNKNOWN_CAMPAIGN: ['This request was not found. Refresh the page.', 'لم نجد هذا الطلب. حدّث الصفحة.'],
  STAFF_ONLY: ['Only the Albayan team can do this.', 'هذا الإجراء لفريق البيان فقط.'],
  NOT_LINKED: ['This request is not linked to a Meta campaign yet.', 'هذا الطلب غير مربوط بحملة ميتا بعد.'],
  SESSION_ENDED: ['Your session has ended. Sign in again.', 'انتهت جلستك. سجّل الدخول مرة أخرى.'],
  FORBIDDEN: ['You do not have access to this.', 'لا تملك صلاحية الوصول إلى هذا.'],
  NOT_FOUND: ['This item was not found. Refresh the page.', 'لم نجد هذا العنصر. حدّث الصفحة.']
});

// By kind: a read can simply be tried again; after an action whose answer never arrived, nobody can
// promise that nothing happened, so the reader is sent to the latest state first.
const STUDIO_ERROR_KIND_TEXTS = Object.freeze({
  read: Object.freeze({
    SERVER: ['Albayan could not load this right now. Try again in a minute.', 'تعذّر على البيان تحميل هذا الآن. أعد المحاولة بعد دقيقة.'],
    NETWORK: ['No connection to Albayan. Check your internet and try again.', 'لا يوجد اتصال بالبيان. تحقّق من الإنترنت وأعد المحاولة.'],
    UNKNOWN: ['This could not be loaded. Try again in a moment.', 'تعذّر التحميل. أعد المحاولة بعد لحظات.']
  }),
  action: Object.freeze({
    SERVER: ['We could not confirm whether this went through. Refresh to see the latest state before trying again.', 'لم نتمكن من التأكد من إتمام العملية. حدّث الصفحة لترى آخر حالة قبل المحاولة مرة أخرى.'],
    NETWORK: ['The connection dropped, so we could not confirm this. Refresh to see the latest state before trying again.', 'انقطع الاتصال، لذلك لم نتأكد من إتمام العملية. حدّث الصفحة لترى آخر حالة قبل المحاولة مرة أخرى.'],
    // PLAN.md §5.5: an unknown refusal says what matters most — the money did not move.
    UNKNOWN: ['The action could not be completed. Nothing changed in your balance.', 'تعذّر إتمام العملية. لم يتغير شيء في رصيدك.']
  })
});

function studioKnownErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(STUDIO_ERROR_TEXTS, code);
}

// Everything a screen needs to explain a failed call: {status, code, retryAfterSeconds, message,
// text}. `text` is plain text in the reader's language (escape it when drawing); `message` is the
// server's own words, for logs only. kind: 'read' (a GET) or 'action' (anything that changes data).
function studioErrorInfo(error, kind = 'action') {
  const mode = kind === 'read' ? 'read' : 'action';
  const base = adsStudioErrorInfo(error);  // 15c: {code, message, retryAfterSeconds}; 429 -> RATE_LIMITED
  const rawStatus = Number(error && error.status);
  const status = Number.isSafeInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : 0;
  const serverCode = /^[A-Z][A-Z0-9_]{1,47}$/.test(base.code) ? base.code : '';
  const message = String(base.message || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
  const pair = pairOrNull => pairOrNull ? adsStudioText(pairOrNull[0], pairOrNull[1]) : '';
  let code = serverCode;
  let text = '';
  if (status === 429 || code === 'RATE_LIMITED') {
    code = 'RATE_LIMITED';
    const wait = adsStudioWaitText(base.retryAfterSeconds);
    text = wait
      ? adsStudioText(`Too many requests. Please wait ${wait[0]} and try again.`, `طلبات كثيرة. انتظر ${wait[1]} ثم أعد المحاولة.`)
      : pair(STUDIO_ERROR_TEXTS.RATE_LIMITED);
  } else if (code) {
    // A code this screen does not know yet (a newer server) is never shown raw.
    text = studioKnownErrorCode(code) ? pair(STUDIO_ERROR_TEXTS[code]) : '';
  } else if (status === 401) {
    code = 'SESSION_ENDED';
  } else if (status === 422) {
    code = 'INVALID_REQUEST';  // FastAPI's own body check: a list of fields, not words for a person
  } else if (status >= 400 && status < 500 && message && !/^\s*[[{]/.test(message)) {
    // The older routes send a plain string with a stable English prefix: the classic map knows them.
    // Arabic shows only what the map translates; English shows the refusal itself (400/403/409).
    const mapped = adsStudioRefusalText(message);
    if (adsStudioIsAr()) text = mapped && mapped !== message ? mapped : '';
    else if (status === 400 || status === 403 || status === 409) text = mapped;
  }
  if (!text && studioKnownErrorCode(code)) text = pair(STUDIO_ERROR_TEXTS[code]);
  if (!text) {
    const name = String((error && error.name) || '');
    const words = String((error && error.message) || '');
    const offline = !status && (name === 'AbortError' || /failed to fetch|networkerror|network error|load failed|network request failed/i.test(words));
    let fallback = 'UNKNOWN';
    if (status >= 500) fallback = 'SERVER';
    else if (!status && offline) fallback = 'NETWORK';
    else if (status === 403) { code = code || 'FORBIDDEN'; text = pair(STUDIO_ERROR_TEXTS.FORBIDDEN); }
    else if (status === 404) { code = code || 'NOT_FOUND'; text = pair(STUDIO_ERROR_TEXTS.NOT_FOUND); }
    if (!text) {
      code = code || fallback;
      text = pair(STUDIO_ERROR_KIND_TEXTS[mode][fallback]);
    }
  }
  return { status, code, retryAfterSeconds: base.retryAfterSeconds || 0, message, text };
}

// apiJson for the studio screens: the same call, and a failure carries error.studio (above).
async function studioApi(path, options = {}, timeout = {}) {
  try {
    return await apiJson(path, options, timeout);
  } catch (error) {
    const method = String((options && options.method) || 'GET').toUpperCase();
    const failure = error && typeof error === 'object' ? error : new Error(String(error || 'Request failed'));
    try { failure.studio = studioErrorInfo(failure, method === 'GET' ? 'read' : 'action'); } catch (_) { /* keeps the plain error */ }
    throw failure;
  }
}

// ------------------------------------------------------------------ GET /api/studio/me

const STUDIO_ME_MAX_AGE_MS = 5 * 60 * 1000;  // the switches can change; a reply this old is read again
const STUDIO_ME_RETRY_MS = 60 * 1000;        // a failed first read is tried again at most once a minute
const _studioMe = { forUser: '', value: null, loadedAt: 0, failedAt: 0, promise: null, generation: 0, session: 0, listeners: new Set() };

function studioMeUserId() {
  return typeof state !== 'undefined' && state && state.currentUser ? String(state.currentUser.id || '') : '';
}

function studioMeFlag(value) {
  return value === true;
}

// The reply, cleaned: only the fields and values the screens understand; anything else reads as
// the safe side (classic layouts, services off, intake unknown).
function studioCleanMe(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const services = raw.services && typeof raw.services === 'object' ? raw.services : {};
  const plain = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return {}; }
  };
  const contact = plain(raw.contact);
  return Object.freeze({
    ui: raw.ui === 'v2' ? 'v2' : 'classic',
    staffDesk: raw.staffDesk === 'v2' ? 'v2' : 'classic',
    isAdmin: studioMeFlag(raw.isAdmin),
    isStaff: studioMeFlag(raw.isStaff) || studioMeFlag(raw.isAdmin),
    services: Object.freeze({
      help: studioMeFlag(services.help),
      stopRequest: studioMeFlag(services.stopRequest),
      tiktok: studioMeFlag(services.tiktok)
    }),
    intakeOpen: raw.intake && typeof raw.intake.open === 'boolean' ? raw.intake.open : null,
    adLimits: typeof adsStudioCleanLimits === 'function' ? adsStudioCleanLimits(raw.adLimits) : plain(raw.adLimits),
    capabilities: plain(raw.capabilities),
    serviceHours: plain(raw.serviceHours),
    contact: Object.freeze({
      whatsapp: studioParsePhone(contact.whatsapp),
      phone: studioParsePhone(contact.phone),
      email: typeof contact.email === 'string' && contact.email.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+$/.test(contact.email) ? contact.email : ''
    }),
    metaConnection: plain(raw.metaConnection)
  });
}

// The current user's /me reply, or null while unknown (never another user's).
function studioMe() {
  const uid = studioMeUserId();
  return uid && _studioMe.forUser === uid ? _studioMe.value : null;
}

function studioMeLoading() {
  const uid = studioMeUserId();
  return !!(uid && _studioMe.forUser === uid && _studioMe.promise);
}

function studioResetMe() {
  _studioMe.generation++;  // a reply still on its way belongs to the old session: dropped
  _studioMe.session++;     // what a screen kept from the old session (the 15h layout) is dropped too
  _studioMe.forUser = '';
  _studioMe.value = null;
  _studioMe.loadedAt = 0;
  _studioMe.failedAt = 0;
  _studioMe.promise = null;
}

// Changes at every reset (sign-out, session end, another user): a screen compares it with the one it
// kept to know that its copy belongs to an older session.
function studioMeSession() {
  return _studioMe.session;
}

// fn() runs after every settled read (a new reply, or a failure that kept the last good one).
function studioMeSubscribe(fn) {
  if (typeof fn === 'function') _studioMe.listeners.add(fn);
  return () => _studioMe.listeners.delete(fn);
}

function studioMeNotify() {
  for (const fn of Array.from(_studioMe.listeners)) {
    try { fn(studioMe()); } catch (_) { /* one screen never breaks another */ }
  }
}

// Resolves to the reply (null when unknown). A reply younger than maxAgeMs is reused; a read on its
// way is joined; a failed read keeps the last good reply. maxAgeMs 0 asks the server again.
function studioLoadMe(maxAgeMs = STUDIO_ME_MAX_AGE_MS) {
  const uid = studioMeUserId();
  if (!uid || typeof isServerModeEnabled !== 'function' || !isServerModeEnabled()) return Promise.resolve(null);
  if (_studioMe.forUser !== uid) studioResetMe();  // another user's reply is never reused
  if (_studioMe.promise) return _studioMe.promise;
  const age = Date.now() - _studioMe.loadedAt;
  const maxAge = Math.max(0, Number(maxAgeMs) || 0);
  if (_studioMe.value && age >= 0 && age < maxAge) return Promise.resolve(_studioMe.value);
  if (!_studioMe.value && _studioMe.failedAt && Date.now() - _studioMe.failedAt < STUDIO_ME_RETRY_MS) return Promise.resolve(null);
  _studioMe.forUser = uid;
  const generation = ++_studioMe.generation;
  const promise = (async () => {
    let value = null;
    let aborted = false;
    try {
      value = studioCleanMe(await apiJson('/api/studio/me', { method: 'GET' }));
    } catch (error) {
      // Leaving a page cancels its reads: that is no failure, the next screen asks again.
      aborted = !!(error && error.name === 'AbortError');
    }
    if (generation !== _studioMe.generation || uid !== studioMeUserId()) {
      // The session moved on (signed out, expired, another user). While no reset or newer read came
      // after this one, the waiting slot is still this read's: free it, or the same user signing in
      // again would join this dead read and never ask the server again.
      if (generation === _studioMe.generation) _studioMe.promise = null;
      return null;
    }
    _studioMe.promise = null;
    if (value) {
      _studioMe.value = value;
      _studioMe.loadedAt = Date.now();
      _studioMe.failedAt = 0;
    } else if (!aborted) {
      _studioMe.failedAt = Date.now();
    }
    studioMeNotify();
    return _studioMe.value;
  })();
  _studioMe.promise = promise;
  return promise;
}

// ------------------------------------------------------------------ pulse poller hook

const STUDIO_PULSE_DEFAULT_MS = 30000;
const STUDIO_PULSE_MIN_MS = 10000;
const STUDIO_PULSE_MAX_BACKOFF_MS = 5 * 60 * 1000;
const _studioPulse = { watches: new Map(), listening: false };

function studioPulseVisible() {
  try { return typeof document === 'undefined' || document.visibilityState !== 'hidden'; } catch (_) { return true; }
}

// Polls `path` (a GET that answers {changedAt}) every intervalMs while the page is visible and calls
// onChange(value, reply) when the value moves (never for the first reading). While the tab is hidden
// there is no timer at all; coming back polls at once if a round was missed. One read at a time;
// failures back off (429: the server's Retry-After). Signing out or another user stops the watch.
// Returns stop(). A second watch under the same key replaces the first.
function studioPulseWatch(key, options = {}) {
  const name = String(key || '');
  const path = String(options.path || '');
  if (!name || !/^\/api\/[A-Za-z0-9/_?=&.-]+$/.test(path) || typeof options.onChange !== 'function') return () => {};
  studioPulseStop(name);
  const watch = {
    key: name,
    path,
    field: typeof options.field === 'string' && options.field ? options.field : 'changedAt',
    intervalMs: Math.max(STUDIO_PULSE_MIN_MS, Number(options.intervalMs) || STUDIO_PULSE_DEFAULT_MS),
    onChange: options.onChange,
    uid: studioMeUserId(),
    timer: null,
    inFlight: false,
    last: undefined,
    lastPollAt: 0,
    failures: 0,
    stopped: false
  };
  _studioPulse.watches.set(name, watch);
  studioPulseListen();
  studioPulseSchedule(watch, 0);
  return () => studioPulseStop(name);
}

function studioPulseStop(key) {
  const watch = _studioPulse.watches.get(String(key || ''));
  if (!watch) return;
  watch.stopped = true;
  if (watch.timer) clearTimeout(watch.timer);
  watch.timer = null;
  _studioPulse.watches.delete(watch.key);
}

function studioPulseSchedule(watch, delayMs) {
  if (watch.stopped) return;
  if (watch.timer) { clearTimeout(watch.timer); watch.timer = null; }
  if (!studioPulseVisible()) return;  // hidden: no timer; the visibility handler starts it again
  watch.timer = setTimeout(() => { watch.timer = null; studioPulsePoll(watch); }, Math.max(0, Number(delayMs) || 0));
}

async function studioPulsePoll(watch) {
  if (watch.stopped || watch.inFlight || !studioPulseVisible()) return;
  if (!watch.uid || watch.uid !== studioMeUserId()) { studioPulseStop(watch.key); return; }
  watch.inFlight = true;
  let delay = watch.intervalMs;
  try {
    const reply = await apiJson(watch.path, { method: 'GET' });
    const raw = reply && typeof reply === 'object' ? reply[watch.field] : undefined;
    const value = raw === undefined || raw === null ? '' : String(raw).slice(0, 100);
    const changed = watch.last !== undefined && value !== watch.last;
    watch.last = value;
    watch.failures = 0;
    if (changed && !watch.stopped && watch.uid === studioMeUserId()) {
      try { watch.onChange(value, reply); } catch (_) { /* a screen's handler never stops the watch */ }
    }
  } catch (error) {
    watch.failures++;
    const wait = Number(error && error.retryAfter);
    delay = error && error.status === 429 && wait > 0
      ? Math.min(wait * 1000, STUDIO_PULSE_MAX_BACKOFF_MS * 2)
      : Math.min(watch.intervalMs * (2 ** Math.min(watch.failures, 4)), STUDIO_PULSE_MAX_BACKOFF_MS);
  } finally {
    watch.inFlight = false;
    watch.lastPollAt = Date.now();
  }
  studioPulseSchedule(watch, delay);
}

function studioPulseListen() {
  if (_studioPulse.listening || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  _studioPulse.listening = true;
  document.addEventListener('visibilitychange', studioPulseOnVisibility);
}

function studioPulseOnVisibility() {
  const onScreen = studioPulseVisible();
  for (const watch of Array.from(_studioPulse.watches.values())) {
    if (!onScreen) {
      if (watch.timer) clearTimeout(watch.timer);
      watch.timer = null;
    } else if (!watch.timer && !watch.inFlight) {
      studioPulseSchedule(watch, Math.max(0, watch.lastPollAt + watch.intervalMs - Date.now()));
    }
  }
}

// ------------------------------------------------------------------ display stages (PLAN.md §5.4)

// Stage n is STUDIO_STAGE_KEYS[n - 1]; the same list, looks and flag words as the server's tables
// (stage_cases.json "tables", checked by scripts/test-mobile-ui.js). Colour never stands alone: every
// stage has its icon (the server's icon name, then the icon this app draws for it).
const STUDIO_STAGE_KEYS = Object.freeze([
  'draft', 'waiting_review', 'needs_changes', 'approved_setup', 'meta_reviewing', 'meta_rejected', 'delivery_problem',
  'running', 'paused', 'ended_settling', 'finished', 'stopped', 'rejected'
]);
const STUDIO_STAGE_LOOK = Object.freeze({
  draft: ['slate', 'pencil', 'pencil'],
  waiting_review: ['amber', 'clock', 'clock'],
  needs_changes: ['orange', 'message-warning', 'message-square-warning'],
  approved_setup: ['blue', 'badge-check', 'badge-check'],
  meta_reviewing: ['blue', 'shield', 'shield'],
  meta_rejected: ['red-orange', 'shield-alert', 'shield-alert'],
  delivery_problem: ['orange', 'alert-triangle', 'triangle-alert'],
  running: ['green', 'play', 'play'],
  paused: ['slate-blue', 'pause', 'pause'],
  ended_settling: ['slate', 'hourglass', 'hourglass'],
  finished: ['slate', 'flag', 'flag'],
  stopped: ['rose', 'stop', 'circle-stop'],
  rejected: ['red', 'x', 'x']
});
const STUDIO_STAGE_FLAGS = Object.freeze({
  runningPastEnd: ['Running past the promised end — the team is on it', 'ما زال يعمل بعد موعد الانتهاء — الفريق يتابعه'],
  stopRequested: ['Stop requested — we will pause it soon', 'طُلب الإيقاف — سنوقفه قريباً'],
  stale: ['Meta has not been checked for a while', 'لم نتحقق من ميتا منذ مدة']
});
const STUDIO_STAGE_TRACKER = Object.freeze(['not_sent', 'sent', 'approved', 'meta_review', 'running', 'ended', 'finished']);
const STUDIO_STAGE_ACTIONS = Object.freeze(['edit', 'send', 'delete', 'withdraw', 'ask', 'fix', 'stop_refund', 'ask_to_stop', 'archive', 'read_reasons', 'copy_fix']);

// One request's stage as the server derived it (GET /api/studio/campaigns/summary), ready to draw:
// the server's words in the reader's language, a look from the list above, and only the actions this
// app knows. A stage this app does not know yet keeps the server's label with a neutral look. "Meta
// used" exists only for a linked request in stages 4-10 (never before a link, PLAN.md §5.4).
// All text is plain: escape it when drawing. null for anything that is not a stage.
function studioStageView(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const number = Number(raw.stage);
  const byNumber = Number.isSafeInteger(number) && number >= 1 && number <= STUDIO_STAGE_KEYS.length ? STUDIO_STAGE_KEYS[number - 1] : '';
  const sentKey = typeof raw.stageKey === 'string' ? raw.stageKey : '';
  const key = STUDIO_STAGE_KEYS.includes(sentKey) ? sentKey : (sentKey ? '' : byNumber);
  const stage = key ? STUDIO_STAGE_KEYS.indexOf(key) + 1 : 0;
  const look = key ? STUDIO_STAGE_LOOK[key] : null;
  const linked = raw.linked === true;
  const used = raw.metaUsedMinor;  // null = Meta has not confirmed a spend: never read as $0
  const flags = Object.keys(STUDIO_STAGE_FLAGS).filter(flag => raw[flag] === true)
    .map(flag => ({ key: flag, text: adsStudioText(STUDIO_STAGE_FLAGS[flag][0], STUDIO_STAGE_FLAGS[flag][1]) }));
  const tracker = raw.tracker && typeof raw.tracker === 'object' ? raw.tracker : {};
  return {
    stage,
    key,
    known: !!key,
    label: studioPickText(raw.labels, 160) || adsStudioText('Status not available', 'الحالة غير متاحة'),
    tone: look ? look[0] : 'slate',
    icon: look ? look[2] : 'circle-help',
    money: studioPickText(raw.money),
    nextActor: studioPickText(raw.nextActorLabels, 120),
    variant: studioPickText(raw.variantLabels, 160),
    linked,
    checking: raw.checking === true,
    checkedAgo: studioPickText(raw.checkedAgo, 80),
    stale: raw.stale === true,
    metaUsedMinor: linked && stage >= 4 && stage <= 10 && Number.isSafeInteger(used) && used >= 0 ? used : null,
    flags,
    tracker: { step: STUDIO_STAGE_TRACKER.includes(tracker.step) ? tracker.step : '', side: tracker.side === true },
    actions: Array.isArray(raw.actions) ? raw.actions.filter(action => STUDIO_STAGE_ACTIONS.includes(action)) : [],
    reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String).filter(reason => /^[a-z_]{1,40}$/.test(reason)).slice(0, 10) : []
  };
}

// ------------------------------------------------------------------ money

// "1,234.56" (Latin digits, grouped: money reads the same on every phone) for a whole number of
// cents; '' for anything else.
function studioMinorText(minor) {
  const value = typeof minor === 'string' && /^-?\d{1,16}$/.test(minor.trim()) ? Number(minor.trim()) : minor;
  if (!Number.isSafeInteger(value)) return '';
  const abs = Math.abs(value);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

// US dollars (the ad wallet): "$1,234.56", "-$5.00"; "—" when the amount is unknown.
function studioUsd(minor) {
  const text = studioMinorText(minor);
  if (!text) return '—';
  return text.startsWith('-') ? `-$${text.slice(1)}` : `$${text}`;
}

// Libyan dinars (plans): "1,234.56 LYD" / "1,234.56 د.ل" — never "$".
function studioLyd(minor) {
  const text = studioMinorText(minor);
  return text ? `${text} ${adsStudioText('LYD', 'د.ل')}` : '—';
}

// ------------------------------------------------------------------ typed input

const STUDIO_MAX_AMOUNT_MINOR = 1e12;

// A typed amount in minor units (cents), or NaN. Built on the classic parser (adsStudioParseMoneyMinor,
// 15c: Arabic-Indic digits, ٫ and ، , "1,250" is a thousand, "12,5" is twelve and a half), plus the
// Arabic thousands sign ٬, a "$" and bidi marks around the number. What could mean two amounts is
// refused rather than guessed: more than two decimals, a sign, any other character, and a comma
// beside a point unless the commas group thousands before the decimals ("1,250.50" yes; "1.250,00",
// "1.234,56", "12,5.5" and "1,5.25" no: which one is the decimal sign?).
function studioParseAmount(raw) {
  if (raw === null || raw === undefined || typeof raw === 'object') return NaN;
  const text = normalizeDigitsAscii(String(raw))
    .replace(/[\s ‎‏‪-‮⁦-⁩]/g, '')
    .replace(/٬/g, ',')
    .replace(/^\$|\$$/g, '');
  if (!text || text.length > 24) return NaN;
  // The number as the classic parser reads it: each comma either groups thousands or is the decimal sign.
  let plain = text.replace(/،/g, ',').replace(/٫/g, '.');
  if (plain.includes(',')) {
    if (plain.includes('.')) {
      if (!/^\d{1,3}(,\d{3})+\.\d{0,2}$/.test(plain)) return NaN;  // no comma after the point either
      plain = plain.replace(/,/g, '');
    } else if (/^\d{1,3}(,\d{3})+$/.test(plain)) {
      plain = plain.replace(/,/g, '');
    } else if (/^\d*,\d*$/.test(plain)) {
      plain = plain.replace(',', '.');
    } else {
      return NaN;
    }
  }
  if (/\.\d{3,}$/.test(plain)) return NaN;  // more than two decimals
  const minor = adsStudioParseMoneyMinor(text);
  return Number.isSafeInteger(minor) && minor >= 0 && minor <= STUDIO_MAX_AMOUNT_MINOR ? minor : NaN;
}

// A typed phone number as E.164 ("+218912345678"), or '' when it is not one. Arabic digits, spaces,
// dots, dashes and brackets are allowed; 00 means +. Libyan numbers may be typed as 091 234 5678,
// 91 234 5678, 218 91 234 5678 or +218 091… (the local 0 dropped). After +218 a mobile (9…) has
// exactly 9 digits and a landline (1…-8…) 8 or 9. Any other country needs its +code. The server's
// rule is wider (studio_settings._phone: +, then 8-15 digits), so whatever passes here passes there.
function studioParsePhone(raw) {
  if (raw === null || raw === undefined || typeof raw === 'object') return '';
  let text = normalizeDigitsAscii(String(raw)).trim();
  if (!text || text.length > 32) return '';
  text = text.replace(/[\s().\- ‎‏‪-‮⁦-⁩]/g, '');
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  if (!/^\+?\d{6,20}$/.test(text)) return '';
  let number;
  if (text.startsWith('+')) number = text;
  else if (/^218\d{8,10}$/.test(text)) number = `+${text}`;
  else if (/^0\d{8,9}$/.test(text)) number = `+218${text.slice(1)}`;
  else if (/^9\d{8}$/.test(text)) number = `+218${text}`;
  else return '';
  if (number.startsWith('+2180')) number = `+218${number.slice(5)}`;
  if (number.startsWith('+218')) {
    const national = number.slice(4);
    return /^9\d{8}$/.test(national) || /^[1-8]\d{7,8}$/.test(national) ? number : '';
  }
  return /^\+[1-9]\d{7,14}$/.test(number) ? number : '';
}
// ==========================================
// ALBAYAN STUDIO v2 — SHELL (plan tasks P2-02a-d; styles P2-08 in assets/ads-workspace.css)
// ==========================================
// The v2 frame, drawn only when GET /api/studio/me says so: ui 'v2' for the customer layout,
// staffDesk 'v2' for the Team desk (staff only). renderAdsStudioView (15c) asks renderStudioV2View()
// first and draws the classic screens, unchanged, whenever the answer is '' (classic, local mode,
// /me unknown or failed, or any error here). The layout is fixed by the first /me answer of a visit
// to the studio; a later answer changes it only at the next page load or the next entry.
//
// Addresses stay on ?tab= (one view, no new paths), with &section=, &id= and &step=:
//   customer: home (the pinned 'dashboard' too), campaigns, replies, wallet, help, inbox, account,
//             builder (&section=boost|full &step=N, also any tab with section=builder) and posts.
//             A staff member in this layout while the Team desk is still off (rollout stage 2) keeps
//             the CLASSIC staff screens: review (review and launch queues, health) and, for an admin,
//             wallet (the classic Overview with the payment confirmations); a "Team desk" header
//             button opens the classic review;
//   Team desk: tab=review&section=requests|launch|settle|tickets|health|more.
// Back (PLAN.md §5.1): builder step N -> N-1; a detail (&id=) -> its list; any other tab -> Home
// (the desk: its Requests); Home -> leaves the studio: back to the app's screen it was opened from,
// else to the studio's way out (adsStudioBackTarget), else no button. The browser history mirrors
// that chain: every studio entry carries history.state.studioV2.chain (the keys from Home to itself).
// Leaving Home pushes, moving between tabs replaces, going up walks back through history, so the
// in-app Back button and the browser's Back always agree. A screen opened straight from a link (or
// after a reload this tab has no proof of) gets its parents put under it. The builder hides the
// section bar (focus mode).
// Screens not built yet show "Coming soon in the new studio" inside their own root.

const STUDIO_V2_TABS = Object.freeze([
  // [tab, icon, English, Arabic, place] place: 'nav' = bottom bar / side rail, 'head' = header button
  ['home', 'house', 'Home', 'الرئيسية', 'nav'],
  ['campaigns', 'megaphone', 'My ads', 'إعلاناتي', 'nav'],
  ['replies', 'messages-square', 'Pages & replies', 'الصفحات والردود', 'nav'],
  ['wallet', 'wallet', 'Wallet', 'المحفظة', 'nav'],
  ['help', 'life-buoy', 'Help', 'المساعدة', 'nav'],
  ['inbox', 'bell', 'Inbox', 'الإشعارات', 'head'],
  ['account', 'circle-user-round', 'Account', 'حسابي', 'head'],
  ['builder', 'wand-sparkles', 'New request', 'طلب جديد', ''],
  ['posts', 'send', 'Scheduled posts', 'المنشورات المجدولة', ''],
  ['review', 'badge-check', 'Team desk', 'مكتب الفريق', '']
]);

const STUDIO_V2_STAFF_SECTIONS = Object.freeze([
  ['requests', 'clipboard-list', 'Requests', 'الطلبات'],
  ['launch', 'rocket', 'Launch', 'الإطلاق'],
  ['settle', 'scale', 'Settle', 'التسوية'],
  ['tickets', 'ticket', 'Tickets', 'التذاكر'],
  ['health', 'activity', 'Health', 'التنبيهات'],
  ['more', 'ellipsis', 'More', 'المزيد']
]);

const STUDIO_V2_BUILDER_STEPS = Object.freeze({
  full: [['Goal', 'الهدف'], ['Page', 'الصفحة'], ['Content', 'المحتوى'], ['Audience', 'الجمهور'], ['Budget & days', 'الميزانية والمدة'], ['Review', 'المراجعة']],
  boost: [['Post', 'المنشور'], ['Budget & days', 'الميزانية والمدة'], ['Review', 'المراجعة']]
});

const STUDIO_V2_CLASSIC_TABS = Object.freeze(['dashboard', 'campaigns', 'builder', 'posts', 'replies', 'review']);
const STUDIO_V2_ONLY_TABS = Object.freeze(['wallet', 'help', 'inbox', 'account']);
const STUDIO_V2_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const STUDIO_V2_SECTION_RE = /^[a-z][a-z0-9-]{0,31}$/;
const STUDIO_V2_WAIT_MS = 3000;  // at most this long a known v2 user sees "Opening the studio…" instead of classic
const STUDIO_V2_LAYOUT_KEY = 'albayan.studio.v2.layout.';  // + user id: the layout /me gave last time (this browser only)
const STUDIO_V2_PROOF_KEY = 'albayan.studio.v2.history';   // sessionStorage (this tab): the chain and address of the last v2 draw
// shown: what the last draw was ('staff', 'customer', 'desk-classic', 'wait', 'classic'). layout: the
// pinned layout (studioV2Layout). repin: entered the studio while /me was being read again. session:
// the /me session the visit notes belong to. fromApp: this visit came from another screen of this app
// in this document (so Home's Back is the browser's Back). popping: a Back/Forward move is running.
const _studioV2 = {
  shown: '', waitFor: '', waitUntil: 0, waitTimer: null, docRendered: false, warned: false,
  layout: null, repin: false, session: -1, fromApp: false, popping: false
};

// ------------------------------------------------------------------ which layout

// A /me answer's layout: 'staff' (the Team desk), 'customer' (the v2 customer layout) or '' (classic).
function studioV2FrameOf(layout) {
  if (!layout) return '';
  if (layout.staffDesk === 'v2' && layout.isStaff) return 'staff';
  return layout.ui === 'v2' ? 'customer' : '';
}

// The layout part of /me (ui, staffDesk, isStaff, isAdmin), pinned at the first answer this visit
// sees: a later answer (the re-read every few minutes) changes only what the screens read from
// studioMe() themselves (services, intake, limits, contact). A layout change applies at the next page
// load or the next entry into the studio (studioV2NoteVisit), never under the reader's hands.
// null while /me is not known.
function studioV2Layout() {
  const uid = studioMeUserId();
  if (!uid) return null;
  const session = studioMeSession();
  const pin = _studioV2.layout;
  if (pin && pin.uid === uid && pin.session === session) return pin;
  const me = studioMe();
  if (!me) return null;
  _studioV2.layout = Object.freeze({ uid, session, ui: me.ui, staffDesk: me.staffDesk, isStaff: me.isStaff, isAdmin: me.isAdmin });
  return _studioV2.layout;
}

// 'staff' (the Team desk), 'customer' (the v2 customer layout) or '' (classic, or /me not known).
function studioV2Frame() {
  return studioV2FrameOf(studioV2Layout());
}

function studioV2IsStaff() {
  const layout = studioV2Layout();
  return !!(layout && layout.isStaff);
}

// Rollout stage 2: a staff member in the customer allowlist while the Team desk is still off gets the
// customer layout, but the staff screens stay CLASSIC until the desk is switched on (none of them is
// in the customer layout): the review tab (review queue, launch queue, health) and, for an admin, the
// wallet tab (the classic Overview, where the payment confirmations of all customers are).
// 'review' / 'wallet' = the classic tab to draw for this route, '' = the v2 screen.
function studioV2DeskClassicTab(route) {
  const layout = studioV2Layout();
  if (!route || !layout || !layout.isStaff || studioV2FrameOf(layout) !== 'customer') return '';
  if (route.tab === 'review') return 'review';
  return route.tab === 'wallet' && layout.isAdmin ? 'wallet' : '';
}

// Entering the studio (after another screen of this app was drawn). The newest /me layout applies from
// here: at once, or when the read on its way answers. "Leave the studio" learns whether the entry under
// the studio's first one is this app's own screen in this document: yes when the studio was opened
// from that screen; not for a return through Back/Forward (the entry carries a studio mark, or a
// history move is running), nor for a sign-in, a reload or the /studio site (nothing drawn before).
function studioV2NoteVisit() {
  const session = studioMeSession();
  if (_studioV2.session !== session) {  // signed out and in again, or another user: the notes are gone
    _studioV2.session = session;
    _studioV2.fromApp = false;
    _studioV2.repin = false;
  }
  const previous = typeof _lastRenderedView !== 'undefined' ? _lastRenderedView : null;
  if (!previous || previous === 'ads-studio') return;
  _studioV2.fromApp = !IS_STUDIO_SHELL && !_studioV2.popping && !studioV2HistoryChain();
  if (studioMeLoading()) _studioV2.repin = true;
  else _studioV2.layout = null;
}

// Back/Forward: the capture listener runs before the router's own (registered at start-up), so the
// draw it causes knows it is a return. The flag clears once the move has been handled.
function studioV2OnPopstate() {
  _studioV2.popping = true;
  setTimeout(() => { _studioV2.popping = false; }, 0);
}

try {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('popstate', studioV2OnPopstate, true);
} catch (_) { /* only the studio mark on the entry tells a return then */ }

function studioV2Remembered(uid) {
  try { return String(window.localStorage.getItem(STUDIO_V2_LAYOUT_KEY + uid) || ''); } catch (_) { return ''; }
}

function studioV2Remember(uid, frame) {
  try {
    if (frame === 'customer' || frame === 'staff') window.localStorage.setItem(STUDIO_V2_LAYOUT_KEY + uid, frame);
    else window.localStorage.removeItem(STUDIO_V2_LAYOUT_KEY + uid);
  } catch (_) { /* a private window: the classic screens show until /me answers */ }
}

// While the first /me read is on its way: a user whose last answer was v2 sees a short neutral
// "Opening the studio…" (never the v2 frame before /me says so); everyone else gets classic at once.
function studioV2ShouldWait() {
  const uid = studioMeUserId();
  if (!uid || !studioMeLoading()) return false;
  const remembered = studioV2Remembered(uid);
  if (remembered !== 'customer' && remembered !== 'staff') return false;
  if (_studioV2.waitFor !== uid) {
    _studioV2.waitFor = uid;
    _studioV2.waitUntil = Date.now() + STUDIO_V2_WAIT_MS;
    if (_studioV2.waitTimer) clearTimeout(_studioV2.waitTimer);
    _studioV2.waitTimer = setTimeout(() => {
      _studioV2.waitTimer = null;
      if (_studioV2.shown === 'wait') studioV2Rerender();
    }, STUDIO_V2_WAIT_MS + 50);
  }
  return Date.now() < _studioV2.waitUntil;
}

function studioV2Rerender() {
  try {
    if (typeof state !== 'undefined' && state.currentView === 'ads-studio' && typeof render === 'function') render();
  } catch (_) { /* the next render shows the right layout */ }
}

// What renderStudioV2View draws for the pinned layout and the address (the 'wait' state aside).
function studioV2Wanted() {
  const frame = studioV2Frame();
  if (frame === 'customer' && studioV2DeskClassicTab(studioV2Route(studioV2ReadAddress(), 'customer'))) return 'desk-classic';
  return frame || 'classic';
}

// A /me answer arrived (or failed): draw again only when the layout on screen is no longer right.
function studioV2OnMe(me) {
  const uid = studioMeUserId();
  if (!uid) return;
  if (me) studioV2Remember(uid, studioV2FrameOf(me));  // the next page's first guess follows the newest answer
  if (_studioV2.repin) {  // the studio was entered while this answer was on its way: its layout applies
    _studioV2.repin = false;
    if (me) _studioV2.layout = null;
  }
  if (!_studioV2.shown) return;
  const want = studioV2Wanted();
  if (want !== _studioV2.shown) studioV2Rerender();
  else if (want === 'classic' && studioV2Layout() && !STUDIO_V2_CLASSIC_TABS.includes(String(_adsStudioActiveTab || ''))) studioV2Rerender();
}

studioMeSubscribe(studioV2OnMe);

// Called first by renderAdsStudioView (15c). '' = draw the classic screens.
function renderStudioV2View() {
  try {
    studioLoadMe();  // reuses a fresh answer, joins a read on its way, re-reads an old one
    studioV2NoteVisit();
    const frame = studioV2Frame();
    if (frame) studioV2RestoreOpeningAddress();
    if (frame === 'staff') { _studioV2.shown = 'staff'; return renderStudioV2StaffFrame(); }
    if (frame === 'customer') {
      const route = studioV2Route(studioV2ReadAddress(), 'customer');
      const deskTab = studioV2DeskClassicTab(route);
      if (deskTab) {  // the classic staff screen, drawn by 15c for this tab
        _studioV2.shown = 'desk-classic';
        _adsStudioActiveTab = deskTab;
        return '';
      }
      _studioV2.shown = 'customer';
      return renderStudioV2CustomerFrame(route);
    }
    if (!studioMe() && studioV2ShouldWait()) { _studioV2.shown = 'wait'; return renderStudioV2Waiting(); }
    _studioV2.shown = 'classic';
    if (studioV2Layout()) studioV2ClassicTabFix();
    return '';
  } catch (error) {
    if (!_studioV2.warned) {
      _studioV2.warned = true;
      try { console.warn('[studio v2] showing the classic screens instead:', error); } catch (_) {}
    }
    _studioV2.shown = 'classic';
    return '';
  }
}

// The classic layout knows only its own tabs: a v2 address (?tab=wallet …) opens its Overview.
function studioV2ClassicTabFix() {
  try {
    if (STUDIO_V2_CLASSIC_TABS.includes(String(_adsStudioActiveTab || ''))) return;
    _adsStudioActiveTab = 'dashboard';
    const tab = new URLSearchParams(window.location.search || '').get('tab');
    if (tab && !STUDIO_V2_CLASSIC_TABS.includes(tab) && typeof updateUrlParams === 'function') {
      updateUrlParams({ tab: 'dashboard', section: null, id: null, step: null }, true);
    }
  } catch (_) { /* the Overview shows anyway */ }
}

// ------------------------------------------------------------------ the address and the Back model

function studioV2ReadAddress() {
  let params;
  try { params = new URLSearchParams(window.location.search || ''); } catch (_) { params = new URLSearchParams(''); }
  return { tab: params.get('tab') || '', section: params.get('section') || '', id: params.get('id') || '', step: params.get('step') || '' };
}

function studioV2BuilderSteps(section) {
  return STUDIO_V2_BUILDER_STEPS[section === 'boost' ? 'boost' : 'full'];
}

function studioV2Home(frame) {
  return frame === 'staff'
    ? { tab: 'review', section: 'requests', id: '', step: 0 }
    : { tab: 'home', section: '', id: '', step: 0 };
}

// Any address -> a route this frame can draw ({tab, section, id, step}); anything unknown is Home.
function studioV2Route(raw, frame) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const section = STUDIO_V2_SECTION_RE.test(String(src.section || '')) ? String(src.section) : '';
  const id = STUDIO_V2_ID_RE.test(String(src.id || '')) ? String(src.id) : '';
  if (frame === 'staff') {
    const known = STUDIO_V2_STAFF_SECTIONS.some(item => item[0] === section);
    return { tab: 'review', section: known ? section : 'requests', id, step: 0 };
  }
  let tab = String(src.tab || '');
  if (!tab || tab === 'dashboard') tab = 'home';
  if (section === 'builder') tab = 'builder';
  if (!STUDIO_V2_TABS.some(item => item[0] === tab) || (tab === 'review' && !studioV2IsStaff())) tab = 'home';
  if (tab === 'home') return studioV2Home(frame);
  if (tab === 'builder') {
    const kind = section === 'boost' || section === 'full' ? section : '';
    const count = studioV2BuilderSteps(kind).length;
    const rawStep = String(src.step === undefined || src.step === null ? '' : src.step);
    const step = /^\d{1,2}$/.test(rawStep) ? Number(rawStep) : 1;
    return { tab, section: kind, id: '', step: Math.min(Math.max(step, 1), count) };
  }
  return { tab, section, id, step: 0 };
}

function studioV2Key(route) {
  return [route.tab, route.section, route.id, route.step || ''].join('|');
}

// One level up (PLAN.md §5.1), or null on Home.
function studioV2Parent(route, frame) {
  if (frame === 'staff') {
    if (route.id) return { ...route, id: '' };
    return route.section === 'requests' ? null : studioV2Home('staff');
  }
  if (route.tab === 'home') return null;
  if (route.tab === 'builder' && route.step > 1) return { ...route, step: route.step - 1 };
  if (route.id) return { ...route, id: '' };
  return studioV2Home('customer');
}

// Home first, the route last.
function studioV2Path(route, frame) {
  const path = [route];
  let up = studioV2Parent(route, frame);
  for (let guard = 0; up && guard < 20; guard++) {
    path.unshift(up);
    up = studioV2Parent(up, frame);
  }
  return path;
}

function studioV2Url(route) {
  const params = new URLSearchParams();
  params.set('tab', route.tab);
  if (route.section) params.set('section', route.section);
  if (route.id) params.set('id', route.id);
  if (route.step) params.set('step', String(route.step));
  return `${window.location.pathname || '/'}?${params.toString()}`;
}

function studioV2HistoryChain() {
  try {
    const mark = window.history.state && window.history.state.studioV2;
    const chain = mark && mark.chain;
    return Array.isArray(chain) && chain.length > 0 && chain.length <= 24
      && chain.every(key => typeof key === 'string' && key.length <= 200) ? chain.slice() : null;
  } catch (_) { return null; }
}

// The classic tab variable follows the v2 address, so a whole-view re-navigation (which keeps only
// ?tab=) and the loader's restore land on the same screen.
function studioV2SyncClassicTab(route) {
  try { _adsStudioActiveTab = route.tab === 'home' ? 'dashboard' : route.tab; } catch (_) {}
}

function studioV2WriteEntry(route, chain, replace) {
  const entry = { view: 'ads-studio', params: { tab: route.tab }, studioV2: { chain: chain.slice() } };
  const url = studioV2Url(route);
  if (replace) window.history.replaceState(entry, '', url);
  else window.history.pushState(entry, '', url);
  studioV2SyncClassicTab(route);
}

function studioV2NavigationType() {
  try {
    const entry = performance.getEntriesByType('navigation')[0];
    return entry && entry.type ? String(entry.type) : 'navigate';
  } catch (_) { return 'navigate'; }
}

function studioV2Here() {
  return `${window.location.pathname || '/'}${window.location.search || ''}`;
}

// This tab's proof of its last v2 draw: the chain and the address (sessionStorage lives as long as the
// tab and survives a reload, never shared with another tab).
function studioV2SaveProof() {
  try {
    const chain = studioV2HistoryChain();
    if (chain) window.sessionStorage.setItem(STUDIO_V2_PROOF_KEY, JSON.stringify({ chain, url: studioV2Here() }));
  } catch (_) { /* no storage (a private window): a reload rebuilds the path instead */ }
}

// True when the last v2 draw of this tab was this very screen with this very chain.
function studioV2Proven(keys) {
  try {
    const proof = JSON.parse(window.sessionStorage.getItem(STUDIO_V2_PROOF_KEY) || 'null');
    return !!proof && typeof proof === 'object' && proof.url === studioV2Here()
      && Array.isArray(proof.chain) && JSON.stringify(proof.chain) === JSON.stringify(keys);
  } catch (_) { return false; }
}

// On every v2 draw: the entry on screen carries its chain. A screen opened straight from a link (or
// from another page of the app) gets Home and its other parents put under it. After a reload or a
// return through history the entries under it are trusted to be the studio's own (only the mark is
// renewed) when this tab kept proof that it drew this screen with this chain before; without that
// proof (another page was there, or the layout was classic then) the path is rebuilt the same way.
function studioV2EnsureHistory(route, frame) {
  try {
    const current = window.history.state;
    if (current && current.overlaySentinel) return;  // an open sheet owns the top entry
    const path = studioV2Path(route, frame);
    const keys = path.map(studioV2Key);
    const chain = studioV2HistoryChain();
    const firstDraw = !_studioV2.docRendered;
    _studioV2.docRendered = true;
    if (chain && chain[chain.length - 1] === keys[keys.length - 1]) {
      // already marked: nothing to write
    } else if (path.length === 1 || (firstDraw && studioV2NavigationType() !== 'navigate' && studioV2Proven(keys))) {
      window.history.replaceState(Object.assign({}, current || {}, { view: 'ads-studio', studioV2: { chain: keys } }), '', window.location.href);
    } else {
      path.forEach((step, index) => studioV2WriteEntry(step, keys.slice(0, index + 1), index === 0));
    }
    studioV2SaveProof();
  } catch (_) { /* the address stays as it is */ }
}

// The start-up address rewrite keeps only ?tab= (and loses even that when this bundle arrives after
// it). On the first v2 draw of a page opened moments ago (a classic staff screen of the v2 layout
// included: it is chosen by the address), the address it was opened with comes back (only tab,
// section, id and step), unless the reader has already moved somewhere else.
function studioV2RestoreOpeningAddress() {
  if (_studioV2.docRendered) return;
  try {
    if (typeof performance === 'undefined' || !(performance.now() < 15000)) return;
    const entry = performance.getEntriesByType('navigation')[0];
    if (!entry || !entry.name) return;
    const opened = new URL(String(entry.name));
    if (opened.pathname !== window.location.pathname) return;
    const now = new URLSearchParams(window.location.search || '');
    if (['section', 'id', 'step'].some(key => now.get(key))) return;
    const tab = now.get('tab') || '';
    const openedTab = opened.searchParams.get('tab') || '';
    if (!openedTab || !(tab === openedTab || tab === '' || tab === 'dashboard')) return;
    const params = new URLSearchParams();
    for (const key of ['tab', 'section', 'id', 'step']) {
      const value = opened.searchParams.get(key);
      if (value) params.set(key, value);
    }
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params.toString()}`);
  } catch (_) { /* the address stays as it is */ }
}

function studioV2HistoryGo(delta) {
  try { window.history.go(delta); } catch (_) {}
}

// After history.go(): runs once the browser has moved (the router has drawn that entry by then).
function studioV2AfterPop(fn) {
  let done = false;
  let timer = null;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener('popstate', finish);
    if (timer) clearTimeout(timer);
    try { fn(); } catch (_) {}
  };
  window.addEventListener('popstate', finish);
  timer = setTimeout(finish, 1500);
}

function studioV2Show(navigated) {
  if (navigated && typeof requestViewScrollReset === 'function') requestViewScrollReset();
  studioV2Rerender();
}

// Opens a route and keeps the history equal to its chain: the common part stays, what is above it is
// walked back (going up = the browser's own Back), the rest is added (the first addition replaces the
// entry being left, so moving between tabs never stacks up).
function studioV2Go(target) {
  const frame = studioV2Frame();
  if (!frame || typeof window === 'undefined' || !window.history) return false;
  const current = studioV2Route(studioV2ReadAddress(), frame);
  const path = studioV2Path(studioV2Route(target, frame), frame);
  const keys = path.map(studioV2Key);
  let chain = studioV2HistoryChain();
  if (!chain || chain[chain.length - 1] !== studioV2Key(current)) chain = [studioV2Key(current)];
  if (chain[chain.length - 1] === keys[keys.length - 1]) { studioV2Show(false); return true; }
  let same = 0;
  while (same < keys.length && same < chain.length && keys[same] === chain[same]) same++;
  const pops = chain.length - same;
  try {
    if (same === keys.length) { studioV2HistoryGo(-pops); return true; }
    if (same === 0) {
      path.forEach((step, index) => studioV2WriteEntry(step, keys.slice(0, index + 1), index === 0));
      studioV2Show(true);
      return true;
    }
    const writeRest = replaceFirst => {
      path.slice(same).forEach((step, index) => studioV2WriteEntry(step, keys.slice(0, same + index + 1), index === 0 && replaceFirst));
      studioV2Show(true);
    };
    if (pops <= 1) writeRest(pops === 1);
    else {
      studioV2AfterPop(() => writeRest(true));
      studioV2HistoryGo(-(pops - 1));
    }
    return true;
  } catch (_) { return false; }
}

function studioV2Open(tab) {
  return studioV2Go({ tab: String(tab || '') });
}

function studioV2OpenSection(section) {
  return studioV2Go({ tab: 'review', section: String(section || '') });
}

function studioV2BuilderStep(delta) {
  if (studioV2Frame() !== 'customer') return false;
  const route = studioV2Route(studioV2ReadAddress(), 'customer');
  if (route.tab !== 'builder') return false;
  return studioV2Go({ tab: 'builder', section: route.section, step: route.step + (Number(delta) || 0) });
}

function studioV2CloseBuilder() {
  return studioV2Go(studioV2Home('customer'));
}

// "Leave the studio" (Back on Home). The number of history entries says nothing about whose entries
// lie below (another site, or nothing at all), so: the browser's Back only when this visit came from
// another screen of this app in this document (studioV2NoteVisit); otherwise the studio's own way
// out (adsStudioBackTarget: Smart Systems for an admin, the user's landing screen), and no button
// when there is none (the /studio site, a customer whose only screen is the studio).
function studioV2CanLeave() {
  return _studioV2.fromApp || !!adsStudioBackTarget();
}

function studioV2Leave() {
  if (_studioV2.fromApp) {
    try { window.history.back(); return true; } catch (_) {}
  }
  const target = adsStudioBackTarget();
  if (target && typeof navigateTo === 'function') { navigateTo(target); return true; }
  return false;
}

// The in-app Back button.
function studioV2Back() {
  const frame = studioV2Frame();
  if (!frame) return false;
  const parent = studioV2Parent(studioV2Route(studioV2ReadAddress(), frame), frame);
  return parent ? studioV2Go(parent) : studioV2Leave();
}

// For the app's hardware Back key (P2-09 hook): true when the studio moved up a level itself; false on
// Home or outside the v2 layout, so the app's own Back runs.
function studioHandleBack() {
  if (typeof state === 'undefined' || state.currentView !== 'ads-studio') return false;
  const frame = studioV2Frame();
  if (!frame) return false;
  return studioV2Parent(studioV2Route(studioV2ReadAddress(), frame), frame) ? studioV2Back() : false;
}

// The pinned tab setter and the address restore keep working in both layouts: in v2 the setter
// drives the v2 address (same ?tab=, the Back model's history); in the v2 layout the restore also
// keeps the v2-only tabs, so a return through history to ?tab=wallet keeps the classic tab variable
// (and the whole-view address it feeds) on the same screen. The v2 frame itself reads the address.
const _studioV2ClassicSetTab = typeof setAdsStudioTab === 'function' ? setAdsStudioTab : null;
const _studioV2ClassicRestoreTab = typeof restoreAdsStudioTabFromUrl === 'function' ? restoreAdsStudioTabFromUrl : null;

setAdsStudioTab = function setAdsStudioTabForLayout(tabId) {
  if (studioV2Frame() && typeof state !== 'undefined' && state.currentView === 'ads-studio') {
    const tab = String(tabId || '');
    // The classic review tab of a staff member while the Team desk is off: the classic setter draws it.
    if (tab === 'review' && studioV2DeskClassicTab({ tab })) { studioV2ClassicDeskSetTab(tabId); return; }
    if (tab === 'dashboard' || STUDIO_V2_TABS.some(item => item[0] === tab)) studioV2Go({ tab });
    return;
  }
  if (_studioV2ClassicSetTab) _studioV2ClassicSetTab(tabId);
};

// The classic setter replaces the entry on screen (?tab=review) with its own state: the entry keeps
// its place in the Back model (Home under it), so the in-app and the browser's Back still agree.
function studioV2ClassicDeskSetTab(tabId) {
  const before = studioV2HistoryChain();
  if (_studioV2ClassicSetTab) _studioV2ClassicSetTab(tabId);
  try {
    const keys = studioV2Path(studioV2Route(studioV2ReadAddress(), 'customer'), 'customer').map(studioV2Key);
    if (!before || before.length !== keys.length || before.slice(0, -1).join('\n') !== keys.slice(0, -1).join('\n')) return;
    window.history.replaceState(Object.assign({}, window.history.state || {}, { view: 'ads-studio', studioV2: { chain: keys } }), '', window.location.href);
  } catch (_) { /* the entry stays unmarked: the next v2 move replaces it */ }
}

restoreAdsStudioTabFromUrl = function restoreAdsStudioTabFromUrlForLayout() {
  if (_studioV2ClassicRestoreTab) _studioV2ClassicRestoreTab();
  // The v2-only addresses mean something only in the v2 layout: while /me is on its way, failed or
  // says classic, the classic rule alone applies (an address it does not know keeps the tab on screen).
  if (!studioV2Frame()) return;
  try {
    const tab = String(new URLSearchParams(window.location.search || '').get('tab') || '');
    if (tab === 'home') _adsStudioActiveTab = 'dashboard';
    else if (STUDIO_V2_ONLY_TABS.includes(tab)) _adsStudioActiveTab = tab;
  } catch (_) {}
};

// ------------------------------------------------------------------ drawing

function studioV2TabInfo(tab) {
  return STUDIO_V2_TABS.find(item => item[0] === tab) || STUDIO_V2_TABS[0];
}

function studioV2StaffSection(section) {
  return STUDIO_V2_STAFF_SECTIONS.find(item => item[0] === section) || STUDIO_V2_STAFF_SECTIONS[0];
}

function studioV2Icon(name, className = 'studio-v2-icon') {
  return `<i data-lucide="${studioEsc(name)}" class="${className}" aria-hidden="true"></i>`;
}

function studioV2BuilderStepText(route) {
  const steps = studioV2BuilderSteps(route.section);
  const step = Math.min(Math.max(1, route.step || 1), steps.length);
  const name = steps[step - 1];
  return adsStudioText(`Step ${step} of ${steps.length}: ${name[0]}`, `الخطوة ${step} من ${steps.length}: ${name[1]}`);
}

function renderStudioV2Header(route, frame) {
  const staff = frame === 'staff';
  const focus = !staff && route.tab === 'builder';
  const parent = studioV2Parent(route, frame);
  const brand = adsStudioText('Albayan Ads Studio', 'استوديو إعلانات البيان');
  let title = brand;
  let kicker = '';
  if (staff) {
    const section = studioV2StaffSection(route.section);
    title = adsStudioText(section[2], section[3]);
    kicker = adsStudioText('Team desk', 'مكتب الفريق');
  } else if (route.tab !== 'home') {
    const info = studioV2TabInfo(route.tab);
    title = adsStudioText(info[2], info[3]);
    kicker = brand;
  }
  const backLabel = parent ? adsStudioText('Back', 'رجوع') : adsStudioText('Leave the studio', 'الخروج من الاستوديو');
  const back = parent || studioV2CanLeave()
    ? `<button type="button" data-testid="studio-back" class="studio-v2-icon-btn" onclick="studioV2Back()" aria-label="${studioEsc(backLabel)}" title="${studioEsc(backLabel)}">${studioV2Icon(adsStudioIsAr() ? 'arrow-right' : 'arrow-left')}</button>`
    : '';
  const headButton = tab => {
    const info = studioV2TabInfo(tab);
    const label = adsStudioText(info[2], info[3]);
    return `<button type="button" data-testid="studio-nav-${tab}" class="studio-v2-icon-btn" onclick="studioV2Open('${tab}')" aria-label="${studioEsc(label)}" title="${studioEsc(label)}"${route.tab === tab ? ' aria-current="page"' : ''}>${studioV2Icon(info[1])}</button>`;
  };
  let actions = '';
  if (focus) {
    const close = adsStudioText('Close', 'إغلاق');
    actions = `<button type="button" data-testid="studio-close" class="studio-v2-icon-btn" onclick="studioV2CloseBuilder()" aria-label="${studioEsc(close)}" title="${studioEsc(close)}">${studioV2Icon('x')}</button>`;
  } else if (!staff) {
    // Staff here have the Team desk off: its button opens their classic review tab.
    actions = (studioV2IsStaff() ? headButton('review') : '') + headButton('inbox') + headButton('account');
  }
  return `
      <header class="studio-v2-header">
        ${back}
        <div class="studio-v2-heading">
          ${kicker ? `<p class="studio-v2-kicker">${studioEsc(kicker)}</p>` : ''}
          <h1 id="studio-v2-title" class="studio-v2-title">${studioEsc(title)}</h1>
        </div>
        ${actions ? `<div class="studio-v2-header-actions">${actions}</div>` : ''}
      </header>`;
}

function renderStudioV2Soon(title, icon, forStaff = false) {
  const note = forStaff
    ? adsStudioText('This part of the Team desk is still being built.', 'ما زلنا نبني هذا القسم من مكتب الفريق.')
    : adsStudioText('This part is still being built. Your requests, money and pages are safe and unchanged.',
      'ما زلنا نبني هذا القسم. طلباتك وأموالك وصفحاتك محفوظة ولم يتغير فيها شيء.');
  return `
          <div class="studio-v2-soon" data-testid="studio-soon">
            <span class="studio-v2-soon-icon" aria-hidden="true">${studioV2Icon(icon)}</span>
            <h2 class="studio-v2-soon-title">${studioEsc(title)}</h2>
            <p class="studio-v2-soon-text">${studioEsc(adsStudioText('Coming soon in the new studio', 'قريباً في الاستوديو الجديد'))}</p>
            <p class="studio-v2-soon-note">${studioEsc(note)}</p>
          </div>`;
}

// Language, theme and sign-out: reachable in every layout while Account / More are being built.
function renderStudioV2Basics() {
  const dark = typeof state !== 'undefined' && state.theme === 'dark';
  const row = (onclick, icon, label, value, extra = '') => `
            <button type="button" class="studio-v2-row${extra}" onclick="${onclick}">
              ${studioV2Icon(icon)}
              <span class="studio-v2-row-label">${studioEsc(label)}</span>
              ${value ? `<span class="studio-v2-row-value">${studioEsc(value)}</span>` : ''}
            </button>`;
  return `
          <div class="studio-v2-list" data-testid="studio-basics">
            ${row('toggleLanguage()', 'languages', adsStudioText('Language', 'اللغة'), adsStudioIsAr() ? 'العربية' : 'English')}
            ${row('toggleTheme()', dark ? 'moon' : 'sun', adsStudioText('Theme', 'المظهر'), dark ? adsStudioText('Dark', 'داكن') : adsStudioText('Light', 'فاتح'))}
            ${row('handleLogout()', 'log-out', adsStudioText('Log out', 'تسجيل الخروج'), '', ' is-danger')}
          </div>`;
}

function renderStudioV2Builder(route) {
  const steps = studioV2BuilderSteps(route.section);
  const items = steps.map((name, index) => {
    const number = index + 1;
    const mark = number === route.step ? ' is-current' : (number < route.step ? ' is-done' : '');
    return `<li class="studio-v2-step${mark}"${number === route.step ? ' aria-current="step"' : ''}><span class="studio-v2-step-dot" aria-hidden="true">${number}</span><span class="studio-v2-step-name">${studioEsc(adsStudioText(name[0], name[1]))}</span></li>`;
  }).join('');
  const next = route.step < steps.length
    ? `<button type="button" data-testid="studio-builder-next" class="studio-v2-action is-primary" onclick="studioV2BuilderStep(1)">${studioEsc(adsStudioText('Next', 'التالي'))}</button>`
    : '';
  return `
          <div class="studio-v2-builder" data-step="${route.step}" data-steps="${steps.length}">
            <p class="studio-v2-step-text" data-testid="studio-builder-step">${studioEsc(studioV2BuilderStepText(route))}</p>
            <ol class="studio-v2-steps">${items}</ol>
            ${renderStudioV2Soon(adsStudioText('New request', 'طلب جديد'), 'wand-sparkles')}
            ${next ? `<div class="studio-v2-builder-actions">${next}</div>` : ''}
          </div>`;
}

function renderStudioV2CustomerScreen(route) {
  const info = studioV2TabInfo(route.tab);
  let body;
  if (route.tab === 'builder') {
    body = renderStudioV2Builder(route);
  } else {
    body = renderStudioV2Soon(adsStudioText(info[2], info[3]), info[1]);
    // A customer without an active plan still needs the way to activate it (the classic card).
    if (route.tab === 'home' && !adsStudioCanUse()) body += `<div class="studio-v2-gate">${renderAdsStudioSubscriptionGate()}</div>`;
    if (route.tab === 'account') body += renderStudioV2Basics();
  }
  const attrs = (route.section ? ` data-section="${studioEsc(route.section)}"` : '') + (route.id ? ` data-id="${studioEsc(route.id)}"` : '');
  return `
        <section data-testid="studio-screen-${studioEsc(route.tab)}" class="studio-v2-screen" aria-labelledby="studio-v2-title"${attrs}>${body}
        </section>`;
}

// route: the address as studioV2Route reads it for this frame (renderStudioV2View).
function renderStudioV2CustomerFrame(route) {
  studioV2EnsureHistory(route, 'customer');
  studioV2SyncClassicTab(route);
  const focus = route.tab === 'builder';
  const items = STUDIO_V2_TABS.filter(item => item[4] === 'nav').map(([tab, icon, en, ar]) => `
          <button type="button" data-testid="studio-nav-${tab}" class="studio-v2-nav-item" onclick="studioV2Open('${tab}')"${route.tab === tab ? ' aria-current="page"' : ''}>${studioV2Icon(icon, 'studio-v2-nav-icon')}<span>${studioEsc(adsStudioText(en, ar))}</span></button>`).join('');
  return `
    <div data-testid="studio-v2-frame" class="studio-v2-frame" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}" data-tab="${studioEsc(route.tab)}" data-focus="${focus ? '1' : '0'}">
      ${renderStudioV2Header(route, 'customer')}
      <div class="studio-v2-body">
        <nav data-testid="studio-nav" class="studio-v2-nav" aria-label="${studioEsc(adsStudioText('Studio sections', 'أقسام الاستوديو'))}"${focus ? ' hidden' : ''}>${items}
        </nav>
        <div class="studio-v2-main">${renderStudioV2CustomerScreen(route)}
        </div>
      </div>
    </div>`;
}

// The Team desk frame (P2-02d): its own sections, no wallet or payment items (admin-only items live
// under More once they are built). Sections are filled in Phase 3.
function renderStudioV2StaffFrame() {
  const route = studioV2Route(studioV2ReadAddress(), 'staff');
  studioV2EnsureHistory(route, 'staff');
  studioV2SyncClassicTab(route);
  const section = studioV2StaffSection(route.section);
  const items = STUDIO_V2_STAFF_SECTIONS.map(([id, icon, en, ar]) => `
          <button type="button" data-testid="studio-staffnav-${id}" class="studio-v2-nav-item" onclick="studioV2OpenSection('${id}')"${section[0] === id ? ' aria-current="page"' : ''}>${studioV2Icon(icon, 'studio-v2-nav-icon')}<span>${studioEsc(adsStudioText(en, ar))}</span></button>`).join('');
  const attrs = route.id ? ` data-id="${studioEsc(route.id)}"` : '';
  return `
    <div data-testid="studio-staff-frame" class="studio-v2-frame is-staff" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}" data-tab="review" data-section="${section[0]}" data-focus="0">
      ${renderStudioV2Header(route, 'staff')}
      <div class="studio-v2-body">
        <nav data-testid="studio-staffnav" class="studio-v2-nav is-staff" aria-label="${studioEsc(adsStudioText('Team desk sections', 'أقسام مكتب الفريق'))}">${items}
        </nav>
        <div class="studio-v2-main">
          <section data-testid="studio-screen-review" data-section="${section[0]}" class="studio-v2-screen" aria-labelledby="studio-v2-title"${attrs}>
            <div data-testid="studio-staff-screen-${section[0]}">${renderStudioV2Soon(adsStudioText(section[2], section[3]), section[1], true)}${section[0] === 'more' ? renderStudioV2Basics() : ''}
            </div>
          </section>
        </div>
      </div>
    </div>`;
}

function renderStudioV2Waiting() {
  return `
    <div data-testid="studio-v2-loading" class="studio-v2-loading" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}" role="status">
      <span class="studio-v2-spinner" aria-hidden="true"></span>
      <p>${studioEsc(adsStudioText('Opening the studio…', 'جارٍ فتح الاستوديو…'))}</p>
    </div>`;
}
// ==========================================
// ALBAYAN STUDIO v2 — HOME (plan task P2-03; styles in assets/ads-workspace.css, "Studio v2 Home and My ads")
// ==========================================
// Home of the v2 customer layout, drawn inside the shell's own screen root (15h):
// - the money strip: Available, Reserved, In your ads, Spent (+ Being returned when it is not zero),
//   each with a one-line meaning, the numbers exactly as GET /api/studio/wallet/summary gives them;
//   "Meta used $Y" only when the server has one (never before a Meta link);
// - "Needs you": requests sent back with their reason, drafts not sent, payments we are confirming,
//   a plan that ended;
// - "Getting started" until the first request is sent (plan, page, money, first request);
// - "Your ads now": tracker rows for the requests in progress (stage, who acts next, checked X ago);
// - quick actions written as goals, and the calm banner while new requests are paused.
// It also holds what Home shares with My ads (15k):
// - studioPlugScreen(): how a screen plugs into the shell (below);
// - studioData*: the server summaries (campaigns, wallet, linked pages), read when a screen shows them,
//   again after a minute or after the synced rows change, never more than one read at a time;
// - the customer's own requests, their display stage (the server's; a plain fallback while unknown)
//   and the stage chip.
// Every server string is escaped; money is studioUsd / studioLyd (LYD never wears "$").

// ------------------------------------------------------------------ plugging into the shell

// The shell (15h) draws every customer tab as <section data-testid="studio-screen-<tab>"> with a
// "Coming soon" body. A screen registered here draws its own body inside that same root; any other
// tab, or a screen that fails, keeps the shell's. The shell's function is wrapped once, the way 15h
// itself wraps setAdsStudioTab.
const _studioPlugScreens = new Map();  // tab -> function(route): the screen's body (HTML)
const _studioPlug = { shell: null, warned: false };

function studioPlugScreen(tab, drawBody) {
  const name = String(tab || '');
  if (/^[a-z]{2,20}$/.test(name) && typeof drawBody === 'function') _studioPlugScreens.set(name, drawBody);
}

// The shell's screen root (same test id, labels and data attributes) around a body.
function studioPlugRoot(route, body) {
  const attrs = (route.section ? ` data-section="${studioEsc(route.section)}"` : '') + (route.id ? ` data-id="${studioEsc(route.id)}"` : '');
  return `
        <section data-testid="studio-screen-${studioEsc(route.tab)}" class="studio-v2-screen" aria-labelledby="studio-v2-title"${attrs}>${body}
        </section>`;
}

if (typeof renderStudioV2CustomerScreen === 'function') {
  _studioPlug.shell = renderStudioV2CustomerScreen;
  renderStudioV2CustomerScreen = function renderStudioV2CustomerScreenPlugged(route) {
    const draw = route && typeof route === 'object' ? _studioPlugScreens.get(String(route.tab || '')) : null;
    if (draw) {
      try {
        return studioPlugRoot(route, draw(route));
      } catch (error) {
        if (!_studioPlug.warned) {
          _studioPlug.warned = true;
          try { console.warn('[studio v2] this screen could not be drawn; showing the placeholder:', error); } catch (_) {}
        }
      }
    }
    return _studioPlug.shell(route);
  };
}

// ------------------------------------------------------------------ server summaries

const STUDIO_DATA_READS = Object.freeze({
  campaigns: '/api/studio/campaigns/summary',
  wallet: '/api/studio/wallet/summary',
  pages: '/api/studio/pages'
});
const STUDIO_DATA_TTL_MS = 60 * 1000;           // a summary this old is read again when a screen shows it
const STUDIO_DATA_PAGES_TTL_MS = 5 * 60 * 1000;
const STUDIO_DATA_CHANGE_MS = 4 * 1000;         // after the synced rows change: at most this often
const STUDIO_DATA_RETRY_MS = 30 * 1000;         // a failed read waits this long (a Retry button asks at once)
const _studioData = { forUser: '', generation: 0, slots: Object.create(null), redrawTimer: null, recheckTimer: null };

function studioDataReset(uid = '') {
  _studioData.generation++;  // replies still on their way belong to the old session: dropped
  _studioData.forUser = String(uid || '');
  _studioData.slots = Object.create(null);
}

function studioDataSlot(kind) {
  const uid = studioMeUserId();
  if (_studioData.forUser !== uid) studioDataReset(uid);
  if (!_studioData.slots[kind]) {
    _studioData.slots[kind] = { value: null, loadedAt: 0, failedAt: 0, error: null, promise: null, mark: '', again: false };
  }
  return _studioData.slots[kind];
}

// The caller's own requests that are not archived, newest first (a reviewer or an admin in the
// customer layout sees only their own here too).
function studioDataRequests() {
  const uid = studioMeUserId();
  if (!uid || typeof getVisibleAdsStudioCampaigns !== 'function') return [];
  return getVisibleAdsStudioCampaigns().filter(row => row && String(row.createdBy || '') === uid
    && typeof row.id === 'string' && Security.isValidRecordId(row.id));
}

function studioDataRequest(id) {
  const wanted = String(id || '');
  return studioDataRequests().find(row => row.id === wanted) || null;
}

// The synced rows a summary depends on, as one string: when it moves, the summary is read again.
function studioDataMark(kind) {
  const uid = studioMeUserId();
  let mark = (Array.isArray(state.adCampaignRequests) ? state.adCampaignRequests : [])
    .filter(row => row && String(row.createdBy || '') === uid)
    .map(row => `${row.id}:${row.status || ''}:${Number(row._lastModified) || 0}:${row._deleted ? 1 : 0}`).join('|');
  if (kind === 'wallet') {
    let count = 0;
    let newest = 0;
    for (const row of Array.isArray(state.walletTransactions) ? state.walletTransactions : []) {
      if (!row || (String(row.toUserId || '') !== uid && String(row.fromUserId || '') !== uid)) continue;
      count++;
      newest = Math.max(newest, Number(row._lastModified) || 0);
    }
    mark += `#${count}:${newest}`;
  }
  return mark;
}

function studioDataClean(kind, raw) {
  if (kind === 'pages') return typeof adsStudioNormalizePostPages === 'function' ? adsStudioNormalizePostPages(raw).length : 0;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (kind === 'wallet') return raw.usd && typeof raw.usd === 'object' && !Array.isArray(raw.usd) ? raw : null;
  const out = Object.create(null);
  for (const [id, entry] of Object.entries(raw)) {
    if (Security.isValidRecordId(id) && entry && typeof entry === 'object' && !Array.isArray(entry)) out[id] = entry;
  }
  return out;
}

// One redraw after a burst of answers (only while the v2 customer layout is on screen).
function studioDataRedraw() {
  if (_studioData.redrawTimer) return;
  _studioData.redrawTimer = setTimeout(() => {
    _studioData.redrawTimer = null;
    if (typeof studioV2Frame === 'function' && studioV2Frame() === 'customer' && typeof studioV2Rerender === 'function') studioV2Rerender();
  }, 30);
}

function studioDataRecheckLater(delayMs) {
  if (_studioData.recheckTimer) return;
  _studioData.recheckTimer = setTimeout(() => {
    _studioData.recheckTimer = null;
    studioDataRedraw();
  }, Math.max(50, Number(delayMs) || 0));
}

// Starts a read of one summary when it is due (see the constants above); force reads now (a read on
// its way is followed by one more, so an answer never predates the action that asked). Returns the
// read's promise, or null when nothing was started.
function studioDataWant(kind, force = false) {
  const path = STUDIO_DATA_READS[kind];
  const uid = studioMeUserId();
  if (!path || !uid || typeof isServerModeEnabled !== 'function' || !isServerModeEnabled()) return null;
  const slot = studioDataSlot(kind);
  if (slot.promise) {
    if (force) slot.again = true;
    return slot.promise;
  }
  const now = Date.now();
  const mark = kind === 'pages' ? '' : studioDataMark(kind);
  if (!force) {
    if (slot.failedAt && now - slot.failedAt < STUDIO_DATA_RETRY_MS) return null;
    const ttl = kind === 'pages' ? STUDIO_DATA_PAGES_TTL_MS : STUDIO_DATA_TTL_MS;
    const age = now - slot.loadedAt;
    const due = slot.value === null || age >= ttl || age < 0 || (mark !== slot.mark && age >= STUDIO_DATA_CHANGE_MS);
    if (!due) {
      if (mark !== slot.mark) studioDataRecheckLater(STUDIO_DATA_CHANGE_MS - age);
      return null;
    }
  }
  const generation = _studioData.generation;
  slot.mark = mark;
  slot.again = false;
  const promise = studioApi(path, { method: 'GET' }).then(raw => {
    if (generation !== _studioData.generation) return;
    const value = studioDataClean(kind, raw);
    if (value === null) {
      slot.failedAt = Date.now();
      slot.error = { code: 'UNKNOWN', text: adsStudioText('This could not be loaded. Try again in a moment.', 'تعذّر التحميل. أعد المحاولة بعد لحظات.') };
      return;
    }
    slot.value = value;
    slot.loadedAt = Date.now();
    slot.failedAt = 0;
    slot.error = null;
  }, error => {
    if (generation !== _studioData.generation) return;
    if (error && error.name === 'AbortError') return;  // leaving a page cancels its reads: not a failure
    slot.failedAt = Date.now();
    slot.error = (error && error.studio) || studioErrorInfo(error, 'read');
  }).finally(() => {
    if (generation !== _studioData.generation) return;
    slot.promise = null;
    if (slot.again) {
      slot.again = false;
      studioDataWant(kind, true);
    }
    studioDataRedraw();
  });
  slot.promise = promise;
  return promise;
}

function studioDataValue(kind) {
  const uid = studioMeUserId();
  if (!uid || _studioData.forUser !== uid || !_studioData.slots[kind]) return null;
  return _studioData.slots[kind].value;
}

// {loading, error} of one summary: error is the {code, text} to show when there is no value at all.
function studioDataState(kind) {
  const uid = studioMeUserId();
  const slot = uid && _studioData.forUser === uid ? _studioData.slots[kind] : null;
  return { loading: !!(slot && slot.promise), error: slot && slot.value === null ? slot.error : null };
}

// After an action that moves money or a stage: both summaries now.
function studioDataRefresh() {
  studioDataWant('campaigns', true);
  studioDataWant('wallet', true);
}

// The Retry button of a failed read.
function studioDataRetry() {
  studioDataRefresh();
  studioDataRedraw();
}

// ------------------------------------------------------------------ stages and small pieces

const STUDIO_DATA_STATUS_STAGE = Object.freeze({ Draft: 1, Submitted: 2, 'Changes Requested': 3, Approved: 4, Stopped: 12, Rejected: 13 });
const STUDIO_DATA_STALE_MS = 6 * 60 * 60 * 1000;

// One request's display stage: the server's (studioStageView of the summary entry), or while that is
// not known the plain status (no money meaning, no actions, never "Meta used").
function studioDataStage(request) {
  const summary = studioDataValue('campaigns');
  const raw = summary && request && Object.prototype.hasOwnProperty.call(summary, request.id) ? summary[request.id] : null;
  const view = raw ? studioStageView(raw) : null;
  if (view && view.stage) {
    view.fromServer = true;
    view.stopRequestedAt = typeof raw.stopRequestedAt === 'string' ? raw.stopRequestedAt : '';
    return view;
  }
  const status = String((request && request.status) || 'Draft');
  const number = Object.prototype.hasOwnProperty.call(STUDIO_DATA_STATUS_STAGE, status) ? STUDIO_DATA_STATUS_STAGE[status] : 1;
  const meta = adsStudioStatusMeta(status);
  const fallback = studioStageView({ stage: number, labels: { en: meta.label, ar: meta.labelAr } });
  fallback.fromServer = false;
  fallback.actions = [];
  fallback.stopRequestedAt = '';
  return fallback;
}

// "checked X ago" for a time the server gave (the server's own wording, studio_results.checked_ago).
function studioDataCheckedAgo(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(Math.floor((Date.now() - at) / 1000), 0);
  if (seconds < 60) return adsStudioText('checked just now', 'فُحص الآن');
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(seconds / 3600);
  const days = Math.floor(seconds / 86400);
  const ar = (n, one, two, few, many) => (n === 1 ? one : n === 2 ? two : `${n} ${n >= 3 && n <= 10 ? few : many}`);
  if (minutes < 60) return adsStudioText(`checked ${minutes} minute${minutes !== 1 ? 's' : ''} ago`, `فُحص قبل ${ar(minutes, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة')}`);
  if (hours < 48) return adsStudioText(`checked ${hours} hour${hours !== 1 ? 's' : ''} ago`, `فُحص قبل ${ar(hours, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}`);
  return adsStudioText(`checked ${days} days ago`, `فُحص قبل ${ar(days, 'يوم', 'يومين', 'أيام', 'يوماً')}`);
}

function studioDataIsStale(iso) {
  const at = Date.parse(String(iso || ''));
  return Number.isFinite(at) && Date.now() - at > STUDIO_DATA_STALE_MS;
}

// A whole number of cents from the server, or null.
function studioDataMinor(value) {
  return Number.isSafeInteger(value) ? value : null;
}

// An amount in its own currency: USD with "$", LYD in LYD / د.ل, anything else with its code.
function studioDataMoneyIn(minor, currency) {
  const code = String(currency || 'USD').trim().toUpperCase();
  if (code === 'USD') return studioUsd(minor);
  if (code === 'LYD') return studioLyd(minor);
  const text = studioMinorText(minor);
  return text && /^[A-Z]{3}$/.test(code) ? `${text} ${code}` : '—';
}

function studioDataName(request) {
  const name = String((request && request.name) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return name ? name.slice(0, 160) : adsStudioText('Untitled request', 'طلب بدون اسم');
}

// The stage chip: the server's words with an icon, never colour alone.
function renderStudioStageChip(view) {
  return `<span class="studio-stage-chip" data-tone="${studioEsc(view.tone || 'slate')}" data-stage="${Number(view.stage) || 0}">${studioV2Icon(view.icon || 'circle-help', 'studio-stage-chip-icon')}<span>${studioEsc(view.label)}</span></span>`;
}

// ------------------------------------------------------------------ Home

const STUDIO_HOME_ACTIVE_STAGES = Object.freeze([2, 4, 5, 6, 7, 8, 9, 10]);
const STUDIO_HOME_MAX_TRACKERS = 3;
const STUDIO_HOME_MAX_DRAFTS = 3;
// [key, icon, English, Arabic, hint EN, hint AR]; the ad goals open the request builder.
const STUDIO_HOME_GOALS = Object.freeze([
  ['messages', 'message-circle', 'Get more messages', 'احصل على رسائل أكثر', 'An ad that gets people talking to you', 'إعلان يدفع الناس إلى مراسلتك'],
  ['promote', 'rocket', 'Promote a post', 'روّج منشوراً', 'Show one of your posts to more people', 'اعرض أحد منشوراتك على أشخاص أكثر'],
  ['grow', 'trending-up', 'Grow my page', 'نمِّ صفحتي', 'More people find and follow your page', 'يجد صفحتك ويتابعها أشخاص أكثر'],
  ['comments', 'messages-square', 'Answer comments', 'ردّ على التعليقات', 'Replies on your posts, set up once', 'ردود على منشوراتك تضبطها مرة واحدة'],
  ['help', 'life-buoy', 'Get help', 'اطلب المساعدة', 'Talk to the Albayan team', 'تحدّث مع فريق البيان']
]);
const STUDIO_HOME_AD_GOALS = Object.freeze({ messages: 'full', promote: 'boost', grow: 'boost' });

function studioHomeCanAsk() {
  return adsStudioCanUse() && adsStudioCanCreate();
}

// A goal: the ad goals open the request builder (drafts save even while sending is paused).
function studioHomeGoal(key) {
  const goal = String(key || '');
  if (Object.prototype.hasOwnProperty.call(STUDIO_HOME_AD_GOALS, goal)) {
    if (!studioHomeCanAsk()) return false;
    return studioV2Go({ tab: 'builder', section: STUDIO_HOME_AD_GOALS[goal] });
  }
  if (goal === 'comments') return studioV2Open('replies');
  if (goal === 'help') return studioV2Open('help');
  return false;
}

function studioHomeOpenRequest(id) {
  const wanted = String(id || '');
  return Security.isValidRecordId(wanted) ? studioV2Go({ tab: 'campaigns', id: wanted }) : false;
}

function renderStudioHomeHead(id, title, link) {
  return `
            <div class="studio-home-head">
              <h2 id="${id}" class="studio-home-h2">${studioEsc(title)}</h2>
              ${link || ''}
            </div>`;
}

function renderStudioHomeLink(onclick, label, testId) {
  return `<button type="button" class="studio-home-link" data-testid="${testId}" onclick="${onclick}">${studioEsc(label)}</button>`;
}

function renderStudioHomeProblem(info) {
  const text = info && info.text ? info.text : adsStudioText('This could not be loaded. Try again in a moment.', 'تعذّر التحميل. أعد المحاولة بعد لحظات.');
  return `
            <div class="studio-home-problem" role="alert">
              <p>${studioEsc(text)}</p>
              <button type="button" class="studio-v2-action" data-testid="studio-home-retry" onclick="studioDataRetry()">${studioEsc(adsStudioText('Try again', 'أعد المحاولة'))}</button>
            </div>`;
}

// The money strip (PLAN.md §7.8), exactly the numbers of GET /api/studio/wallet/summary.
function renderStudioHomeMoney(wallet, loadState) {
  const usd = wallet && wallet.usd && typeof wallet.usd === 'object' ? wallet.usd : null;
  const value = field => (usd ? studioDataMinor(usd[field]) : null);
  const metaUsed = value('metaUsedInAdsMinor');
  const metaLine = metaUsed === null ? '' : (() => {
    const ago = studioDataCheckedAgo(usd.metaCheckedAt);
    const used = studioUsd(metaUsed);
    return adsStudioText(`Meta used ${used} so far${ago ? ` · ${ago}` : ''}`, `استخدمت ميتا ${used} حتى الآن${ago ? ` · ${ago}` : ''}`);
  })();
  const items = [
    ['available', 'availableMinor', 'Available', 'متاح', 'Yours to use now', 'لك، وتستطيع استخدامه الآن'],
    ['reserved', 'reservedMinor', 'Reserved', 'محجوز', 'Held for requests our team is reviewing — still yours', 'محجوز لطلبات يراجعها فريقنا — ما زال لك'],
    ['in-ads', 'inAdsMinor', 'In your ads', 'في إعلاناتك', 'Paid for approved ads — what Meta does not use may come back', 'مدفوع لإعلانات معتمدة — ما لا تصرفه ميتا قد يعود إليك'],
    ['spent', 'spentMinor', 'Spent', 'صُرف', 'Final: what your finished ads used', 'نهائي: ما صرفته إعلاناتك المنتهية']
  ];
  const returning = value('beingReturnedMinor');
  if (returning !== null && returning !== 0) {
    items.push(['returning', 'beingReturnedMinor', 'Being returned', 'في طريقه إليك', 'On its way back to you, usually within minutes', 'في طريقه إلى رصيدك، عادةً خلال دقائق']);
  }
  const cells = items.map(([key, field, en, ar, noteEn, noteAr]) => {
    const minor = value(field);
    const extra = key === 'in-ads' && metaLine ? `<dd class="studio-home-money-meta" data-testid="studio-money-meta-used">${studioEsc(metaLine)}</dd>` : '';
    return `
              <div class="studio-home-money-item" data-testid="studio-money-${key}"${minor === null ? '' : ` data-minor="${minor}"`}>
                <dt class="studio-home-money-label">${studioEsc(adsStudioText(en, ar))}</dt>
                <dd class="studio-home-money-value">${minor === null ? '<span aria-hidden="true">—</span>' : studioLtr(studioUsd(minor))}</dd>
                <dd class="studio-home-money-note">${studioEsc(adsStudioText(noteEn, noteAr))}</dd>${extra}
              </div>`;
  }).join('');
  const busy = !usd && loadState.loading;
  return `
          <section class="studio-home-block" data-testid="studio-home-money" aria-labelledby="studio-home-money-title"${busy ? ' aria-busy="true"' : ''}>
            ${renderStudioHomeHead('studio-home-money-title', adsStudioText('Your ad money', 'أموال إعلاناتك'),
              renderStudioHomeLink("studioV2Open('wallet')", adsStudioText('Open wallet', 'افتح المحفظة'), 'studio-home-wallet-link'))}
            <dl class="studio-home-money">${cells}
            </dl>
            ${!usd && loadState.error ? renderStudioHomeProblem(loadState.error) : ''}
          </section>`;
}

// "Needs you": what waits for the customer, most urgent first.
function studioHomeNeeds(requests, wallet) {
  const items = [];
  const usd = wallet && wallet.usd && typeof wallet.usd === 'object' ? wallet.usd : null;
  const available = usd ? studioDataMinor(usd.availableMinor) : null;
  if (!adsStudioCanUse() && adsStudioCanCreate()) {
    items.push({
      key: 'plan', icon: 'badge-alert', tone: 'orange',
      title: adsStudioText('Your plan has ended', 'انتهى اشتراكك'),
      text: adsStudioText('Renew it to send new requests. Your money and your ads stay safe meanwhile.', 'جدّده لترسل طلبات جديدة. أموالك وإعلاناتك تبقى محفوظة في الأثناء.'),
      button: adsStudioText('Renew', 'جدّد'), onclick: "showSubscriptionModal('ad_maker', 'ad_maker')"
    });
  }
  for (const request of requests.filter(row => String(row.status || '') === 'Changes Requested')) {
    const reason = adsStudioReviewReasonLabel(request.reviewReasonCode);
    const note = String(request.reviewNote || '').replace(/\s+/g, ' ').trim();
    items.push({
      key: `fix-${request.id}`, icon: 'message-square-warning', tone: 'orange',
      title: reason ? adsStudioText(`Needs your changes: ${reason}`, `يحتاج تعديلك: ${reason}`) : adsStudioText('Needs your changes', 'يحتاج تعديلك'),
      text: `${studioDataName(request)}${note ? ` — ${note.length > 140 ? `${note.slice(0, 139)}…` : note}` : ''}`,
      textAuto: true,  // the customer's and the reviewer's own words: their direction, not the page's
      button: adsStudioText('Fix it', 'عدّله'), onclick: `studioHomeOpenRequest('${request.id}')`
    });
  }
  const drafts = requests.filter(row => String(row.status || 'Draft') === 'Draft');
  for (const request of drafts.slice(0, STUDIO_HOME_MAX_DRAFTS)) {
    const total = adsStudioRequestTotalMinor(request);
    const covered = available !== null && total > 0 && available >= total;
    items.push({
      key: `draft-${request.id}`, icon: 'pencil', tone: 'slate',
      title: adsStudioText(`Not sent yet: ${studioDataName(request)}`, `لم يُرسل بعد: ${studioDataName(request)}`),
      text: covered
        ? adsStudioText('Your available money covers it — send it when you are ready.', 'رصيدك المتاح يكفيه — أرسله عندما تكون جاهزاً.')
        : adsStudioText('Finish it and send it to our team when you are ready.', 'أكمله وأرسله إلى فريقنا عندما تكون جاهزاً.'),
      button: adsStudioText('Open', 'افتح'), onclick: `studioHomeOpenRequest('${request.id}')`
    });
  }
  if (drafts.length > STUDIO_HOME_MAX_DRAFTS) {
    const more = drafts.length - STUDIO_HOME_MAX_DRAFTS;
    items.push({
      key: 'drafts-more', icon: 'files', tone: 'slate',
      title: adsStudioText(`${more} more draft${more === 1 ? '' : 's'}`, `${more === 1 ? 'مسودة أخرى' : `${more} مسودات أخرى`}`),
      text: adsStudioText('They are all in My ads.', 'تجدها كلها في «إعلاناتي».'),
      button: adsStudioText('My ads', 'إعلاناتي'), onclick: "studioV2Go({ tab: 'campaigns', section: 'waiting' })"
    });
  }
  const pending = wallet && Array.isArray(wallet.pendingPayments) ? wallet.pendingPayments : [];
  for (const payment of pending.slice(0, 5)) {
    if (!payment || typeof payment !== 'object') continue;
    const reference = /^[A-Z0-9-]{3,40}$/.test(String(payment.reference || '')) ? String(payment.reference) : '';
    const amount = studioDataMinor(payment.amountMinor);
    const money = amount === null ? '' : studioDataMoneyIn(amount, payment.currency);
    items.push({
      key: `pay-${reference || items.length}`, icon: 'hourglass', tone: 'amber',
      title: adsStudioText('We are confirming your payment', 'نؤكد دفعتك الآن'),
      text: [reference, money].filter(Boolean).join(' · '),
      textAuto: true,
      button: adsStudioText('Wallet', 'المحفظة'), onclick: "studioV2Open('wallet')"
    });
  }
  return items;
}

function renderStudioHomeNeeds(items, loading) {
  const list = items.map(item => `
              <li class="studio-home-need" data-testid="studio-need-${studioEsc(item.key)}" data-tone="${studioEsc(item.tone)}">
                <span class="studio-home-need-icon" aria-hidden="true">${studioV2Icon(item.icon)}</span>
                <div class="studio-home-need-text">
                  <p class="studio-home-need-title">${studioEsc(item.title)}</p>
                  ${item.text ? `<p class="studio-home-need-note"${item.textAuto ? ' dir="auto"' : ''}>${studioEsc(item.text)}</p>` : ''}
                </div>
                <button type="button" class="studio-v2-action" onclick="${item.onclick}">${studioEsc(item.button)}</button>
              </li>`).join('');
  const empty = loading
    ? adsStudioText('Checking what needs you…', 'نتحقق مما يحتاجك…')
    : adsStudioText('Nothing needs you right now.', 'لا شيء يحتاجك الآن.');
  return `
          <section class="studio-home-block" data-testid="studio-home-needs" aria-labelledby="studio-home-needs-title">
            ${renderStudioHomeHead('studio-home-needs-title', adsStudioText('Needs you', 'يحتاجك'), '')}
            ${items.length ? `<ul class="studio-home-needs">${list}
            </ul>` : `<p class="studio-home-empty">${studioEsc(empty)}</p>`}
          </section>`;
}

// Getting started (J0): until the first request is sent, the four steps in their real order.
function renderStudioHomeStart(requests, wallet) {
  studioDataWant('pages');
  const pages = studioDataValue('pages');
  const usd = wallet && wallet.usd && typeof wallet.usd === 'object' ? wallet.usd : null;
  const added = usd ? studioDataMinor(usd.addedMinor) : null;
  // Unknown while its read is on the way (null); a failed read offers the step's action.
  const known = (value, kind) => (value !== null ? value : (studioDataState(kind).error ? false : null));
  const steps = [
    ['plan', adsStudioCanUse(), 'Activate your plan', 'فعّل اشتراكك', 'Paid in Libyan dinars', 'يُدفع بالدينار الليبي',
      "showSubscriptionModal('ad_maker', 'ad_maker')", 'Activate', 'فعّل'],
    ['page', known(pages === null ? null : pages > 0, 'pages'), 'Ask us to link your page', 'اطلب منا ربط صفحتك', 'So we can run ads and replies on it', 'لنشغّل عليها الإعلانات والردود',
      "studioV2Open('replies')", 'Pages', 'الصفحات'],
    ['money', known(added === null ? null : added > 0, 'wallet'), 'Add ad money', 'أضف مالاً للإعلانات', 'In US dollars, used only for your ads', 'بالدولار، ويُستخدم لإعلاناتك فقط',
      "studioV2Open('wallet')", 'Add money', 'أضف مالاً'],
    ['first', requests.some(row => String(row.status || 'Draft') !== 'Draft'), 'Send your first ad request', 'أرسل أول طلب إعلان', 'Our team reviews it before anything is charged', 'يراجعه فريقنا قبل خصم أي مبلغ',
      "studioHomeGoal('messages')", 'Start', 'ابدأ']
  ];
  const nextIndex = steps.findIndex(step => step[1] !== true);
  const rows = steps.map(([key, done, en, ar, hintEn, hintAr, onclick, buttonEn, buttonAr], index) => {
    const status = done === true
      ? `<span class="studio-home-step-status is-done">${studioV2Icon('check')}<span>${studioEsc(adsStudioText('Done', 'تم'))}</span></span>`
      : done === null
        ? `<span class="studio-home-step-status">${studioEsc(adsStudioText('Checking…', 'نتحقق…'))}</span>`
        : '';
    const canAct = done === false && (key !== 'first' || studioHomeCanAsk());
    return `
              <li class="studio-home-step${done === true ? ' is-done' : ''}${index === nextIndex ? ' is-next' : ''}" data-testid="studio-start-${key}"${index === nextIndex ? ' aria-current="step"' : ''}>
                <span class="studio-home-step-number" aria-hidden="true">${index + 1}</span>
                <div class="studio-home-step-text">
                  <p class="studio-home-step-title">${studioEsc(adsStudioText(en, ar))}</p>
                  <p class="studio-home-step-hint">${studioEsc(adsStudioText(hintEn, hintAr))}</p>
                </div>
                ${status}${canAct ? `<button type="button" class="studio-v2-action${index === nextIndex ? ' is-primary' : ''}" onclick="${onclick}">${studioEsc(adsStudioText(buttonEn, buttonAr))}</button>` : ''}
              </li>`;
  }).join('');
  return `
          <section class="studio-home-block" data-testid="studio-home-start" aria-labelledby="studio-home-start-title">
            ${renderStudioHomeHead('studio-home-start-title', adsStudioText('Getting started', 'لنبدأ'), '')}
            <ol class="studio-home-steps">${rows}
            </ol>
          </section>`;
}

// "Your ads now": the requests in progress, with their stage, who acts next and the last Meta check.
function renderStudioHomeTrackers(requests) {
  const active = requests
    .map(request => ({ request, stage: studioDataStage(request) }))
    .filter(item => STUDIO_HOME_ACTIVE_STAGES.includes(item.stage.stage));
  if (!active.length) return '';
  const rows = active.slice(0, STUDIO_HOME_MAX_TRACKERS).map(({ request, stage }) => {
    const next = stage.nextActor ? adsStudioText(`Next: ${stage.nextActor}`, `التالي: ${stage.nextActor}`) : '';
    const flags = stage.flags.map(flag => `<span class="studio-flag">${studioEsc(flag.text)}</span>`).join('');
    return `
              <li>
                <button type="button" class="studio-home-tracker" data-testid="studio-tracker-${studioEsc(request.id)}" onclick="studioHomeOpenRequest('${request.id}')">
                  <span class="studio-home-tracker-name">${studioEsc(studioDataName(request))}</span>
                  ${renderStudioStageChip(stage)}
                  <span class="studio-home-tracker-meta">
                    ${next ? `<span>${studioEsc(next)}</span>` : ''}
                    ${stage.checkedAgo ? `<span class="studio-checked${stage.stale ? ' is-stale' : ''}">${studioEsc(stage.checkedAgo)}</span>` : ''}
                  </span>
                  ${flags ? `<span class="studio-flags">${flags}</span>` : ''}
                </button>
              </li>`;
  }).join('');
  return `
          <section class="studio-home-block" data-testid="studio-home-trackers" aria-labelledby="studio-home-trackers-title">
            ${renderStudioHomeHead('studio-home-trackers-title', adsStudioText('Your ads now', 'إعلاناتك الآن'),
              renderStudioHomeLink("studioV2Open('campaigns')", adsStudioText('See all', 'عرض الكل'), 'studio-home-all-ads'))}
            <ul class="studio-home-trackers">${rows}
            </ul>
          </section>`;
}

function renderStudioHomeGoals(paused) {
  const canAsk = studioHomeCanAsk();
  const cards = STUDIO_HOME_GOALS.map(([key, icon, en, ar, hintEn, hintAr]) => {
    const adGoal = Object.prototype.hasOwnProperty.call(STUDIO_HOME_AD_GOALS, key);
    const off = adGoal && !canAsk;
    return `
              <li>
                <button type="button" class="studio-home-goal" data-testid="studio-goal-${key}" onclick="studioHomeGoal('${key}')"${off ? ' disabled' : ''}>
                  <span class="studio-home-goal-icon" aria-hidden="true">${studioV2Icon(icon)}</span>
                  <span class="studio-home-goal-title">${studioEsc(adsStudioText(en, ar))}</span>
                  <span class="studio-home-goal-hint">${studioEsc(adsStudioText(hintEn, hintAr))}</span>
                </button>
              </li>`;
  }).join('');
  let note = '';
  if (!canAsk && adsStudioCanCreate()) note = adsStudioText('Activate your plan to start a new ad request.', 'فعّل اشتراكك لتبدأ طلب إعلان جديد.');
  else if (paused) note = adsStudioText('Sending is paused for now: your request is saved as a draft until we open again.', 'الإرسال متوقف مؤقتاً: يُحفظ طلبك مسودةً حتى نستأنف.');
  return `
          <section class="studio-home-block" data-testid="studio-home-goals" aria-labelledby="studio-home-goals-title">
            ${renderStudioHomeHead('studio-home-goals-title', adsStudioText('What do you want to do?', 'ماذا تريد أن تفعل؟'), '')}
            <ul class="studio-home-goals">${cards}
            </ul>
            ${note ? `<p class="studio-home-empty">${studioEsc(note)}</p>` : ''}
          </section>`;
}

function renderStudioHomeBody() {
  studioDataWant('campaigns');
  studioDataWant('wallet');
  const me = studioMe();
  const requests = studioDataRequests();
  const wallet = studioDataValue('wallet');
  const walletState = studioDataState('wallet');
  const paused = !!(me && me.intakeOpen === false);
  const banner = paused ? `
          <div class="studio-home-banner" role="status" data-testid="studio-intake-paused">
            ${studioV2Icon('circle-pause')}
            <p>${studioEsc(adsStudioText('New ad requests will open again soon — your drafts are saved.', 'نستقبل طلبات الإعلانات الجديدة مجدداً قريباً — مسوداتك محفوظة.'))}</p>
          </div>` : '';
  const firstRun = !requests.some(row => String(row.status || 'Draft') !== 'Draft' || String(row.submittedAt || ''));
  const needs = studioHomeNeeds(requests, wallet);
  const gate = !adsStudioCanUse() ? `<div class="studio-v2-gate">${renderAdsStudioSubscriptionGate()}</div>` : '';
  return `
        <div class="studio-home" data-testid="studio-home">${banner}
          ${firstRun ? renderStudioHomeStart(requests, wallet) : ''}
          ${renderStudioHomeMoney(wallet, walletState)}
          ${renderStudioHomeNeeds(needs, !wallet && walletState.loading)}
          ${renderStudioHomeTrackers(requests)}
          ${renderStudioHomeGoals(paused)}
          ${gate}
        </div>`;
}

studioPlugScreen('home', renderStudioHomeBody);
// ==========================================
// ALBAYAN STUDIO v2 — MY ADS (plan task P2-04; styles in assets/ads-workspace.css, "Studio v2 Home and My ads")
// ==========================================
// The customer's requests in the v2 layout (?tab=campaigns), drawn through the Home file's plug (15j):
// - the list: every own request with its stage chip, filters All / Active / Waiting / Finished
//   (&section=active|waiting|finished, so a filter survives Back and a reload);
// - the detail (&id=): stage tracker, who acts next and the last Meta check, the reason and note of a
//   request sent back, the money chain of that request (GET /api/studio/wallet/summary, exactly as
//   the server gives it), Meta's results once the team linked the campaign, and the actions the
//   server's stage allows;
// - in-page sheets, never a native dialog: Withdraw (a request waiting for review), Stop (the stop
//   route's own rule: approved, not started, not linked: a full refund), Archive (a finished request;
//   a draft is deleted), and "Ask to stop" / "Ask about this": coming soon in the app, meanwhile the
//   public contact from /me (P3-10 and P3-08 replace them).
// Every action is single-flight; withdraw and stop send one operationId per (action, version)
// through the classic helpers (adsStudioActionAttempt), so a retry after a lost answer replays it.
// A sheet is a .mobile-dialog-overlay on <body>: the phone's Back closes it first (01b overlay model),
// and every sign-in change removes it with the app's other overlays (10-live-sync).

const STUDIO_ADS_FILTERS = Object.freeze([
  // [section, English, Arabic, stages]
  ['', 'All', 'الكل', null],
  ['active', 'Active', 'جارية', [4, 5, 6, 7, 8, 9, 10]],
  ['waiting', 'Waiting', 'بالانتظار', [1, 2, 3]],
  ['finished', 'Finished', 'منتهية', [11, 12, 13]]
]);
const STUDIO_ADS_TRACK = Object.freeze([
  ['sent', 'Sent', 'أُرسل'],
  ['approved', 'Approved', 'اعتُمد'],
  ['meta_review', 'Meta review', 'مراجعة ميتا'],
  ['running', 'Running', 'يعمل'],
  ['ended', 'Ended', 'انتهى'],
  ['finished', 'Closed', 'أُغلق']
]);
// The tracker dot of a stage whose server answer is not known yet (stage number - 1).
const STUDIO_ADS_TRACK_BY_STAGE = Object.freeze(['not_sent', 'sent', 'sent', 'approved', 'meta_review', 'meta_review', 'running', 'running', 'running', 'ended', 'finished', 'finished', 'sent']);
const STUDIO_ADS_BUCKETS = Object.freeze({
  inAds: ['In your ads', 'في إعلاناتك'],
  beingReturned: ['Being returned', 'في طريقه إليك'],
  spent: ['Spent', 'صُرف']
});
const _studioAdsRuns = new Map();  // `${kind}:${id}` -> the action in flight (single flight)
const _studioAdsSheet = { kind: '', id: '', el: null, opener: null };

// ------------------------------------------------------------------ navigation

function studioAdsSection(route) {
  const section = String((route && route.section) || '');
  return STUDIO_ADS_FILTERS.some(item => item[0] === section) ? section : '';
}

function studioAdsFilter(section) {
  const key = STUDIO_ADS_FILTERS.some(item => item[0] === String(section || '')) ? String(section || '') : '';
  return studioV2Go({ tab: 'campaigns', section: key });
}

function studioAdsCurrentSection() {
  return typeof studioV2ReadAddress === 'function' ? studioAdsSection(studioV2Route(studioV2ReadAddress(), 'customer')) : '';
}

function studioAdsOpen(id) {
  const wanted = String(id || '');
  if (!Security.isValidRecordId(wanted)) return false;
  return studioV2Go({ tab: 'campaigns', section: studioAdsCurrentSection(), id: wanted });
}

function studioAdsBackToList() {
  return studioV2Go({ tab: 'campaigns', section: studioAdsCurrentSection() });
}

// Opens a draft (or a request sent back) in the request builder. Until the v2 builder (P2-05) has
// its own opener this is the classic loader, which puts ?tab=builder in the address itself.
function studioAdsEdit(id) {
  const request = studioDataRequest(id);
  if (!request || !['Draft', 'Changes Requested'].includes(String(request.status || 'Draft'))) return false;
  if (typeof startAdsStudioCampaign === 'function') startAdsStudioCampaign(request.id);
  return true;
}

// ------------------------------------------------------------------ the list

function studioAdsBudgetText(request) {
  const total = String(request.status || '') === 'Submitted' ? adsStudioHeldMinorFor(request) : adsStudioRequestTotalMinor(request);
  const days = adsStudioCampaignDays(request);
  const money = total > 0 ? studioUsd(total) : '';
  if (money && days) return adsStudioText(`${money} for ${adsStudioDaysText(days)}`, `${money} لمدة ${adsStudioDaysText(days)}`);
  return money || (days ? adsStudioDaysText(days) : '');
}

function renderStudioAdsCard(request, stage) {
  const next = stage.nextActor ? adsStudioText(`Next: ${stage.nextActor}`, `التالي: ${stage.nextActor}`) : '';
  const budget = studioAdsBudgetText(request);
  const flags = stage.flags.map(flag => `<span class="studio-flag">${studioEsc(flag.text)}</span>`).join('');
  return `
              <li>
                <button type="button" class="studio-ads-card" data-testid="studio-ad-${studioEsc(request.id)}" data-stage="${stage.stage}" onclick="studioAdsOpen('${request.id}')">
                  <span class="studio-ads-card-name">${studioEsc(studioDataName(request))}</span>
                  ${renderStudioStageChip(stage)}
                  <span class="studio-ads-card-meta">
                    ${budget ? `<span dir="auto">${studioEsc(budget)}</span>` : ''}
                    ${next ? `<span>${studioEsc(next)}</span>` : ''}
                    ${stage.checkedAgo ? `<span class="studio-checked${stage.stale ? ' is-stale' : ''}">${studioEsc(stage.checkedAgo)}</span>` : ''}
                  </span>
                  ${flags ? `<span class="studio-flags">${flags}</span>` : ''}
                </button>
              </li>`;
}

function renderStudioAdsList(route) {
  const section = studioAdsSection(route);
  const rows = studioDataRequests().map(request => ({ request, stage: studioDataStage(request) }));
  const summaryState = studioDataState('campaigns');
  const inFilter = (item, stages) => !stages || stages.includes(item.stage.stage);
  const chips = STUDIO_ADS_FILTERS.map(([key, en, ar, stages]) => {
    const count = rows.filter(item => inFilter(item, stages)).length;
    return `<button type="button" class="studio-ads-filter" data-testid="studio-ads-filter-${key || 'all'}" aria-pressed="${key === section ? 'true' : 'false'}" onclick="studioAdsFilter('${key}')"><span>${studioEsc(adsStudioText(en, ar))}</span><span class="studio-ads-count">${count}</span></button>`;
  }).join('');
  const stages = (STUDIO_ADS_FILTERS.find(item => item[0] === section) || STUDIO_ADS_FILTERS[0])[3];
  const shown = rows.filter(item => inFilter(item, stages));
  const empty = rows.length
    ? adsStudioText('No requests in this list.', 'لا توجد طلبات في هذه القائمة.')
    : adsStudioText('You have no ad requests yet. Start one when you are ready.', 'لا توجد لديك طلبات إعلان بعد. ابدأ واحداً عندما تكون جاهزاً.');
  const canAsk = studioHomeCanAsk();
  return `
        <div class="studio-ads" data-testid="studio-ads">
          <div class="studio-ads-bar">
            <div class="studio-ads-filters" role="group" aria-label="${studioEsc(adsStudioText('Show', 'اعرض'))}">${chips}</div>
            ${canAsk ? `<button type="button" class="studio-v2-action is-primary" data-testid="studio-ads-new" onclick="studioHomeGoal('messages')">${studioV2Icon('plus')}<span>${studioEsc(adsStudioText('New request', 'طلب جديد'))}</span></button>` : ''}
          </div>
          ${!summaryState.error ? '' : `<p class="studio-home-empty">${studioEsc(adsStudioText('The latest stages could not be loaded; the list shows what we know.', 'تعذّر تحميل آخر المراحل؛ تعرض القائمة ما نعرفه.'))}</p>`}
          ${shown.length ? `<ul class="studio-ads-list" data-testid="studio-ads-list">${shown.map(item => renderStudioAdsCard(item.request, item.stage)).join('')}
          </ul>` : `<p class="studio-home-empty" data-testid="studio-ads-empty">${studioEsc(empty)}</p>`}
        </div>`;
}

// ------------------------------------------------------------------ the detail

function renderStudioAdsTracker(stage) {
  const step = stage.tracker.step || STUDIO_ADS_TRACK_BY_STAGE[stage.stage - 1] || '';
  if (!step || step === 'not_sent') {
    return `<p class="studio-ads-track-none" data-testid="studio-ad-track">${studioV2Icon('pencil')}<span>${studioEsc(adsStudioText('Not sent yet', 'لم يُرسل بعد'))}</span></p>`;
  }
  const at = STUDIO_ADS_TRACK.findIndex(item => item[0] === step);
  const items = STUDIO_ADS_TRACK.map(([key, en, ar], index) => {
    const current = index === at;
    const mark = index < at ? ' is-done' : (current ? ' is-current' : '');
    const side = current && stage.tracker.side;
    const icon = index < at ? 'check' : (current ? (side ? stage.icon : 'circle-dot') : '');
    return `<li class="studio-ads-track-step${mark}${side ? ' is-side' : ''}"${current ? ` aria-current="step" data-tone="${studioEsc(stage.tone)}"` : ''}><span class="studio-ads-track-dot" aria-hidden="true">${icon ? studioV2Icon(icon, 'studio-ads-track-icon') : ''}</span><span class="studio-ads-track-name">${studioEsc(adsStudioText(en, ar))}</span></li>`;
  }).join('');
  // Phones show the current step in words under the dots (the names under each dot need more room).
  const current = at >= 0 ? STUDIO_ADS_TRACK[at] : null;
  const words = current ? adsStudioText(`Step ${at + 1} of ${STUDIO_ADS_TRACK.length}: ${current[1]}`, `المرحلة ${at + 1} من ${STUDIO_ADS_TRACK.length}: ${current[2]}`) : '';
  return `<ol class="studio-ads-track" data-testid="studio-ad-track" data-step="${studioEsc(step)}" aria-label="${studioEsc(adsStudioText('Progress', 'مراحل الطلب'))}">${items}</ol>${words ? `<p class="studio-ads-track-text" aria-hidden="true">${studioEsc(words)}</p>` : ''}`;
}

function renderStudioAdsReason(request, stage) {
  const status = String(request.status || '');
  if (!['Changes Requested', 'Rejected'].includes(status) && ![3, 13].includes(stage.stage)) return '';
  const labels = [adsStudioReviewReasonLabel(request.reviewReasonCode)].concat(stage.reasons.map(adsStudioReviewReasonLabel)).filter(Boolean);
  const unique = Array.from(new Set(labels));
  const note = String(request.reviewNote || '').trim();
  if (!unique.length && !note) return '';
  const rejected = status === 'Rejected' || stage.stage === 13;
  return `
          <section class="studio-ads-box studio-ads-reason" data-testid="studio-ad-reason" data-tone="${rejected ? 'red' : 'orange'}">
            <h3 class="studio-ads-h3">${studioEsc(rejected ? adsStudioText('Why our team did not approve it', 'لماذا لم يعتمده فريقنا') : adsStudioText('What to change', 'ما المطلوب تعديله'))}</h3>
            ${unique.length ? `<p class="studio-ads-reason-label">${studioEsc(unique.join(' · '))}</p>` : ''}
            ${note ? `<p class="studio-ads-reason-note" dir="auto">${studioEsc(note.slice(0, 2000))}</p>` : ''}
          </section>`;
}

function renderStudioAdsMoneyRow(label, minor, testId = '') {
  return `<li class="studio-ads-money-row"${testId ? ` data-testid="${testId}"` : ''}><span>${studioEsc(label)}</span><span class="studio-ads-money-amount">${studioLtr(studioUsd(minor))}</span></li>`;
}

// This request's money, from the wallet summary: its reservation and every paid cycle (payment,
// returns, and the number that cycle counts in), with the server's own labels and amounts.
function renderStudioAdsMoney(request, stage) {
  const wallet = studioDataValue('wallet');
  const walletState = studioDataState('wallet');
  const id = request.id;
  const reserved = wallet && Array.isArray(wallet.reserved) ? wallet.reserved.find(item => item && item.campaignId === id) : null;
  const chains = wallet && Array.isArray(wallet.chains) ? wallet.chains.filter(chain => chain && chain.campaignId === id) : [];
  let body = '';
  if (!wallet) {
    body = walletState.error ? renderStudioHomeProblem(walletState.error)
      : `<p class="studio-home-empty">${studioEsc(adsStudioText('Loading the money of this request…', 'نحمّل أموال هذا الطلب…'))}</p>`;
  } else {
    const parts = [];
    const held = reserved ? studioDataMinor(reserved.budgetMinor) : null;
    if (held !== null) {
      const daily = studioDataMinor(reserved.dailyMinor);
      const days = studioDataMinor(reserved.days);
      parts.push(`<ul class="studio-ads-money-rows" data-testid="studio-ad-reserved">
              ${renderStudioAdsMoneyRow(adsStudioText('Reserved — still yours', 'محجوز — ما زال لك'), held)}
            </ul>${daily !== null && days !== null ? `<p class="studio-ads-money-note">${studioLtr(`${studioUsd(daily)} × ${days}`)} ${studioEsc(adsStudioText('(daily × days)', '(يومياً × الأيام)'))}</p>` : ''}`);
    }
    for (const chain of chains) {
      const steps = (Array.isArray(chain.steps) ? chain.steps : []).filter(step => step && typeof step === 'object' && studioDataMinor(step.amountMinor) !== null);
      const bucket = Object.prototype.hasOwnProperty.call(STUDIO_ADS_BUCKETS, chain.bucket) ? STUDIO_ADS_BUCKETS[chain.bucket] : null;
      const net = studioDataMinor(chain.netMinor);
      const returned = studioDataMinor(chain.returnedMinor);
      const full = chain.state === 'returned' && returned !== null;
      const totalLabel = full ? adsStudioText('Came back to you in full', 'عاد إليك كاملاً') : (bucket ? adsStudioText(bucket[0], bucket[1]) : '');
      const totalMinor = full ? returned : net;
      const used = studioDataMinor(chain.metaUsedMinor);
      const ago = used === null ? '' : studioDataCheckedAgo(chain.checkedAt);
      parts.push(`<div class="studio-ads-chain" data-testid="studio-ad-chain" data-bucket="${studioEsc(chain.bucket || '')}">
              <ul class="studio-ads-money-rows">${steps.map(step => renderStudioAdsMoneyRow(studioPickText(step.labels, 240), step.amountMinor)).join('')}</ul>
              ${totalLabel && totalMinor !== null ? `<p class="studio-ads-chain-total"><span>${studioEsc(totalLabel)}</span><span class="studio-ads-money-amount">${studioLtr(studioUsd(totalMinor))}</span></p>` : ''}
              ${used !== null ? `<p class="studio-ads-money-note" data-testid="studio-ad-meta-used">${studioEsc(adsStudioText(`Meta used ${studioUsd(used)} so far${ago ? ` · ${ago}` : ''}`, `استخدمت ميتا ${studioUsd(used)} حتى الآن${ago ? ` · ${ago}` : ''}`))}</p>` : ''}
            </div>`);
    }
    body = parts.length ? parts.join('')
      : `<p class="studio-home-empty">${studioEsc(adsStudioText('Nothing is held or paid for this request right now.', 'لا يوجد مبلغ محجوز أو مدفوع لهذا الطلب الآن.'))}</p>`;
  }
  return `
          <section class="studio-ads-box" data-testid="studio-ad-money" aria-labelledby="studio-ad-money-title">
            <h3 id="studio-ad-money-title" class="studio-ads-h3">${studioEsc(adsStudioText('Money for this request', 'أموال هذا الطلب'))}</h3>
            ${stage.money ? `<p class="studio-ads-money-meaning">${studioEsc(stage.money)}</p>` : ''}
            ${body}
          </section>`;
}

// Meta's numbers once the team linked the campaign (GET /api/studio/campaigns/{id}/results through
// the classic reader: one read at a time, the last good values kept when a read fails).
function renderStudioAdsResults(request) {
  if (typeof adsStudioShowsResults !== 'function' || !adsStudioShowsResults(request)) return '';
  adsStudioLoadResults(request.id);
  const entry = _adsStudioResults.byId.get(String(request.id));
  const data = entry ? entry.data : null;
  let body;
  if (!data) {
    body = `<p class="studio-home-empty">${studioEsc(entry && entry.state === 'failed'
      ? adsStudioText("Meta's numbers are late; we will check again automatically.", 'تأخرت أرقام ميتا؛ سنتحقق مرة أخرى تلقائياً.')
      : adsStudioText('Checking Meta…', 'نتحقق من ميتا…'))}</p>`;
  } else {
    const used = studioDataMinor(data.metaUsedMinor);
    const paid = studioDataMinor(data.paidMinor);
    const usedText = used === null ? '' : (paid
      ? adsStudioText(`Meta used ${studioUsd(used)} of ${studioUsd(paid)}`, `استخدمت ميتا ${studioUsd(used)} من ${studioUsd(paid)}`)
      : adsStudioText(`Meta used ${studioUsd(used)} so far`, `استخدمت ميتا ${studioUsd(used)} حتى الآن`));
    const stats = [
      [adsStudioText('Impressions', 'مرات الظهور'), data.impressions],
      [adsStudioText('Reach', 'الوصول'), data.reach],
      [adsStudioResultTypeLabel(data.resultType), data.resultCount]
    ].filter(([, value]) => Number.isSafeInteger(value));
    const ago = data.checkedAgo ? studioPickText(data.checkedAgo, 80) : '';
    body = `${data.stageLabels ? `<p class="studio-ads-money-meaning">${studioEsc(studioPickText(data.stageLabels, 160))}</p>` : ''}
            ${usedText ? `<p class="studio-ads-results-used" data-testid="studio-ad-results-used">${studioEsc(usedText)}</p>` : ''}
            ${stats.length ? `<dl class="studio-ads-stats">${stats.map(([label, value]) => `<div><dt>${studioEsc(label)}</dt><dd>${studioEsc(adsStudioCount(value))}</dd></div>`).join('')}</dl>` : ''}
            ${ago ? `<p class="studio-checked${data.stale ? ' is-stale' : ''}">${studioEsc(ago)}</p>` : ''}
            <p class="studio-ads-money-note">${studioEsc(adsStudioText('Reported by Meta', 'بحسب ما تُبلغ به ميتا'))}</p>`;
  }
  return `
          <section class="studio-ads-box" data-testid="studio-ad-results" aria-labelledby="studio-ad-results-title" aria-live="polite">
            <h3 id="studio-ad-results-title" class="studio-ads-h3">${studioEsc(adsStudioText('Meta results', 'نتائج ميتا'))}</h3>
            ${body}
          </section>`;
}

// The actions this request offers now: the server's stage decides, the app's permissions agree.
function studioAdsActions(request, stage) {
  const status = String(request.status || 'Draft');
  const creator = request.createdBy;
  const own = String(creator || '') === studioMeUserId();
  const offered = new Set(stage.actions);
  const out = [];
  if (['Draft', 'Changes Requested'].includes(status) && canActOnRecord('adCampaignRequests', 'edit', creator)) out.push('edit');
  if (status === 'Submitted' && own && (offered.has('withdraw') || !stage.fromServer) && canActOnRecord('adCampaignRequests', 'submit', creator)) out.push('withdraw');
  if (status === 'Approved' && offered.has('stop_refund') && canActOnRecord('adCampaignRequests', 'stop', creator)) out.push('stop');
  if (status === 'Approved' && offered.has('ask_to_stop')) out.push('ask_stop');
  if ((offered.has('archive') || offered.has('delete')) && canActOnRecord('adCampaignRequests', 'delete', creator)) out.push('archive');
  if (offered.has('ask')) out.push('ask');
  return out;
}

function studioAdsActionLabel(action, request, stage) {
  switch (action) {
    case 'edit': return String(request.status || '') === 'Changes Requested' ? adsStudioText('Fix it', 'عدّله') : adsStudioText('Continue editing', 'أكمل التعديل');
    case 'withdraw': return adsStudioText('Withdraw', 'اسحب الطلب');
    case 'stop': return adsStudioText('Stop and get a full refund', 'أوقفه واسترد المبلغ كاملاً');
    case 'ask_stop': return adsStudioText('Ask to stop', 'اطلب الإيقاف');
    case 'archive': return stage.stage === 1 ? adsStudioText('Delete draft', 'احذف المسودة') : adsStudioText('Archive', 'أرشف');
    case 'ask': return adsStudioText('Ask about this', 'اسأل عن هذا');
    default: return '';
  }
}

const STUDIO_ADS_ACTION_LOOK = Object.freeze({
  edit: ['pencil', ' is-primary', 'studioAdsEdit'],
  withdraw: ['undo-2', '', 'studioAdsSheet'],
  stop: ['circle-stop', ' studio-ads-danger', 'studioAdsSheet'],
  ask_stop: ['hand', '', 'studioAdsSheet'],
  archive: ['archive', '', 'studioAdsSheet'],
  ask: ['message-circle', '', 'studioAdsSheet']
});

function renderStudioAdsActions(request, stage) {
  const actions = studioAdsActions(request, stage);
  if (!actions.length) return '';
  const buttons = actions.map(action => {
    const [icon, look, handler] = STUDIO_ADS_ACTION_LOOK[action];
    const call = handler === 'studioAdsEdit' ? `studioAdsEdit('${request.id}')` : `studioAdsSheet('${action}', '${request.id}', this)`;
    const busy = _studioAdsRuns.has(`${action}:${request.id}`);
    return `<button type="button" class="studio-v2-action${look}" data-testid="studio-ad-action-${action}" onclick="${call}"${busy ? ' disabled aria-busy="true"' : ''}>${studioV2Icon(action === 'archive' && stage.stage === 1 ? 'trash-2' : icon)}<span>${studioEsc(studioAdsActionLabel(action, request, stage))}</span></button>`;
  }).join('');
  return `<div class="studio-ads-actions" data-testid="studio-ad-actions">${buttons}</div>`;
}

function renderStudioAdsBrief(request) {
  const platforms = (Array.isArray(request.platforms) ? request.platforms : []).map(item => String(item)).filter(Boolean)
    .map(item => (item === 'facebook' ? 'Facebook' : item === 'instagram' ? 'Instagram' : item)).join(' + ');
  const days = adsStudioCampaignDays(request);
  const rows = [
    [adsStudioText('Budget', 'الميزانية'), studioAdsBudgetText(request)],
    [adsStudioText('Page', 'الصفحة'), String(request.pageName || '')],
    [adsStudioText('Where', 'المنصات'), platforms],
    [adsStudioText('Dates', 'التواريخ'), request.startDate ? `${adsStudioFormatDate(request.startDate)} → ${adsStudioFormatDate(request.endDate)}` : (days ? adsStudioDaysText(days) : '')],
    [adsStudioText('Ad text', 'نص الإعلان'), String(request.primaryText || '')]
  ].filter(([, value]) => value);
  if (!rows.length) return '';
  return `
          <details class="studio-ads-box studio-ads-brief">
            <summary class="studio-ads-h3"><span>${studioEsc(adsStudioText('The request', 'تفاصيل الطلب'))}</span>${studioV2Icon('chevron-down', 'studio-ads-brief-icon')}</summary>
            <dl class="studio-ads-brief-list">${rows.map(([label, value]) => `<div><dt>${studioEsc(label)}</dt><dd dir="auto">${studioEsc(String(value).slice(0, 2000))}</dd></div>`).join('')}</dl>
          </details>`;
}

function renderStudioAdsDetail(route) {
  const request = studioDataRequest(route.id);
  if (!request) {
    return `
        <div class="studio-ads-box studio-ads-missing" data-testid="studio-ad-missing">
          <p>${studioEsc(adsStudioText('This request is not in your list any more.', 'هذا الطلب لم يعد في قائمتك.'))}</p>
          <button type="button" class="studio-v2-action" onclick="studioAdsBackToList()">${studioEsc(adsStudioText('My ads', 'إعلاناتي'))}</button>
        </div>`;
  }
  const stage = studioDataStage(request);
  const next = stage.nextActor ? adsStudioText(`Next: ${stage.nextActor}`, `التالي: ${stage.nextActor}`) : '';
  const flags = stage.flags.map(flag => `<span class="studio-flag">${studioEsc(flag.text)}</span>`).join('');
  return `
        <article class="studio-ads-detail" data-testid="studio-ad-detail" data-stage="${stage.stage}" aria-labelledby="studio-ad-name">
          <header class="studio-ads-box studio-ads-head">
            <h2 id="studio-ad-name" class="studio-ads-name" dir="auto">${studioEsc(studioDataName(request))}</h2>
            ${renderStudioStageChip(stage)}
            ${stage.variant ? `<p class="studio-ads-variant">${studioEsc(stage.variant)}</p>` : ''}
            ${renderStudioAdsTracker(stage)}
            <p class="studio-ads-next">
              ${next ? `<span data-testid="studio-ad-next">${studioEsc(next)}</span>` : ''}
              ${stage.checkedAgo ? `<span class="studio-checked${stage.stale ? ' is-stale' : ''}">${studioEsc(stage.checkedAgo)}</span>` : ''}
            </p>
            ${flags ? `<p class="studio-flags">${flags}</p>` : ''}
            ${renderStudioAdsActions(request, stage)}
          </header>
          ${renderStudioAdsReason(request, stage)}
          ${renderStudioAdsMoney(request, stage)}
          ${renderStudioAdsResults(request)}
          ${renderStudioAdsBrief(request)}
        </article>`;
}

function renderStudioAdsBody(route) {
  studioDataWant('campaigns');
  studioDataWant('wallet');
  return route && route.id ? renderStudioAdsDetail(route) : renderStudioAdsList(route);
}

studioPlugScreen('campaigns', renderStudioAdsBody);

// ------------------------------------------------------------------ sheets

// Contact links for the "coming soon" sheets: the public contact of /me (never the urgent line).
function renderStudioAdsContact(request, purpose) {
  const me = studioMe();
  const contact = me && me.contact ? me.contact : {};
  const name = studioDataName(request).slice(0, 80);
  const ref = /^ALB-S-[A-Za-z0-9]{1,20}$/.test(String(request.studioRef || '')) ? ` (${request.studioRef})` : '';
  const message = purpose === 'stop'
    ? adsStudioText(`Hello Albayan team, please stop my ad "${name}"${ref}.`, `مرحباً فريق البيان، أرجو إيقاف إعلاني «${name}»${ref}.`)
    : adsStudioText(`Hello Albayan team, I have a question about my request "${name}"${ref}.`, `مرحباً فريق البيان، لدي سؤال عن طلبي «${name}»${ref}.`);
  const links = [];
  if (contact.whatsapp) {
    links.push(['whatsapp', `https://wa.me/${contact.whatsapp.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`, 'message-circle', adsStudioText('WhatsApp', 'واتساب'), true]);
  }
  if (contact.phone) links.push(['phone', `tel:${contact.phone}`, 'phone', adsStudioText('Call us', 'اتصل بنا'), false]);
  if (contact.email) {
    links.push(['email', `mailto:${contact.email}?subject=${encodeURIComponent(message.slice(0, 120))}`, 'mail', adsStudioText('Email', 'البريد'), false]);
  }
  const open = me && me.serviceHours && typeof me.serviceHours.openNow === 'boolean' ? me.serviceHours.openNow : null;
  const hours = open === null ? '' : (open
    ? adsStudioText('We are working now.', 'نحن في ساعات العمل الآن.')
    : adsStudioText('We are outside working hours now; we answer as soon as we open.', 'نحن خارج ساعات العمل الآن؛ نرد فور بدء الدوام.'));
  const list = links.map(([key, href, icon, label, newTab]) =>
    `<a class="studio-v2-action" data-testid="studio-contact-${key}" href="${studioEsc(href)}"${newTab ? ' target="_blank" rel="noopener noreferrer"' : ''}>${studioV2Icon(icon)}<span>${studioEsc(label)}</span></a>`).join('');
  return `
            <div class="studio-ads-contact" data-testid="studio-sheet-contact">
              ${list || `<p class="studio-ads-sheet-text">${studioEsc(adsStudioText('Our contact details are not published yet. Please reach your usual Albayan contact.', 'لم تُنشر وسائل التواصل معنا بعد. تواصل مع جهة الاتصال المعتادة لديك في البيان.'))}</p>`}
              ${hours ? `<p class="studio-ads-sheet-note">${studioEsc(hours)}</p>` : ''}
              ${list ? `<p class="studio-ads-sheet-note" dir="auto">${studioEsc(adsStudioText(`Mention: ${name}${ref}`, `اذكر: ${name}${ref}`))}</p>` : ''}
            </div>`;
}

// The amount a sheet speaks of: the server's number when the wallet summary has it.
function studioAdsSheetAmount(kind, request) {
  const wallet = studioDataValue('wallet');
  if (kind === 'withdraw') {
    const item = wallet && Array.isArray(wallet.reserved) ? wallet.reserved.find(entry => entry && entry.campaignId === request.id) : null;
    const held = item ? studioDataMinor(item.budgetMinor) : null;
    return held !== null ? held : adsStudioHeldMinorFor(request);
  }
  const paid = wallet && Array.isArray(wallet.inAds) ? wallet.inAds.find(entry => entry && entry.campaignId === request.id) : null;
  const inAds = paid ? studioDataMinor(paid.inAdsMinor) : null;
  return inAds !== null ? inAds : Math.max(parseInt(request.paidMinorUSD, 10) || 0, 0);
}

function renderStudioAdsSheet(kind, request, stage) {
  const amount = kind === 'withdraw' || kind === 'stop' ? studioUsd(studioAdsSheetAmount(kind, request)) : '';
  const draft = stage.stage === 1;
  const texts = {
    withdraw: [adsStudioText('Withdraw this request?', 'سحب هذا الطلب؟'),
      adsStudioText(`Your reservation of ${amount} ends now and the money is available again. The request goes back to your drafts.`,
        `ينتهي حجز ${amount} الآن ويعود المبلغ إلى رصيدك المتاح، ويرجع الطلب إلى مسوداتك.`),
      adsStudioText('Withdraw', 'اسحب الطلب'), adsStudioText('Keep it', 'أبقِه')],
    stop: [adsStudioText('Stop this ad before it starts?', 'إيقاف هذا الإعلان قبل أن يبدأ؟'),
      adsStudioText(`The full ${amount} you paid comes back to your available money now, and the request closes as stopped.`,
        `يعود كامل المبلغ الذي دفعته ${amount} إلى رصيدك المتاح الآن، ويُغلق الطلب كطلب موقوف.`),
      adsStudioText('Stop and refund', 'أوقفه واسترد المبلغ'), adsStudioText('Keep it', 'أبقِه')],
    archive: draft
      ? [adsStudioText('Delete this draft?', 'حذف هذه المسودة؟'),
        adsStudioText('The draft and its photos are removed. Nothing was reserved for it.', 'تُحذف المسودة وصورها. لم يُحجز لها أي مبلغ.'),
        adsStudioText('Delete', 'احذف'), adsStudioText('Keep it', 'أبقِها')]
      : [adsStudioText('Archive this request?', 'أرشفة هذا الطلب؟'),
        adsStudioText('It leaves your lists. Your money history stays in the wallet.', 'يختفي من قوائمك، ويبقى سجل أموالك في المحفظة.'),
        adsStudioText('Archive', 'أرشف'), adsStudioText('Keep it', 'أبقِه')],
    ask_stop: [adsStudioText('Ask us to stop this ad', 'اطلب منا إيقاف هذا الإعلان'),
      adsStudioText('Asking from the app is coming soon. Until then, contact the Albayan team and mention this ad. Meta may keep spending until we pause it; what Meta did not spend comes back after its numbers settle, usually within 2–3 days.',
        'طلب الإيقاف من داخل التطبيق قريباً. إلى ذلك الحين تواصل مع فريق البيان واذكر هذا الإعلان. قد تواصل ميتا الصرف حتى نوقفه، ويعود إليك ما لم تصرفه ميتا بعد أن تثبت أرقامها، عادةً خلال يومين إلى ثلاثة.'),
      '', adsStudioText('Close', 'إغلاق')],
    ask: [adsStudioText('Ask about this request', 'اسأل عن هذا الطلب'),
      adsStudioText('Messages inside the app are coming soon. Until then, contact the Albayan team and mention this request.',
        'المراسلة من داخل التطبيق قريباً. إلى ذلك الحين تواصل مع فريق البيان واذكر هذا الطلب.'),
      '', adsStudioText('Close', 'إغلاق')]
  };
  const [title, text, confirmLabel, cancelLabel] = texts[kind];
  const soon = kind === 'ask_stop' || kind === 'ask';
  return `
    <div class="mobile-dialog-overlay studio-ads-sheet" data-testid="studio-sheet-${kind.replace('_', '-')}" onclick="if (event.target === this) studioAdsCloseSheet()">
      <div class="studio-ads-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="studio-ads-sheet-title" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}">
        ${soon ? `<p class="studio-ads-soon">${studioEsc(adsStudioText('Coming soon', 'قريباً'))}</p>` : ''}
        <h2 id="studio-ads-sheet-title" class="studio-ads-sheet-title">${studioEsc(title)}</h2>
        <p class="studio-ads-sheet-name" dir="auto">${studioEsc(studioDataName(request))}</p>
        <p class="studio-ads-sheet-text">${studioEsc(text)}</p>
        ${soon ? renderStudioAdsContact(request, kind === 'ask_stop' ? 'stop' : 'ask') : ''}
        <p class="studio-ads-sheet-error" role="alert" data-testid="studio-sheet-error" hidden></p>
        <div class="studio-ads-sheet-actions">
          <button type="button" class="studio-v2-action" data-testid="studio-sheet-cancel" data-sheet-focus="1" onclick="studioAdsCloseSheet()">${studioEsc(cancelLabel)}</button>
          ${confirmLabel ? `<button type="button" class="studio-v2-action is-primary${kind === 'stop' ? ' studio-ads-danger' : ''}" data-testid="studio-sheet-confirm" onclick="studioAdsConfirmSheet()">${studioEsc(confirmLabel)}</button>` : ''}
        </div>
      </div>
    </div>`;
}

// Opens one sheet (another open one is replaced). The request must still offer that action.
function studioAdsSheet(kind, id, opener = null) {
  if (typeof document === 'undefined' || !document.body) return false;
  const request = studioDataRequest(id);
  if (!request) return false;
  const stage = studioDataStage(request);
  if (!studioAdsActions(request, stage).includes(kind) || kind === 'edit') return false;
  const holder = document.createElement('div');
  holder.innerHTML = renderStudioAdsSheet(kind, request, stage).trim();
  const el = holder.firstElementChild;
  if (!el) return false;
  const previous = _studioAdsSheet.el;
  _studioAdsSheet.kind = kind;
  _studioAdsSheet.id = request.id;
  _studioAdsSheet.el = el;
  _studioAdsSheet.opener = opener || _studioAdsSheet.opener;
  el.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (_studioAdsSheet.el === el) studioAdsCloseSheet();
    }
  });
  if (previous && previous.isConnected) previous.replaceWith(el);
  else document.body.appendChild(el);
  if (typeof IconQueue !== 'undefined' && IconQueue && typeof IconQueue.schedule === 'function') IconQueue.schedule(el);
  const focus = el.querySelector('[data-sheet-focus]');
  try { if (focus) focus.focus(); } catch (_) {}
  return true;
}

function studioAdsCloseSheet() {
  const el = _studioAdsSheet.el;
  const opener = _studioAdsSheet.opener;
  _studioAdsSheet.kind = '';
  _studioAdsSheet.id = '';
  _studioAdsSheet.el = null;
  _studioAdsSheet.opener = null;
  if (el && el.isConnected) el.remove();
  try { if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus(); } catch (_) {}
}

// On a phone the open sheet owns one history entry that closing it gives back (01b overlay model);
// a navigation right after waits for that step so the two never cross.
function studioAdsAfterSheet(fn) {
  let pending = false;
  try { pending = !!(window.history.state && window.history.state.overlaySentinel); } catch (_) {}
  if (pending && typeof studioV2AfterPop === 'function') studioV2AfterPop(fn);
  else fn();
}

function studioAdsSheetBusy(el, busy, errorText = '') {
  if (!el) return;
  el.querySelectorAll('.studio-ads-sheet-actions button').forEach(button => {
    button.disabled = !!busy && button.getAttribute('data-testid') === 'studio-sheet-confirm';
    if (busy && button.getAttribute('data-testid') === 'studio-sheet-confirm') button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  });
  const error = el.querySelector('.studio-ads-sheet-error');
  if (error) {
    error.textContent = errorText;
    error.hidden = !errorText;
  }
}

function studioAdsConfirmSheet() {
  const el = _studioAdsSheet.el;
  const kind = _studioAdsSheet.kind;
  const id = _studioAdsSheet.id;
  if (!el || !el.isConnected || !['withdraw', 'stop', 'archive'].includes(kind)) return null;
  studioAdsSheetBusy(el, true);
  const operation = studioAdsRun(kind, id);
  operation.then(outcome => {
    const open = _studioAdsSheet.el === el && el.isConnected;
    if (!outcome || !outcome.ok) {
      const text = (outcome && outcome.text) || adsStudioText('The action could not be completed. Nothing changed in your balance.', 'تعذّر إتمام العملية. لم يتغير شيء في رصيدك.');
      if (open) studioAdsSheetBusy(el, false, text);
      else showNotification(adsStudioText('Not done', 'لم يتم'), text, 'error');  // the sheet was closed meanwhile
      return;
    }
    if (_studioAdsSheet.el === el) studioAdsCloseSheet();
    if (outcome.leave) {
      studioAdsAfterSheet(() => {
        const route = studioV2Route(studioV2ReadAddress(), 'customer');
        if (route.tab === 'campaigns' && route.id === id) studioAdsBackToList();
      });
    }
  });
  return operation;
}

// ------------------------------------------------------------------ the actions

// One action per request at a time: a second tap joins the first.
function studioAdsRun(kind, id) {
  const key = `${kind}:${String(id || '')}`;
  if (_studioAdsRuns.has(key)) return _studioAdsRuns.get(key);
  const once = { withdraw: studioAdsWithdrawOnce, stop: studioAdsStopOnce, archive: studioAdsArchiveOnce }[kind];
  const operation = (once ? once(String(id || '')) : Promise.resolve({ ok: false }))
    .catch(error => ({ ok: false, text: studioErrorInfo(error, 'action').text }));
  _studioAdsRuns.set(key, operation);
  const cleanup = () => {
    if (_studioAdsRuns.get(key) === operation) _studioAdsRuns.delete(key);
    studioV2Rerender();
  };
  operation.then(cleanup, cleanup);
  return operation;
}

function studioAdsNoServer() {
  return { ok: false, text: adsStudioText('This moves wallet money, which needs the connection to Albayan.', 'هذا الإجراء يحرّك أموال المحفظة، ويحتاج الاتصال بالبيان.') };
}

function studioAdsGoneText() {
  return { ok: false, text: adsStudioText('This request changed meanwhile. Check its new state.', 'تغيّر هذا الطلب في الأثناء. راجع حالته الجديدة.') };
}

// After money moved: the wallet rows, both summaries and the screen.
function studioAdsAfterMoney() {
  if (typeof resetAdsStudioWalletCache === 'function') resetAdsStudioWalletCache();
  if (typeof serverLiveSyncTick === 'function') {
    try {
      const tick = serverLiveSyncTick();
      if (tick && typeof tick.catch === 'function') tick.catch(() => {});
    } catch (_) { /* the next tick brings the rows */ }
  }
  studioDataRefresh();
  studioV2Rerender();
}

async function studioAdsWithdrawOnce(id) {
  const request = studioDataRequest(id);
  if (!request || String(request.status || '') !== 'Submitted') return studioAdsGoneText();
  if (!isServerModeEnabled()) return studioAdsNoServer();
  const held = studioAdsSheetAmount('withdraw', request);
  const attempt = adsStudioActionAttempt('withdraw', request.id, Number(request._lastModified));
  let entity;
  try {
    entity = await adsStudioApiWithdraw(request.id, attempt.expectedLastModified, attempt.operationId);
  } catch (error) {
    const fresh = error && error.status === 409 ? await adsStudioReloadCampaign(request.id) : null;
    if (!fresh || String((fresh.data && fresh.data.status) || '') !== 'Draft') throw error;
    entity = fresh;  // the first tap already withdrew it
  }
  _adsStudioActionAttempts.delete(attempt.key);
  upsertAdsStudioEntity(entity);
  studioAdsAfterMoney();
  showNotification(adsStudioText('Request withdrawn', 'سُحب الطلب'),
    adsStudioText(`${studioUsd(held)} is available again. The request is back in your drafts.`, `عاد ${studioUsd(held)} إلى رصيدك المتاح، والطلب الآن في مسوداتك.`), 'success');
  return { ok: true };
}

async function studioAdsStopOnce(id) {
  const request = studioDataRequest(id);
  if (!request || String(request.status || '') !== 'Approved') return studioAdsGoneText();
  if (!isServerModeEnabled()) return studioAdsNoServer();
  const attempt = adsStudioActionAttempt('stop', request.id, Number(request._lastModified));
  let entity;
  try {
    entity = await apiStopAdCampaignRequest(request.id, attempt.expectedLastModified, attempt.operationId, null, null);
  } catch (error) {
    const fresh = error && error.status === 409 ? await adsStudioReloadCampaign(request.id) : null;
    if (!fresh || String((fresh.data && fresh.data.status) || '') !== 'Stopped') throw error;
    entity = fresh;  // the first tap already stopped it
  }
  _adsStudioActionAttempts.delete(attempt.key);
  upsertAdsStudioEntity(entity);
  studioAdsAfterMoney();
  const refunded = studioDataMinor(entity && entity.data ? Number(entity.data.refundMinorUSD) : null);
  showNotification(adsStudioText('Ad stopped', 'أُوقف الإعلان'), refunded
    ? adsStudioText(`${studioUsd(refunded)} is back in your available money.`, `عاد ${studioUsd(refunded)} إلى رصيدك المتاح.`)
    : adsStudioText('The request is closed.', 'أُغلق الطلب.'), 'success');
  return { ok: true };
}

async function studioAdsArchiveOnce(id) {
  const request = studioDataRequest(id);
  if (!request) return { ok: true, leave: true };  // already gone
  const draft = String(request.status || 'Draft') === 'Draft';
  const done = await deleteRecord(state.adCampaignRequests, request.id);
  if (!done) {
    return { ok: false, text: adsStudioText('This request could not be removed. Nothing changed.', 'تعذّرت إزالة هذا الطلب. لم يتغير شيء.') };
  }
  if (typeof clearTransientEntityMediaCache === 'function') clearTransientEntityMediaCache('adCampaignRequests');
  studioAdsAfterMoney();
  showNotification(
    draft ? adsStudioText('Draft deleted', 'حُذفت المسودة') : adsStudioText('Request archived', 'أُرشف الطلب'),
    draft ? adsStudioText('The draft was removed.', 'أُزيلت المسودة.') : adsStudioText('It is hidden from your lists; your money history stays in the wallet.', 'أُخفي من قوائمك، ويبقى سجل أموالك في المحفظة.'),
    'success');
  return { ok: true, leave: true };
}
