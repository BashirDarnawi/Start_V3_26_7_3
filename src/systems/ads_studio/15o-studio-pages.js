// ==========================================
// ALBAYAN STUDIO v2 — PAGES & REPLIES, THE PAGE-LINK REQUEST AND THE HELP GUIDES
// (plan tasks P4-06, P4-07, P5-03; styles in assets/ads-workspace.css, "Albayan Studio v2 Pages & replies")
// ==========================================
// This file is its own lazy bundle, studio-pages.js (src/manifest.json "lazy"; stage 15 size cap):
// the loader in studio.js (15o0 ensureStudioBundle) fetches it when the replies or posts tab is drawn,
// when a screen asks for guide links, when the Help list draws the guides card, and before the
// classic tabs hand over. Nothing runs at load time except the two screen registrations below.
// The "Pages & replies" tab of the v2 layout (?tab=replies&section=pages|rules|log|posts; the 'posts'
// tab draws the posts section alone), registered with the shell (15h). The classic Replies and Posts
// tabs (15f) hand over through studioPagesClassicDelegate() (via the loader's
// studioPagesClassicHandover) while /me says the v2 layout.
// - Pages: the health the server derives (GET /api/social-studio/pages: state, reason, label, fix,
//   "checked X ago"), one neutral banner while Albayan's Meta connection is down (/me metaConnection),
//   "Ask about this" / "I did it, tell the team" through the help desk (15n), "Check now" for admins.
// - Ask us to link a page (P4-07, id=link): platform, name and link, the Instagram pre-check as Yes /
//   No / Not sure chips, the sharing guide before sending, then one 'page' ticket (one operationId
//   until the server answers) whose message carries every answer in both languages.
// - Reply rules: master switch, honest channel labels (the rules reply's states; /me capabilities
//   before the gates are armed), rules with their pages (a removed page wears the server's label),
//   on/off, and the editor (id=new|<rule>): an action whose channel is off or not available says why
//   and cannot be picked; a gated one is saved and shown as waiting for Meta.
// - Reply log (GET /log): counters, the server's outcome labels, the problem in plain words, paging.
// - Posts (GET /posts) as they are. Help guides (P5-03): static bilingual content, opened in a sheet
//   from any screen (studioGuideOpen), listed by renderStudioGuidesCard() for the Help screen.
// Every server string is escaped; every text is EN/AR; no native dialog; nothing wraps another file.

const STUDIO_PG_SECTIONS = Object.freeze([
  // [section, icon, English, Arabic]; 'tiktok' shows only when a later file draws it (renderStudioTiktokSection)
  ['pages', 'flag', 'Pages', 'الصفحات'],
  ['rules', 'message-circle-reply', 'Reply rules', 'قواعد الرد'],
  ['log', 'list-checks', 'Reply log', 'سجل الردود'],
  ['posts', 'send', 'Posts', 'المنشورات'],
  ['tiktok', 'music', 'TikTok', 'تيك توك']
]);
const STUDIO_PG_READS = Object.freeze({
  pages: '/api/social-studio/pages', rules: '/api/social-studio/rules', settings: '/api/social-studio/settings', posts: '/api/social-studio/posts'
});
const STUDIO_PG_FRESH_MS = 30 * 1000;
const STUDIO_PG_RETRY_MS = 30 * 1000;
const STUDIO_PG_LOG_DAYS = 30;
const STUDIO_PG_LOG_LIMIT = 50;
const STUDIO_PG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const STUDIO_PG_MAX = Object.freeze({ name: 80, keyword: 40, keywords: 30, reply: 1000, linkName: 120, linkUrl: 300, note: 500, pages: 10 });
// platform:action -> the capability switch it needs (social_studio.CHANNEL_OF)
const STUDIO_PG_CHANNEL_OF = Object.freeze({ 'fb:dm': 'fbPrivateReply', 'fb:public': 'fbPublicReply', 'fb:like': 'fbPublicReply', 'ig:dm': 'igPrivateReply', 'ig:public': 'igPublicReply' });
const STUDIO_PG_STATES = Object.freeze(['on', 'poll', 'gated', 'off', 'unavailable']);
// The server's words (social_studio.CHANNEL_STATE_LABELS) as the fallback while a reply has not arrived.
const STUDIO_PG_STATE_LABELS = Object.freeze({
  on: ['Working', 'يعمل'], poll: ['Working, checked every 5 minutes', 'يعمل — نفحص كل 5 دقائق'],
  gated: ['Waiting for Meta approval', 'بانتظار موافقة ميتا'], off: ['Switched off', 'متوقف'], unavailable: ['Not available now', 'غير متاح حالياً']
});
const STUDIO_PG_ACTIONS = Object.freeze({ public: ['Public reply', 'رد عام'], dm: ['Private message', 'رسالة خاصة'], like: ['Like', 'إعجاب'] });
const STUDIO_PG_OUTCOMES = Object.freeze(['sent', 'partial', 'failed', 'waiting', 'parked', 'missed', 'skipped', 'sending', 'none']);
const STUDIO_PG_OUTCOME_LABELS = Object.freeze({
  sent: ['Sent', 'أُرسل'], partial: ['Partly sent', 'أُرسل جزئياً'], failed: ['Failed', 'فشل'], waiting: ['Waiting to retry', 'بانتظار إعادة المحاولة'],
  parked: ['Waiting for the Meta connection', 'بانتظار عودة ربط ميتا'], missed: ['Missed during the outage', 'فات أثناء الانقطاع'],
  skipped: ['Not sent: channel not available', 'لم يُرسل: القناة غير متاحة'], sending: ['Sending', 'قيد الإرسال'], none: ['Nothing to send', 'لا شيء للإرسال']
});
const STUDIO_PG_OUTCOME_TONE = Object.freeze({ sent: 'ok', partial: 'warn', failed: 'bad', waiting: 'warn', parked: 'warn', missed: 'bad', skipped: 'slate', sending: 'slate', none: 'slate' });
const STUDIO_PG_LOG_FILTERS = Object.freeze(['', 'sent', 'failed', 'waiting', 'parked', 'missed', 'skipped']);
const STUDIO_PG_POST_STATUSES = Object.freeze([
  ['scheduled', 'clock', 'Scheduled', 'مجدولة', 'warn'], ['published', 'check', 'Published', 'منشورة', 'ok'],
  ['draft', 'pencil', 'Drafts', 'مسودات', 'slate'], ['failed', 'triangle-alert', 'Failed', 'فشلت', 'bad']
]);
// A failed post's problem in plain words: the server's errorClass (social_studio publish: the class
// of its lastError) -> [English, Arabic]. The raw Meta text stays in a details line; an unknown or
// missing class gets the neutral pair (studioPgPostErrorText), never the raw English alone.
const STUDIO_PG_POST_ERRORS = Object.freeze({
  timeout: ['Meta did not answer in time; the post may have gone out. Check the page before retrying.', 'لم تجب ميتا في الوقت المحدد؛ ربما نُشر المنشور. تحقق من الصفحة قبل إعادة المحاولة.'],
  access_paused: ['Publishing is paused: the account needs active Social Studio access.', 'النشر متوقف: يحتاج الحساب إلى اشتراك فعّال في استوديو التواصل.'],
  page_unlinked: ['This page is no longer linked to the account.', 'هذه الصفحة لم تعد مربوطة بالحساب.'],
  meta_paused: ['Meta asked Albayan to wait; the post is tried again later.', 'طلبت ميتا من البيان الانتظار؛ يُعاد نشر المنشور لاحقاً.'],
  meta_not_configured: ["Albayan's Meta connection is not set up yet.", 'ربط البيان مع ميتا غير مُعدّ بعد.'],
  meta_refused: ['Meta refused this post; the team can see why.', 'رفضت ميتا هذا المنشور؛ يمكن للفريق معرفة السبب.'],
  publish_failed: ['Publishing failed on our side; the team can see why.', 'فشل النشر من جهتنا؛ يمكن للفريق معرفة السبب.']
});
const STUDIO_PG_POST_ERROR_ALIASES = Object.freeze({
  meta_timeout: 'timeout', ambiguous: 'timeout', paused: 'access_paused', owner_paused: 'access_paused', subscription: 'access_paused',
  unlinked: 'page_unlinked', page_removed: 'page_unlinked', page_missing: 'page_unlinked', meta_busy: 'meta_paused', rate_limited: 'meta_paused',
  not_configured: 'meta_not_configured', refused: 'meta_refused', meta_error: 'meta_refused', meta: 'meta_refused', failed: 'publish_failed', exception: 'publish_failed'
});
const STUDIO_PG_LINK_QUESTIONS = Object.freeze([
  // [key, English, Arabic] — the Instagram pre-check (PLAN.md §5.5 J7)
  ['professional', 'Is it a business or creator (professional) account?', 'هل حسابك حساب أعمال أو صانع محتوى (احترافي)؟'],
  ['linked', 'Is it linked to a Facebook page?', 'هل هو مربوط بصفحة فيسبوك؟'],
  ['isPublic', 'Is the account public (not private)?', 'هل الحساب عام (غير خاص)؟']
]);
const STUDIO_PG_ANSWERS = Object.freeze([['yes', 'Yes', 'نعم'], ['no', 'No', 'لا'], ['unsure', 'Not sure', 'لست متأكداً']]);

const _studioPg = {
  forUser: '', generation: 0,
  slots: Object.create(null),   // pages | rules | settings | posts -> {value, loadedAt, failedAt, error, loading}
  log: null,                    // {filter, rows, next, counters, labels, loadedAt, failedAt, error, loading}
  busy: new Map(),              // 'check:<page>' | 'toggle:<rule>' | 'master' | 'save' | 'delete' -> true
  editor: null,                 // the rule draft (studioPgEditorFor)
  link: null,                   // the page-link request draft (studioPgLinkDraft)
  logFilter: '', postsFilter: 'scheduled',
  classic: { section: 'pages', id: '' },  // where the classic delegate is (the v2 layout reads the address)
  sheet: null, opener: null
};

// ------------------------------------------------------------------ small helpers

function studioPgText(en, ar) {
  return adsStudioText(en, ar);
}

function studioPgIcon(name, className = 'studio-v2-icon') {
  return typeof studioV2Icon === 'function' ? studioV2Icon(name, className) : '';
}

function studioPgServer() {
  return typeof isServerModeEnabled === 'function' && isServerModeEnabled();
}

function studioPgInV2() {
  return typeof studioV2Frame === 'function' && studioV2Frame() === 'customer';
}

function studioPgMe() {
  return typeof studioMe === 'function' ? studioMe() : null;
}

function studioPgClean(value, max = 300) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

// The server's {en, ar} pair, cleaned, or null; studioPickText picks it when drawn (the reader may switch language).
function studioPgPair(raw, max = 300) {
  if (!raw || typeof raw !== 'object') return null;
  const en = studioPgClean(raw.en, max);
  const ar = studioPgClean(raw.ar, max);
  return en || ar ? { en, ar } : null;
}

function studioPgTime(value) {
  const text = studioPgClean(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? text : '';
}

function studioPgWhen(iso) {
  if (typeof studioHelpWhen === 'function') return studioHelpWhen(iso);
  const at = Date.parse(String(iso || ''));
  return Number.isFinite(at) ? new Date(at).toLocaleString() : '';
}

function studioPgPlatform(value) {
  const v = String(value || '').toLowerCase();
  return v === 'ig' || v === 'instagram' ? 'ig' : (v === 'fb' || v === 'facebook' ? 'fb' : '');
}

function studioPgPlatformName(platform) {
  return platform === 'ig' ? 'Instagram' : 'Facebook';
}

function studioPgBadge(platform) {
  return `<span class="studio-pg-badge" data-platform="${platform === 'ig' ? 'ig' : 'fb'}">${platform === 'ig' ? 'IG' : 'FB'}</span>`;
}

function studioPgChip(text, tone, icon = '', testId = '', extra = '') {
  return `<span class="studio-pg-chip" data-tone="${studioEsc(tone)}"${testId ? ` data-testid="${studioEsc(testId)}"` : ''}${extra}>${icon ? studioPgIcon(icon, 'studio-pg-chip-icon') : ''}<span>${studioEsc(text)}</span></span>`;
}

function studioPgSwitch(on, onclick, label, testId, disabled = false) {
  return `<button type="button" role="switch" class="studio-pg-switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${studioEsc(label)}" data-testid="${studioEsc(testId)}" onclick="${onclick}"${disabled ? ' disabled' : ''}><span class="studio-pg-switch-knob" aria-hidden="true"></span></button>`;
}

function studioPgErrorText(error, kind = 'action') {
  if (error && error.studio && error.studio.text) return error.studio.text;
  try { return studioErrorInfo(error, kind).text; } catch (_) {
    return kind === 'read' ? studioPgText('This could not be loaded. Try again in a moment.', 'تعذّر التحميل. أعد المحاولة بعد لحظات.') : studioPgText('The action could not be completed.', 'تعذّر إتمام العملية.');
  }
}

function studioPgNotify(ok, title, text) {
  if (typeof showNotification === 'function') showNotification(title, text, ok ? 'success' : 'error');
}

function studioPgRedraw() {
  try {
    if (typeof state === 'undefined' || state.currentView !== 'ads-studio') return;
    if (studioPgInV2() && typeof studioV2Rerender === 'function') studioV2Rerender();
    else if (typeof render === 'function') render();
  } catch (_) { /* the next draw shows the state */ }
}

function renderStudioPgProblem(error, retry, testId = 'studio-pg-problem') {
  const text = error && error.text ? error.text : studioPgText('This could not be loaded.', 'تعذّر التحميل.');
  return `<div class="studio-pg-problem" role="alert" data-testid="${studioEsc(testId)}"><span>${studioEsc(text)}</span><button type="button" class="studio-v2-action studio-pg-small" data-testid="studio-pg-retry" onclick="${retry}">${studioEsc(studioPgText('Try again', 'أعد المحاولة'))}</button></div>`;
}

function renderStudioPgLoading(text, testId) {
  return `<p class="studio-pg-empty" data-testid="${studioEsc(testId)}">${studioEsc(text)}</p>`;
}

// ------------------------------------------------------------------ scope and the reads

function studioPgScope() {
  const uid = typeof studioMeUserId === 'function' ? studioMeUserId() : '';
  if (_studioPg.forUser !== uid) {
    _studioPg.generation++;
    _studioPg.forUser = uid;
    _studioPg.slots = Object.create(null);
    _studioPg.log = null;
    _studioPg.busy = new Map();
    _studioPg.editor = null;
    _studioPg.link = null;
    _studioPg.logFilter = '';
    _studioPg.postsFilter = 'scheduled';
    _studioPg.classic = { section: 'pages', id: '' };
  }
  return !!uid;
}

function studioPgSlot(kind) {
  if (!_studioPg.slots[kind]) _studioPg.slots[kind] = { value: null, loadedAt: 0, failedAt: 0, error: null, loading: null };
  return _studioPg.slots[kind];
}

function studioPgCleanHealth(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const state = ['ok', 'attention', 'connection'].includes(raw.state) ? raw.state : 'ok';
  const reason = /^[a-z_]{1,60}$/.test(String(raw.reason || '')) ? String(raw.reason) : '';
  return {
    state, reason,
    labels: studioPgPair(raw.label, 200), fixes: studioPgPair(raw.fix, 300),
    teamAction: raw.teamAction === true, checkedAt: studioPgTime(raw.checkedAt), since: studioPgTime(raw.since)
  };
}

function studioPgCleanPage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  const platform = studioPgPlatform(raw.platform);
  if (!STUDIO_PG_ID_RE.test(id) || !platform) return null;
  const health = studioPgCleanHealth(raw.health) || { state: raw.healthy === false ? 'attention' : 'ok', reason: '', labels: null, fixes: null, teamAction: false, checkedAt: '', since: '' };
  return { id, platform, name: studioPgClean(raw.name, 160) || studioPgText('Linked page', 'صفحة مربوطة'), metaPageId: /^\d{1,40}$/.test(String(raw.metaPageId || '')) ? String(raw.metaPageId) : '', health };
}

function studioPgCleanRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!STUDIO_PG_ID_RE.test(id)) return null;
  const list = (value, max, size) => (Array.isArray(value) ? value.map(item => studioPgClean(item, size)).filter(Boolean).slice(0, max) : []);
  const pages = (Array.isArray(raw.pages) ? raw.pages : []).filter(page => page && typeof page === 'object' && STUDIO_PG_ID_RE.test(String(page.id || '')))
    .map(page => ({ id: String(page.id), removed: page.removed === true, name: studioPgClean(page.name, 160), platform: studioPgPlatform(page.platform) })).slice(0, STUDIO_PG_MAX.pages);
  return {
    id, name: studioPgClean(raw.name, STUDIO_PG_MAX.name) || studioPgText('Rule', 'قاعدة'), platform: studioPgPlatform(raw.platform) || 'fb',
    enabled: raw.enabled !== false, trigger: raw.trigger === 'every' ? 'every' : 'keywords', keywords: list(raw.keywords, STUDIO_PG_MAX.keywords, STUDIO_PG_MAX.keyword),
    publicReply: studioPgClean(raw.publicReply, STUDIO_PG_MAX.reply), dmEnabled: raw.dmEnabled === true, dmText: studioPgClean(raw.dmText, STUDIO_PG_MAX.reply),
    likeComment: raw.likeComment === true, oncePerPerson: raw.oncePerPerson === true, skipPublicAfterDm: raw.skipPublicAfterDm === true, quietHours: raw.quietHours === true,
    scope: raw.scope === 'chosen' ? 'chosen' : 'all', pageRefs: list(raw.pageRefs, STUDIO_PG_MAX.pages, 80).filter(ref => STUDIO_PG_ID_RE.test(ref)), pages,
    pageRemoved: raw.pageRemoved === true, pageRemovedLabels: studioPgPair(raw.pageRemovedLabel, 80)
  };
}

