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
const ADS_STUDIO_ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ADS_STUDIO_MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const ADS_STUDIO_MAX_SELECTED_SOURCE_BYTES = 40 * 1024 * 1024;
const ADS_STUDIO_MAX_TOTAL_CREATIVE_BYTES = 5 * 1024 * 1024;

function resetAdsStudioSessionState() {
  if (typeof resetSocialStudioState === 'function') resetSocialStudioState();
  // Invalidate image compression still running for the previous draft/session.
  _adsStudioPhotoToken++;
  if (typeof window !== 'undefined' && window._adsStudioSearchTimer) {
    clearTimeout(window._adsStudioSearchTimer);
    window._adsStudioSearchTimer = null;
  }
  _adsStudioActiveTab = 'dashboard';
  _adsStudioWizardStep = 1;
  _adsStudioEditingId = '';
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
  if (typeof resetAdsStudioWalletCache === 'function') resetAdsStudioWalletCache();
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
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 0));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
    endDate: _adsStudioDateOffset(8),
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
// customer only names the campaign, pastes the post, and sets a budget.
function beginAdsStudioBoost(boostType) {
  const kind = boostType === 'boost_page' ? 'boost_page' : 'boost_post';
  beginAdsStudioCampaign();
  _adsStudioDraft.boostType = kind;
  _adsStudioDraft.objective = 'engagement';
  _adsStudioDraft.callToAction = kind === 'boost_post' ? 'Send Message' : 'Learn More';
  _adsStudioDraft.name = kind === 'boost_post'
    ? adsStudioText('Boost a post', 'تعزيز منشور')
    : adsStudioText('Boost my Page', 'تعزيز صفحتي');
  setAdsStudioTab('builder');
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

function adsStudioObjectiveLabel(objective) {
  const item = ADS_STUDIO_OBJECTIVES.find(row => row.id === objective);
  return item ? adsStudioText(item.label, item.labelAr) : String(objective || '—');
}

function adsStudioMoney(minor) {
  const value = Math.max(0, Math.trunc(Number(minor) || 0));
  return `$${(value / 100).toFixed(2)}`;
}

// "$25.00 (≈ 130 LYD)" companion — an estimate for planning, never a charge.
function adsStudioMoneyWithLyd(minor) {
  const usd = adsStudioMoney(minor);
  const rate = typeof _adsStudioUsdToLydRate === 'function' ? _adsStudioUsdToLydRate() : 0;
  if (!(rate > 1)) return usd;
  const lyd = Math.ceil((Math.max(0, Math.trunc(Number(minor) || 0)) / 100) * rate);
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
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
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
          <h1 class="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white truncate">${isAr ? 'استوديو إعلانات البيان' : 'Albayan Ads Studio'}</h1>
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
    <div class="mb-6 overflow-x-auto custom-scrollbar pb-2">
      <div class="flex min-w-max gap-2" role="tablist" aria-label="${isAr ? 'أقسام استوديو الإعلانات' : 'Ads Studio sections'}">
        ${adsStudioTabsForUser().map(tab => {
          const active = _adsStudioActiveTab === tab.id;
          return `
            <button type="button" role="tab" aria-selected="${active}" onclick="setAdsStudioTab('${tab.id}')" class="touch-target inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${active ? 'bg-gradient-to-r from-blue-600 to-cyan-500 text-white shadow-lg' : 'bg-white/70 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300 border border-white/60 dark:border-slate-700'}">
              <i data-lucide="${tab.icon}" class="w-4 h-4"></i><span>${isAr ? tab.labelAr : tab.label}</span>
              ${tab.id === 'review' ? `<span class="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px]">${getVisibleAdsStudioCampaigns().filter(item => item.status === 'Submitted').length}</span>` : ''}
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
        </div>`;
    }
    return `<div class="max-w-7xl mx-auto" dir="${isAr ? 'rtl' : 'ltr'}">${renderAdsStudioHeader()}${renderAdsStudioSubscriptionGate()}</div>`;
  }

  let content = '';
  if (_adsStudioActiveTab === 'campaigns') content = renderAdsStudioCampaigns();
  else if (_adsStudioActiveTab === 'builder') content = renderAdsStudioBuilder();
  else if (_adsStudioActiveTab === 'review') content = renderAdsStudioReviewQueue();
  else if (_adsStudioActiveTab === 'posts') content = renderSocialStudioPostsTab();
  else if (_adsStudioActiveTab === 'replies') content = renderSocialStudioRepliesTab();
  else content = renderAdsStudioDashboard();

  return `
    <div class="max-w-7xl mx-auto" dir="${isAr ? 'rtl' : 'ltr'}">
      ${renderAdsStudioHeader()}
      ${renderAdsStudioTabBar()}
      ${content}
    </div>
  `;
}

function renderAdsStudioDashboard() {
  const campaigns = getVisibleAdsStudioCampaigns();
  const draftCount = campaigns.filter(item => ['Draft', 'Changes Requested'].includes(String(item.status || 'Draft'))).length;
  const reviewCount = campaigns.filter(item => item.status === 'Submitted').length;
  const approvedCount = campaigns.filter(item => item.status === 'Approved').length;
  const lifetimeBudget = campaigns
    .filter(item => String(item.budgetType || 'lifetime') !== 'daily')
    .reduce((sum, item) => sum + Math.max(0, Number(item.budgetMinorUSD) || 0), 0);
  const dailyBudget = campaigns
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
      <div class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-700 via-blue-600 to-cyan-500 p-6 sm:p-8 text-white shadow-2xl">
        <div class="absolute -right-10 -top-16 h-52 w-52 rounded-full bg-white/10"></div>
        <div class="relative grid gap-6 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <span class="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-bold"><i data-lucide="shield-check" class="w-4 h-4"></i>${isAr ? 'إنشاء آمن مع مراجعة بشرية' : 'Safe creation with human review'}</span>
            <h2 class="mt-4 text-2xl sm:text-4xl font-black max-w-2xl">${isAr ? 'أنشئ إعلانك من الهاتف أو الكمبيوتر' : 'Create your next ad from phone or desktop'}</h2>
            <p class="mt-3 max-w-2xl text-blue-50">${isAr ? 'اختر الهدف والجمهور والميزانية والصور. لن يتم صرف أي مبلغ حتى تتم المراجعة والموافقة.' : 'Choose the objective, audience, budget and creative. No money is spent by this request system.'}</p>
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
          <p class="text-sm text-slate-500 mt-1">${isAr ? 'ميزانيات الحملات المطلوبة، وليست مصروفاً فعلياً' : 'Requested campaign budgets, not actual spend'}</p>
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
  const isLaunched = !!String(campaign.publishStatus || '').trim();
  const photoCount = getEntityPhotoCountHint('adCampaignRequests', campaign);
  const safeId = Security.escapeHtml(String(campaign.id || ''));
  const platforms = (Array.isArray(campaign.platforms) ? campaign.platforms : []).map(item => String(item)).join(' + ');
  const paidMinorEarly = Math.max(0, parseInt(campaign.paidMinorUSD, 10) || 0);
  const spendMinorEarly = Math.max(0, parseInt(campaign.spendMinorUSD, 10) || 0);
  // Mirror of the server's owner-stop gate: instant refund only before start.
  const ownerCanInstantStop = !isLaunched && spendMinorEarly === 0 && String(campaign.startDate || '') > _adsStudioDateOffset(0);
  const mayStop = canActOnRecord('adCampaignRequests', 'stop', campaign.createdBy);
  const canStop = statusValue === 'Approved' && (adsStudioCanReview() || (mayStop && ownerCanInstantStop));
  const showAskStop = statusValue === 'Approved' && !adsStudioCanReview() && mayStop && !ownerCanInstantStop;
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
            ${isLaunched && adsStudioCanReview() ? `<span class="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/30 px-2.5 py-1 text-[11px] font-bold text-emerald-800 dark:text-emerald-200"><i data-lucide="radio" class="w-3.5 h-3.5"></i>${Security.escapeHtml(String(campaign.publishStatus))}</span>` : ''}
          </div>
          <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span class="inline-flex items-center gap-1"><i data-lucide="target" class="w-3.5 h-3.5"></i>${Security.escapeHtml(adsStudioObjectiveLabel(campaign.objective))}</span>
            <span class="inline-flex items-center gap-1"><i data-lucide="wallet-cards" class="w-3.5 h-3.5"></i>${Security.escapeHtml(adsStudioMoneyWithLyd(campaign.budgetMinorUSD))}</span>
            <span class="inline-flex items-center gap-1"><i data-lucide="calendar-days" class="w-3.5 h-3.5"></i>${adsStudioFormatDate(campaign.startDate)} → ${adsStudioFormatDate(campaign.endDate)}</span>
            ${adsStudioCanReview() ? `<span class="inline-flex items-center gap-1"><i data-lucide="user" class="w-3.5 h-3.5"></i>${Security.escapeHtml(adsStudioCreatorName(campaign))}</span>` : ''}
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 sm:justify-end">
          ${photoCount ? `<button type="button" onclick="openAdsStudioCreativeViewer('${safeId}', 0, this)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-cyan-50 dark:bg-cyan-900/20 px-3 text-sm font-bold text-cyan-700 dark:text-cyan-300"><i data-lucide="images" class="w-4 h-4"></i><span>${isAr ? 'الصور' : 'Creative'} ${photoCount}</span></button>` : ''}
          ${canEdit ? `<button type="button" onclick="startAdsStudioCampaign('${safeId}')" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-blue-50 dark:bg-blue-900/20 px-3 text-sm font-bold text-blue-700 dark:text-blue-300"><i data-lucide="pencil" class="w-4 h-4"></i>${isAr ? 'تعديل' : 'Edit'}</button>` : ''}
          ${canSubmit ? `<button type="button" onclick="submitAdsStudioCampaign('${safeId}', this)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 px-3 text-sm font-bold text-white disabled:opacity-60"><i data-lucide="send" class="w-4 h-4"></i>${isAr ? 'إرسال' : 'Submit'}</button>` : ''}
          ${canStop ? `<button type="button" onclick="stopAdsStudioCampaign('${safeId}', this)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-rose-100 dark:bg-rose-900/30 px-3 text-sm font-bold text-rose-700 dark:text-rose-200 disabled:opacity-60"><i data-lucide="circle-stop" class="w-4 h-4"></i>${isAr ? 'إيقاف واسترداد' : 'Stop & refund'}</button>` : ''}
          ${showAskStop ? `<button type="button" onclick="showNotification('${isAr ? 'الإعلان بدأ بالفعل' : 'This ad already started'}', '${isAr ? 'راسلنا لنوقفه ونعيد الجزء غير المصروف إلى محفظتك.' : 'Message us — we stop it and refund the unspent part to your wallet.'}', 'info')" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 px-3 text-sm font-bold text-slate-600 dark:text-slate-300"><i data-lucide="circle-help" class="w-4 h-4"></i>${isAr ? 'اطلب الإيقاف' : 'Ask us to stop it'}</button>` : ''}
          ${statusValue === 'Approved' && adsStudioCanReview() && !isLaunched ? `<button type="button" onclick="markAdsStudioCampaignLaunched('${safeId}', this)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 px-3 text-sm font-bold text-emerald-700 dark:text-emerald-300 disabled:opacity-60"><i data-lucide="radio" class="w-4 h-4"></i>${isAr ? 'تم الإطلاق' : 'Mark launched'}</button>` : ''}
          ${canDuplicate && ['Approved', 'Stopped'].includes(statusValue) ? `<button type="button" onclick="duplicateAdsStudioCampaign('${safeId}', this, true)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 px-3 text-sm font-bold text-indigo-700 dark:text-indigo-300 disabled:opacity-60"><i data-lucide="calendar-plus" class="w-4 h-4"></i>${isAr ? 'تمديد' : 'Extend'}</button>` : ''}
          ${canDuplicate ? `<button type="button" onclick="duplicateAdsStudioCampaign('${safeId}', this, false)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 px-3 text-sm font-bold text-slate-700 dark:text-slate-200 disabled:opacity-60"><i data-lucide="copy" class="w-4 h-4"></i>${isAr ? 'نسخ' : 'Duplicate'}</button>` : ''}
          ${canDelete ? `<button type="button" onclick="deleteAdsStudioCampaign('${safeId}', this)" class="touch-target min-h-11 inline-flex items-center gap-1.5 rounded-xl bg-rose-50 dark:bg-rose-900/20 px-3 text-sm font-bold text-rose-700 dark:text-rose-300 disabled:opacity-60"><i data-lucide="${editableStatus ? 'trash-2' : 'archive'}" class="w-4 h-4"></i>${editableStatus ? (isAr ? 'حذف' : 'Delete') : (isAr ? 'أرشفة' : 'Archive')}</button>` : ''}
        </div>
      </div>
      ${statusValue === 'Stopped' ? `<div class="mt-4 rounded-xl bg-rose-50 dark:bg-rose-900/20 p-3 text-sm text-rose-800 dark:text-rose-200"><span class="font-bold">${isAr ? 'الأموال:' : 'Money:'}</span> ${isAr ? 'مدفوع' : 'paid'} ${adsStudioMoney(paidMinor)} · ${isAr ? 'مسترد' : 'refunded'} ${adsStudioMoney(refundMinor)}${spendMinor ? ` · ${isAr ? 'مصروف' : 'spent'} ${adsStudioMoney(spendMinor)}` : ''}${campaign.stopReason ? `<div class="mt-1">${Security.escapeHtml(String(campaign.stopReason))}</div>` : ''}</div>` : ''}
      ${campaign.boostType === 'boost_post' && adsStudioIsValidBoostRef(campaign.sourcePostRef) ? `<div class="mt-3 text-xs"><a href="${Security.escapeHtml(String(campaign.sourcePostRef))}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 font-bold text-blue-600 hover:text-blue-700"><i data-lucide="external-link" class="w-3.5 h-3.5"></i>${isAr ? 'فتح المنشور الأصلي' : 'Open the boosted post'}</a></div>` : ''}
      ${campaign.reviewNote ? `<div class="mt-4 rounded-xl ${campaign.status === 'Rejected' ? 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200' : 'bg-orange-50 dark:bg-orange-900/20 text-orange-800 dark:text-orange-200'} p-3 text-sm"><span class="font-bold">${isAr ? 'ملاحظة المراجع:' : 'Reviewer note:'}</span> ${Security.escapeHtml(campaign.reviewNote)}</div>` : ''}
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

async function stopAdsStudioCampaignOnce(id) {
  const campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign || String(campaign.status || '') !== 'Approved') return false;
  const staff = adsStudioCanReview();
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
    const answer = prompt(
      adsStudioText(
        `Refund amount in USD (0 to ${(remaining / 100).toFixed(2)}):`,
        `مبلغ الاسترداد بالدولار (من 0 إلى ${(remaining / 100).toFixed(2)}):`
      ),
      (remaining / 100).toFixed(2)
    );
    if (answer === null) return false;
    // "1,000" is a thousand, "12,50" is a decimal — never silently under-refund.
    let cleaned = String(answer).replace(/\s+/g, '');
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
    const operationId = Security.generateSecureId('campaign-stop');
    const entity = await apiStopAdCampaignRequest(
      campaign.id, Number(campaign._lastModified), operationId, null, refundMinor
    );
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
    showNotification(adsStudioText('Could not stop the campaign', 'تعذر إيقاف الحملة'), String(detail), 'error');
    return false;
  }
}

async function markAdsStudioCampaignLaunched(id, button = null) {
  const campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign || String(campaign.status || '') !== 'Approved' || !adsStudioCanReview()) return false;
  if (!isServerModeEnabled()) return false;
  const metaId = prompt(adsStudioText('Meta campaign id (optional):', 'معرّف حملة ميتا (اختياري):'), '');
  if (metaId === null) return false;
  setAdsStudioActionButtonBusy(button, true);
  try {
    const operationId = Security.generateSecureId('campaign-publish');
    const entity = await apiSetAdCampaignPublishStatus(
      campaign.id, Number(campaign._lastModified), 'live',
      Security.sanitizeInput(String(metaId || ''), { maxLength: 120 }).trim() || null,
      operationId
    );
    upsertAdsStudioEntity(entity);
    showNotification(
      adsStudioText('Marked as launched', 'تم تسجيل الإطلاق'),
      adsStudioText('The customer’s instant stop now goes through staff.', 'أصبح إيقاف العميل الفوري يمر عبر الفريق الآن.'),
      'success'
    );
    render();
    return true;
  } catch (e) {
    const detail = (e?.payload && e.payload.detail) ? e.payload.detail : (e?.message || '');
    showNotification(adsStudioText('Could not mark launched', 'تعذر تسجيل الإطلاق'), String(detail), 'error');
    return false;
  } finally {
    setAdsStudioActionButtonBusy(button, false);
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
    const startBase = new Date(`${_adsStudioDateOffset(1)}T00:00:00`);
    let durationDays = 7;
    try {
      const s = new Date(`${String(src.startDate || '')}T00:00:00`);
      const e = new Date(`${String(src.endDate || '')}T00:00:00`);
      const diff = Math.round((e.getTime() - s.getTime()) / 86400000);
      if (Number.isFinite(diff) && diff >= 0 && diff <= 366) durationDays = diff;
    } catch (_) {}
    _adsStudioPhotoToken++;
    _adsStudioEditingId = '';
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
      endDate: _adsStudioDateOffset(1 + durationDays),
      budgetMinorUSD: Math.max(0, parseInt(src.budgetMinorUSD, 10) || 0),
      budgetType: src.budgetType === 'daily' ? 'daily' : 'lifetime',
      notes: String(src.notes || ''),
      creativeImages: Array.isArray(src.creativeImages) ? src.creativeImages.slice(0, 3) : [],
      creativeAssetIds: Array.isArray(src.creativeAssetIds) ? src.creativeAssetIds.slice(0, 20) : [],
      specialAdCategories: Array.isArray(src.specialAdCategories) ? src.specialAdCategories.slice(0, 4) : [],
      boostType: ['boost_post', 'boost_page'].includes(String(src.boostType || '')) ? String(src.boostType) : '',
      sourcePostRef: String(src.sourcePostRef || ''),
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
    return `<div class="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-3 text-sm"><div class="flex flex-wrap items-center justify-between gap-2"><span class="font-bold text-slate-800 dark:text-slate-100">${Security.escapeHtml(isAr ? meta.labelAr : meta.label)}</span>${dateText ? `<time class="text-xs text-slate-500">${Security.escapeHtml(dateText)}</time>` : ''}</div>${entry?.note ? `<p class="mt-1 whitespace-pre-wrap text-slate-600 dark:text-slate-300">${Security.escapeHtml(String(entry.note))}</p>` : ''}</div>`;
  }).join('')}</div></details>`;
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
  _adsStudioWizardStep = 1;
  _adsStudioDraft = newAdsStudioDraft();
  _adsStudioConfirmationChecked = false;
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
  _adsStudioActiveTab = 'builder';
  try { updateUrlParams({ tab: 'builder' }, true); } catch (_) {}
  render();
}

function adsStudioSetDraftField(field, value) {
  if (!_adsStudioDraft) _adsStudioDraft = newAdsStudioDraft();
  const allowed = new Set(['name', 'objective', 'pageName', 'primaryText', 'headline', 'description', 'callToAction', 'destination', 'ageMin', 'ageMax', 'startDate', 'endDate', 'budgetType', 'budgetMinorUSD', 'notes', 'boostType', 'sourcePostRef', 'extendsCampaignId']);
  if (!allowed.has(field)) return;
  if (field === 'budgetMinorUSD') _adsStudioDraft[field] = Math.max(0, Math.round((Number(value) || 0) * 100));
  else if (field === 'ageMin' || field === 'ageMax') _adsStudioDraft[field] = Math.max(0, Math.trunc(Number(value) || 0));
  else _adsStudioDraft[field] = String(value ?? '').slice(0, 4000);
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
  _adsStudioDraft[field] = String(raw || '').split(',').map(item => Security.sanitizeInput(item.trim(), { maxLength: 80 })).filter(Boolean).slice(0, 30);
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
  return `<div class="mb-6 overflow-x-auto pb-2"><div class="flex min-w-[620px] items-center">${adsStudioWizardSteps().map(([num, icon, en, ar], index, all) => `<div class="flex flex-1 items-center"><div class="flex items-center gap-2 ${_adsStudioWizardStep >= Number(num) ? 'text-blue-700 dark:text-cyan-300' : 'text-slate-400'}"><span class="w-9 h-9 rounded-full flex items-center justify-center font-black ${_adsStudioWizardStep >= Number(num) ? 'bg-blue-100 dark:bg-blue-900/40' : 'bg-slate-100 dark:bg-slate-800'}">${num}</span><span class="text-xs font-bold whitespace-nowrap">${isAr ? ar : en}</span></div>${index < all.length - 1 ? `<div class="mx-3 h-0.5 flex-1 ${_adsStudioWizardStep > Number(num) ? 'bg-blue-500' : 'bg-slate-200 dark:bg-slate-700'}"></div>` : ''}</div>`).join('')}</div></div>`;
}

function renderAdsStudioBuilder() {
  if (!_adsStudioDraft) beginAdsStudioCampaign();
  const isAr = adsStudioIsAr();
  const isBoost = !!_adsStudioDraft.boostType;
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
          ${_adsStudioWizardStep < adsStudioWizardSteps().length ? `<button type="button" onclick="moveAdsStudioWizard(1)" class="touch-target min-h-12 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 px-6 font-black text-white shadow-lg"><span class="inline-flex items-center gap-2">${isAr ? 'التالي' : 'Continue'}<i data-lucide="${isAr ? 'arrow-left' : 'arrow-right'}" class="w-4 h-4"></i></span></button>` : `<button type="button" onclick="saveAndSubmitAdsStudioDraft(this)" class="touch-target min-h-12 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 px-6 font-black text-white shadow-lg disabled:opacity-60"><span class="inline-flex items-center gap-2"><i data-lucide="send" class="w-4 h-4"></i>${isAr ? 'حفظ وإرسال للمراجعة' : 'Save & submit for review'}</span></button>`}
        </div>
      </div>
    </section>
  `;
}

