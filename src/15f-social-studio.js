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