function studioPgCleanChannels(raw) {
  const out = { states: {}, labels: {} };
  if (!raw || typeof raw !== 'object') return out;
  const states = raw.states && typeof raw.states === 'object' ? raw.states : {};
  for (const channel of Object.values(STUDIO_PG_CHANNEL_OF)) {
    if (STUDIO_PG_STATES.includes(states[channel])) out.states[channel] = states[channel];
  }
  const labels = raw.labels && typeof raw.labels === 'object' ? raw.labels : {};
  for (const state of STUDIO_PG_STATES) {
    const pair = studioPgPair(labels[state], 120);
    if (pair) out.labels[state] = pair;
  }
  return out;
}

function studioPgCleanPost(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!STUDIO_PG_ID_RE.test(id)) return null;
  const status = ['draft', 'scheduled', 'publishing', 'published', 'failed'].includes(raw.status) ? raw.status : 'draft';
  return {
    id, status, caption: studioPgClean(raw.caption, 280), pageIds: (Array.isArray(raw.pageIds) ? raw.pageIds : []).map(String).filter(pid => STUDIO_PG_ID_RE.test(pid)).slice(0, STUDIO_PG_MAX.pages),
    scheduledAt: studioPgTime(raw.scheduledAt), publishedAt: studioPgTime(raw.publishedAt), updatedAt: studioPgTime(raw.updatedAt || raw.createdAt),
    mediaCount: Number.isSafeInteger(raw.mediaCount) && raw.mediaCount > 0 ? raw.mediaCount : 0, lastError: studioPgClean(raw.lastError, 300),
    errorClass: /^[a-z][a-z0-9_]{0,39}$/.test(String(raw.errorClass || '')) ? String(raw.errorClass) : ''
  };
}

// The bilingual words for a failed post's class ('' or unknown: the neutral refusal words).
function studioPgPostErrorText(errorClass) {
  const key = String(errorClass || '');
  const name = Object.prototype.hasOwnProperty.call(STUDIO_PG_POST_ERRORS, key) ? key : (STUDIO_PG_POST_ERROR_ALIASES[key] || 'meta_refused');
  const pair = STUDIO_PG_POST_ERRORS[name];
  return studioPgText(pair[0], pair[1]);
}

function studioPgCleanValue(kind, raw) {
  if (kind === 'pages') return Array.isArray(raw && raw.pages) ? raw.pages.map(studioPgCleanPage).filter(Boolean).slice(0, 50) : null;
  if (kind === 'posts') return Array.isArray(raw && raw.posts) ? raw.posts.map(studioPgCleanPost).filter(Boolean).slice(0, 200) : null;
  if (kind === 'rules') return Array.isArray(raw && raw.rules) ? { rules: raw.rules.map(studioPgCleanRule).filter(Boolean).slice(0, 100), channels: studioPgCleanChannels(raw.channels) } : null;
  if (kind === 'settings') {
    if (!raw || typeof raw !== 'object') return null;
    const quiet = raw.quietHours && typeof raw.quietHours === 'object' ? raw.quietHours : {};
    const clock = value => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')) ? String(value) : '');
    return { masterEnabled: raw.masterEnabled !== false, quietFrom: clock(quiet.from) || '22:00', quietTo: clock(quiet.to) || '08:00' };
  }
  return null;
}

// Starts a read of one list when it is due (fresh for 30 s; a failure waits 30 s unless forced);
// one read at a time. Resolves when the slot is settled; null when nothing was started.
function studioPgWant(kind, force = false) {
  const path = STUDIO_PG_READS[kind];
  if (!path || !studioPgScope() || !studioPgServer()) return null;
  const slot = studioPgSlot(kind);
  if (slot.loading) return slot.loading;
  const now = Date.now();
  if (!force && ((slot.failedAt && now - slot.failedAt < STUDIO_PG_RETRY_MS) || (slot.loadedAt && now - slot.loadedAt < STUDIO_PG_FRESH_MS))) return null;
  const generation = _studioPg.generation;
  const signal = studioReadSignal();
  const promise = studioApi(path, { method: 'GET' }).then(raw => {
    if (generation !== _studioPg.generation) return;
    const value = studioPgCleanValue(kind, raw);
    if (value === null) {
      slot.failedAt = Date.now();
      slot.error = { code: 'UNKNOWN', text: studioPgText('This could not be loaded. Try again in a moment.', 'تعذّر التحميل. أعد المحاولة بعد لحظات.') };
      return;
    }
    slot.value = value;
    slot.loadedAt = now;
    slot.failedAt = 0;
    slot.error = null;
  }, error => {
    if (generation !== _studioPg.generation) return;
    if (studioReadCancelled(error, signal)) return;
    slot.failedAt = Date.now();
    slot.error = (error && error.studio) || studioErrorInfo(error, 'read');
  }).finally(() => {
    if (generation !== _studioPg.generation) return;
    slot.loading = null;
    studioPgRedraw();
  });
  slot.loading = promise;
  return promise;
}

function studioPgRefresh() {
  for (const kind of Object.keys(STUDIO_PG_READS)) if (_studioPg.slots[kind] && _studioPg.slots[kind].loadedAt) studioPgWant(kind, true);
  if (_studioPg.log && _studioPg.log.loadedAt) studioPgWantLog(true);
  studioPgRedraw();
}

function studioPgRetry() {
  for (const kind of Object.keys(STUDIO_PG_READS)) if (_studioPg.slots[kind] && _studioPg.slots[kind].failedAt) studioPgWant(kind, true);
  if (_studioPg.log && _studioPg.log.failedAt) studioPgWantLog(true);
  studioPgRedraw();
}

function studioPgPages() {
  const slot = studioPgSlot('pages');
  return Array.isArray(slot.value) ? slot.value : [];
}

function studioPgPage(id) {
  return studioPgPages().find(page => page.id === String(id || '')) || null;
}

function studioPgRules() {
  const slot = studioPgSlot('rules');
  return slot.value && Array.isArray(slot.value.rules) ? slot.value.rules : [];
}

function studioPgRule(id) {
  return studioPgRules().find(rule => rule.id === String(id || '')) || null;
}

function studioPgCanUse() {
  return typeof adsStudioCanUse !== 'function' || adsStudioCanUse();
}

// ------------------------------------------------------------------ navigation

function studioPgSectionKnown(section) {
  return STUDIO_PG_SECTIONS.some(item => item[0] === section) && (section !== 'tiktok' || studioPgTiktokOn());
}

function studioPgTiktokOn() {
  const me = studioPgMe();
  return !!(me && me.services && me.services.tiktok === true) && typeof renderStudioTiktokSection === 'function';
}

// The screen a route asks for: {section, id} (id: 'link' on pages, 'new' or a rule id on rules).
function studioPgView(route) {
  let section = '';
  let id = '';
  if (route && typeof route === 'object') {
    section = String(route.section || '');
    id = String(route.id || '');
  } else {
    studioPgScope();
    section = _studioPg.classic.section;
    id = _studioPg.classic.id;
  }
  if (!studioPgSectionKnown(section)) section = 'pages';
  if (section === 'pages') id = id === 'link' ? 'link' : '';
  else if (section === 'rules') id = id === 'new' || STUDIO_PG_ID_RE.test(id) ? id : '';
  else id = '';
  return { section, id };
}

// Opens a section (and a sub-screen): the v2 address in the v2 layout (Back returns one level up),
// the classic tab's own state otherwise.
function studioPgGo(section, id = '') {
  const sec = studioPgSectionKnown(String(section || '')) ? String(section) : 'pages';
  const wanted = String(id || '');
  const safeId = wanted === 'new' || wanted === 'link' || STUDIO_PG_ID_RE.test(wanted) ? wanted : '';
  if (studioPgInV2()) return studioV2Go({ tab: 'replies', section: sec, id: safeId });
  studioPgScope();
  _studioPg.classic = { section: sec, id: safeId };
  if (typeof _adsStudioActiveTab !== 'undefined' && _adsStudioActiveTab !== 'replies' && typeof setAdsStudioTab === 'function') setAdsStudioTab('replies');
  else studioPgRedraw();
  return true;
}

// ------------------------------------------------------------------ the screen root

function renderStudioPgSections(view) {
  const chips = STUDIO_PG_SECTIONS.filter(item => item[0] !== 'tiktok' || studioPgTiktokOn()).map(([id, icon, en, ar]) =>
    `<button type="button" class="studio-pg-section" data-testid="studio-pg-section-${id}" onclick="studioPgGo('${id}')"${view.section === id ? ' aria-current="page"' : ''}>${studioPgIcon(icon, 'studio-pg-chip-icon')}<span>${studioEsc(studioPgText(en, ar))}</span></button>`).join('');
  return `<nav class="studio-pg-sections" aria-label="${studioEsc(studioPgText('Pages & replies sections', 'أقسام الصفحات والردود'))}">${chips}</nav>`;
}

function renderStudioPgPlanEnded() {
  return `
          <section class="studio-pg-card" data-testid="studio-pg-plan-ended">
            <h2 class="studio-pg-h2">${studioEsc(studioPgText('Your plan has ended', 'انتهى اشتراكك'))}</h2>
            <p class="studio-pg-note">${studioEsc(studioPgText('Pages, reply rules and posts come back as soon as you renew your plan. Nothing of yours was removed.', 'تعود الصفحات وقواعد الرد والمنشورات فور تجديد اشتراكك. لم يُحذف شيء مما لديك.'))}</p>
            ${studioPgInV2() ? `<button type="button" class="studio-v2-action is-primary" data-testid="studio-pg-renew" onclick="studioV2Open('wallet')">${studioPgIcon('wallet')}<span>${studioEsc(studioPgText('Renew from Wallet', 'جدّد من المحفظة'))}</span></button>` : ''}
          </section>`;
}

// The body of the tab (registered with the shell for 'replies'; the 'posts' tab draws the posts
// section alone with a way to the whole tab). route null = the classic delegate's own state.
function renderStudioPagesBody(route) {
  studioPgScope();
  const postsTab = !!(route && route.tab === 'posts');
  const view = postsTab ? { section: 'posts', id: '' } : studioPgView(route);
  // A draft outlives its editor only while its save is in flight: leaving the editor (Back, Cancel,
  // a section chip, the posts tab, a deep link or Back/Forward) drops it, so the next opening builds
  // it from the rule as the list knows it then (a switch-off or a rename from the list or another
  // device is never overwritten by stale fields).
  const kept = _studioPg.editor;
  if (kept && !kept.sending && !(view.section === 'rules' && view.id === kept.for)) _studioPg.editor = null;
  let body = '';
  if (!studioPgServer()) {
    body = `<section class="studio-pg-card" data-testid="studio-pg-offline"><p class="studio-pg-note">${studioEsc(studioPgText('Pages and replies need the connection to Albayan. Sign in to the online workspace.', 'الصفحات والردود تحتاج الاتصال بالبيان. سجّل الدخول إلى مساحة العمل عبر الإنترنت.'))}</p></section>`;
  } else if (!studioPgCanUse()) {
    body = renderStudioPgPlanEnded();
  } else if (view.section === 'pages') {
    body = view.id === 'link' ? renderStudioPgLink() : renderStudioPgPages();
  } else if (view.section === 'rules') {
    body = view.id ? renderStudioPgEditor(view.id) : renderStudioPgRules();
  } else if (view.section === 'log') {
    body = renderStudioPgLog();
  } else if (view.section === 'posts') {
    body = renderStudioPgPosts(postsTab);
  } else {
    body = renderStudioTiktokSection();
  }
  const chips = view.id || postsTab ? '' : renderStudioPgSections(view);
  return `
        <div class="studio-pg" data-testid="studio-pg" data-section="${studioEsc(view.section)}" data-id="${studioEsc(view.id)}">${chips}${body}
        </div>`;
}

if (typeof studioV2RegisterScreen === 'function') {
  studioV2RegisterScreen('replies', renderStudioPagesBody);
  studioV2RegisterScreen('posts', route => renderStudioPagesBody({ tab: 'posts', section: 'posts', id: '' }));
}

// The classic Replies / Posts tabs (15f) hand over while /me says the v2 layout; '' = classic draws.
function studioPagesClassicDelegate(tab) {
  const me = studioPgMe();
  if (!me || me.ui !== 'v2') return '';
  studioPgScope();
  const body = tab === 'posts' ? renderStudioPagesBody({ tab: 'posts', section: 'posts', id: '' }) : renderStudioPagesBody(null);
  return `<div class="studio-pg-classic" data-testid="studio-pg-classic" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}">${body}</div>`;
}

// ------------------------------------------------------------------ Pages (P4-06, J7)

function studioPgHealthTone(health) {
  if (health.state === 'ok') return 'ok';
  return health.state === 'connection' ? 'slate' : 'warn';
}

function studioPgHealthIcon(health) {
  if (health.state === 'ok') return 'circle-check';
  return health.state === 'connection' ? 'plug-zap' : 'triangle-alert';
}

function renderStudioPgPage(page, admin, down) {
  const h = page.health;
  const label = studioPickText(h.labels, 200) || (h.state === 'ok' ? studioPgText('Working', 'يعمل') : studioPgText('Needs attention', 'يحتاج انتباهاً'));
  const checked = h.checkedAt && typeof studioDataCheckedAgo === 'function' ? studioDataCheckedAgo(h.checkedAt) : (h.checkedAt ? studioPgWhen(h.checkedAt) : studioPgText('not checked yet', 'لم يُفحص بعد'));
  const stale = h.checkedAt && typeof studioDataIsStale === 'function' && studioDataIsStale(h.checkedAt);
  let fix = '';
  if (h.state === 'attention' && !down) {
    const helpOn = typeof studioHelpOn === 'function' && studioHelpOn();
    const done = !h.teamAction && helpOn
      ? `<button type="button" class="studio-v2-action studio-pg-small" data-testid="studio-pg-fix-${studioEsc(page.id)}" onclick="studioHelpAskAbout('page', '${studioEsc(page.id)}')">${studioPgIcon('check')}<span>${studioEsc(studioPgText('I did it, tell the team', 'فعلتها — أبلغ الفريق'))}</span></button>` : '';
    fix = `<div class="studio-pg-fix" data-testid="studio-pg-fix"><p class="studio-pg-fix-title">${studioEsc(h.teamAction ? studioPgText('Our team is on it', 'فريقنا يتولى الأمر') : studioPgText('One fix', 'خطوة واحدة'))}</p><p class="studio-pg-note">${studioEsc(studioPickText(h.fixes, 300) || studioPgText('Tell the team; they will check the page.', 'أبلغ الفريق ليفحص الصفحة.'))}</p>${done}</div>`;
  }
  const busy = _studioPg.busy.has(`check:${page.id}`);
  const check = admin ? `<button type="button" class="studio-v2-action studio-pg-small" data-testid="studio-pg-check-${studioEsc(page.id)}" onclick="studioPgCheck('${studioEsc(page.id)}', this)"${busy ? ' disabled aria-busy="true"' : ''}>${studioPgIcon('refresh-cw')}<span>${studioEsc(busy ? studioPgText('Checking…', 'جارٍ الفحص…') : studioPgText('Check now', 'افحص الآن'))}</span></button>` : '';
  const ask = typeof studioHelpAskButton === 'function' ? studioHelpAskButton('page', page.id, true) : '';
  return `
            <li class="studio-pg-page" data-testid="studio-pg-page-${studioEsc(page.id)}" data-state="${studioEsc(h.state)}" data-reason="${studioEsc(h.reason)}">
              <div class="studio-pg-page-head">
                ${studioPgBadge(page.platform)}
                <span class="studio-pg-page-name" dir="auto">${studioEsc(page.name)}</span>
                ${studioPgChip(label, studioPgHealthTone(h), studioPgHealthIcon(h), 'studio-pg-health')}
              </div>
              <p class="studio-pg-meta"><span>${studioEsc(studioPgPlatformName(page.platform))}</span>${page.metaPageId ? `<span>${studioLtr(page.metaPageId)}</span>` : ''}<span class="studio-checked${stale ? ' is-stale' : ''}" data-testid="studio-pg-checked">${studioEsc(checked)}</span></p>
              ${fix}
              ${check || ask ? `<div class="studio-pg-actions">${check}${ask}</div>` : ''}
            </li>`;
}