function renderAdsStudioBasicsStep() {
  const d = _adsStudioDraft;
  const isAr = adsStudioIsAr();
  return `<div class="space-y-6"><div><h3 class="text-lg font-black text-slate-900 dark:text-white">${isAr ? 'ما الذي تريد تحقيقه؟' : 'What do you want to achieve?'}</h3><p class="text-sm text-slate-500">${isAr ? 'اختر هدفاً واحداً واضحاً للحملة.' : 'Choose one clear objective for this campaign.'}</p></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'اسم الحملة *' : 'Campaign name *'}</label><input type="text" maxlength="120" value="${Security.escapeHtml(d.name || '')}" oninput="adsStudioSetDraftField('name', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="${isAr ? 'مثال: عروض الصيف - رسائل واتساب' : 'e.g. Summer offers — WhatsApp messages'}" /></div>
    <div class="grid gap-3 sm:grid-cols-2">${ADS_STUDIO_OBJECTIVES.map(item => `<label class="cursor-pointer rounded-2xl border-2 p-4 transition-colors ${d.objective === item.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700'}"><input type="radio" name="ads-objective" class="sr-only" value="${item.id}" ${d.objective === item.id ? 'checked' : ''} onchange="adsStudioSetDraftField('objective', this.value); render()" /><span class="flex items-start gap-3"><span class="w-10 h-10 rounded-xl bg-white dark:bg-slate-800 flex items-center justify-center text-blue-600"><i data-lucide="${item.icon}" class="w-5 h-5"></i></span><span><span class="block font-black text-slate-900 dark:text-white">${isAr ? item.labelAr : item.label}</span><span class="block text-xs text-slate-500 mt-1">${isAr ? item.descAr : item.desc}</span></span></span></label>`).join('')}</div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'المنصات *' : 'Platforms *'}</label><div class="grid grid-cols-2 gap-3"><label class="touch-target min-h-12 flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-4"><input type="checkbox" ${d.platforms.includes('facebook') ? 'checked' : ''} onchange="adsStudioToggleDraftArray('platforms','facebook',this.checked)" class="w-5 h-5 accent-blue-600" /><i data-lucide="facebook" class="w-5 h-5 text-blue-600"></i><span class="font-bold">Facebook</span></label><label class="touch-target min-h-12 flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-4"><input type="checkbox" ${d.platforms.includes('instagram') ? 'checked' : ''} onchange="adsStudioToggleDraftArray('platforms','instagram',this.checked)" class="w-5 h-5 accent-fuchsia-600" /><i data-lucide="instagram" class="w-5 h-5 text-fuchsia-600"></i><span class="font-bold">Instagram</span></label></div></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'اسم صفحة فيسبوك أو حساب إنستغرام *' : 'Facebook Page or Instagram account name *'}</label><input type="text" maxlength="160" value="${Security.escapeHtml(d.pageName || '')}" oninput="adsStudioSetDraftField('pageName', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="${isAr ? 'اكتب اسم الصفحة التي تريد الإعلان منها' : 'Name of the Page that should run the ad'}" /><p class="mt-2 text-xs text-slate-500">${isAr ? 'سيتم التحقق من ملكية الصفحة عند ربط حساب ميتا.' : 'Ownership will be verified when the Meta account is connected.'}</p></div>
  </div>`;
}