function renderStudioPgPages() {
  const slot = studioPgSlot('pages');
  studioPgWant('pages');
  const me = studioPgMe();
  const admin = !!(me && me.isAdmin);
  const down = !!(me && me.metaConnection && me.metaConnection.down === true);
  const banner = down ? `<div class="studio-pg-banner" role="status" data-testid="studio-pg-connection">${studioPgIcon('plug-zap')}<p>${studioEsc(studioPickText(me.metaConnection.labels, 300) || studioPgText('Facebook and Instagram updates are delayed right now; page checks resume once the connection is back.', 'تحديثات فيسبوك وإنستغرام متأخرة حالياً؛ تعود فحوص الصفحات بعد عودة الاتصال.'))}</p></div>` : '';
  let list = '';
  if (!slot.loadedAt && slot.error) list = renderStudioPgProblem(slot.error, 'studioPgRetry()');
  else if (!slot.loadedAt) list = renderStudioPgLoading(studioPgText('Reading your pages…', 'نقرأ صفحاتك…'), 'studio-pg-loading');
  else if (!slot.value.length) list = `<p class="studio-pg-empty" data-testid="studio-pg-empty">${studioEsc(studioPgText('No page is linked yet. Ask us to link your Facebook page or Instagram account: the team does the linking, you never share a password.', 'لا توجد صفحة مربوطة بعد. اطلب منا ربط صفحتك على فيسبوك أو حسابك على إنستغرام: الفريق يتولى الربط، ولا تشارك كلمة مرور أبداً.'))}</p>`;
  else list = `<ul class="studio-pg-list" data-testid="studio-pg-list">${slot.value.map(page => renderStudioPgPage(page, admin, down)).join('')}</ul>`;
  const stalePart = slot.loadedAt && slot.error ? `<p class="studio-pg-note">${studioEsc(studioPgText('The list could not be refreshed; it shows what we know.', 'تعذّر تحديث القائمة؛ تعرض ما نعرفه.'))}</p>` : '';
  return `
          <section class="studio-pg-card" data-testid="studio-pg-pages" aria-labelledby="studio-pg-pages-title">
            <div class="studio-pg-head">
              <h2 id="studio-pg-pages-title" class="studio-pg-h2">${studioEsc(studioPgText('Linked pages', 'الصفحات المربوطة'))}</h2>
              <button type="button" class="studio-pg-link" data-testid="studio-pg-refresh" onclick="studioPgRefresh()"${slot.loading ? ' disabled' : ''}>${studioPgIcon('refresh-cw', 'studio-pg-chip-icon')}<span>${studioEsc(studioPgText('Refresh', 'تحديث'))}</span></button>
            </div>
            <p class="studio-pg-note">${studioEsc(studioPgText('Albayan reads the comments on these pages and answers them with your rules. Every page is checked daily.', 'يقرأ البيان التعليقات على هذه الصفحات ويرد عليها بقواعدك. تُفحص كل صفحة يومياً.'))}</p>
            ${banner}${stalePart}${list}
            <button type="button" class="studio-v2-action is-primary" data-testid="studio-pg-link-request" onclick="studioPgGo('pages', 'link')">${studioPgIcon('link-2')}<span>${studioEsc(studioPgText('Ask us to link a page', 'اطلب منا ربط صفحة'))}</span></button>
          </section>
          ${renderStudioGuideLinks(['share-page', 'instagram'], 'studio-pg-guides')}`;
}

// Admin: the page's health check now (POST /pages/{id}/check; the server allows one a minute).
function studioPgCheck(id, button = null) {
  const page = studioPgPage(id);
  const key = `check:${String(id || '')}`;
  if (!page || _studioPg.busy.has(key) || !studioPgServer()) return null;
  _studioPg.busy.set(key, true);
  _studioPg.opener = button || null;
  studioPgRedraw();
  const generation = _studioPg.generation;
  return studioApi(`/api/social-studio/pages/${encodeURIComponent(page.id)}/check`, { method: 'POST', body: {} }).then(raw => {
    if (generation !== _studioPg.generation) return null;
    const health = studioPgCleanHealth(raw && raw.health);
    if (health) page.health = health;
    const notConfigured = !!(raw && raw.errorCode === 'not_configured');
    studioPgNotify(!notConfigured, notConfigured ? studioPgText('Meta is not connected on the server', 'ميتا غير مربوطة على الخادم') : studioPgText('Page checked', 'فُحصت الصفحة'),
      notConfigured ? studioPgText('Nothing was checked. Set up the Meta connection first.', 'لم يُفحص شيء. أعدّ ربط ميتا أولاً.') : (health ? studioPickText(health.labels, 200) : ''));
    return health;
  }, error => {
    if (generation !== _studioPg.generation) return null;
    studioPgNotify(false, studioPgText('Could not check the page', 'تعذّر فحص الصفحة'), studioPgErrorText(error, 'action'));
    return null;
  }).finally(() => {
    if (generation !== _studioPg.generation) return;
    _studioPg.busy.delete(key);
    studioPgRedraw();
  });
}

// ------------------------------------------------------------------ Ask us to link a page (P4-07)

function studioPgLinkDraft() {
  studioPgScope();
  if (!_studioPg.link) {
    _studioPg.link = {
      platform: '', name: '', link: '', professional: '', linked: '', isPublic: '', shared: false, note: '',
      operationId: Security.generateSecureId('page-link'), sending: false, error: '', problems: {}, result: null
    };
  }
  return _studioPg.link;
}

function studioPgLinkSet(field, value) {
  const draft = studioPgLinkDraft();
  if (draft.sending) return;
  if (field === 'name') draft.name = String(value || '').slice(0, STUDIO_PG_MAX.linkName);
  else if (field === 'link') draft.link = String(value || '').slice(0, STUDIO_PG_MAX.linkUrl);
  else if (field === 'note') draft.note = String(value || '').slice(0, STUDIO_PG_MAX.note);
  else return;
  if (draft.problems[field] || draft.problems.page) {
    delete draft.problems[field];
    delete draft.problems.page;
    studioPgRedraw();
  }
}

function studioPgLinkPick(field, value) {
  const draft = studioPgLinkDraft();
  if (draft.sending) return;
  const answer = String(value || '');
  if (field === 'platform') {
    if (!studioPgPlatform(answer)) return;
    draft.platform = studioPgPlatform(answer);
  } else if (STUDIO_PG_LINK_QUESTIONS.some(([key]) => key === field)) {
    if (!STUDIO_PG_ANSWERS.some(([key]) => key === answer)) return;
    draft[field] = answer;
  } else return;
  delete draft.problems[field];
  studioPgRedraw();
}

function studioPgLinkShared(checked) {
  const draft = studioPgLinkDraft();
  if (draft.sending) return;
  draft.shared = checked === true;
}

function studioPgLinkValidate(draft) {
  const problems = {};
  if (!draft.platform) problems.platform = studioPgText('Choose Facebook or Instagram.', 'اختر فيسبوك أو إنستغرام.');
  if (draft.name.trim().length < 2 && draft.link.trim().length < 4) problems.page = studioPgText('Write the page name or paste its link.', 'اكتب اسم الصفحة أو الصق رابطها.');
  if (draft.platform === 'ig') {
    for (const [key] of STUDIO_PG_LINK_QUESTIONS) if (!draft[key]) problems[key] = studioPgText('Pick an answer.', 'اختر إجابة.');
  }
  return problems;
}

function studioPgAnswerWords(value) {
  const hit = STUDIO_PG_ANSWERS.find(([key]) => key === value);
  return hit ? `${hit[1]} / ${hit[2]}` : '—';
}

// The ticket's first message: every answer on its own line, in both languages, so the desk reads
// it as it is (the server keeps the text, this screen adds nothing later).
function studioPgLinkMessage(draft) {
  const platform = studioPgPlatformName(draft.platform);
  const lines = [
    'Page link request / طلب ربط صفحة',
    `Platform / المنصة: ${platform}`,
    `Page name / اسم الصفحة: ${draft.name.trim() || '—'}`,
    `Page link / رابط الصفحة: ${draft.link.trim() || '—'}`
  ];
  if (draft.platform === 'ig') {
    lines.push(`Professional account (business or creator) / حساب احترافي (أعمال أو صانع محتوى): ${studioPgAnswerWords(draft.professional)}`);
    lines.push(`Linked to a Facebook page / مربوط بصفحة فيسبوك: ${studioPgAnswerWords(draft.linked)}`);
    lines.push(`Public account / حساب عام: ${studioPgAnswerWords(draft.isPublic)}`);
  }
  lines.push(`Albayan added as a partner in Meta Business Suite / أُضيف البيان كشريك في Meta Business Suite: ${draft.shared ? 'Yes / نعم' : 'Not yet / ليس بعد'}`);
  if (draft.note.trim()) lines.push(`Note / ملاحظة: ${draft.note.trim()}`);
  return lines.join('\n').slice(0, 2000);
}

function studioPgLinkSend() {
  const draft = studioPgLinkDraft();
  if (draft.sending) return null;
  const problems = studioPgLinkValidate(draft);
  if (Object.keys(problems).length) {
    draft.problems = problems;
    draft.error = '';
    studioPgRedraw();
    return null;
  }
  if (!studioPgServer()) {
    draft.error = studioPgText('Sending the request needs the connection to Albayan.', 'إرسال الطلب يحتاج الاتصال بالبيان.');
    studioPgRedraw();
    return null;
  }
  draft.sending = true;
  draft.error = '';
  draft.problems = {};
  studioPgRedraw();
  const generation = _studioPg.generation;
  const name = draft.name.trim() || draft.link.trim();
  const body = {
    subject: studioPgText(`Link my page: ${name}`, `ربط صفحتي: ${name}`).slice(0, 120),
    category: 'page', message: studioPgLinkMessage(draft), operationId: draft.operationId
  };
  return studioApi('/api/studio/tickets', { method: 'POST', body }).then(raw => {
    if (generation !== _studioPg.generation) return null;
    const ticket = raw && raw.ticket && typeof raw.ticket === 'object' ? raw.ticket : {};
    const id = /^tkt_[0-9a-f]{40}$/.test(String(ticket.id || '')) ? String(ticket.id) : '';
    draft.sending = false;
    draft.result = { id, number: studioPgClean(ticket.number, 20) || studioPgText('sent', 'أُرسل'), dueAt: studioPgTime(ticket.dueAt) };
    studioPgNotify(true, studioPgText('Request sent', 'أُرسل الطلب'), draft.result.number);
    studioPgRedraw();
    return draft.result;
  }, error => {
    if (generation !== _studioPg.generation) return null;
    draft.sending = false;
    draft.error = studioPgErrorText(error, 'action');
    const code = String((error && error.studio && error.studio.code) || '');
    if (code === 'IDEMPOTENCY_MISMATCH') draft.operationId = Security.generateSecureId('page-link');
    else if (code === 'SERVICE_OFF' && typeof studioLoadMe === 'function') studioLoadMe(0);
    studioPgRedraw();
    return null;
  });
}

function studioPgLinkCancel() {
  studioPgScope();
  if (_studioPg.link && !_studioPg.link.sending) _studioPg.link = null;
  return studioPgGo('pages');
}

function renderStudioPgLinkDone(draft) {
  const result = draft.result;
  const due = result.dueAt ? studioPgWhen(result.dueAt) : '';
  const open = result.id && typeof studioHelpOpen === 'function'
    ? `<button type="button" class="studio-v2-action is-primary" data-testid="studio-pg-link-open" onclick="studioHelpOpen('${result.id}')">${studioPgIcon('ticket')}<span>${studioEsc(studioPgText('Open the ticket', 'افتح التذكرة'))}</span></button>` : '';
  return `
          <section class="studio-pg-card studio-pg-done" data-testid="studio-pg-link-done">
            <span class="studio-pg-done-icon" aria-hidden="true">${studioPgIcon('check')}</span>
            <h2 class="studio-pg-h2">${studioEsc(studioPgText('Your link request is with the team', 'طلب الربط لدى الفريق'))}</h2>
            <p class="studio-pg-number" data-testid="studio-pg-link-number">${studioEsc(result.number)}</p>
            <p class="studio-pg-note">${studioEsc(due
              ? studioPgText(`We reply by ${due} (Tripoli time) in this ticket. Once the page is linked it appears here with its health.`, `نرد قبل ${due} (بتوقيت طرابلس) في هذه التذكرة. وبعد ربط الصفحة تظهر هنا مع حالتها.`)
              : studioPgText('We reply in this ticket during our working hours. Once the page is linked it appears here with its health.', 'نرد في هذه التذكرة خلال ساعات عملنا. وبعد ربط الصفحة تظهر هنا مع حالتها.'))}</p>
            <div class="studio-pg-actions">${open}<button type="button" class="studio-v2-action" data-testid="studio-pg-link-back" onclick="studioPgLinkCancel()">${studioEsc(studioPgText('Back to pages', 'العودة إلى الصفحات'))}</button></div>
          </section>`;
}

function renderStudioPgLink() {
  const draft = studioPgLinkDraft();
  if (draft.result) return renderStudioPgLinkDone(draft);
  const helpOn = typeof studioHelpOn === 'function' && studioHelpOn();
  if (!helpOn) {
    return `
          <section class="studio-pg-card" data-testid="studio-pg-link-off">
            <h2 class="studio-pg-h2">${studioEsc(studioPgText('Ask us to link a page', 'اطلب منا ربط صفحة'))}</h2>
            <p class="studio-pg-note">${studioEsc(studioPgText('Sending requests from here is not open for your account yet. Contact the Albayan team with your page link and we do the rest.', 'إرسال الطلبات من هنا غير مفتوح لحسابك بعد. تواصل مع فريق البيان مع رابط صفحتك ونتولى الباقي.'))}</p>
            ${typeof renderStudioHelpContact === 'function' ? renderStudioHelpContact() : ''}
            <button type="button" class="studio-v2-action" data-testid="studio-pg-link-back" onclick="studioPgLinkCancel()">${studioEsc(studioPgText('Back to pages', 'العودة إلى الصفحات'))}</button>
          </section>`;
  }
  const field = (key, label, control, hint = '') => `
            <div class="studio-pg-field${draft.problems[key] ? ' is-invalid' : ''}">
              <p class="studio-pg-label" id="studio-pg-link-label-${key}">${studioEsc(label)}</p>
              ${control}
              ${hint ? `<p class="studio-pg-note">${studioEsc(hint)}</p>` : ''}
              ${draft.problems[key] ? `<p class="studio-pg-error" data-testid="studio-pg-link-problem-${key}">${studioEsc(draft.problems[key])}</p>` : ''}
            </div>`;
  const chip = (testId, label, on, onclick) => `<button type="button" class="studio-pg-choice" data-testid="${testId}" aria-pressed="${on ? 'true' : 'false'}" onclick="${onclick}"${draft.sending ? ' disabled' : ''}>${studioEsc(label)}</button>`;
  const platforms = `<div class="studio-pg-chips" role="group" aria-labelledby="studio-pg-link-label-platform">${chip('studio-pg-link-platform-fb', 'Facebook', draft.platform === 'fb', "studioPgLinkPick('platform', 'fb')")}${chip('studio-pg-link-platform-ig', 'Instagram', draft.platform === 'ig', "studioPgLinkPick('platform', 'ig')")}</div>`;
  const questions = draft.platform === 'ig' ? STUDIO_PG_LINK_QUESTIONS.map(([key, en, ar]) => {
    const answers = `<div class="studio-pg-chips" role="group" aria-labelledby="studio-pg-link-label-${key}">${STUDIO_PG_ANSWERS.map(([value, aEn, aAr]) => chip(`studio-pg-link-${key}-${value}`, studioPgText(aEn, aAr), draft[key] === value, `studioPgLinkPick('${key}', '${value}')`)).join('')}</div>`;
    const warn = draft[key] === 'no' || draft[key] === 'unsure'
      ? (key === 'isPublic' ? studioPgText('Comments reach Albayan only from a public account. The guide below shows the setting; you can still send the request.', 'تصل التعليقات إلى البيان من حساب عام فقط. يعرض الدليل أدناه الإعداد؛ ويمكنك إرسال الطلب على أي حال.')
        : studioPgText('Instagram replies need a professional account linked to a Facebook page. The guide below shows how; the team helps too.', 'ردود إنستغرام تحتاج حساباً احترافياً مربوطاً بصفحة فيسبوك. يعرض الدليل أدناه الطريقة؛ والفريق يساعدك أيضاً.'))
      : '';
    return field(key, studioPgText(en, ar), answers, warn);
  }).join('') : '';
  const guideKeys = draft.platform === 'ig' ? ['share-page', 'instagram'] : ['share-page'];
  return `
          <form class="studio-pg-card studio-pg-form" data-testid="studio-pg-link-form" onsubmit="event.preventDefault(); studioPgLinkSend();">
            <h2 class="studio-pg-h2">${studioEsc(studioPgText('Ask us to link a page', 'اطلب منا ربط صفحة'))}</h2>
            <p class="studio-pg-note">${studioEsc(studioPgText('The Albayan team links the page for you within a business day. You never share a password: you add Albayan as a partner in Meta Business Suite (the guide is below).', 'يربط فريق البيان الصفحة لك خلال يوم عمل. لا تشارك كلمة مرور أبداً: تضيف البيان شريكاً في Meta Business Suite (الدليل في الأسفل).'))}</p>
            ${field('platform', studioPgText('Which platform?', 'أي منصة؟'), platforms)}
            ${field('page', studioPgText('Which page?', 'أي صفحة؟'), `
              <label class="studio-pg-sublabel" for="studio-pg-link-name">${studioEsc(studioPgText('Page name', 'اسم الصفحة'))}</label>
              <input id="studio-pg-link-name" class="studio-pg-input" type="text" maxlength="${STUDIO_PG_MAX.linkName}" value="${studioEsc(draft.name)}" oninput="studioPgLinkSet('name', this.value)"${draft.sending ? ' disabled' : ''} />
              <label class="studio-pg-sublabel" for="studio-pg-link-url">${studioEsc(studioPgText('Page link or @username', 'رابط الصفحة أو @اسم المستخدم'))}</label>
              <input id="studio-pg-link-url" class="studio-pg-input" type="text" inputmode="url" dir="ltr" maxlength="${STUDIO_PG_MAX.linkUrl}" value="${studioEsc(draft.link)}" oninput="studioPgLinkSet('link', this.value)"${draft.sending ? ' disabled' : ''} />`)}
            ${questions}
            ${renderStudioGuideInline(guideKeys[0])}
            ${guideKeys.length > 1 ? renderStudioGuideLinks(guideKeys.slice(1), 'studio-pg-link-guides') : ''}
            <label class="studio-pg-check" for="studio-pg-link-shared">
              <input id="studio-pg-link-shared" type="checkbox"${draft.shared ? ' checked' : ''} onchange="studioPgLinkShared(this.checked)"${draft.sending ? ' disabled' : ''} />
              <span>${studioEsc(studioPgText('I added Albayan as a partner in Meta Business Suite (or I will once the team sends the Business ID).', 'أضفت البيان شريكاً في Meta Business Suite (أو سأفعل بعد أن يرسل الفريق رقم النشاط التجاري).'))}</span>
            </label>
            <div class="studio-pg-field">
              <label class="studio-pg-label" for="studio-pg-link-note">${studioEsc(studioPgText('Anything else? (optional)', 'أي شيء آخر؟ (اختياري)'))}</label>
              <textarea id="studio-pg-link-note" class="studio-pg-input" rows="3" maxlength="${STUDIO_PG_MAX.note}" oninput="studioPgLinkSet('note', this.value)"${draft.sending ? ' disabled' : ''}>${studioEsc(draft.note)}</textarea>
            </div>
            ${draft.error ? `<p class="studio-pg-error" role="alert" data-testid="studio-pg-link-error">${studioEsc(draft.error)}</p>` : ''}
            <div class="studio-pg-actions">
              <button type="button" class="studio-v2-action" data-testid="studio-pg-link-cancel" onclick="studioPgLinkCancel()"${draft.sending ? ' disabled' : ''}>${studioEsc(studioPgText('Cancel', 'إلغاء'))}</button>
              <button type="submit" class="studio-v2-action is-primary" data-testid="studio-pg-link-send"${draft.sending ? ' disabled aria-busy="true"' : ''}>${studioPgIcon('send')}<span>${studioEsc(draft.sending ? studioPgText('Sending…', 'جارٍ الإرسال…') : studioPgText('Send the request', 'أرسل الطلب'))}</span></button>
            </div>
          </form>`;
}

// ------------------------------------------------------------------ Reply rules (P4-06, J6, P4-05 labels)

// The state of one reply action on one platform: {channel, state, label, open, refused}. The rules
// reply's channel states rule once an admin armed the gates; /me capabilities say it before that.
function studioPgChannel(platform, kind) {
  const channel = STUDIO_PG_CHANNEL_OF[`${studioPgPlatform(platform)}:${kind}`];
  if (!channel) return { channel: '', state: 'on', label: '', open: true, refused: false };
  const rules = studioPgSlot('rules').value;
  const armed = rules && rules.channels && Object.keys(rules.channels.states).length ? rules.channels.states : null;
  const me = studioPgMe();
  const caps = me && me.capabilities && typeof me.capabilities === 'object' ? me.capabilities : {};
  let state = String((armed || caps)[channel] || '');
  if (state === 'poll' && channel !== 'igPublicReply') state = 'gated';
  if (!STUDIO_PG_STATES.includes(state)) state = armed ? 'unavailable' : 'on';
  const label = studioPickText(rules && rules.channels ? rules.channels.labels[state] : null, 120) || studioPgText(STUDIO_PG_STATE_LABELS[state][0], STUDIO_PG_STATE_LABELS[state][1]);
  return { channel, state, label, open: state === 'on' || state === 'poll', refused: state === 'off' || state === 'unavailable' };
}

function studioPgStateTone(state) {
  if (state === 'on' || state === 'poll') return 'ok';
  return state === 'gated' ? 'warn' : 'slate';
}

function studioPgActionWord(kind) {
  const words = STUDIO_PG_ACTIONS[kind];
  return words ? studioPgText(words[0], words[1]) : String(kind || '');
}

function studioPgMaster() {
  const key = 'master';
  const settings = studioPgSlot('settings').value;
  if (!settings || _studioPg.busy.has(key) || !studioPgServer()) return null;
  const next = !settings.masterEnabled;
  _studioPg.busy.set(key, true);
  studioPgRedraw();
  const generation = _studioPg.generation;
  return studioApi('/api/social-studio/settings', { method: 'PUT', body: { masterEnabled: next } }).then(raw => {
    if (generation !== _studioPg.generation) return null;
    const clean = studioPgCleanValue('settings', raw);
    studioPgSlot('settings').value = clean || { ...settings, masterEnabled: next };
    studioPgNotify(true, next ? studioPgText('Auto-reply is on', 'الرد التلقائي مفعّل') : studioPgText('Auto-reply is paused', 'الرد التلقائي متوقف'), '');
    return true;
  }, error => {
    if (generation !== _studioPg.generation) return null;
    studioPgNotify(false, studioPgText('Could not change the switch', 'تعذّر تغيير المفتاح'), studioPgErrorText(error, 'action'));
    return null;
  }).finally(() => {
    if (generation !== _studioPg.generation) return;
    _studioPg.busy.delete(key);
    studioPgRedraw();
  });
}

function studioPgRuleToggle(id) {
  const rule = studioPgRule(id);
  const key = `toggle:${String(id || '')}`;
  if (!rule || _studioPg.busy.has(key) || !studioPgServer()) return null;
  const next = !rule.enabled;
  _studioPg.busy.set(key, true);
  studioPgRedraw();
  const generation = _studioPg.generation;
  return studioApi(`/api/social-studio/rules/${encodeURIComponent(rule.id)}`, { method: 'PATCH', body: { enabled: next } }).then(raw => {
    if (generation !== _studioPg.generation) return null;
    const saved = studioPgCleanRule(raw);
    Object.assign(rule, saved || { enabled: next });
    return true;
  }, error => {
    if (generation !== _studioPg.generation) return null;
    studioPgNotify(false, studioPgText('Could not change the rule', 'تعذّر تغيير القاعدة'), studioPgErrorText(error, 'action'));
    return null;
  }).finally(() => {
    if (generation !== _studioPg.generation) return;
    _studioPg.busy.delete(key);
    studioPgRedraw();
  });
}

function renderStudioPgRuleRow(rule) {
  const trigger = rule.trigger === 'every' ? studioPgText('Every comment', 'كل تعليق')
    : `${studioPgText('Keywords', 'كلمات مفتاحية')}: ${rule.keywords.slice(0, 4).join(', ')}${rule.keywords.length > 4 ? '…' : ''}`;
  const pages = rule.pages.length
    ? rule.pages.map(page => (page.removed
      ? studioPgChip(studioPickText(rule.pageRemovedLabels, 80) || studioPgText('Page removed', 'الصفحة أُزيلت'), 'bad', 'unlink', `studio-pg-rule-page-removed-${rule.id}`)
      : studioPgChip(page.name || studioPgText('Page', 'صفحة'), 'slate', page.platform === 'ig' ? 'instagram' : 'facebook'))).join('')
    : studioPgChip(studioPgText('All linked pages', 'كل الصفحات المربوطة'), 'slate', 'layers');
  const actions = [['public', !!rule.publicReply], ['dm', rule.dmEnabled && !!rule.dmText], ['like', rule.likeComment && rule.platform === 'fb']]
    .filter(([, on]) => on).map(([kind]) => {
      const channel = studioPgChannel(rule.platform, kind);
      return studioPgChip(channel.open ? studioPgActionWord(kind) : `${studioPgActionWord(kind)} — ${channel.label}`, channel.open ? 'ok' : studioPgStateTone(channel.state), channel.open ? 'check' : 'clock', '', ` data-action="${kind}" data-state="${studioEsc(channel.state)}"`);
    }).join('');
  const busy = _studioPg.busy.has(`toggle:${rule.id}`);
  return `
            <li class="studio-pg-rule${rule.enabled ? '' : ' is-off'}" data-testid="studio-pg-rule-${studioEsc(rule.id)}" data-enabled="${rule.enabled ? '1' : '0'}">
              <button type="button" class="studio-pg-rule-open" data-testid="studio-pg-rule-edit-${studioEsc(rule.id)}" onclick="studioPgGo('rules', '${studioEsc(rule.id)}')">
                <span class="studio-pg-rule-head">${studioPgBadge(rule.platform)}<span class="studio-pg-rule-name" dir="auto">${studioEsc(rule.name)}</span></span>
                <span class="studio-pg-meta"><span dir="auto">${studioEsc(trigger)}</span></span>
                <span class="studio-pg-chips is-tight">${pages}</span>
                <span class="studio-pg-chips is-tight">${actions}</span>
              </button>
              ${studioPgSwitch(rule.enabled, `studioPgRuleToggle('${studioEsc(rule.id)}')`, rule.name, `studio-pg-rule-toggle-${rule.id}`, busy)}
            </li>`;
}

function renderStudioPgChannels() {
  const rows = [['fb', 'public'], ['fb', 'dm'], ['ig', 'public'], ['ig', 'dm']].map(([platform, kind]) => {
    const channel = studioPgChannel(platform, kind);
    return `<li class="studio-pg-channel" data-testid="studio-pg-channel-${channel.channel}" data-state="${studioEsc(channel.state)}">${studioPgBadge(platform)}<span class="studio-pg-channel-name">${studioEsc(studioPgActionWord(kind))}</span>${studioPgChip(channel.label, studioPgStateTone(channel.state), channel.open ? 'circle-check' : (channel.state === 'gated' ? 'clock' : 'circle-off'))}</li>`;
  }).join('');
  return `
          <details class="studio-pg-card studio-pg-details" data-testid="studio-pg-channels">
            <summary>${studioPgIcon('radio', 'studio-pg-chip-icon')}<span>${studioEsc(studioPgText('What works today', 'ما الذي يعمل اليوم'))}</span>${studioPgIcon('chevron-down', 'studio-pg-chip-icon')}</summary>
            <p class="studio-pg-note">${studioEsc(studioPgText('Each channel shows its honest state. A rule can be saved for a channel that waits for Meta; it starts working the moment the channel does, with no change on your side.', 'تعرض كل قناة حالتها الحقيقية. يمكن حفظ قاعدة لقناة تنتظر ميتا؛ وتبدأ العمل لحظة تعمل القناة، دون أي تغيير من جهتك.'))}</p>
            <ul class="studio-pg-channels">${rows}</ul>
          </details>`;
}

function renderStudioPgRules() {
  const slot = studioPgSlot('rules');
  const settings = studioPgSlot('settings');
  studioPgWant('rules');
  studioPgWant('settings');
  studioPgWant('pages');
  const master = settings.value ? settings.value.masterEnabled : true;
  const masterBusy = _studioPg.busy.has('master') || !settings.value;
  let list = '';
  if (!slot.loadedAt && slot.error) list = renderStudioPgProblem(slot.error, 'studioPgRetry()');
  else if (!slot.loadedAt) list = renderStudioPgLoading(studioPgText('Reading your rules…', 'نقرأ قواعدك…'), 'studio-pg-loading');
  else if (!slot.value.rules.length) list = `<p class="studio-pg-empty" data-testid="studio-pg-rules-empty">${studioEsc(studioPgText('No rules yet. A rule answers comments for you: in public, by private message, or both.', 'لا توجد قواعد بعد. القاعدة تردّ على التعليقات نيابةً عنك: علناً أو برسالة خاصة أو كليهما.'))}</p>`;
  else list = `<ul class="studio-pg-list" data-testid="studio-pg-rules">${slot.value.rules.map(renderStudioPgRuleRow).join('')}</ul>`;
  const noPages = studioPgSlot('pages').loadedAt && !studioPgPages().length;
  return `
          <section class="studio-pg-card" data-testid="studio-pg-rules-card" aria-labelledby="studio-pg-rules-title">
            <div class="studio-pg-head">
              <h2 id="studio-pg-rules-title" class="studio-pg-h2">${studioEsc(studioPgText('Reply rules', 'قواعد الرد'))}</h2>
              <button type="button" class="studio-v2-action is-primary studio-pg-small" data-testid="studio-pg-rule-new" onclick="studioPgGo('rules', 'new')">${studioPgIcon('plus')}<span>${studioEsc(studioPgText('New rule', 'قاعدة جديدة'))}</span></button>
            </div>
            <div class="studio-pg-master" data-testid="studio-pg-master-row">
              <span class="studio-pg-master-text"><span class="studio-pg-master-title">${studioEsc(master ? studioPgText('Auto-reply is on', 'الرد التلقائي مفعّل') : studioPgText('Auto-reply is paused', 'الرد التلقائي متوقف'))}</span><span class="studio-pg-note">${studioEsc(master ? studioPgText('Your rules run on every new comment.', 'تعمل قواعدك على كل تعليق جديد.') : studioPgText('No reply is sent while it is paused.', 'لا يُرسل أي رد أثناء الإيقاف.'))}</span></span>
              ${studioPgSwitch(master, 'studioPgMaster()', studioPgText('Auto-reply master switch', 'مفتاح الرد التلقائي'), 'studio-pg-master', masterBusy)}
            </div>
            ${noPages ? `<p class="studio-pg-note" data-testid="studio-pg-rules-nopages">${studioEsc(studioPgText('Rules need a linked page. Ask us to link one from the Pages section first.', 'تحتاج القواعد إلى صفحة مربوطة. اطلب ربط صفحة من قسم الصفحات أولاً.'))}</p>` : ''}
            ${list}
          </section>
          ${renderStudioPgChannels()}`;
}

// ------------------------------------------------------------------ the rule editor

// A fresh rule: every action follows its channel's state, so a channel that is off or not
// available (fbPublicReply rules the like too) starts unticked and is never sent to be refused.
function studioPgNewRule(platform) {
  const kind = studioPgPlatform(platform) || 'fb';
  return {
    id: '', name: '', platform: kind, enabled: true, trigger: 'keywords', keywords: [], pageRefs: [], publicReply: '', dmEnabled: false, dmText: '',
    likeComment: kind === 'fb' && !studioPgChannel('fb', 'like').refused, oncePerPerson: true, skipPublicAfterDm: false, quietHours: false, scope: 'all',
    keywordInput: '', sending: false, error: '', problems: {}, dirty: false
  };
}

// The fields of a rule the editor copies (the draft's own bookkeeping aside).
function studioPgRuleDraftOf(rule) {
  return Object.assign(studioPgNewRule(rule.platform), JSON.parse(JSON.stringify(rule)), { keywordInput: '', sending: false, error: '', problems: {}, dirty: false, for: rule.id });
}

// The draft the editor at ?id= shows: a fresh one for 'new', a copy of the rule otherwise (null
// while that rule is not known yet). Opening an existing rule asks the server for the list again;
// until the owner types, the draft follows what that read brings (a rename or a switch from the
// list, another tab or device), so a save never carries stale fields.
function studioPgEditorFor(id) {
  studioPgScope();
  const draft = _studioPg.editor;
  if (draft && draft.for === id) {
    if (!draft.dirty && !draft.sending) {
      if (id === 'new') {
        // The channel states may land after the fresh draft was made: its like follows them until the owner types.
        draft.likeComment = draft.platform === 'fb' && !studioPgChannel('fb', 'like').refused;
        return draft;
      }
      const rule = studioPgRule(id);
      if (rule && JSON.stringify(studioPgRuleDraftOf(rule)) !== JSON.stringify(Object.assign({}, draft, { keywordInput: '', error: '', problems: {} }))) {
        _studioPg.editor = studioPgRuleDraftOf(rule);
        return _studioPg.editor;
      }
    }
    return draft;
  }
  if (id === 'new') {
    _studioPg.editor = Object.assign(studioPgNewRule('fb'), { for: 'new' });
    return _studioPg.editor;
  }
  const rule = studioPgRule(id);
  if (!rule) return null;
  _studioPg.editor = studioPgRuleDraftOf(rule);
  // The rule as the server knows it now (a list read older than a moment); the draft follows the answer until the owner types.
  if (Date.now() - studioPgSlot('rules').loadedAt > 2000) studioPgWant('rules', true);
  return _studioPg.editor;
}

function studioPgEditor() {
  return _studioPg.editor && !_studioPg.editor.sending ? _studioPg.editor : null;
}

function studioPgRuleTouched(draft) {
  draft.dirty = true;
}

function studioPgRuleSet(field, value) {
  const draft = studioPgEditor();
  if (!draft) return;
  if (field === 'name') draft.name = String(value || '').slice(0, STUDIO_PG_MAX.name);
  else if (field === 'publicReply') draft.publicReply = String(value || '').slice(0, STUDIO_PG_MAX.reply);
  else if (field === 'dmText') draft.dmText = String(value || '').slice(0, STUDIO_PG_MAX.reply);
  else if (field === 'keywordInput') draft.keywordInput = String(value || '').slice(0, 200);
  else return;
  if (field !== 'keywordInput') studioPgRuleTouched(draft);
  const key = field === 'publicReply' || field === 'dmText' ? 'reply' : field;
  if (draft.problems[key]) { delete draft.problems[key]; studioPgRedraw(); }
}