function renderAdsStudioBoostBasicsStep() {
  const d = _adsStudioDraft;
  const isAr = adsStudioIsAr();
  const isPost = d.boostType === 'boost_post';
  return `<div class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div><h3 class="text-lg font-black text-slate-900 dark:text-white">${isPost ? (isAr ? 'أي منشور تريد تعزيزه؟' : 'Which post do you want to boost?') : (isAr ? 'عرّفنا بصفحتك' : 'Tell us about your Page')}</h3><p class="text-sm text-slate-500">${isAr ? 'ثلاث خطوات فقط — نتكفل نحن بالباقي.' : 'Just three steps — we handle the rest.'}</p></div>
      <button type="button" onclick="adsStudioSwitchToFullWizard()" class="touch-target min-h-11 px-3 text-sm font-bold text-blue-600">${isAr ? 'خيارات أكثر' : 'More options'}</button>
    </div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'اسم الحملة *' : 'Campaign name *'}</label><input type="text" maxlength="120" value="${Security.escapeHtml(d.name || '')}" oninput="adsStudioSetDraftField('name', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'اسم صفحتك أو حسابك *' : 'Your Page or account name *'}</label><input type="text" maxlength="160" value="${Security.escapeHtml(d.pageName || '')}" oninput="adsStudioSetDraftField('pageName', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div>
    ${isPost ? `
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'رابط المنشور *' : 'Link to your post *'}</label><input type="url" maxlength="500" value="${Security.escapeHtml(d.sourcePostRef || '')}" oninput="adsStudioSetDraftField('sourcePostRef', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="https://www.facebook.com/..." /><p class="mt-2 text-xs text-slate-500">${isAr ? 'افتح المنشور على فيسبوك أو إنستغرام وانسخ رابطه هنا.' : 'Open the post on Facebook or Instagram and copy its link here.'}</p></div>
    <label class="touch-target flex items-start gap-3 rounded-2xl border border-slate-200 dark:border-slate-700 p-4"><input type="checkbox" ${d.autoReply ? 'checked' : ''} onchange="adsStudioToggleDraftFlag('autoReply', this.checked)" class="mt-0.5 w-5 h-5 accent-blue-600" /><span><span class="block font-bold text-slate-800 dark:text-slate-100">${isAr ? 'الرد التلقائي على الرسائل' : 'Auto-reply to messages'}</span><span class="block text-xs text-slate-500 mt-0.5">${isAr ? 'نرد تلقائياً على من يراسلك من الإعلان — اكتب نص الرد في الملاحظات.' : 'We reply automatically to people who message from this ad — put the reply text in the notes.'}</span></span></label>` : `
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'رابط صفحتك *' : 'Your Page link *'}</label><input type="url" maxlength="500" value="${Security.escapeHtml(d.destination || '')}" oninput="adsStudioSetDraftField('destination', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="https://www.facebook.com/yourpage" /></div>`}
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'نص قصير للإعلان *' : 'Short ad text *'}</label><textarea rows="3" maxlength="2200" oninput="adsStudioSetDraftField('primaryText', this.value)" class="glass-input w-full rounded-xl px-4 py-3" placeholder="${isAr ? 'اكتب الرسالة التي سيقرأها العميل...' : 'Write the message customers will see...'}">${Security.escapeHtml(d.primaryText || '')}</textarea></div>
    <div data-photo-paste-target="ads-studio" tabindex="0" class="rounded-2xl border border-slate-200 dark:border-slate-700 p-3 focus:outline-none focus:ring-2 focus:ring-blue-500">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-2"><label class="block text-sm font-bold">${isPost ? (isAr ? 'صورة من المنشور (حتى 3) *' : 'A picture of the post (up to 3) *') : (isAr ? 'الصور (حتى 3) *' : 'Images (up to 3) *')}</label><span class="text-xs text-slate-500">${(d.creativeImages || []).length}/3</span></div>
      <div id="ads-studio-creative-preview">${renderAdsStudioCreativePreview()}</div>
      <input id="ads-studio-image-input" type="file" accept="image/png,image/jpeg,image/webp" multiple class="hidden" onchange="onAdsStudioCreativeSelected(this)" />
    </div>
  </div>`;
}

function renderAdsStudioCreativeStep() {
  const d = _adsStudioDraft;
  const isAr = adsStudioIsAr();
  return `<div class="space-y-5"><div><h3 class="text-lg font-black text-slate-900 dark:text-white">${isAr ? 'محتوى الإعلان' : 'Ad creative'}</h3><p class="text-sm text-slate-500">${isAr ? 'أضف النص والصور والرابط الذي سيفتحه العميل.' : 'Add the copy, images and destination customers will open.'}</p></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'النص الأساسي *' : 'Primary text *'}</label><textarea rows="5" maxlength="2200" oninput="adsStudioSetDraftField('primaryText', this.value); updateAdsStudioCreativeCount(this)" class="glass-input w-full rounded-xl px-4 py-3" placeholder="${isAr ? 'اكتب الرسالة التي سيقرأها العميل...' : 'Write the message customers will see...'}">${Security.escapeHtml(d.primaryText || '')}</textarea><div id="ads-studio-copy-count" class="text-end text-xs text-slate-400">${String(d.primaryText || '').length}/2200</div></div>
    <div class="grid gap-4 sm:grid-cols-2"><div><label class="block text-sm font-bold mb-2">${isAr ? 'العنوان' : 'Headline'}</label><input type="text" maxlength="255" value="${Security.escapeHtml(d.headline || '')}" oninput="adsStudioSetDraftField('headline', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div><div><label class="block text-sm font-bold mb-2">${isAr ? 'زر الدعوة' : 'Call-to-action'}</label><select onchange="adsStudioSetDraftField('callToAction', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4">${ADS_STUDIO_CTA.map(([en, ar]) => `<option value="${en}" ${d.callToAction === en ? 'selected' : ''}>${isAr ? ar : en}</option>`).join('')}</select></div></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'الوصف القصير' : 'Short description'}</label><input type="text" maxlength="500" value="${Security.escapeHtml(d.description || '')}" oninput="adsStudioSetDraftField('description', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'الرابط أو رقم واتساب *' : 'Website, WhatsApp or Messenger destination *'}</label><input type="text" maxlength="500" value="${Security.escapeHtml(d.destination || '')}" oninput="adsStudioSetDraftField('destination', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="https://... or +218..." /><p class="mt-2 text-xs text-slate-500">${isAr ? 'سنراجع الرابط قبل إطلاق الإعلان.' : 'The destination is checked during review.'}</p></div>
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
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'المدن أو الدول *' : 'Cities or countries *'}</label><input type="text" value="${Security.escapeHtml(locationText)}" oninput="adsStudioSetListField('locations', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="Libya, Tripoli, Benghazi" /><p class="mt-1 text-xs text-slate-500">${isAr ? 'افصل بين المواقع بفاصلة.' : 'Separate locations with commas.'}</p></div>
    <div class="grid grid-cols-2 gap-4"><div><label class="block text-sm font-bold mb-2">${isAr ? 'أقل عمر' : 'Minimum age'}</label><input type="number" min="18" max="65" value="${Number(d.ageMin) || 18}" oninput="adsStudioSetDraftField('ageMin', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div><div><label class="block text-sm font-bold mb-2">${isAr ? 'أعلى عمر' : 'Maximum age'}</label><input type="number" min="18" max="65" value="${Number(d.ageMax) || 65}" oninput="adsStudioSetDraftField('ageMax', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'الجنس' : 'Gender'}</label><div class="grid grid-cols-3 gap-2">${[['all','All','الكل'],['female','Women','نساء'],['male','Men','رجال']].map(([value,en,ar]) => `<label class="touch-target min-h-12 rounded-xl border ${d.genders.includes(value) ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700'} flex items-center justify-center gap-2 font-bold"><input type="radio" name="ads-gender" value="${value}" ${d.genders.includes(value) ? 'checked' : ''} onchange="adsStudioToggleDraftArray('genders','${value}',this.checked,true); render()" class="sr-only" />${isAr ? ar : en}</label>`).join('')}</div></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'اللغات' : 'Languages'}</label><input type="text" value="${Security.escapeHtml(languageText)}" oninput="adsStudioSetListField('languages', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="Arabic, English" /></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'الاهتمامات المقترحة' : 'Suggested interests'}</label><input type="text" value="${Security.escapeHtml(interestText)}" oninput="adsStudioSetListField('interests', this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" placeholder="Online shopping, Fashion, Technology" /><p class="mt-1 text-xs text-slate-500">${isAr ? 'اقتراحات فقط؛ ميتا تحدد الخيارات المتاحة للحساب.' : 'Suggestions only; Meta determines what is available to the account.'}</p></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'فئة إعلانية خاصة' : 'Special Ad Category'}</label><select onchange="_adsStudioDraft.specialAdCategories = this.value ? [this.value] : []" class="glass-input min-h-12 w-full rounded-xl px-4"><option value="" ${!d.specialAdCategories.length ? 'selected' : ''}>${isAr ? 'لا توجد' : 'None'}</option><option value="credit" ${d.specialAdCategories.includes('credit') ? 'selected' : ''}>${isAr ? 'الائتمان والخدمات المالية' : 'Credit / financial products'}</option><option value="employment" ${d.specialAdCategories.includes('employment') ? 'selected' : ''}>${isAr ? 'التوظيف' : 'Employment'}</option><option value="housing" ${d.specialAdCategories.includes('housing') ? 'selected' : ''}>${isAr ? 'السكن' : 'Housing'}</option><option value="social_issues_elections_politics" ${d.specialAdCategories.includes('social_issues_elections_politics') ? 'selected' : ''}>${isAr ? 'القضايا الاجتماعية أو الانتخابات أو السياسة' : 'Social issues, elections or politics'}</option></select><div class="mt-2 flex items-start gap-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-800 dark:text-amber-200"><i data-lucide="triangle-alert" class="w-4 h-4 flex-shrink-0"></i><span>${isAr ? 'اختيار الفئة الصحيحة إلزامي وقد يحد من العمر والجنس والاهتمامات.' : 'The correct category is mandatory and may restrict age, gender and interest targeting.'}</span></div></div>
  </div>`;
}

function renderAdsStudioBudgetStep() {
  const d = _adsStudioDraft;
  const isAr = adsStudioIsAr();
  return `<div class="space-y-5"><div><h3 class="text-lg font-black text-slate-900 dark:text-white">${isAr ? 'الميزانية والمدة' : 'Budget and schedule'}</h3><p class="text-sm text-slate-500">${isAr ? 'هذه ميزانية مقترحة للمراجعة وليست عملية دفع.' : 'This is a requested planning budget, not a payment.'}</p></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'نوع الميزانية' : 'Budget type'}</label><div class="grid grid-cols-2 gap-3"><label class="touch-target min-h-14 rounded-xl border-2 px-4 flex items-center gap-3 ${d.budgetType === 'lifetime' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700'}"><input type="radio" name="budget-type" value="lifetime" ${d.budgetType === 'lifetime' ? 'checked' : ''} onchange="adsStudioSetDraftField('budgetType',this.value);render()" class="sr-only" /><i data-lucide="calendar-range" class="w-5 h-5 text-blue-600"></i><span class="font-bold">${isAr ? 'إجمالي الحملة' : 'Lifetime'}</span></label><label class="touch-target min-h-14 rounded-xl border-2 px-4 flex items-center gap-3 ${d.budgetType === 'daily' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700'}"><input type="radio" name="budget-type" value="daily" ${d.budgetType === 'daily' ? 'checked' : ''} onchange="adsStudioSetDraftField('budgetType',this.value);render()" class="sr-only" /><i data-lucide="sun" class="w-5 h-5 text-blue-600"></i><span class="font-bold">${isAr ? 'يومي' : 'Daily'}</span></label></div></div>
    <div><label class="block text-sm font-bold mb-2">${d.budgetType === 'daily' ? (isAr ? 'الميزانية اليومية بالدولار *' : 'Daily budget in USD *') : (isAr ? 'إجمالي الميزانية بالدولار *' : 'Total budget in USD *')}</label><div class="relative"><span class="absolute ${isAr ? 'right-4' : 'left-4'} top-1/2 -translate-y-1/2 font-black text-blue-600">$</span><input type="number" min="1" max="1000000" step="0.01" value="${(Math.max(0, Number(d.budgetMinorUSD) || 0) / 100).toFixed(2)}" oninput="adsStudioSetDraftField('budgetMinorUSD', this.value)" class="glass-input min-h-14 w-full rounded-xl ${isAr ? 'pr-9 pl-4' : 'pl-9 pr-4'} text-xl font-black" /></div>${(typeof _adsStudioUsdToLydRate === 'function' && _adsStudioUsdToLydRate() > 1) ? `<p class="mt-2 text-xs font-bold text-blue-700 dark:text-blue-300">${Security.escapeHtml(adsStudioMoneyWithLyd(d.budgetMinorUSD))} — ${isAr ? 'تقديري' : 'estimate'}</p>` : ''}</div>
    <div class="grid gap-4 sm:grid-cols-2"><div><label class="block text-sm font-bold mb-2">${isAr ? 'تاريخ البدء *' : 'Start date *'}</label><input type="date" value="${Security.escapeHtml(d.startDate || '')}" onchange="adsStudioSetDraftField('startDate',this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div><div><label class="block text-sm font-bold mb-2">${isAr ? 'تاريخ الانتهاء *' : 'End date *'}</label><input type="date" value="${Security.escapeHtml(d.endDate || '')}" onchange="adsStudioSetDraftField('endDate',this.value)" class="glass-input min-h-12 w-full rounded-xl px-4" /></div></div>
    <div><label class="block text-sm font-bold mb-2">${isAr ? 'ملاحظات لفريق المراجعة' : 'Notes for the review team'}</label><textarea rows="3" maxlength="1000" oninput="adsStudioSetDraftField('notes', this.value)" class="glass-input w-full rounded-xl px-4 py-3" placeholder="${isAr ? 'وقت مفضل، عرض خاص، تفاصيل إضافية...' : 'Preferred time, special offer, extra context...'}">${Security.escapeHtml(d.notes || '')}</textarea></div>
    <div class="rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 p-4 text-sm text-emerald-800 dark:text-emerald-200 flex items-start gap-3"><i data-lucide="shield-check" class="w-5 h-5 flex-shrink-0"></i><span>${isAr ? 'لن نرفع الميزانية أو نطلق الإعلان دون تأكيد وموافقة. عند إضافة الربط المباشر، سيتم إنشاء إعلانات ميتا في وضع الإيقاف المؤقت أولاً.' : 'We will not increase the budget or launch without confirmation. Future Meta publishing will create campaigns paused first.'}</span></div>
  </div>`;
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
    [isAr ? 'الوجهة' : 'Destination', d.destination || '—'],
    [isAr ? 'الجمهور' : 'Audience', `${(d.locations || []).join(', ') || '—'} · ${d.ageMin || 18}–${d.ageMax || 65}`],
    [isAr ? 'الميزانية' : 'Budget', `${adsStudioMoney(d.budgetMinorUSD)} ${d.budgetType === 'daily' ? (isAr ? 'يومياً' : 'daily') : (isAr ? 'إجمالي' : 'lifetime')}`],
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
    if (!String(d.primaryText || '').trim()) errors.push(adsStudioText('Primary ad text is required.', 'النص الأساسي للإعلان مطلوب.'));
    if (!String(d.destination || '').trim()) {
      // A boosted post's destination is derived from the post link at save
      // time — the boost-ref check below covers it; no invisible field error.
      if (String(d.boostType || '') !== 'boost_post') errors.push(adsStudioText('A website, WhatsApp or Messenger destination is required.', 'رابط الموقع أو واتساب أو ماسنجر مطلوب.'));
    } else if (!adsStudioIsValidDestination(d.destination)) errors.push(adsStudioText('Use an HTTPS website/link or an international phone number.', 'استخدم رابط HTTPS أو رقم هاتف دولي صحيح.'));
    const hasSafeCreative = (Array.isArray(d.creativeImages) && d.creativeImages.some(isSafeAdsStudioCreativeSource)) ||
      (d._mediaOmitted === true && getEntityPhotoCountHint('adCampaignRequests', d) > 0);
    if (!hasSafeCreative) errors.push(adsStudioText('Add at least one PNG, JPEG or WebP creative image.', 'أضف صورة إعلانية واحدة على الأقل بصيغة PNG أو JPEG أو WebP.'));
  }
  if (step >= 3) {
    if (!Array.isArray(d.locations) || !d.locations.length) errors.push(adsStudioText('Add at least one location.', 'أضف موقعاً واحداً على الأقل.'));
    const min = Number(d.ageMin), max = Number(d.ageMax);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 18 || max > 65 || min > max) errors.push(adsStudioText('Age range must be between 18 and 65.', 'يجب أن يكون العمر بين 18 و65.'));
  }
  if (step >= 4) {
    if (!(Number(d.budgetMinorUSD) > 0)) errors.push(adsStudioText('Budget must be greater than zero.', 'يجب أن تكون الميزانية أكبر من صفر.'));
    if (!String(d.startDate || '') || !String(d.endDate || '') || String(d.startDate) < _adsStudioDateOffset(0) || String(d.endDate) < String(d.startDate)) errors.push(adsStudioText('Choose a start date from today onward and a valid end date.', 'اختر تاريخ بداية من اليوم فصاعداً وتاريخ نهاية صحيحاً.'));
  }
  if (String(d.boostType || '') === 'boost_post' && !adsStudioIsValidBoostRef(d.sourcePostRef)) {
    errors.unshift(adsStudioText('Paste the Facebook or Instagram link of the post you want to boost.', 'الصق رابط المنشور من فيسبوك أو إنستغرام.'));
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
  return {
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
    saved = await updateRecord(state.adCampaignRequests, id, payload, current._lastModified);
  } else {
    id = Security.generateSecureId('campaign');
    saved = await addRecord(state.adCampaignRequests, { id, ...payload, status: 'Draft', createdAt: new Date().toISOString() });
  }
  if (!saved) return null;
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
  // Client mirror of the server money gate.
  const _budgetMinor = Math.max(parseInt(campaign.budgetMinorUSD, 10) || 0, 0);
  if (String(campaign.createdBy || '') === String(state.currentUser?.id || '')
      && adsStudioWalletAvailableMinor() < _budgetMinor) {
    showNotification(
      adsStudioText('Not enough wallet balance', 'رصيد المحفظة غير كافٍ'),
      adsStudioText('Charge your wallet first — the budget is held from it when you submit.', 'اشحن محفظتك أولاً — الميزانية تُحجز منها عند الإرسال.'),
      'error'
    );
    _adsStudioActiveTab = 'dashboard';
    try { updateUrlParams({ tab: 'dashboard' }, true); } catch (_) {}
    render();
    return false;
  }
  try {
    if (isServerModeEnabled()) {
      const operationId = Security.generateSecureId('campaign-submit');
      const entity = await apiSubmitAdCampaignRequest(campaign.id, Number(campaign._lastModified), operationId);
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
    _adsStudioConfirmationChecked = false;
    _adsStudioActiveTab = 'campaigns';
    try { updateUrlParams({ tab: 'campaigns' }, true); } catch (_) {}
    render();
    return true;
  } catch (error) {
    showNotification(adsStudioText('Could not submit', 'تعذر الإرسال'), error?.message || adsStudioText('Refresh and try again.', 'حدّث الصفحة وحاول مرة أخرى.'), 'error');
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

function renderAdsStudioReviewQueue() {
  const isAr = adsStudioIsAr();
  if (!adsStudioCanReview()) return renderAdsStudioEmptyState();
  const queue = getVisibleAdsStudioCampaigns().filter(item => item.status === 'Submitted');
  return `<section><div class="mb-5"><h2 class="text-2xl font-black text-slate-900 dark:text-white">${isAr ? 'طلبات تحتاج المراجعة' : 'Campaign review queue'}</h2><p class="text-sm text-slate-500">${isAr ? 'الموافقة هنا لا تنشر إعلاناً ولا تخصم أي مبلغ.' : 'Approval here does not publish an ad or charge money.'}</p></div><div class="space-y-5">${queue.length ? queue.map(campaign => {
    const safeId = Security.escapeHtml(String(campaign.id || ''));
    const note = Security.escapeHtml(String(_adsStudioReviewNotes[String(campaign.id || '')] || ''));
    return `${renderAdsStudioCampaignCard(campaign)}<div class="-mt-3 rounded-b-2xl border border-t-0 border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-900/10 p-4"><label class="block text-sm font-bold mb-2">${isAr ? 'ملاحظة القرار' : 'Decision note'}</label><textarea id="ads-review-note-${safeId}" rows="2" maxlength="1000" oninput="setAdsStudioReviewNote('${safeId}', this.value)" class="glass-input w-full rounded-xl px-4 py-3" placeholder="${isAr ? 'اشرح أي تعديل مطلوب...' : 'Explain any requested change...'}">${note}</textarea><div class="mt-3 grid gap-2 sm:grid-cols-3"><button type="button" onclick="reviewAdsStudioCampaign('${safeId}','Changes Requested', this)" class="touch-target min-h-12 rounded-xl bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-200 font-bold disabled:opacity-60">${isAr ? 'طلب تعديلات' : 'Request changes'}</button><button type="button" onclick="reviewAdsStudioCampaign('${safeId}','Rejected', this)" class="touch-target min-h-12 rounded-xl bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200 font-bold disabled:opacity-60">${isAr ? 'رفض' : 'Reject'}</button><button type="button" onclick="reviewAdsStudioCampaign('${safeId}','Approved', this)" class="touch-target min-h-12 rounded-xl bg-emerald-600 text-white font-black disabled:opacity-60">${isAr ? 'موافقة' : 'Approve'}</button></div></div>`;
  }).join('') : `<div class="glass-panel rounded-2xl p-10 text-center"><i data-lucide="badge-check" class="w-12 h-12 mx-auto text-emerald-400 mb-3"></i><h3 class="font-black text-lg text-slate-900 dark:text-white">${isAr ? 'تمت مراجعة كل الطلبات' : 'Review queue is clear'}</h3><p class="text-sm text-slate-500 mt-1">${isAr ? 'ستظهر الحملات الجديدة هنا بعد الإرسال.' : 'New submitted campaigns will appear here.'}</p></div>`}</div></section>`;
}

function setAdsStudioReviewNote(id, value) {
  const campaignId = String(id || '');
  if (!campaignId) return;
  _adsStudioReviewNotes[campaignId] = String(value || '').slice(0, 1000);
}

function reviewAdsStudioCampaign(id, decision, button = null) {
  const campaignId = String(id || '');
  if (_adsStudioReviewPromises.has(campaignId)) return _adsStudioReviewPromises.get(campaignId);
  setAdsStudioActionButtonBusy(button, true);
  const operation = reviewAdsStudioCampaignOnce(campaignId, decision);
  _adsStudioReviewPromises.set(campaignId, operation);
  const cleanup = () => {
    if (_adsStudioReviewPromises.get(campaignId) === operation) _adsStudioReviewPromises.delete(campaignId);
    setAdsStudioActionButtonBusy(button, false);
  };
  operation.then(cleanup, cleanup);
  return operation;
}

async function reviewAdsStudioCampaignOnce(id, decision) {
  if (!adsStudioCanReview() || !['Approved', 'Changes Requested', 'Rejected'].includes(decision)) return;
  const campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign || campaign.status !== 'Submitted') return;
  const inputValue = document.getElementById(`ads-review-note-${id}`)?.value;
  if (inputValue !== undefined) setAdsStudioReviewNote(id, inputValue);
  const note = Security.sanitizeInput(String(_adsStudioReviewNotes[id] || ''), { maxLength: 1000 }).trim();
  if (decision !== 'Approved' && !note) {
    showNotification(adsStudioText('Add a note', 'أضف ملاحظة'), adsStudioText('Explain what the customer should change.', 'اشرح للعميل ما الذي يجب تعديله.'), 'warning');
    return;
  }
  if (decision === 'Approved' && !confirm(adsStudioText('Approve this request? This records approval but does not publish or spend money.', 'الموافقة على هذا الطلب؟ سيتم تسجيل الموافقة فقط ولن يتم النشر أو صرف المال.'))) return;
  try {
    if (isServerModeEnabled()) {
      const operationId = Security.generateSecureId('campaign-review');
      const entity = await apiReviewAdCampaignRequest(campaign.id, Number(campaign._lastModified), decision, note, operationId);
      upsertAdsStudioEntity(entity);
    } else {
      const saved = await updateRecord(state.adCampaignRequests, campaign.id, { status: decision, reviewNote: note, reviewedAt: new Date().toISOString(), reviewedBy: state.currentUser?.id }, campaign._lastModified);
      if (!saved) return;
    }
    delete _adsStudioReviewNotes[id];
    showNotification(adsStudioText('Decision saved', 'تم حفظ القرار'), adsStudioText(`Campaign marked ${decision}.`, `تم تحديث حالة الحملة: ${decision}.`), 'success');
    render();
  } catch (error) {
    showNotification(adsStudioText('Review failed', 'تعذر حفظ المراجعة'), error?.message || adsStudioText('Refresh and try again.', 'حدّث الصفحة وحاول مرة أخرى.'), 'error');
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

function adsStudioUpdateLydPreview() {
  const el = document.getElementById('ads-studio-lyd-preview');
  if (!el) return;
  const usd = parseFloat(document.getElementById('ads-studio-charge-amount')?.value || '0');
  const rate = _adsStudioUsdToLydRate();
  el.textContent = (Number.isFinite(usd) && usd > 0 && rate > 0)
    ? `≈ ${(Math.ceil(usd * rate * 100) / 100).toFixed(2)} LYD @ ${rate}`
    : '';
}

function adsStudioWalletHeldMinor() {
  const uid = String(state.currentUser?.id || '');
  return (Array.isArray(state.adCampaignRequests) ? state.adCampaignRequests : [])
    .filter(c => c && !c._deleted && String(c.createdBy || '') === uid && String(c.status || '') === 'Submitted')
    .reduce((sum, c) => sum + Math.max(parseInt(c.budgetMinorUSD, 10) || 0, 0), 0);
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
  const amountUSD = parseFloat(input?.value || '0');
  const amountMinor = Math.round((Number.isFinite(amountUSD) ? amountUSD : 0) * 100);
  if (amountMinor < 100) {
    showNotification(adsStudioText('Invalid amount', 'مبلغ غير صالح'), adsStudioText('Minimum charge is $1.00', 'أقل مبلغ للشحن هو 1 دولار'), 'error');
    return;
  }
  if (!method || !_adsStudioPayMethod(method)) {
    showNotification(adsStudioText('Pick a payment method', 'اختر طريقة الدفع'), adsStudioText('Choose how you will pay, then create the request.', 'اختر كيف ستدفع ثم أنشئ الطلب.'), 'warning');
    return;
  }
  _adsStudioChargeBusy = true;
  try {
    const created = await apiWalletPaymentRequestCreate(amountMinor, method, `paycreate-${state.currentUser?.id || 'me'}-${Date.now()}`);
    const d = created?.data || {};
    const entry = _adsStudioPayMethod(d.method);
    const template = entry && entry.instructions ? String(adsStudioIsAr() ? entry.instructions.ar : entry.instructions.en) : '';
    let message;
    if (template) {
      message = template
        .split('{reference}').join(String(d.reference || ''))
        .split('{amountLYD}').join(d.amountMinorLYD ? (d.amountMinorLYD / 100).toFixed(2) : '—')
        .split('{amountUSD}').join((Number(d.amountMinor || 0) / 100).toFixed(2))
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
  const lyd = d.amountMinorLYD ? ` • ≈ ${(d.amountMinorLYD / 100).toFixed(2)} LYD` : '';
  return `
    <div class="flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40">
      <div class="min-w-0">
        <div class="font-mono font-bold text-slate-800 dark:text-white">${Security.escapeHtml(String(d.reference || ''))} ${hasPhoto ? '<i data-lucide="paperclip" class="inline w-3.5 h-3.5 text-emerald-600"></i>' : ''}</div>
        <div class="text-xs text-slate-500">${adsStudioMoney(parseInt(d.amountMinor, 10) || 0)}${lyd} • ${Security.escapeHtml(_adsStudioWalletMethodLabel(String(d.method || '')))}</div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
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
    .slice(-8).reverse();
  return `
    <div class="space-y-6">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="glass-panel rounded-2xl p-5"><div class="text-xs text-slate-500 mb-1">${adsStudioText('Wallet balance', 'رصيد المحفظة')}</div><div class="text-2xl font-bold text-slate-800 dark:text-white">${adsStudioMoney(balance)}</div></div>
        <div class="glass-panel rounded-2xl p-5"><div class="text-xs text-slate-500 mb-1">${adsStudioText('Held for submitted campaigns', 'محجوز للحملات المُرسلة')}</div><div class="text-2xl font-bold text-amber-600">${adsStudioMoney(held)}</div></div>
        <div class="glass-panel rounded-2xl p-5"><div class="text-xs text-slate-500 mb-1">${adsStudioText('Available to spend', 'متاح للصرف')}</div><div class="text-2xl font-bold text-emerald-600">${adsStudioMoney(available)}</div></div>
      </div>

      <div class="glass-panel rounded-2xl p-6">
        <h3 class="font-bold text-slate-800 dark:text-white mb-1">${adsStudioText('Add money', 'إضافة رصيد')}</h3>
        <p class="text-xs text-slate-500 mb-4">${adsStudioText('Choose how you pay. You get a reference code; the wallet fills up the moment the payment is confirmed — automatically once the payment company is connected.', 'اختر طريقة الدفع. ستحصل على رمز مرجعي، وتتعبأ المحفظة فور تأكيد الدفع — تلقائياً بعد ربط شركة الدفع.')}</p>
        <div class="mb-4">
          <label class="text-xs text-slate-500 block mb-1">${adsStudioText('Amount (USD)', 'المبلغ (دولار)')}</label>
          <div class="flex items-center gap-3">
            <input id="ads-studio-charge-amount" type="number" min="1" step="0.01" placeholder="50.00" oninput="adsStudioUpdateLydPreview()"
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
          return `<div class="flex justify-between text-sm py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
            <span class="text-slate-600 dark:text-slate-300">${Security.escapeHtml(String(tx.memo || tx.type || ''))}</span>
            <span class="font-mono font-bold ${incoming ? 'text-emerald-600' : 'text-rose-600'}">${incoming ? '+' : '−'}${adsStudioMoney(Math.abs(parseInt(tx.amountMinor, 10) || 0))}</span>
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
  return `<section class="grid gap-6 lg:grid-cols-[1.1fr_1fr]"><div class="glass-panel rounded-3xl p-5 sm:p-7"><div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-600 to-cyan-500 flex items-center justify-center text-white mb-5"><i data-lucide="facebook" class="w-7 h-7"></i></div><span class="inline-flex rounded-full bg-emerald-100 dark:bg-emerald-900/30 px-3 py-1 text-xs font-bold text-emerald-800 dark:text-emerald-200">${isAr ? 'تتبع Meta للقراءة فقط متاح' : 'Read-only Meta tracking available'}</span><h2 class="mt-4 text-2xl font-black text-slate-900 dark:text-white">${isAr ? 'اربط الإعلان الحقيقي وتابع تغيّراته' : 'Link the real ad and track its changes'}</h2><p class="mt-3 text-slate-500 dark:text-slate-400">${isAr ? 'من صفحة الإعلانات يمكنك ربط إعلان Albayan بإعلان Meta ومزامنة الحالة والميزانية والمصروف والنتائج. تبقى الوصل والأموال والصور داخل Albayan دون تغيير. النشر المباشر سيبقى مغلقاً حتى اكتمال موافقات ميتا.' : 'From the Ads page you can link an Albayan ad to a real Meta ad and sync status, budget, spend and results. Albayan receipts, money and photos stay unchanged. Direct publishing remains locked until Meta approvals are complete.'}</p><button type="button" onclick="navigateTo('ads')" class="mt-5 inline-flex min-h-12 items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 font-black text-white hover:bg-blue-700"><i data-lucide="link" class="h-5 w-5"></i>${isAr ? 'فتح الإعلانات والربط' : 'Open Ads and link'}</button><div class="mt-5 rounded-2xl bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-800 dark:text-red-200 flex items-start gap-3"><i data-lucide="shield-alert" class="w-5 h-5 flex-shrink-0"></i><span>${isAr ? 'لن نطلب كلمة مرور فيسبوك ولن نخزن رمز ميتا داخل تطبيق الهاتف أو بيانات الحملة.' : 'We will never ask for a Facebook password or store a Meta token in the mobile app or campaign records.'}</span></div></div><div class="glass-panel rounded-3xl p-5 sm:p-7"><h3 class="text-lg font-black text-slate-900 dark:text-white">${isAr ? 'خطة النشر المباشر لاحقاً' : 'Future direct-publishing checklist'}</h3><div class="mt-5 space-y-3">${checklist.map(([icon,label], index) => `<div class="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3"><span class="w-9 h-9 rounded-xl ${index < 2 ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-200' : 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'} flex items-center justify-center"><i data-lucide="${icon}" class="w-4 h-4"></i></span><span class="flex-1 text-sm font-bold text-slate-700 dark:text-slate-200">${label}</span><i data-lucide="${index < 2 ? 'clock-3' : 'circle-dashed'}" class="w-4 h-4 text-slate-400"></i></div>`).join('')}</div></div></section>`;
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