function studioPgRulePick(field, value) {
  const draft = studioPgEditor();
  if (!draft) return;
  const wanted = String(value || '');
  if (field === 'platform') {
    const platform = studioPgPlatform(wanted);
    if (!platform || platform === draft.platform) return;
    draft.platform = platform;
    draft.pageRefs = [];  // pages belong to one platform
    if (platform === 'ig') draft.likeComment = false;
  } else if (field === 'trigger') {
    if (wanted !== 'every' && wanted !== 'keywords') return;
    draft.trigger = wanted;
  } else return;
  studioPgRuleTouched(draft);
  delete draft.problems.keywords;
  studioPgRedraw();
}

// A switch whose channel is off or not available can only be turned OFF (the server refuses the
// action; the executor withholds it anyway), never on.
function studioPgRuleFlip(field) {
  const draft = studioPgEditor();
  if (!draft || !['dmEnabled', 'likeComment', 'oncePerPerson', 'skipPublicAfterDm', 'quietHours'].includes(field)) return;
  if ((field === 'dmEnabled' && !draft.dmEnabled && studioPgChannel(draft.platform, 'dm').refused)
    || (field === 'likeComment' && !draft.likeComment && (draft.platform !== 'fb' || studioPgChannel('fb', 'like').refused))) return;
  draft[field] = !draft[field];
  studioPgRuleTouched(draft);
  delete draft.problems.reply;
  studioPgRedraw();
}

// The live pages of the draft's platform among its refs: the only ones the editor can show or send
// (a ref whose page was removed is kept by the server while the list is left alone, P4-01).
function studioPgRuleLiveRefs(draft) {
  return draft.pageRefs.filter(id => { const page = studioPgPage(id); return !!page && page.platform === draft.platform; });
}

function studioPgRulePage(id) {
  const draft = studioPgEditor();
  const page = studioPgPage(id);
  if (!draft || !page || page.platform !== draft.platform) return;
  const set = new Set(draft.pageRefs);
  if (set.has(page.id)) set.delete(page.id);
  else if (set.size < STUDIO_PG_MAX.pages) set.add(page.id);
  draft.pageRefs = Array.from(set);
  studioPgRuleTouched(draft);
  studioPgRedraw();
}

function studioPgKeywordAdd() {
  const draft = studioPgEditor();
  if (!draft) return;
  const input = typeof document !== 'undefined' && document && typeof document.getElementById === 'function' ? document.getElementById('studio-rule-keyword') : null;
  const raw = String((input ? input.value : draft.keywordInput) || '');
  const parts = raw.split(/[,\n،]/).map(part => part.trim().toLowerCase().slice(0, STUDIO_PG_MAX.keyword)).filter(Boolean);
  if (!parts.length) return;
  draft.keywords = Array.from(new Set(draft.keywords.concat(parts))).slice(0, STUDIO_PG_MAX.keywords);
  draft.keywordInput = '';
  studioPgRuleTouched(draft);
  delete draft.problems.keywords;
  studioPgRedraw();
}

function studioPgKeywordRemove(index) {
  const draft = studioPgEditor();
  const at = Number(index);
  if (!draft || !Number.isInteger(at) || at < 0 || at >= draft.keywords.length) return;
  draft.keywords.splice(at, 1);
  studioPgRuleTouched(draft);
  studioPgRedraw();
}

function studioPgKeywordKey(event) {
  if (event && (event.key === 'Enter' || event.key === ',')) {
    event.preventDefault();
    studioPgKeywordAdd();
  }
}

function studioPgRuleValidate(draft) {
  const problems = {};
  if (draft.name.trim().length < 1) problems.name = studioPgText('Give the rule a name.', 'أعطِ القاعدة اسماً.');
  if (draft.trigger === 'keywords' && !draft.keywords.length) problems.keywords = studioPgText('Add at least one keyword, or answer every comment.', 'أضف كلمة مفتاحية واحدة على الأقل، أو اختر «كل تعليق».');
  const publicOn = !!draft.publicReply.trim();
  const dmOn = draft.dmEnabled && !!draft.dmText.trim();
  if (!publicOn && !dmOn) problems.reply = studioPgText('Write a public reply or a private message.', 'اكتب رداً عاماً أو رسالة خاصة.');
  if (publicOn && studioPgChannel(draft.platform, 'public').refused) problems.reply = `${studioPgActionWord('public')}: ${studioPgChannel(draft.platform, 'public').label}`;
  if (dmOn && studioPgChannel(draft.platform, 'dm').refused) problems.reply = `${studioPgActionWord('dm')}: ${studioPgChannel(draft.platform, 'dm').label}`;
  return problems;
}

// The body of POST /rules and PATCH /rules/{id}. `enabled` is never in it: the list switch owns it
// (the server keeps the stored value when the body omits it; a new rule starts on), so a draft can
// never switch a rule back on. `pageRefs` names only live pages of the draft's platform, the only
// ones the editor can tick: an edit that left the list alone omits it (the server keeps its stored
// list, a removed page included, P4-01), a touched list replaces it. A like whose channel is off
// or not available is sent as false (the executor withholds it anyway), never to be refused.
function studioPgRuleBody(draft) {
  const body = {
    name: draft.name.trim(), platform: draft.platform,
    trigger: draft.trigger, keywords: draft.trigger === 'keywords' ? draft.keywords : [], pageRefs: studioPgRuleLiveRefs(draft),
    publicReply: draft.publicReply.trim(), dmEnabled: draft.dmEnabled && !!draft.dmText.trim(), dmText: draft.dmEnabled ? draft.dmText.trim() : '',
    likeComment: draft.platform === 'fb' && !!draft.likeComment && !studioPgChannel('fb', 'like').refused,
    oncePerPerson: !!draft.oncePerPerson, skipPublicAfterDm: !!draft.skipPublicAfterDm, quietHours: !!draft.quietHours
  };
  const stored = draft.id ? studioPgRule(draft.id) : null;
  const untouched = !!stored && stored.pageRefs.length === draft.pageRefs.length && stored.pageRefs.every((id, i) => draft.pageRefs[i] === id);
  if (untouched) delete body.pageRefs;
  return body;
}

function studioPgRuleSave() {
  const draft = _studioPg.editor;
  if (!draft || draft.sending || _studioPg.busy.has('save')) return null;
  const problems = studioPgRuleValidate(draft);
  if (Object.keys(problems).length) {
    draft.problems = problems;
    draft.error = '';
    studioPgRedraw();
    return null;
  }
  if (!studioPgServer()) {
    draft.error = studioPgText('Saving needs the connection to Albayan.', 'الحفظ يحتاج الاتصال بالبيان.');
    studioPgRedraw();
    return null;
  }
  draft.sending = true;
  draft.error = '';
  draft.problems = {};
  _studioPg.busy.set('save', true);
  studioPgRedraw();
  const generation = _studioPg.generation;
  const body = studioPgRuleBody(draft);
  const call = draft.id
    ? studioApi(`/api/social-studio/rules/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body })
    : studioApi('/api/social-studio/rules', { method: 'POST', body });
  return call.then(raw => {
    if (generation !== _studioPg.generation) return null;
    const saved = studioPgCleanRule(raw);
    const rules = studioPgSlot('rules');
    if (saved && rules.value) {
      const at = rules.value.rules.findIndex(rule => rule.id === saved.id);
      if (at >= 0) rules.value.rules[at] = saved; else rules.value.rules.push(saved);
    }
    _studioPg.editor = null;
    studioPgNotify(true, studioPgText('Rule saved', 'حُفظت القاعدة'), body.name);
    studioPgWant('rules', true);
    studioPgGo('rules');
    return saved;
  }, error => {
    if (generation !== _studioPg.generation) return null;
    draft.sending = false;
    draft.error = studioPgErrorText(error, 'action');
    // The owner left the editor while the save was on its way: the refusal is not left unseen.
    if (!studioPgEditorOnScreen(draft)) studioPgNotify(false, studioPgText('The rule was not saved', 'لم تُحفظ القاعدة'), draft.error);
    studioPgRedraw();
    return null;
  }).finally(() => {
    if (generation !== _studioPg.generation) return;
    _studioPg.busy.delete('save');
  });
}

// True while the editor of this draft is the screen on show (the v2 address, or the classic tab's own state).
function studioPgEditorOnScreen(draft) {
  if (typeof state === 'undefined' || !state || state.currentView !== 'ads-studio') return false;
  if (studioPgInV2()) {
    const route = typeof studioV2Route === 'function' && typeof studioV2ReadAddress === 'function' ? studioV2Route(studioV2ReadAddress(), 'customer') : null;
    return !!route && route.tab === 'replies' && String(route.section || '') === 'rules' && String(route.id || '') === String(draft.for || '');
  }
  return typeof _adsStudioActiveTab !== 'undefined' && _adsStudioActiveTab === 'replies' && _studioPg.classic.section === 'rules' && _studioPg.classic.id === String(draft.for || '');
}

function studioPgRuleDelete(button = null) {
  const draft = studioPgEditor();
  if (!draft || !draft.id) return false;
  const sheet = `
      <div class="studio-pg-sheet" role="alertdialog" aria-modal="true" aria-labelledby="studio-pg-sheet-title" data-testid="studio-pg-delete-sheet">
        <h2 id="studio-pg-sheet-title" class="studio-pg-sheet-title">${studioEsc(studioPgText('Delete this rule?', 'حذف هذه القاعدة؟'))}</h2>
        <p class="studio-pg-note" dir="auto">${studioEsc(draft.name)}</p>
        <p class="studio-pg-sheet-text">${studioEsc(studioPgText('It stops answering comments at once. Replies already sent stay in the log.', 'تتوقف عن الرد على التعليقات فوراً. الردود المرسلة تبقى في السجل.'))}</p>
        <div class="studio-pg-sheet-actions">
          <button type="button" class="studio-v2-action studio-pg-danger" data-testid="studio-sheet-confirm" onclick="studioPgDeleteConfirm()">${studioEsc(studioPgText('Delete', 'احذف'))}</button>
          <button type="button" class="studio-v2-action" data-testid="studio-sheet-cancel" data-sheet-focus="1" onclick="studioPgCloseSheet()">${studioEsc(studioPgText('Keep it', 'أبقِها'))}</button>
        </div>
      </div>`;
  return studioPgOpenSheet(sheet, 'studio-pg-delete', button);
}

function studioPgDeleteConfirm() {
  const draft = _studioPg.editor;
  if (!draft || !draft.id || draft.sending || _studioPg.busy.has('delete') || !studioPgServer()) return null;
  const id = draft.id;
  _studioPg.busy.set('delete', true);
  draft.sending = true;
  studioPgCloseSheet();
  studioPgRedraw();
  const generation = _studioPg.generation;
  return studioApi(`/api/social-studio/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => {
    if (generation !== _studioPg.generation) return null;
    const rules = studioPgSlot('rules');
    if (rules.value) rules.value.rules = rules.value.rules.filter(rule => rule.id !== id);
    _studioPg.editor = null;
    studioPgNotify(true, studioPgText('Rule deleted', 'حُذفت القاعدة'), '');
    studioPgWant('rules', true);
    studioPgGo('rules');
    return true;
  }, error => {
    if (generation !== _studioPg.generation) return null;
    draft.sending = false;
    draft.error = studioPgErrorText(error, 'action');
    studioPgRedraw();
    return null;
  }).finally(() => {
    if (generation !== _studioPg.generation) return;
    _studioPg.busy.delete('delete');
  });
}

function renderStudioPgEditor(id) {
  studioPgWant('rules');
  studioPgWant('pages');
  studioPgWant('settings');
  const draft = studioPgEditorFor(id);
  const back = `<button type="button" class="studio-pg-link" data-testid="studio-pg-rule-back" onclick="studioPgGo('rules')">${studioPgIcon(adsStudioIsAr() ? 'arrow-right' : 'arrow-left', 'studio-pg-chip-icon')}<span>${studioEsc(studioPgText('All rules', 'كل القواعد'))}</span></button>`;
  if (!draft) {
    const slot = studioPgSlot('rules');
    const inner = slot.loadedAt
      ? `<p class="studio-pg-empty" data-testid="studio-pg-rule-missing">${studioEsc(studioPgText('This rule was not found. It may have been deleted.', 'لم نجد هذه القاعدة. ربما حُذفت.'))}</p>`
      : (slot.error ? renderStudioPgProblem(slot.error, 'studioPgRetry()') : renderStudioPgLoading(studioPgText('Reading the rule…', 'نقرأ القاعدة…'), 'studio-pg-loading'));
    return `<section class="studio-pg-card" data-testid="studio-pg-rule-form">${back}${inner}</section>`;
  }
  const off = draft.sending ? ' disabled' : '';
  const isIg = draft.platform === 'ig';
  const chip = (testId, label, on, onclick) => `<button type="button" class="studio-pg-choice" data-testid="${testId}" aria-pressed="${on ? 'true' : 'false'}" onclick="${onclick}"${off}>${studioEsc(label)}</button>`;
  const pages = studioPgPages().filter(page => page.platform === draft.platform);
  const liveRefs = studioPgRuleLiveRefs(draft);
  const stored = draft.id ? studioPgRule(draft.id) : null;
  // A ref whose page was removed (the server's label on the list) is invisible here: it stays on the
  // rule while the pages are left alone and is dropped the moment the owner chooses the pages again.
  const removedRef = !!stored && draft.pageRefs.some(id => !studioPgPage(id)) && stored.pages.some(page => page.removed);
  const removedNote = removedRef ? `<p class="studio-pg-note" data-testid="studio-pg-rule-page-removed">${studioEsc(studioPgText('A page of this rule was removed. It stays on the rule until you choose the pages again; the rule can still be saved or switched off.', 'أُزيلت إحدى صفحات هذه القاعدة. تبقى على القاعدة حتى تختار الصفحات من جديد؛ ويمكن حفظ القاعدة أو إيقافها.'))}</p>` : '';
  const pageChips = pages.length
    ? `<div class="studio-pg-chips" role="group" aria-labelledby="studio-pg-rule-label-pages">${pages.map(page => chip(`studio-pg-rule-page-${page.id}`, page.name, draft.pageRefs.includes(page.id), `studioPgRulePage('${studioEsc(page.id)}')`)).join('')}</div>
              <p class="studio-pg-note">${studioEsc(liveRefs.length ? studioPgText('The rule answers on the chosen pages only.', 'تردّ القاعدة على الصفحات المختارة فقط.') : studioPgText('Nothing chosen: the rule answers on all your linked pages of this platform.', 'لم تختر شيئاً: تردّ القاعدة على كل صفحاتك المربوطة على هذه المنصة.'))}</p>${removedNote}`
    : `<p class="studio-pg-note" data-testid="studio-pg-rule-nopages">${studioEsc(studioPgText('No linked page on this platform yet. The rule is saved and starts once a page is linked.', 'لا توجد صفحة مربوطة على هذه المنصة بعد. تُحفظ القاعدة وتبدأ بعد ربط صفحة.'))}</p>${removedNote}`;
  const keywords = draft.trigger === 'keywords' ? `
              <div class="studio-pg-chips is-tight">${draft.keywords.map((keyword, index) => `<span class="studio-pg-chip" data-tone="slate"><span dir="auto">${studioEsc(keyword)}</span><button type="button" class="studio-pg-chip-remove" data-testid="studio-pg-rule-keyword-remove-${index}" onclick="studioPgKeywordRemove(${index})" aria-label="${studioEsc(studioPgText('Remove keyword', 'إزالة الكلمة'))}"${off}>${studioPgIcon('x', 'studio-pg-chip-icon')}</button></span>`).join('')}</div>
              <div class="studio-pg-row">
                <input id="studio-rule-keyword" class="studio-pg-input" type="text" maxlength="${STUDIO_PG_MAX.keyword}" value="${studioEsc(draft.keywordInput)}" oninput="studioPgRuleSet('keywordInput', this.value)" onkeydown="studioPgKeywordKey(event)" placeholder="${studioEsc(studioPgText('price, how much, السعر', 'السعر، بكم، price'))}" aria-label="${studioEsc(studioPgText('Keyword', 'كلمة مفتاحية'))}"${off} />
                <button type="button" class="studio-v2-action studio-pg-small" data-testid="studio-pg-rule-keyword-add" onclick="studioPgKeywordAdd()"${off}>${studioPgIcon('plus')}<span>${studioEsc(studioPgText('Add', 'إضافة'))}</span></button>
              </div>
              <p class="studio-pg-note">${studioEsc(studioPgText(`Up to ${STUDIO_PG_MAX.keywords} keywords. Matching ignores case and Arabic diacritics.`, `حتى ${STUDIO_PG_MAX.keywords} كلمة. المطابقة تتجاهل حالة الأحرف والتشكيل.`))}</p>` : '';
  const channelLine = (kind) => {
    const channel = studioPgChannel(draft.platform, kind);
    return studioPgChip(channel.label, studioPgStateTone(channel.state), channel.open ? 'circle-check' : (channel.state === 'gated' ? 'clock' : 'circle-off'), `studio-pg-rule-channel-${kind}`, ` data-state="${studioEsc(channel.state)}"`);
  };
  const dm = studioPgChannel(draft.platform, 'dm');
  const like = studioPgChannel('fb', 'like');
  const pub = studioPgChannel(draft.platform, 'public');
  // A refused channel blocks turning an action ON; what is already on can always be cleared or
  // switched off (else a rule saved before the channel closed could never be saved again).
  const publicLocked = pub.refused && !draft.publicReply.trim();
  const publicWhy = pub.refused ? `<p class="studio-pg-note">${studioEsc(draft.publicReply.trim()
    ? studioPgText('Public replies are not available on this platform right now: clear this text to save the rule, or keep it and switch the rule off from the list.', 'الردود العامة غير متاحة على هذه المنصة حالياً: امسح هذا النص لحفظ القاعدة، أو أبقِه وأوقف القاعدة من القائمة.')
    : studioPgText('Public replies cannot be picked on this platform right now.', 'لا يمكن اختيار الردود العامة على هذه المنصة حالياً.'))}</p>` : '';
  const dmWhy = dm.refused ? `<p class="studio-pg-note" data-testid="studio-pg-rule-dm-why">${studioEsc(studioPgText('Private messages cannot be picked on this platform right now: ', 'لا يمكن اختيار الرسائل الخاصة على هذه المنصة حالياً: '))}${studioEsc(dm.label)}</p>`
    : (dm.state === 'gated' ? `<p class="studio-pg-note" data-testid="studio-pg-rule-dm-why">${studioEsc(studioPgText('Saved now, sent once Meta approves private messages.', 'تُحفظ الآن وتُرسل بعد موافقة ميتا على الرسائل الخاصة.'))}</p>` : '');
  const behaviour = (field, label, testId, disabled, hint = '') => `
              <div class="studio-pg-behaviour${disabled ? ' is-off' : ''}">
                <span class="studio-pg-master-text"><span class="studio-pg-behaviour-title">${studioEsc(label)}</span>${hint ? `<span class="studio-pg-note">${studioEsc(hint)}</span>` : ''}</span>
                ${studioPgSwitch(!!draft[field], `studioPgRuleFlip('${field}')`, label, testId, disabled || draft.sending)}
              </div>`;
  const settings = studioPgSlot('settings').value;
  const quiet = settings ? `${settings.quietFrom}–${settings.quietTo}` : '22:00–08:00';
  const problem = key => (draft.problems[key] ? `<p class="studio-pg-error" data-testid="studio-pg-rule-problem-${key}">${studioEsc(draft.problems[key])}</p>` : '');
  return `
          <form class="studio-pg-card studio-pg-form" data-testid="studio-pg-rule-form" data-rule="${studioEsc(draft.id || 'new')}" onsubmit="event.preventDefault(); studioPgRuleSave();">
            ${back}
            <h2 class="studio-pg-h2">${studioEsc(draft.id ? studioPgText('Edit rule', 'تعديل القاعدة') : studioPgText('New rule', 'قاعدة جديدة'))}</h2>
            <div class="studio-pg-field${draft.problems.name ? ' is-invalid' : ''}">
              <label class="studio-pg-label" for="studio-rule-name">${studioEsc(studioPgText('Rule name', 'اسم القاعدة'))}</label>
              <input id="studio-rule-name" class="studio-pg-input" type="text" maxlength="${STUDIO_PG_MAX.name}" value="${studioEsc(draft.name)}" oninput="studioPgRuleSet('name', this.value)" placeholder="${studioEsc(studioPgText('e.g. Price questions', 'مثال: أسئلة الأسعار'))}"${off} />
              ${problem('name')}
            </div>
            <div class="studio-pg-field">
              <p class="studio-pg-label" id="studio-pg-rule-label-platform">${studioEsc(studioPgText('Where: platform', 'أين: المنصة'))}</p>
              <div class="studio-pg-chips" role="group" aria-labelledby="studio-pg-rule-label-platform">${chip('studio-pg-rule-platform-fb', 'Facebook', !isIg, "studioPgRulePick('platform', 'fb')")}${chip('studio-pg-rule-platform-ig', 'Instagram', isIg, "studioPgRulePick('platform', 'ig')")}</div>
            </div>
            <div class="studio-pg-field">
              <p class="studio-pg-label" id="studio-pg-rule-label-pages">${studioEsc(studioPgText('Where: pages', 'أين: الصفحات'))}</p>
              ${pageChips}
            </div>
            <div class="studio-pg-field${draft.problems.keywords ? ' is-invalid' : ''}">
              <p class="studio-pg-label" id="studio-pg-rule-label-trigger">${studioEsc(studioPgText('When', 'متى'))}</p>
              <div class="studio-pg-chips" role="group" aria-labelledby="studio-pg-rule-label-trigger">${chip('studio-pg-rule-trigger-every', studioPgText('Every comment', 'كل تعليق'), draft.trigger === 'every', "studioPgRulePick('trigger', 'every')")}${chip('studio-pg-rule-trigger-keywords', studioPgText('Comments with keywords', 'تعليقات تحوي كلمات مفتاحية'), draft.trigger === 'keywords', "studioPgRulePick('trigger', 'keywords')")}</div>
              ${keywords}
              ${problem('keywords')}
            </div>
            <div class="studio-pg-field${draft.problems.reply ? ' is-invalid' : ''}">
              <div class="studio-pg-head"><label class="studio-pg-label" for="studio-rule-public">${studioEsc(studioPgText('Reply: public reply', 'الرد: رد عام'))}</label>${channelLine('public')}</div>
              <textarea id="studio-rule-public" class="studio-pg-input" rows="3" maxlength="${STUDIO_PG_MAX.reply}" oninput="studioPgRuleSet('publicReply', this.value)" placeholder="${studioEsc(studioPgText('What everyone sees under the comment', 'ما يراه الجميع تحت التعليق'))}"${off || (publicLocked ? ' disabled' : '')}>${studioEsc(draft.publicReply)}</textarea>
              ${publicWhy}
              <div class="studio-pg-behaviour${dm.refused ? ' is-off' : ''}">
                <span class="studio-pg-master-text"><span class="studio-pg-behaviour-title">${studioEsc(studioPgText('Reply: private message', 'الرد: رسالة خاصة'))}</span>${channelLine('dm')}</span>
                ${studioPgSwitch(draft.dmEnabled, "studioPgRuleFlip('dmEnabled')", studioPgText('Private message', 'رسالة خاصة'), 'studio-pg-rule-dm', (dm.refused && !draft.dmEnabled) || draft.sending)}
              </div>
              ${dmWhy}
              ${draft.dmEnabled ? `<textarea id="studio-rule-dm" class="studio-pg-input" rows="3" maxlength="${STUDIO_PG_MAX.reply}" oninput="studioPgRuleSet('dmText', this.value)" placeholder="${studioEsc(studioPgText('What only the commenter receives', 'ما يستلمه صاحب التعليق فقط'))}" aria-label="${studioEsc(studioPgText('Private message', 'رسالة خاصة'))}"${off}>${studioEsc(draft.dmText)}</textarea>` : ''}
              ${problem('reply')}
            </div>
            <div class="studio-pg-field">
              <p class="studio-pg-label">${studioEsc(studioPgText('Also', 'وأيضاً'))}</p>
              ${isIg ? `<p class="studio-pg-note" data-testid="studio-pg-rule-like-why">${studioEsc(studioPgText('Liking a comment is a Facebook feature; Instagram rules reply only.', 'الإعجاب بالتعليق ميزة في فيسبوك؛ قواعد إنستغرام تردّ فقط.'))}</p>` : behaviour('likeComment', studioPgText('Like the comment', 'الإعجاب بالتعليق'), 'studio-pg-rule-like', like.refused && !draft.likeComment, like.open ? '' : (like.refused && draft.likeComment ? studioPgText(`${like.label}: it is not sent; switch it off or leave it.`, `${like.label}: لا يُرسل؛ أوقفه أو اتركه.`) : like.label))}
              ${behaviour('oncePerPerson', studioPgText('One reply per person', 'رد واحد لكل شخص'), 'studio-pg-rule-once', false)}
              ${behaviour('skipPublicAfterDm', studioPgText('Skip the public reply once a private message is sent', 'تجاوز الرد العام بعد إرسال رسالة خاصة'), 'studio-pg-rule-skip', false)}
              ${behaviour('quietHours', studioPgText(`Stay silent during quiet hours (${quiet}, Libya time)`, `التزم الصمت في ساعات الهدوء (${quiet} بتوقيت ليبيا)`), 'studio-pg-rule-quiet', false)}
              ${draft.scope === 'chosen' ? `<p class="studio-pg-note">${studioEsc(studioPgText('This rule applies to chosen posts only (set in the classic studio); that choice is kept.', 'تنطبق هذه القاعدة على منشورات محددة فقط (ضُبطت في الاستوديو الكلاسيكي)؛ ويبقى ذلك الاختيار.'))}</p>` : ''}
            </div>
            ${draft.error ? `<p class="studio-pg-error" role="alert" data-testid="studio-pg-rule-error">${studioEsc(draft.error)}</p>` : ''}
            <div class="studio-pg-actions">
              ${draft.id ? `<button type="button" class="studio-v2-action studio-pg-danger" data-testid="studio-pg-rule-delete" onclick="studioPgRuleDelete(this)"${off}>${studioPgIcon('trash-2')}<span>${studioEsc(studioPgText('Delete rule', 'حذف القاعدة'))}</span></button>` : `<button type="button" class="studio-v2-action" data-testid="studio-pg-rule-cancel" onclick="studioPgGo('rules')"${off}>${studioEsc(studioPgText('Cancel', 'إلغاء'))}</button>`}
              <button type="submit" class="studio-v2-action is-primary" data-testid="studio-pg-rule-save"${draft.sending ? ' disabled aria-busy="true"' : ''}>${studioPgIcon('save')}<span>${studioEsc(draft.sending ? studioPgText('Saving…', 'جارٍ الحفظ…') : studioPgText('Save rule', 'حفظ القاعدة'))}</span></button>
            </div>
          </form>`;
}

// ------------------------------------------------------------------ Reply log (P4-02 consumer)

function studioPgLogState() {
  studioPgScope();
  if (!_studioPg.log) _studioPg.log = { filter: '', rows: [], next: null, counters: null, labels: null, loadedAt: 0, failedAt: 0, error: null, loading: null, more: false };
  return _studioPg.log;
}

function studioPgCleanLogRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!STUDIO_PG_ID_RE.test(id)) return null;
  const actions = (Array.isArray(raw.actions) ? raw.actions : []).map(String).filter(kind => Object.prototype.hasOwnProperty.call(STUDIO_PG_ACTIONS, kind));
  const skipped = (Array.isArray(raw.skipped) ? raw.skipped : []).filter(item => item && typeof item === 'object')
    .map(item => ({ action: Object.prototype.hasOwnProperty.call(STUDIO_PG_ACTIONS, item.action) ? String(item.action) : '', state: STUDIO_PG_STATES.includes(item.state) ? String(item.state) : 'unavailable' })).filter(item => item.action);
  return {
    id, at: studioPgTime(raw.at), platform: studioPgPlatform(raw.platform) || 'fb', pageName: studioPgClean(raw.pageName, 160), ruleName: studioPgClean(raw.ruleName, 80),
    actions, skipped, outcome: STUDIO_PG_OUTCOMES.includes(raw.outcome) ? raw.outcome : 'none', problemCode: /^[a-z_]{1,60}$/.test(String(raw.problemCode || '')) ? String(raw.problemCode) : '',
    error: studioPgClean(raw.error, 200), source: /^[a-z_]{1,20}$/.test(String(raw.source || '')) ? String(raw.source) : 'webhook',
    latencySeconds: Number.isSafeInteger(raw.latencySeconds) && raw.latencySeconds >= 0 ? raw.latencySeconds : null, retryAfter: studioPgTime(raw.retryAfter)
  };
}

function studioPgCleanLog(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rows)) return null;
  const counters = raw.counters && typeof raw.counters === 'object' ? raw.counters : {};
  const count = (group, key) => (group && typeof group === 'object' && Number.isSafeInteger(group[key]) && group[key] >= 0 ? group[key] : 0);
  const labels = raw.labels && typeof raw.labels === 'object' ? raw.labels : {};
  const pick = (group, keys) => Object.fromEntries(keys.map(key => [key, studioPgPair(group && group[key], 120)]).filter(([, pair]) => pair));
  return {
    rows: raw.rows.map(studioPgCleanLogRow).filter(Boolean),
    next: /^\d{1,15}:[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(raw.nextBefore || '')) ? String(raw.nextBefore) : null,
    counters: {
      total: Number.isSafeInteger(counters.total) && counters.total >= 0 ? counters.total : 0,
      byAction: Object.fromEntries(Object.keys(STUDIO_PG_ACTIONS).map(kind => [kind, count(counters.byAction, kind)])),
      byOutcome: Object.fromEntries(STUDIO_PG_OUTCOMES.map(kind => [kind, count(counters.byOutcome, kind)]))
    },
    labels: { outcome: pick(labels.outcome, STUDIO_PG_OUTCOMES), channelState: pick(labels.channelState, STUDIO_PG_STATES), pageRemoved: studioPgPair(labels.pageRemoved, 80) },
    windowDays: Number.isSafeInteger(raw.windowDays) && raw.windowDays > 0 ? raw.windowDays : STUDIO_PG_LOG_DAYS
  };
}

// Reads the log (the current filter); more = the next page after the last row shown.
function studioPgWantLog(force = false, more = false) {
  if (!studioPgScope() || !studioPgServer()) return null;
  const log = studioPgLogState();
  if (log.loading) return log.loading;
  const now = Date.now();
  if (more && !log.next) return null;
  if (!force && !more && ((log.failedAt && now - log.failedAt < STUDIO_PG_RETRY_MS) || (log.loadedAt && now - log.loadedAt < STUDIO_PG_FRESH_MS))) return null;
  const filter = _studioPg.logFilter;
  const params = new URLSearchParams();
  params.set('days', String(STUDIO_PG_LOG_DAYS));
  params.set('limit', String(STUDIO_PG_LOG_LIMIT));
  if (filter) params.set('status', filter);
  if (more) params.set('before', log.next);
  const generation = _studioPg.generation;
  const signal = studioReadSignal();
  log.more = more;
  const promise = studioApi(`/api/social-studio/log?${params.toString()}`, { method: 'GET' }).then(raw => {
    if (generation !== _studioPg.generation || filter !== _studioPg.logFilter) return;
    const clean = studioPgCleanLog(raw);
    if (!clean) {
      log.failedAt = Date.now();
      log.error = { code: 'UNKNOWN', text: studioPgText('The log could not be loaded. Try again in a moment.', 'تعذّر تحميل السجل. أعد المحاولة بعد لحظات.') };
      return;
    }
    const known = new Set(more ? log.rows.map(row => row.id) : []);
    log.rows = (more ? log.rows : []).concat(clean.rows.filter(row => !known.has(row.id)));
    log.next = clean.next;
    log.counters = clean.counters;
    log.labels = clean.labels;
    log.windowDays = clean.windowDays;
    log.filter = filter;
    log.loadedAt = now;
    log.failedAt = 0;
    log.error = null;
  }, error => {
    if (generation !== _studioPg.generation) return;
    if (studioReadCancelled(error, signal)) return;
    log.failedAt = Date.now();
    log.error = (error && error.studio) || studioErrorInfo(error, 'read');
  }).finally(() => {
    if (generation !== _studioPg.generation) return;
    log.loading = null;
    log.more = false;
    studioPgRedraw();
  });
  log.loading = promise;
  return promise;
}

function studioPgLogFilter(filter) {
  const wanted = String(filter || '');
  if (!STUDIO_PG_LOG_FILTERS.includes(wanted) || wanted === _studioPg.logFilter) return;
  _studioPg.logFilter = wanted;
  const log = studioPgLogState();
  log.rows = [];
  log.next = null;
  log.loadedAt = 0;
  log.failedAt = 0;
  log.error = null;
  studioPgWantLog(true);
  studioPgRedraw();
}

function studioPgLogMore() {
  studioPgWantLog(false, true);
  studioPgRedraw();
}

function studioPgOutcomeLabel(outcome, labels) {
  const pair = STUDIO_PG_OUTCOME_LABELS[outcome] || STUDIO_PG_OUTCOME_LABELS.none;
  return studioPickText(labels && labels.outcome ? labels.outcome[outcome] : null, 120) || studioPgText(pair[0], pair[1]);
}