function socialApi(path, options = {}, extra = {}) {
  return apiJson('/api/social-studio' + path, options, extra);
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
  _social.loading = true;
  try {
    const [settings, rules, pages, posts, stats] = await Promise.allSettled([
      socialApi('/settings'), socialApi('/rules'), socialApi('/pages'), socialApi('/posts'), socialApi('/stats')
    ]);
    if (uid !== String(state.currentUser?.id || '')) return;
    if (settings.status === 'fulfilled') _social.settings = socialUnwrap(settings.value, 'settings') || settings.value;
    if (rules.status === 'fulfilled') _social.rules = Array.isArray(rules.value?.rules) ? rules.value.rules : (Array.isArray(rules.value) ? rules.value : []);
    if (pages.status === 'fulfilled') _social.pages = Array.isArray(pages.value?.pages) ? pages.value.pages : (Array.isArray(pages.value) ? pages.value : []);
    if (posts.status === 'fulfilled') _social.posts = Array.isArray(posts.value?.posts) ? posts.value.posts : (Array.isArray(posts.value) ? posts.value : []);
    if (stats.status === 'fulfilled') _social.stats = stats.value || null;
    const failed = [settings, rules, pages, posts, stats].find(r => r.status === 'rejected');
    _social.error = failed ? socialErrorDetail(failed.reason, 'Some studio data did not load.', 'لم يتم تحميل بعض بيانات الاستوديو.') : '';
    _social.loadedAt = Date.now();
  } finally {
    _social.loading = false;
    if (state.currentView === 'ads-studio') { try { render(); } catch (_) {} }
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
  _social.linkSheetOpen = true;
  _social.linkOwnerId = _social.linkOwnerId || String(state.currentUser?.id || '');
  if (_social.availablePages === null && !_social.availableBusy) {
    _social.availableBusy = true;
    socialApi('/pages/available').then(res => {
      _social.availablePages = Array.isArray(res?.pages) ? res.pages : [];
    }).catch(e => {
      _social.availablePages = [];
      showNotification(socialText('Meta pages unavailable', 'صفحات ميتا غير متاحة'), socialErrorDetail(e, 'Connect Meta on the server first.', 'اربط ميتا على الخادم أولاً.'), 'warning');
    }).finally(() => { _social.availableBusy = false; render(); });
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
              <button type="button" onclick="socialLinkPage('${socialEsc(pg.metaPageId)}', '${socialEsc(pg.platform)}', '${socialEsc(pg.igUserId || '')}')" ${_social.busy ? 'disabled' : ''} class="touch-target min-h-10 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50">${socialText('Link', 'ربط')}</button>
            </div>`).join('')}</div>`
          : `<div class="py-6 text-center text-sm text-slate-500">${socialText('All available pages are linked, or Meta is not connected on the server yet.', 'كل الصفحات المتاحة مرتبطة، أو أن ميتا غير متصلة على الخادم بعد.')}</div>`}
        <p class="mt-4 text-[11px] text-slate-500">${socialText('Albayan only reads comments and publishes what you approve. Unlink any time.', 'يقرأ البيان التعليقات وينشر ما توافق عليه فقط. يمكنك إلغاء الربط في أي وقت.')}</p>
      </div>
    </div>`;
}

async function socialLinkPage(metaPageId, platform, igUserId) {
  if (_social.busy) return;
  const entry = (Array.isArray(_social.availablePages) ? _social.availablePages : []).find(p => String(p.metaPageId) === String(metaPageId) && String(p.platform) === String(platform));
  _social.busy = true;
  render();
  try {
    await socialApi('/pages/link', { method: 'POST', body: { ownerId: _social.linkOwnerId || String(state.currentUser?.id || ''), metaPageId: String(metaPageId), platform: String(platform), name: entry?.name || '', igUserId: String(igUserId || '') } });
    showNotification(socialText('Page linked', 'تم ربط الصفحة'), entry?.name || '', 'success');
    _social.availablePages = null;
    _social.linkSheetOpen = false;
    socialRefreshNow();
  } catch (e) {
    showNotification(socialText('Could not link the page', 'تعذر ربط الصفحة'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    _social.busy = false;
    render();
  }
}

async function socialUnlinkPage(pageId) {
  const page = socialPageById(pageId);
  if (!page) return;
  const ok = confirm(socialText(`Unlink "${page.name}"? Scheduled posts for this page will stop and its reply rules will no longer run.`, `إلغاء ربط "${page.name}"؟ ستتوقف المنشورات المجدولة لهذه الصفحة ولن تعمل قواعد الرد الخاصة بها.`));
  if (!ok) return;
  try {
    await socialApi(`/pages/${encodeURIComponent(pageId)}/unlink`, { method: 'POST', body: {} });
    showNotification(socialText('Page unlinked', 'تم إلغاء ربط الصفحة'), '', 'success');
    socialRefreshNow();
  } catch (e) {
    showNotification(socialText('Could not unlink', 'تعذر إلغاء الربط'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  }
}

// ---------- posts tab ----------

function socialOpenPostsTab(filter) {
  if (filter) _social.postsFilter = filter;
  _social.screen = '';
  setAdsStudioTab('posts');
}

function socialOpenRepliesTab() {
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
  _social.composer = socialNewComposer();
  _social.screen = 'compose';
  if (_adsStudioActiveTab !== 'posts') setAdsStudioTab('posts'); else render();
}

async function socialEditPost(postId) {
  const summary = _social.posts.find(p => String(p.id) === String(postId));
  if (!summary) return;
  let full = summary;
  try {
    const res = await socialApi(`/posts/${encodeURIComponent(postId)}`);
    full = socialUnwrap(res, 'post') || summary;
  } catch (_) { /* fall back to the summary; media may be empty */ }
  const scheduled = String(full.status) === 'scheduled' && full.scheduledAt;
  _social.composer = {
    id: String(full.id),
    pageIds: (Array.isArray(full.pageIds) ? full.pageIds : []).map(String),
    caption: String(full.caption || ''),
    media: Array.isArray(full.media) ? full.media.slice() : [],
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

function socialComposerBody(statusWanted) {
  const c = _social.composer;
  return {
    pageIds: c.pageIds,
    caption: String(c.caption || ''),
    media: c.media,
    status: statusWanted,
    scheduledAt: statusWanted === 'scheduled' ? new Date(c.scheduledAt).toISOString() : '',
    autoReplyRuleId: c.autoReply ? String(c.autoReplyRuleId || '') : ''
  };
}

async function socialComposerSave(action) {
  // action: 'draft' | 'schedule' | 'now'
  if (_social.busy || !_social.composer) return;
  const problem = action === 'draft' && !_social.composer.pageIds.length ? '' : socialComposerValidate();
  if (problem) { showNotification(socialText('Check the post', 'راجع المنشور'), problem, 'warning'); return; }
  const wanted = action === 'schedule' ? 'scheduled' : 'draft';
  _social.busy = true;
  render();
  try {
    const body = socialComposerBody(wanted);
    let saved;
    if (_social.composer.id) {
      saved = socialUnwrap(await socialApi(`/posts/${encodeURIComponent(_social.composer.id)}`, { method: 'PATCH', body }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 'post');
    } else {
      saved = socialUnwrap(await socialApi('/posts', { method: 'POST', body }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 'post');
    }
    const postId = String(saved?.id || _social.composer.id || '');
    if (action === 'now' && postId) {
      saved = socialUnwrap(await socialApi(`/posts/${encodeURIComponent(postId)}/publish`, { method: 'POST', body: {} }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 'post') || saved;
    }
    _social.lastDone = { action, post: saved || {}, pageNames: _social.composer.pageIds.map(id => socialPageById(id)?.name || '').filter(Boolean), mediaCount: _social.composer.media.length, ruleName: _social.composer.autoReply ? (_social.rules.find(r => String(r.id) === String(_social.composer.autoReplyRuleId))?.name || '') : '' };
    _social.composer = null;
    _social.screen = 'post-done';
    socialRefreshNow();
  } catch (e) {
    showNotification(socialText('Could not save the post', 'تعذر حفظ المنشور'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    _social.busy = false;
    render();
  }
}

function socialComposerClose() {
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
  const ok = confirm(socialText('Publish this post now?', 'نشر هذا المنشور الآن؟'));
  if (!ok) return;
  _social.busy = true;
  render();
  try {
    const res = socialUnwrap(await socialApi(`/posts/${encodeURIComponent(postId)}/publish`, { method: 'POST', body: {} }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS }), 'post') || {};
    const failed = String(res.status) === 'failed';
    showNotification(failed ? socialText('Publishing failed', 'فشل النشر') : socialText('Post published', 'تم نشر المنشور'), failed ? String(res.lastError || '') : '', failed ? 'error' : 'success');
    socialRefreshNow();
  } catch (e) {
    showNotification(socialText('Could not publish', 'تعذر النشر'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    _social.busy = false;
    render();
  }
}

async function socialCancelPost(postId) {
  try {
    await socialApi(`/posts/${encodeURIComponent(postId)}/cancel`, { method: 'POST', body: {} });
    showNotification(socialText('Schedule cancelled', 'تم إلغاء الجدولة'), socialText('The post is back in Drafts.', 'عاد المنشور إلى المسودات.'), 'success');
    socialRefreshNow();
  } catch (e) {
    showNotification(socialText('Could not cancel', 'تعذر الإلغاء'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  }
}

async function socialDeletePost(postId) {
  const ok = confirm(socialText('Delete this post?', 'حذف هذا المنشور؟'));
  if (!ok) return;
  try {
    await socialApi(`/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' });
    showNotification(socialText('Post deleted', 'تم حذف المنشور'), '', 'success');
    socialRefreshNow();
  } catch (e) {
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
  const next = !(_social.settings ? _social.settings.masterEnabled !== false : true);
  _social.busy = true;
  try {
    const res = await socialApi('/settings', { method: 'PUT', body: { masterEnabled: next } });
    _social.settings = socialUnwrap(res, 'settings') || { ...(_social.settings || {}), masterEnabled: next };
    showNotification(next ? socialText('Auto-reply is on', 'الرد التلقائي مفعّل') : socialText('Auto-reply is paused', 'الرد التلقائي متوقف'), '', 'success');
  } catch (e) {
    showNotification(socialText('Could not update', 'تعذر التحديث'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    _social.busy = false;
    render();
  }
}

async function socialToggleRule(ruleId) {
  const rule = _social.rules.find(r => String(r.id) === String(ruleId));
  if (!rule || _social.busy) return;
  const next = rule.enabled === false;
  _social.busy = true;
  try {
    const res = await socialApi(`/rules/${encodeURIComponent(ruleId)}`, { method: 'PATCH', body: { enabled: next } });
    const saved = socialUnwrap(res, 'rule');
    Object.assign(rule, saved && saved.id ? saved : { enabled: next });
  } catch (e) {
    showNotification(socialText('Could not update the rule', 'تعذر تحديث القاعدة'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    _social.busy = false;
    render();
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
  _social.ruleDraft = socialNewRule();
  _social.screen = 'rule';
  render();
}

function socialEditRule(ruleId) {
  const rule = _social.rules.find(r => String(r.id) === String(ruleId));
  if (!rule) return;
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
    showNotification(socialText('Rule saved', 'تم حفظ القاعدة'), body.name, 'success');
    _social.platformFilter = body.platform;
    _social.ruleDraft = null;
    _social.screen = '';
    socialRefreshNow();
  } catch (e) {
    showNotification(socialText('Could not save the rule', 'تعذر حفظ القاعدة'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    _social.busy = false;
    render();
  }
}

async function socialRuleDelete() {
  const r = _social.ruleDraft;
  if (!r || !r.id || _social.busy) return;
  const ok = confirm(socialText(`Delete the rule "${r.name}"?`, `حذف القاعدة "${r.name}"؟`));
  if (!ok) return;
  _social.busy = true;
  try {
    await socialApi(`/rules/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
    showNotification(socialText('Rule deleted', 'تم حذف القاعدة'), '', 'success');
    _social.ruleDraft = null;
    _social.screen = '';
    socialRefreshNow();
  } catch (e) {
    showNotification(socialText('Could not delete the rule', 'تعذر حذف القاعدة'), socialErrorDetail(e, 'Please try again.', 'حاول مرة أخرى.'), 'error');
  } finally {
    _social.busy = false;
    render();
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