function renderStudioPgLogRow(row, labels) {
  const outcome = studioPgOutcomeLabel(row.outcome, labels);
  const actions = row.actions.map(kind => studioPgChip(studioPgActionWord(kind), 'ok', 'check')).join('');
  const skipped = row.skipped.map(item => {
    const stateLabel = studioPickText(labels && labels.channelState ? labels.channelState[item.state] : null, 120) || studioPgText(STUDIO_PG_STATE_LABELS[item.state][0], STUDIO_PG_STATE_LABELS[item.state][1]);
    return studioPgChip(`${studioPgActionWord(item.action)} — ${stateLabel}`, studioPgStateTone(item.state), 'circle-off');
  }).join('');
  let problem = '';
  if (row.problemCode === 'missed_during_outage') problem = studioPgText('The Meta connection was down too long, so this reply could not be sent in time.', 'انقطع ربط ميتا مدة طويلة، لذلك تعذر إرسال هذا الرد في وقته.');
  else if (row.outcome === 'parked') problem = studioPgText('Kept until the Meta connection is back; it is sent then.', 'محفوظ حتى تعود ميتا؛ يُرسل بعدها.');
  else if (row.outcome === 'waiting') problem = row.retryAfter ? studioPgText(`Meta refused for now; we try again after ${studioPgWhen(row.retryAfter)}.`, `رفضت ميتا مؤقتاً؛ نعيد المحاولة بعد ${studioPgWhen(row.retryAfter)}.`) : studioPgText('Meta refused for now; we try again automatically.', 'رفضت ميتا مؤقتاً؛ نعيد المحاولة تلقائياً.');
  else if ((row.outcome === 'failed' || row.outcome === 'partial') && row.error) problem = studioPgText('Meta refused this reply. If the page needs attention, the Pages section says what to do.', 'رفضت ميتا هذا الرد. إن كانت الصفحة تحتاج انتباهاً، فقسم الصفحات يقول ما العمل.');
  const latency = row.latencySeconds !== null && row.outcome === 'sent'
    ? `<span data-testid="studio-pg-log-latency">${studioEsc(row.latencySeconds < 60 ? studioPgText(`replied in ${row.latencySeconds} s`, `رُدّ خلال ${row.latencySeconds} ث`) : studioPgText(`replied in ${Math.round(row.latencySeconds / 60)} min`, `رُدّ خلال ${Math.round(row.latencySeconds / 60)} د`))}</span>` : '';
  return `
            <li class="studio-pg-log-row" data-testid="studio-pg-log-${studioEsc(row.id)}" data-outcome="${studioEsc(row.outcome)}">
              <div class="studio-pg-page-head">${studioPgBadge(row.platform)}<span class="studio-pg-page-name" dir="auto">${studioEsc(row.pageName || studioPickText(labels && labels.pageRemoved, 80) || studioPgText('Page removed', 'الصفحة أُزيلت'))}</span>${studioPgChip(outcome, STUDIO_PG_OUTCOME_TONE[row.outcome] || 'slate', row.outcome === 'sent' ? 'check' : (row.outcome === 'failed' || row.outcome === 'missed' ? 'triangle-alert' : 'clock'), 'studio-pg-log-outcome')}</div>
              <p class="studio-pg-meta"><span>${studioEsc(row.at ? studioPgWhen(row.at) : '')}</span>${row.ruleName ? `<span dir="auto">${studioEsc(studioPgText(`Rule: ${row.ruleName}`, `القاعدة: ${row.ruleName}`))}</span>` : ''}${latency}</p>
              ${actions || skipped ? `<div class="studio-pg-chips is-tight">${actions}${skipped}</div>` : ''}
              ${problem ? `<p class="studio-pg-note" data-testid="studio-pg-log-problem">${studioEsc(problem)}</p>` : ''}
            </li>`;
}

function renderStudioPgLog() {
  const log = studioPgLogState();
  studioPgWantLog();
  const labels = log.labels;
  const chips = STUDIO_PG_LOG_FILTERS.map(key => `<button type="button" class="studio-pg-choice" data-testid="studio-pg-log-filter-${key || 'all'}" aria-pressed="${key === _studioPg.logFilter ? 'true' : 'false'}" onclick="studioPgLogFilter('${key}')">${studioEsc(key ? studioPgOutcomeLabel(key, labels) : studioPgText('All', 'الكل'))}</button>`).join('');
  const counters = log.counters;
  const tiles = counters ? [
    [counters.total, studioPgText('comments handled', 'تعليقات عولجت')],
    [counters.byOutcome.sent + counters.byOutcome.partial, studioPgText('replies sent', 'ردود أُرسلت')],
    [counters.byAction.dm, studioPgText('private messages', 'رسائل خاصة')],
    [counters.byOutcome.failed + counters.byOutcome.missed, studioPgText('not sent', 'لم تُرسل')]
  ].map(([value, label]) => `<div class="studio-pg-tile"><span class="studio-pg-tile-value">${Number(value) || 0}</span><span class="studio-pg-note">${studioEsc(label)}</span></div>`).join('') : '';
  let list = '';
  if (!log.loadedAt && log.error) list = renderStudioPgProblem(log.error, 'studioPgRetry()');
  else if (!log.loadedAt) list = renderStudioPgLoading(studioPgText('Reading the log…', 'نقرأ السجل…'), 'studio-pg-loading');
  else if (!log.rows.length) list = `<p class="studio-pg-empty" data-testid="studio-pg-log-empty">${studioEsc(_studioPg.logFilter ? studioPgText('No replies with this outcome in the last 30 days.', 'لا توجد ردود بهذه النتيجة في آخر 30 يوماً.') : studioPgText('No comments handled yet. Every comment your rules answer appears here with what happened.', 'لم تُعالج تعليقات بعد. كل تعليق تردّ عليه قواعدك يظهر هنا مع ما حدث.'))}</p>`;
  else list = `<ul class="studio-pg-list" data-testid="studio-pg-log">${log.rows.map(row => renderStudioPgLogRow(row, labels)).join('')}</ul>${log.next ? `<button type="button" class="studio-v2-action studio-pg-small" data-testid="studio-pg-log-more" onclick="studioPgLogMore()"${log.loading ? ' disabled' : ''}>${studioEsc(studioPgText('Show older', 'اعرض الأقدم'))}</button>` : ''}`;
  return `
          <section class="studio-pg-card" data-testid="studio-pg-log-card" aria-labelledby="studio-pg-log-title">
            <div class="studio-pg-head">
              <h2 id="studio-pg-log-title" class="studio-pg-h2">${studioEsc(studioPgText('Reply log', 'سجل الردود'))}</h2>
              <button type="button" class="studio-pg-link" data-testid="studio-pg-log-refresh" onclick="studioPgRefresh()"${log.loading ? ' disabled' : ''}>${studioPgIcon('refresh-cw', 'studio-pg-chip-icon')}<span>${studioEsc(studioPgText('Refresh', 'تحديث'))}</span></button>
            </div>
            <p class="studio-pg-note">${studioEsc(studioPgText(`The last ${log.windowDays || STUDIO_PG_LOG_DAYS} days. Every comment your rules handled, with what was sent and any problem in plain words.`, `آخر ${log.windowDays || STUDIO_PG_LOG_DAYS} يوماً. كل تعليق عالجته قواعدك، مع ما أُرسل وأي مشكلة بكلمات واضحة.`))}</p>
            ${tiles ? `<div class="studio-pg-tiles" data-testid="studio-pg-log-counters">${tiles}</div>` : ''}
            <div class="studio-pg-chips" role="group" aria-label="${studioEsc(studioPgText('Show', 'اعرض'))}">${chips}</div>
            ${list}
          </section>`;
}

// ------------------------------------------------------------------ Posts (the existing /posts, read as they are)

function studioPgPostsFilter(status) {
  const wanted = String(status || '');
  if (!STUDIO_PG_POST_STATUSES.some(item => item[0] === wanted)) return;
  _studioPg.postsFilter = wanted;
  studioPgRedraw();
}

function renderStudioPgPost(post) {
  const status = post.status === 'publishing' ? 'scheduled' : post.status;
  const look = STUDIO_PG_POST_STATUSES.find(item => item[0] === status) || STUDIO_PG_POST_STATUSES[2];
  const pages = post.pageIds.map(id => studioPgPage(id)).filter(Boolean);
  const when = post.status === 'published' ? post.publishedAt : (post.status === 'scheduled' || post.status === 'publishing' ? post.scheduledAt : post.updatedAt);
  return `
            <li class="studio-pg-log-row" data-testid="studio-pg-post-${studioEsc(post.id)}" data-status="${studioEsc(post.status)}">
              <div class="studio-pg-page-head">${pages.map(page => studioPgBadge(page.platform)).join('') || studioPgBadge('fb')}<span class="studio-pg-page-name" dir="auto">${studioEsc(post.caption || studioPgText('(no caption)', '(بدون نص)'))}</span>${studioPgChip(post.status === 'publishing' ? studioPgText('Publishing…', 'جارٍ النشر…') : studioPgText(look[2], look[3]), look[4], look[1])}</div>
              <p class="studio-pg-meta">${when ? `<span>${studioEsc(studioPgWhen(when))}</span>` : ''}${pages.length ? `<span dir="auto">${studioEsc(pages.map(page => page.name).join(', '))}</span>` : ''}${post.mediaCount ? `<span>${studioEsc(studioPgText(`${post.mediaCount} photo${post.mediaCount === 1 ? '' : 's'}`, `${post.mediaCount} ${post.mediaCount === 1 ? 'صورة' : (post.mediaCount === 2 ? 'صورتان' : (post.mediaCount <= 10 ? 'صور' : 'صورة'))}`))}</span>` : ''}</p>
              ${post.status === 'failed' ? `<p class="studio-pg-error" data-testid="studio-pg-post-error" data-class="${studioEsc(post.errorClass)}">${studioEsc(studioPgPostErrorText(post.errorClass))}</p>${post.lastError ? `<details class="studio-pg-details studio-pg-post-details" data-testid="studio-pg-post-error-details"><summary>${studioEsc(studioPgText('Details from Meta', 'التفاصيل من ميتا'))}</summary><p class="studio-pg-note" dir="ltr">${studioEsc(post.lastError)}</p></details>` : ''}` : ''}
            </li>`;
}

function renderStudioPgPosts(postsTab = false) {
  const slot = studioPgSlot('posts');
  studioPgWant('posts');
  studioPgWant('pages');
  const posts = Array.isArray(slot.value) ? slot.value : [];
  const counts = Object.fromEntries(STUDIO_PG_POST_STATUSES.map(([status]) => [status, posts.filter(post => post.status === status || (status === 'scheduled' && post.status === 'publishing')).length]));
  const chips = STUDIO_PG_POST_STATUSES.filter(([status]) => status !== 'failed' || counts.failed).map(([status, , en, ar]) =>
    `<button type="button" class="studio-pg-choice" data-testid="studio-pg-posts-filter-${status}" aria-pressed="${status === _studioPg.postsFilter ? 'true' : 'false'}" onclick="studioPgPostsFilter('${status}')">${studioEsc(studioPgText(en, ar))}${counts[status] ? ` <span class="studio-pg-count">${counts[status]}</span>` : ''}</button>`).join('');
  const filter = _studioPg.postsFilter;
  const rows = posts.filter(post => post.status === filter || (filter === 'scheduled' && post.status === 'publishing'))
    .sort((a, b) => (filter === 'scheduled' ? String(a.scheduledAt).localeCompare(String(b.scheduledAt)) : String(b.publishedAt || b.updatedAt).localeCompare(String(a.publishedAt || a.updatedAt))));
  let list = '';
  if (!slot.loadedAt && slot.error) list = renderStudioPgProblem(slot.error, 'studioPgRetry()');
  else if (!slot.loadedAt) list = renderStudioPgLoading(studioPgText('Reading your posts…', 'نقرأ منشوراتك…'), 'studio-pg-loading');
  else if (!rows.length) list = `<p class="studio-pg-empty" data-testid="studio-pg-posts-empty">${studioEsc(studioPgText('Nothing here yet.', 'لا شيء هنا بعد.'))}</p>`;
  else list = `<ul class="studio-pg-list" data-testid="studio-pg-posts">${rows.map(renderStudioPgPost).join('')}</ul>`;
  const way = postsTab && studioPgInV2() ? `<button type="button" class="studio-pg-link" data-testid="studio-pg-posts-all" onclick="studioV2Open('replies')">${studioPgIcon('messages-square', 'studio-pg-chip-icon')}<span>${studioEsc(studioPgText('Pages & replies', 'الصفحات والردود'))}</span></button>` : '';
  return `
          <section class="studio-pg-card" data-testid="studio-pg-posts-card" aria-labelledby="studio-pg-posts-title">
            <div class="studio-pg-head">
              <h2 id="studio-pg-posts-title" class="studio-pg-h2">${studioEsc(studioPgText('Scheduled posts', 'المنشورات المجدولة'))}</h2>
              ${way}
            </div>
            <p class="studio-pg-note">${studioEsc(studioPgText('Your posts as they stand: scheduled ones publish at their time. Writing and scheduling from the new studio comes in a later step.', 'منشوراتك كما هي: المجدولة تُنشر في وقتها. الكتابة والجدولة من الاستوديو الجديد تأتي في خطوة لاحقة.'))}</p>
            <div class="studio-pg-chips" role="group" aria-label="${studioEsc(studioPgText('Show', 'اعرض'))}">${chips}</div>
            ${list}
          </section>`;
}

// ------------------------------------------------------------------ Help guides (P5-03): static, bilingual, in this bundle

// key -> {icon, title [en, ar], intro [en, ar], steps [[en, ar]…], note [en, ar] | null}. The hours
// guide adds the calendar from /me serviceHours when it is drawn (studioGuideHours).
const STUDIO_GUIDES = Object.freeze({
  money: {
    icon: 'wallet',
    title: ['Your money in four numbers', 'أموالك في أربعة أرقام'],
    intro: ['Nothing is charged until our team approves a request. The wallet shows where every dollar is.', 'لا يُخصم شيء حتى يوافق فريقنا على الطلب. تعرض المحفظة أين كل دولار.'],
    steps: [
      ['Available: money you can use now for a new ad request.', 'المتاح: مال يمكنك استخدامه الآن لطلب إعلان جديد.'],
      ['Reserved: held for a request waiting for our team. It is still yours; withdraw the request and it is available again.', 'المحجوز: محتجز لطلب ينتظر فريقنا. ما زال لك؛ اسحب الطلب فيعود متاحاً.'],
      ['In your ads: paid for approved ads. "Meta used" shows what Meta has spent so far; the rest may come back when the ad ends.', 'في إعلاناتك: دُفع لإعلانات موافق عليها. «صرفت ميتا» يعرض ما صرفته ميتا حتى الآن؛ وقد يعود الباقي عند انتهاء الإعلان.'],
      ['Spent: final. Meta delivered it and it will not come back.', 'المصروف: نهائي. عرضته ميتا ولن يعود.'],
      ['On its way back to you: shown only while a payment whose approval did not finish is coming back to Available, usually within minutes.', 'في طريقه إليك: يظهر فقط بينما يعود إلى المتاح مبلغٌ لم تكتمل الموافقة عليه، عادةً خلال دقائق.'],
      ['Your plan is paid in dinars (LYD) and is separate from the ad money in dollars.', 'اشتراكك يُدفع بالدينار الليبي وهو منفصل عن مال الإعلانات بالدولار.']
    ],
    note: null
  },
  stages: {
    icon: 'route',
    title: ['The stages of an ad request', 'مراحل طلب الإعلان'],
    intro: ['Every request shows its stage and who acts next. After our team links it to Meta, the Meta stages come from Meta\'s own report, never from a button someone pressed.', 'كل طلب يعرض مرحلته ومن يتصرف بعدها. وبعد أن يربطه فريقنا بميتا، تأتي مراحل ميتا من تقرير ميتا نفسه، لا من زر ضغطه أحد.'],
    steps: [
      ['Draft, not sent: nothing reserved. You edit, send or delete it.', 'مسودة لم تُرسل: لا شيء محجوز. تعدّلها أو ترسلها أو تحذفها.'],
      ['Waiting for Albayan review: the budget is reserved, still yours. You can withdraw.', 'بانتظار مراجعة البيان: الميزانية محجوزة وما زالت لك. يمكنك السحب.'],
      ['Needs your changes: the reserve is released; fix what the note says and send again.', 'يحتاج تعديلك: أُلغي الحجز؛ عدّل ما تقوله الملاحظة وأرسل مجدداً.'],
      ['Approved, being set up in Meta: paid. Until the start day you can stop it for a full refund.', 'مقبول ونجهّزه في ميتا: مدفوع. حتى يوم البدء يمكنك إيقافه واسترداد المبلغ كاملاً.'],
      ['Meta is reviewing (about 24 hours), then Running. A rejection or a delivery problem is shown as such, and the team fixes it.', 'ميتا تراجع الإعلان (نحو 24 ساعة) ثم يعمل. الرفض أو مشكلة التشغيل تُعرض كما هي، والفريق يعالجها.'],
      ['Ended: we calculate the final amount from Meta\'s final numbers. Then Finished, with what was spent and what came back.', 'انتهى: نحسب المبلغ النهائي من أرقام ميتا النهائية. ثم «انتهى» مع ما صُرف وما عاد.'],
      ['Stopped or Rejected: the money outcome is written on the request itself.', 'أُوقف أو مرفوض: نتيجة المال مكتوبة على الطلب نفسه.']
    ],
    note: ['Ask to stop works at any stage after approval and opens an urgent ticket for our team.', '«اطلب الإيقاف» يعمل في أي مرحلة بعد الموافقة ويفتح تذكرة عاجلة لفريقنا.']
  },
  settle: {
    icon: 'hourglass',
    title: ['Why the final amount takes 2-3 days', 'لماذا يستغرق المبلغ النهائي يومين إلى ثلاثة'],
    intro: ['When an ad ends, the unused part of what you paid comes back. We wait for Meta\'s numbers to settle before we return it, so the amount is right the first time.', 'عند انتهاء الإعلان يعود إليك الجزء غير المستخدم مما دفعت. ننتظر حتى تثبت أرقام ميتا قبل الإرجاع، ليكون المبلغ صحيحاً من المرة الأولى.'],
    steps: [
      ['Meta may keep adjusting an ad\'s spend for a couple of days after it stops delivering.', 'قد تواصل ميتا تعديل صرف الإعلان يومين تقريباً بعد توقف عرضه.'],
      ['We read the final spend about 48 hours after delivery ends, then return paid minus Meta used.', 'نقرأ الصرف النهائي بعد نحو 48 ساعة من انتهاء العرض، ثم نعيد المدفوع ناقص ما صرفته ميتا.'],
      ['If Meta never showed your ad, the full amount comes back within one business day.', 'إذا لم تعرض ميتا إعلانك، يعود المبلغ كاملاً خلال يوم عمل.'],
      ['Until then the request says "Ended, final amount being calculated" and the wallet shows the money in "In your ads".', 'حتى ذلك الحين يقول الطلب «انتهى ونحسب المبلغ النهائي»، وتعرض المحفظة المال في «في إعلاناتك».']
    ],
    note: ['If Meta spends more than you paid, Albayan absorbs the difference; you never pay more than your budget.', 'إذا صرفت ميتا أكثر مما دفعت، يتحمل البيان الفرق؛ لا تدفع أبداً أكثر من ميزانيتك.']
  },
  'share-page': {
    icon: 'link-2',
    title: ['Sharing your page with Albayan', 'مشاركة صفحتك مع البيان'],
    intro: ['Albayan never asks for your password. You add Albayan as a partner of your page in Meta Business Suite; our team then links it here. The names below are Meta\'s menu names; they can differ slightly by app version, and the team checks with you.', 'لا يطلب البيان كلمة مرورك أبداً. تضيف البيان شريكاً لصفحتك في Meta Business Suite، ثم يربطها فريقنا هنا. الأسماء أدناه هي أسماء قوائم ميتا؛ وقد تختلف قليلاً حسب إصدار التطبيق، والفريق يتحقق معك.'],
    steps: [
      ['Open business.facebook.com, choose the business portfolio that owns your page, then Settings → Business settings.', 'افتح business.facebook.com، واختر محفظة الأعمال التي تملك صفحتك، ثم Settings ← Business settings.'],
      ['In the side menu open Accounts → Pages and select your page.', 'من القائمة الجانبية افتح Accounts ← Pages واختر صفحتك.'],
      ['Tap Assign partners → Business ID and paste Albayan\'s Business ID (our team sends it in your ticket).', 'اضغط Assign partners ← Business ID والصق رقم النشاط التجاري للبيان (يرسله فريقنا في تذكرتك).'],
      ['Choose the access: Full control, or at least Content, Messages and calls, and Community activity (needed to read and answer comments). Confirm with Assign.', 'اختر الصلاحية: Full control، أو على الأقل Content وMessages and calls وCommunity activity (لازمة لقراءة التعليقات والرد عليها). أكّد بـ Assign.'],
      ['Tell us in the ticket that it is done. We link the page and it appears in Pages with its health.', 'أخبرنا في التذكرة أنك انتهيت. نربط الصفحة فتظهر في الصفحات مع حالتها.']
    ],
    note: ['A page that is not in a business portfolio yet: in Business settings → Accounts → Pages tap Add → Add a Page first.', 'صفحة ليست في محفظة أعمال بعد: من Business settings ← Accounts ← Pages اضغط Add ← Add a Page أولاً.']
  },
  instagram: {
    icon: 'instagram',
    title: ['Instagram: a professional, public account', 'إنستغرام: حساب احترافي وعام'],
    intro: ['Comments reach Albayan only from a business or creator account that is linked to a Facebook page and is public. Three settings, all inside Instagram and Facebook.', 'تصل التعليقات إلى البيان فقط من حساب أعمال أو صانع محتوى مربوط بصفحة فيسبوك وعام. ثلاثة إعدادات، كلها داخل إنستغرام وفيسبوك.'],
    steps: [
      ['Professional account: in the Instagram app open your profile → menu (≡) → Settings and privacy → Account type and tools → Switch to professional account, then choose Business (or Creator).', 'حساب احترافي: في تطبيق إنستغرام افتح ملفك ← القائمة (≡) ← Settings and privacy ← Account type and tools ← Switch to professional account، ثم اختر Business (أو Creator).'],
      ['Link to your Facebook page: open your Facebook page → Settings → Linked accounts → Instagram → Connect account, and sign in to the Instagram account.', 'الربط بصفحة فيسبوك: افتح صفحتك على فيسبوك ← Settings ← Linked accounts ← Instagram ← Connect account، وسجّل الدخول إلى حساب إنستغرام.'],
      ['Public account: Settings and privacy → Account privacy → switch Private account off. A private account sends no comment notifications to anyone.', 'حساب عام: Settings and privacy ← Account privacy ← أوقف Private account. الحساب الخاص لا يرسل إشعارات التعليقات لأحد.'],
      ['Then ask us to link the page: the Instagram questions in the request tell the team what is already done.', 'ثم اطلب منا ربط الصفحة: أسئلة إنستغرام في الطلب تخبر الفريق بما أُنجز.']
    ],
    note: ['Private messages on Instagram wait for Meta\'s approval of Albayan; the reply rules show the honest state of each channel.', 'الرسائل الخاصة على إنستغرام تنتظر موافقة ميتا على البيان؛ وتعرض قواعد الرد الحالة الحقيقية لكل قناة.']
  },
  tiktok: {
    icon: 'music',
    title: ['TikTok today', 'تيك توك اليوم'],
    intro: ['TikTok has not opened automatic replies to Albayan, so no rule of yours can answer TikTok comments yet. What we offer is help by hand from the team.', 'لم يفتح تيك توك الردود التلقائية للبيان، لذلك لا تستطيع أي قاعدة لديك الرد على تعليقات تيك توك بعد. ما نقدمه هو مساعدة يدوية من الفريق.'],
    steps: [
      ['Help setting up TikTok\'s own built-in auto-messages inside the TikTok app (TikTok runs them, from your account).', 'مساعدة في إعداد الرسائل التلقائية المدمجة في تطبيق تيك توك (يشغّلها تيك توك من حسابك).'],
      ['Advice on answering comments by hand and on TikTok ads.', 'نصائح للرد على التعليقات يدوياً وعلى إعلانات تيك توك.'],
      ['Send a TikTok service request; a team member contacts you within one business day, in the ticket or on WhatsApp if you allowed it.', 'أرسل طلب خدمة تيك توك؛ يتواصل معك أحد أعضاء الفريق خلال يوم عمل، في التذكرة أو عبر واتساب إن سمحت بذلك.']
    ],
    note: ['We tell you the moment TikTok makes automatic replies available.', 'نخبرك فور أن يتيح تيك توك الردود التلقائية.']
  },
  hours: {
    icon: 'clock',
    title: ['Our working hours', 'ساعات عملنا'],
    intro: ['Tripoli time. Tickets, stop requests and payment confirmations are answered within these hours; each ticket shows the exact time we reply by.', 'بتوقيت طرابلس. نرد على التذاكر وطلبات الإيقاف وتأكيدات الدفع خلال هذه الساعات؛ وتعرض كل تذكرة الوقت الذي نرد قبله.'],
    steps: [
      ['An urgent stop request outside these hours can also go to the on-duty WhatsApp line shown on the request.', 'طلب إيقاف عاجل خارج هذه الساعات يمكن أن يذهب أيضاً إلى خط واتساب المناوبة الظاهر على الطلب.'],
      ['Ad requests are reviewed on working days; Meta then reviews the ad itself, usually within 24 hours.', 'تُراجع طلبات الإعلانات في أيام العمل؛ ثم تراجع ميتا الإعلان نفسه، عادةً خلال 24 ساعة.']
    ],
    note: null
  }
});
const STUDIO_GUIDE_KEYS = Object.freeze(Object.keys(STUDIO_GUIDES));
const STUDIO_GUIDE_DAYS = Object.freeze([['sun', 'Sunday', 'الأحد'], ['mon', 'Monday', 'الاثنين'], ['tue', 'Tuesday', 'الثلاثاء'], ['wed', 'Wednesday', 'الأربعاء'], ['thu', 'Thursday', 'الخميس'], ['fri', 'Friday', 'الجمعة'], ['sat', 'Saturday', 'السبت']]);

function studioGuide(key) {
  const name = String(key || '');
  return Object.prototype.hasOwnProperty.call(STUDIO_GUIDES, name) ? STUDIO_GUIDES[name] : null;
}

function studioGuideKeys() {
  return STUDIO_GUIDE_KEYS.slice();
}

function studioGuideTitle(key) {
  const guide = studioGuide(key);
  return guide ? studioPgText(guide.title[0], guide.title[1]) : '';
}

// The calendar of the hours guide: /me serviceHours (week, open now, holidays, Ramadan), or ''.
function studioGuideHours() {
  const me = studioPgMe();
  const hours = me && me.serviceHours && typeof me.serviceHours === 'object' ? me.serviceHours : null;
  if (!hours) return '';
  const clock = value => (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : '');
  const week = hours.week && typeof hours.week === 'object' ? hours.week : null;
  const rows = week ? STUDIO_GUIDE_DAYS.map(([key, en, ar]) => {
    const day = week[key];
    const range = day && clock(day.open) && clock(day.close) ? `${day.open}–${day.close}` : '';
    return `<div class="studio-guide-hours-row${range ? '' : ' is-closed'}"><dt>${studioEsc(studioPgText(en, ar))}</dt><dd>${range ? studioLtr(range) : studioEsc(studioPgText('Closed', 'مغلق'))}</dd></div>`;
  }).join('') : '';
  const open = typeof hours.openNow === 'boolean' ? studioPgChip(hours.openNow ? studioPgText('Open now', 'نعمل الآن') : studioPgText('Closed now', 'مغلق الآن'), hours.openNow ? 'ok' : 'slate', hours.openNow ? 'circle-check' : 'clock', 'studio-guide-open-now') : '';
  const holidays = (Array.isArray(hours.holidays) ? hours.holidays : []).filter(item => item && /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || ''))).slice(0, 6)
    .map(item => { const label = studioPgText(studioPgClean(item.labelEn, 80), studioPgClean(item.labelAr, 80)); return label ? `${item.date} (${label})` : String(item.date); });
  const ramadan = hours.ramadan && typeof hours.ramadan === 'object' && clock(hours.ramadan.open) && clock(hours.ramadan.close) && /^\d{4}-\d{2}-\d{2}$/.test(String(hours.ramadan.from || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(hours.ramadan.to || ''))
    ? `<p class="studio-pg-note">${studioEsc(studioPgText(`Ramadan (${hours.ramadan.from} to ${hours.ramadan.to}): ${hours.ramadan.open}–${hours.ramadan.close} on working days.`, `رمضان (من ${hours.ramadan.from} إلى ${hours.ramadan.to}): ${hours.ramadan.open}–${hours.ramadan.close} في أيام العمل.`))}</p>` : '';
  return `${open}${rows ? `<dl class="studio-guide-hours" data-testid="studio-guide-hours">${rows}</dl>` : ''}${holidays.length ? `<p class="studio-pg-note" data-testid="studio-guide-holidays">${studioEsc(studioPgText('Closed on: ', 'مغلق في: '))}${studioEsc(holidays.join('، '))}</p>` : ''}${ramadan}`;
}

// The body of one guide (title, intro, steps, note), used inline and in the sheet.
function renderStudioGuideBody(key, headingId = '') {
  const guide = studioGuide(key);
  if (!guide) return '';
  const steps = guide.steps.map(([en, ar]) => `<li>${studioEsc(studioPgText(en, ar))}</li>`).join('');
  return `
        <h2 class="studio-pg-h2"${headingId ? ` id="${studioEsc(headingId)}"` : ''}>${studioPgIcon(guide.icon, 'studio-pg-chip-icon')}<span>${studioEsc(studioPgText(guide.title[0], guide.title[1]))}</span></h2>
        <p class="studio-guide-intro">${studioEsc(studioPgText(guide.intro[0], guide.intro[1]))}</p>
        ${key === 'hours' ? studioGuideHours() : ''}
        <ol class="studio-guide-steps">${steps}</ol>
        ${guide.note ? `<p class="studio-pg-note studio-guide-note">${studioEsc(studioPgText(guide.note[0], guide.note[1]))}</p>` : ''}`;
}

// A guide folded into a screen (the link request shows the sharing guide before Send).
function renderStudioGuideInline(key) {
  if (!studioGuide(key)) return '';
  return `
            <details class="studio-pg-details studio-guide-inline" data-testid="studio-guide-inline-${studioEsc(key)}" open>
              <summary>${studioPgIcon('book-open', 'studio-pg-chip-icon')}<span>${studioEsc(studioPgText(`Guide: ${studioGuideTitle(key)}`, `دليل: ${studioGuideTitle(key)}`))}</span>${studioPgIcon('chevron-down', 'studio-pg-chip-icon')}</summary>
              <div class="studio-guide-body">${renderStudioGuideBody(key)}</div>
            </details>`;
}

// Buttons that open guides in the sheet: for the relevant screens (Pages, the link request, and the
// other screens through their own guarded call).
function renderStudioGuideLinks(keys, testId = 'studio-guide-links') {
  const list = (Array.isArray(keys) ? keys : []).filter(studioGuide);
  if (!list.length) return '';
  return `
          <div class="studio-guide-links" data-testid="${studioEsc(testId)}">
            ${list.map(key => `<button type="button" class="studio-pg-link" data-testid="studio-guide-link-${studioEsc(key)}" onclick="studioGuideOpen('${studioEsc(key)}', this)">${studioPgIcon('book-open', 'studio-pg-chip-icon')}<span>${studioEsc(studioGuideTitle(key))}</span></button>`).join('')}
          </div>`;
}

// The card that lists every guide (the Help screen draws it through a guarded call).
function renderStudioGuidesCard() {
  return `
          <section class="studio-pg-card studio-guides" data-testid="studio-guides" aria-labelledby="studio-guides-title">
            <h2 id="studio-guides-title" class="studio-pg-h2">${studioPgIcon('book-open', 'studio-pg-chip-icon')}<span>${studioEsc(studioPgText('Short guides', 'أدلة قصيرة'))}</span></h2>
            <ul class="studio-guide-list">${STUDIO_GUIDE_KEYS.map(key => `<li><button type="button" class="studio-guide-item" data-testid="studio-guide-link-${key}" onclick="studioGuideOpen('${key}', this)">${studioPgIcon(STUDIO_GUIDES[key].icon)}<span>${studioEsc(studioGuideTitle(key))}</span>${studioPgIcon(adsStudioIsAr() ? 'chevron-left' : 'chevron-right', 'studio-pg-chip-icon')}</button></li>`).join('')}</ul>
          </section>`;
}

// ------------------------------------------------------------------ sheets (a guide, the delete question)

// One overlay on <body> (.mobile-dialog-overlay: the phone's Back closes it first); Escape and the
// backdrop close it; focus returns to the opener.
function studioPgOpenSheet(innerHtml, testId, opener = null) {
  if (typeof document === 'undefined' || !document.body) return false;
  studioPgCloseSheet();
  const overlay = document.createElement('div');
  overlay.className = 'mobile-dialog-overlay studio-pg-overlay';
  overlay.setAttribute('data-testid', testId);
  overlay.setAttribute('dir', adsStudioIsAr() ? 'rtl' : 'ltr');
  overlay.innerHTML = innerHtml;
  overlay.addEventListener('click', event => { if (event.target === overlay) studioPgCloseSheet(); });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); studioPgCloseSheet(); }
  });
  _studioPg.sheet = overlay;
  _studioPg.opener = opener && typeof opener === 'object' ? opener : (document.activeElement || null);
  document.body.appendChild(overlay);
  if (typeof IconQueue !== 'undefined' && IconQueue && typeof IconQueue.schedule === 'function') IconQueue.schedule(overlay);
  const focus = overlay.querySelector('[data-sheet-focus]');
  try { if (focus) focus.focus(); } catch (_) {}
  return true;
}

function studioPgCloseSheet() {
  const overlay = _studioPg.sheet;
  const opener = _studioPg.opener;
  _studioPg.sheet = null;
  _studioPg.opener = null;
  if (overlay && overlay.isConnected) overlay.remove();
  try { if (overlay && opener && opener.isConnected && typeof opener.focus === 'function') opener.focus(); } catch (_) {}
}

// Opens one guide in the sheet, from any screen (the Help card, the Pages section, the wallet or a
// request through their own guarded calls). true when the guide exists.
function studioGuideOpen(key, opener = null) {
  const name = String(key || '');
  if (!studioGuide(name)) return false;
  const close = studioPgText('Close', 'إغلاق');
  const html = `
      <div class="studio-pg-sheet studio-guide-sheet" role="dialog" aria-modal="true" aria-labelledby="studio-guide-title" data-testid="studio-guide-sheet" data-guide="${studioEsc(name)}">
        <div class="studio-guide-body">${renderStudioGuideBody(name, 'studio-guide-title')}</div>
        <div class="studio-pg-sheet-actions">
          <button type="button" class="studio-v2-action is-primary" data-testid="studio-guide-close" data-sheet-focus="1" onclick="studioGuideClose()">${studioEsc(close)}</button>
        </div>
      </div>`;
  return studioPgOpenSheet(html, 'studio-guide-overlay', opener);
}

function studioGuideClose() {
  studioPgCloseSheet();
}
