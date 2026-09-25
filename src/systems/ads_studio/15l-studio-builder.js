// ==========================================
// ALBAYAN STUDIO v2 — REQUEST BUILDER (plan tasks P2-05a-e; styles in assets/ads-workspace.css)
// ==========================================
// The "New request" screen of the v2 customer layout (?tab=builder, drawn by the 15h shell):
// - a quick boost in three screens (section=boost): what to promote (a post from the linked page,
//   a new ad without a post, or a pasted post link when no page is linked) -> budget & days ->
//   review & send;
// - a full request in six (section=full, or no section): goal -> page -> content -> audience ->
//   budget & days -> review & send.
// The shell owns the frame, the address (&step=N), focus mode and the Back model. This file registers
// the builder screen with the shell (studioV2RegisterScreen('builder'); the shell's placeholder stays
// the fallback if a draw fails) and moves between steps with studioV2Go / studioV2BuilderStep.
//
// The draft is the classic draft object (_adsStudioDraft: one object per request, never replaced
// while it is open), so the existing photo path works unchanged: the file input
// #ads-studio-image-input, the paste zone data-photo-paste-target="ads-studio", compression and the
// size limits all stay in uploadAdsStudioCreativeFiles (15c; wrapped only to redraw and save).
//
// Saving as you go: a change saves itself about a second later, one save at a time. The first save
// creates the Draft (POST /api/collections/adCampaignRequests with an id fixed when the draft was
// opened, so a retried create replays); later saves PATCH only the fields that changed, with
// expectedLastModified. A version conflict never overwrites: the screen offers the other version or
// keeps this one on top of it. A value the server would refuse (a half-typed link, days outside the
// limits) stays on screen with its hint and is not sent until it is fixed. Close keeps the draft.
//
// Sending: POST /api/ad-studio/campaigns/{id}/submit with an operationId per (action, version)
// (adsStudioActionAttempt, 15c); a 409 whose request is already Submitted counts as sent. Refusals
// are explained through 15g's error map (studioErrorInfo). Money is what the server says: the
// wallet line reads GET /api/studio/wallet/summary through Home's one copy of it (studioData, 15j),
// painted in place; the "reserved" amount is the total the submit stamped on the request
// (totalBudgetMinorUSD). "Add money" opens Wallet's Add money for the missing dollars (15m).
//
// Entry points for the other v2 screens (Home quick actions, My ads, Needs you):
//   studioBuilderStart('boost' | 'full', {goal, boostType})  a new request
//   studioBuilderEdit(campaignId, {step, field})              continue a Draft / Changes Requested one
//   studioBuilderFix(campaignId, reasonCode)                  "Fix: <field>": the right step, field highlighted
//   studioBuilderFixLabel(reasonCode)                         that button's words ("Fix: photo")

const STUDIO_BUILDER_SAVE_DELAY_MS = 1200;
const STUDIO_BUILDER_PRESETS = Object.freeze([2000, 3500, 6000, 10000, 15000]);  // suggested totals ($20 … $150)
const STUDIO_BUILDER_RETRY_MS = Object.freeze([4000, 10000, 30000]);
const STUDIO_BUILDER_WALLET_MAX_AGE_MS = 30000;
const STUDIO_BUILDER_ENTRY_MS = 5000;           // a start/edit/fix call owns the next draw for this long
const STUDIO_BUILDER_MEMORY_KEY = 'albayan.studio.builder.';  // + user id: the open draft (this tab only)
const STUDIO_BUILDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const STUDIO_BUILDER_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

// The steps of each kind, in the shell's order (STUDIO_V2_BUILDER_STEPS names them).
const STUDIO_BUILDER_STEPS = Object.freeze({
  full: Object.freeze(['goal', 'page', 'content', 'audience', 'budget', 'review']),
  boost: Object.freeze(['promote', 'budget', 'review'])
});

// Goals: [key, objective, icon, English, Arabic, English hint, Arabic hint, default button]. Keys
// and objectives are the server's (ad_campaign_fields.AD_CAMPAIGN_GOAL_DETAILS); the server's own
// labels (GET /api/studio/ad-options) replace these words once they arrive.
const STUDIO_BUILDER_GOALS = Object.freeze([
  ['messages', 'messages', 'message-circle', 'Messages', 'رسائل', 'People write to you on Messenger, WhatsApp or Instagram.', 'يراسلك الناس على ماسنجر أو واتساب أو إنستغرام.', 'Send Message'],
  ['page_likes', 'engagement', 'thumbs-up', 'Page likes', 'إعجابات الصفحة', 'More people follow your page.', 'يتابع صفحتك عدد أكبر من الناس.', 'Learn More'],
  ['post_engagement', 'engagement', 'heart', 'Post engagement', 'التفاعل مع المنشور', 'More reactions, comments and shares.', 'تفاعل وتعليقات ومشاركات أكثر.', 'Learn More'],
  ['video_views', 'engagement', 'play', 'Video views', 'مشاهدات الفيديو', 'More people watch your video.', 'يشاهد فيديوك عدد أكبر من الناس.', 'Learn More'],
  ['website_visits', 'traffic', 'mouse-pointer-click', 'Website visits', 'زيارات الموقع', 'People open your website or online shop.', 'يفتح الناس موقعك أو متجرك الإلكتروني.', 'Learn More'],
  ['leads', 'leads', 'contact', 'Leads', 'عملاء محتملون', 'People leave their details so you can reach them.', 'يترك الناس بياناتهم لتتواصل معهم.', 'Sign Up'],
  ['sales', 'sales', 'shopping-bag', 'Sales', 'مبيعات', 'People buy from your shop.', 'يشتري الناس من متجرك.', 'Shop Now']
]);

// A quick boost: the goal each kind runs under (both under the engagement objective).
const STUDIO_BUILDER_BOOST_GOALS = Object.freeze({ boost_post: 'post_engagement', boost_page: 'page_likes' });

const STUDIO_BUILDER_LIBYA = 'libya';
const STUDIO_BUILDER_SPECIAL = Object.freeze([
  ['', 'None of these', 'لا شيء مما يلي'],
  ['credit', 'Credit, loans or financial services', 'قروض أو ائتمان أو خدمات مالية'],
  ['employment', 'Jobs', 'وظائف'],
  ['housing', 'Housing', 'سكن وعقارات'],
  ['social_issues_elections_politics', 'Social issues, elections or politics', 'قضايا اجتماعية أو انتخابات أو سياسة']
]);

// Review reasons -> the field to fix. The P1-12 codes (reviewReasonCode) and the plan's reason
// picker words (changeReasons); an unknown code opens the review step with the team's note.
const STUDIO_BUILDER_FIX = Object.freeze({
  budget_dates: 'budget', creative_quality: 'photos', text_policy: 'text', targeting: 'locations',
  page_access: 'page', payment: 'wallet', other: 'note',
  photo: 'photos', text: 'text', link: 'destination', page: 'page', audience: 'locations', policy: 'text'
});

// Field -> [its step in a full request, its step in a quick boost].
const STUDIO_BUILDER_FIELD_STEP = Object.freeze({
  goal: ['goal', 'promote'], page: ['page', 'promote'], platforms: ['page', 'promote'], post: ['content', 'promote'],
  text: ['content', 'promote'], photos: ['content', 'promote'], destination: ['content', 'promote'], cta: ['content', 'promote'],
  locations: ['audience', 'budget'], ages: ['audience', 'budget'], budget: ['budget', 'budget'], days: ['budget', 'budget'],
  start: ['budget', 'budget'], wallet: ['budget', 'budget'], name: ['review', 'review'], note: ['review', 'review'], rights: ['review', 'review']
});

// "Fix: <field>" words, [English, Arabic].
const STUDIO_BUILDER_FIELD_NAMES = Object.freeze({
  goal: ['goal', 'الهدف'], page: ['page', 'الصفحة'], platforms: ['platforms', 'المنصات'], post: ['post', 'المنشور'],
  text: ['text', 'النص'], photos: ['photo', 'الصورة'], destination: ['link', 'الرابط'], cta: ['button', 'الزر'],
  locations: ['audience', 'الجمهور'], ages: ['age', 'العمر'], budget: ['budget', 'الميزانية'], days: ['days', 'المدة'],
  start: ['start date', 'تاريخ البدء'], wallet: ['payment', 'الدفع'], name: ['name', 'الاسم'], note: ['details', 'التفاصيل'],
  rights: ['confirmation', 'التأكيد']
});

const _studioBuilder = {
  forUser: '',
  generation: 0,
  session: null,      // the open draft (studioBuilderOpenSession)
  entryAt: 0,         // set by studioBuilderStart / Edit / Fix: their draw is not a plain navigation
  opening: null,      // {id, token} while an existing request loads
  memoryTried: false,
  lastRoute: null,    // {id, kind, step}: where the open draft was last drawn (studioBuilderPlace)
  sent: null,         // {id, totalMinor, name} after a send, until a new request starts
  submit: null,       // the send in flight
  options: { state: '', goals: null, locations: null, failedAt: 0 },
  pages: { state: '', list: [], error: '', failedAt: 0, pageId: '', posts: Object.create(null) },
  focusTimer: null,
  listening: false
};

// ------------------------------------------------------------------ small helpers

function studioBuilderT(en, ar) {
  return adsStudioText(en, ar);
}

function studioBuilderUid() {
  return typeof studioMeUserId === 'function' ? studioMeUserId() : String((state && state.currentUser && state.currentUser.id) || '');
}

function studioBuilderToday() {
  return _adsStudioDateOffset(0);
}

function studioBuilderLimits() {
  const me = typeof studioMe === 'function' ? studioMe() : null;
  const raw = me && me.adLimits && typeof me.adLimits === 'object' ? me.adLimits : null;
  return raw && Number.isSafeInteger(raw.minTotalMinorUSD) ? raw : ADS_STUDIO_DEFAULT_LIMITS;
}

// A new, empty state for another user (or a signed-out one): nothing of the last user survives.
function studioBuilderSync() {
  const uid = studioBuilderUid();
  if (_studioBuilder.forUser === uid) return;
  const old = _studioBuilder.session;
  if (old) studioBuilderStopTimers(old);
  _studioBuilder.generation++;
  _studioBuilder.forUser = uid;
  _studioBuilder.session = null;
  _studioBuilder.entryAt = 0;
  _studioBuilder.opening = null;
  _studioBuilder.memoryTried = false;
  _studioBuilder.lastRoute = null;
  _studioBuilder.sent = null;
  _studioBuilder.submit = null;
  _studioBuilder.options = { state: '', goals: null, locations: null, failedAt: 0 };
  _studioBuilder.pages = { state: '', list: [], error: '', failedAt: 0, pageId: '', posts: Object.create(null) };
}

function studioBuilderCurrent(generation) {
  return generation === _studioBuilder.generation && _studioBuilder.forUser === studioBuilderUid();
}

function studioBuilderOnScreen() {
  try {
    return typeof state !== 'undefined' && state.currentView === 'ads-studio'
      && typeof studioV2Frame === 'function' && studioV2Frame() === 'customer'
      && studioV2Route(studioV2ReadAddress(), 'customer').tab === 'builder';
  } catch (_) { return false; }
}

function studioBuilderRedraw() {
  if (studioBuilderOnScreen() && typeof studioV2Rerender === 'function') studioV2Rerender();
}

function studioBuilderEl(id) {
  try { return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null; } catch (_) { return null; }
}

function studioBuilderIcons(node) {
  try { if (node && typeof IconQueue !== 'undefined') IconQueue.schedule(node); } catch (_) {}
}

// The app cancels a page's reads when it moves (the post-sign-in view restore too): not a failure.
// A read cut off by its timeout is one (15g studioReadCancelled): the step offers Try again.
function studioBuilderAborted(error, signal) {
  return studioReadCancelled(error, signal);
}

function studioBuilderMemoryKey() {
  return STUDIO_BUILDER_MEMORY_KEY + studioBuilderUid();
}

function studioBuilderMemory() {
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(studioBuilderMemoryKey()) || 'null');
    return raw && STUDIO_BUILDER_ID_RE.test(String(raw.id || '')) && (raw.kind === 'boost' || raw.kind === 'full') ? raw : null;
  } catch (_) { return null; }
}

function studioBuilderRemember(session) {
  try {
    if (session && session.created) window.sessionStorage.setItem(studioBuilderMemoryKey(), JSON.stringify({ id: session.id, kind: session.kind }));
  } catch (_) { /* a private window: a reload starts a new draft; the saved one stays in My ads */ }
}

function studioBuilderForget() {
  try { window.sessionStorage.removeItem(studioBuilderMemoryKey()); } catch (_) {}
}

// ------------------------------------------------------------------ server lists (goals, locations, pages, posts, wallet)

function studioBuilderGoalList() {
  const fromServer = _studioBuilder.options.goals;
  return STUDIO_BUILDER_GOALS.map(item => {
    const server = fromServer ? fromServer.find(goal => goal.key === item[0]) : null;
    return {
      key: item[0], objective: server && server.objective ? server.objective : item[1], icon: item[2],
      en: server && server.en ? server.en : item[3], ar: server && server.ar ? server.ar : item[4],
      hintEn: item[5], hintAr: item[6], cta: item[7]
    };
  });
}

function studioBuilderGoal(key) {
  return studioBuilderGoalList().find(goal => goal.key === key) || null;
}

function studioBuilderLocationList() {
  const list = _studioBuilder.options.locations;
  return list && list.length ? list : [{ key: STUDIO_BUILDER_LIBYA, en: 'All of Libya', ar: 'كل ليبيا' }];
}

function studioBuilderLocationLabel(key, language) {
  const hit = studioBuilderLocationList().find(item => item.key === key);
  if (!hit) return key;
  return (language || (adsStudioIsAr() ? 'ar' : 'en')) === 'ar' ? hit.ar : hit.en;
}

function studioBuilderPlacesText(draft) {
  return studioBuilderLocationKeys(draft).map(key => studioBuilderLocationLabel(key)).join(adsStudioIsAr() ? '، ' : ', ');
}

function studioBuilderCleanOptions(reply) {
  const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
  const goals = (reply && Array.isArray(reply.goals) ? reply.goals : []).slice(0, 20)
    .filter(goal => goal && STUDIO_BUILDER_KEY_RE.test(String(goal.key || '')))
    .map(goal => ({ key: String(goal.key), objective: STUDIO_BUILDER_KEY_RE.test(String(goal.objective || '')) ? String(goal.objective) : '', en: text(goal.labelEn, 60), ar: text(goal.labelAr, 60) }));
  const locations = (reply && Array.isArray(reply.locations) ? reply.locations : []).slice(0, 60)
    .filter(item => item && STUDIO_BUILDER_KEY_RE.test(String(item.key || '')))
    .map(item => ({ key: String(item.key), en: text(item.labelEn, 60) || String(item.key), ar: text(item.labelAr, 60) || text(item.labelEn, 60) || String(item.key) }));
  return { goals, locations };
}

// GET /api/studio/ad-options: once per session (a failure is tried again after a minute).
async function studioBuilderLoadOptions(force = false) {
  const options = _studioBuilder.options;
  if (options.state === 'loading' || (!force && (options.state === 'done' || (options.state === 'failed' && Date.now() - options.failedAt < 60000)))) return;
  const generation = _studioBuilder.generation;
  options.state = 'loading';
  let reply = null;
  let aborted = false;
  const signal = studioReadSignal();
  try { reply = await studioApi('/api/studio/ad-options', { method: 'GET' }); } catch (e) { aborted = studioBuilderAborted(e, signal); }
  if (!studioBuilderCurrent(generation)) return;
  if (aborted) { options.state = ''; return; }
  const clean = reply ? studioBuilderCleanOptions(reply) : null;
  if (clean && clean.locations.length) {
    options.goals = clean.goals;
    options.locations = clean.locations;
    options.state = 'done';
  } else {
    options.state = 'failed';
    options.failedAt = Date.now();
  }
  studioBuilderRedraw();
}

function studioBuilderCleanPages(reply) {
  const list = reply && Array.isArray(reply.pages) ? reply.pages : [];
  const seen = new Set();
  const pages = [];
  for (const raw of list.slice(0, 50)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    if (!STUDIO_BUILDER_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    pages.push({
      id,
      name: String(raw.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160),
      fb: raw.hasFacebook === true, ig: raw.hasInstagram === true, healthy: raw.healthy !== false
    });
  }
  return pages;
}

// GET /api/studio/pages: the customer's linked pages (once; a failure is tried again after a minute).
async function studioBuilderLoadPages(force = false) {
  const pages = _studioBuilder.pages;
  if (pages.state === 'loading' || (!force && (pages.state === 'done' || (pages.state === 'failed' && Date.now() - pages.failedAt < 60000)))) return;
  const generation = _studioBuilder.generation;
  pages.state = 'loading';
  pages.error = '';
  let list = null;
  let error = '';
  let aborted = false;
  const signal = studioReadSignal();
  try { list = studioBuilderCleanPages(await studioApi('/api/studio/pages', { method: 'GET' })); } catch (e) { error = (e && e.studio && e.studio.text) || ''; aborted = studioBuilderAborted(e, signal); }
  if (!studioBuilderCurrent(generation)) return;
  if (aborted) { pages.state = ''; studioBuilderRedraw(); return; }
  if (list) {
    pages.list = list;
    pages.state = 'done';
    const session = _studioBuilder.session;
    const chosen = session ? String(session.draft.connectedAssetId || '') : '';
    if (!list.some(page => page.id === pages.pageId)) pages.pageId = (list.find(page => page.id === chosen) || list[0] || { id: '' }).id;
  } else {
    pages.state = 'failed';
    pages.error = error;
    pages.failedAt = Date.now();
  }
  studioBuilderRedraw();
}

// GET /api/studio/pages/{id}/recent-posts (the classic normalizer keeps only safe fields).
async function studioBuilderLoadPosts(pageId, force = false) {
  const pages = _studioBuilder.pages;
  const id = String(pageId || '');
  if (!STUDIO_BUILDER_ID_RE.test(id)) return;
  const current = pages.posts[id];
  if (current && current.state === 'loading') return;
  if (!force && current && (current.state === 'done' || (current.state === 'failed' && Date.now() - current.at < 60000))) return;
  const generation = _studioBuilder.generation;
  pages.posts[id] = { state: 'loading', posts: current ? current.posts : [], platforms: current ? current.platforms : {}, checkedAt: current ? current.checkedAt : '', error: '', at: Date.now() };
  let result = null;
  let error = '';
  const signal = studioReadSignal();
  try {
    result = adsStudioNormalizeRecentPosts(await studioApi(`/api/studio/pages/${encodeURIComponent(id)}/recent-posts${force ? '?refresh=1' : ''}`, { method: 'GET' }));
  } catch (e) {
    error = (e && e.studio && e.studio.text) || '';
    if (studioBuilderAborted(e, signal)) {
      if (studioBuilderCurrent(generation)) { delete pages.posts[id]; studioBuilderRedraw(); }
      return;
    }
  }
  if (!studioBuilderCurrent(generation)) return;
  pages.posts[id] = result
    ? { state: 'done', posts: result.posts, platforms: result.platforms, checkedAt: result.checkedAt, error: '', at: Date.now() }
    : { state: 'failed', posts: current ? current.posts : [], platforms: current ? current.platforms : {}, checkedAt: current ? current.checkedAt : '', error, at: Date.now() };
  studioBuilderRedraw();
}

function studioBuilderCleanWallet(reply) {
  const usd = reply && reply.usd && typeof reply.usd === 'object' ? reply.usd : {};
  const whole = value => Number.isSafeInteger(value) ? value : null;
  const pending = (reply && Array.isArray(reply.pendingPayments) ? reply.pendingPayments : []).slice(0, 10)
    .filter(item => item && String(item.currency || 'USD').toUpperCase() === 'USD')
    .map(item => ({
      reference: String(item.reference || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40),
      amountMinor: Number.isSafeInteger(item.amountMinor) && item.amountMinor > 0 ? item.amountMinor : null
    }))
    .filter(item => item.reference);
  return { availableMinor: whole(usd.availableMinor), reservedMinor: whole(usd.reservedMinor), pending };
}

// GET /api/studio/wallet/summary through Home's one copy (studioData, 15j): read again after half a
// minute, after a send and after every money action anywhere in the studio (studioDataRefresh). An
// answer paints the wallet lines in place (studioDataPaintInPlace below: the keyboard stays open).
function studioBuilderLoadWallet(force = false) {
  return (typeof studioDataWant === 'function' ? studioDataWant('wallet', force, STUDIO_BUILDER_WALLET_MAX_AGE_MS) : null) || Promise.resolve(null);
}

// The wallet lines' numbers: {value: {availableMinor, reservedMinor, pending} or null, failed}.
function studioBuilderWallet() {
  const raw = typeof studioDataValue === 'function' ? studioDataValue('wallet') : null;
  const known = typeof studioDataState === 'function' ? studioDataState('wallet') : { error: null };
  return { value: raw ? studioBuilderCleanWallet(raw) : null, failed: !raw && !!known.error };
}

// ------------------------------------------------------------------ the draft

function studioBuilderGoalName(draft, language) {
  const ar = language === 'ar';
  const boost = String(draft.boostType || '');
  let what;
  if (boost === 'boost_post') what = ar ? 'ترويج منشور' : 'Boost a post';
  else if (boost === 'boost_page') what = ar ? 'تنمية صفحتي' : 'Grow my page';
  else {
    const goal = studioBuilderGoal(String(draft.goalDetail || ''));
    what = goal ? (ar ? goal.ar : goal.en) : (ar ? 'طلب إعلان' : 'Ad request');
  }
  let day = '';
  try {
    day = new Intl.DateTimeFormat(ar ? 'ar-LY' : 'en-GB', { day: 'numeric', month: 'long', timeZone: 'Africa/Tripoli' }).format(new Date());
  } catch (_) { day = studioBuilderToday(); }
  return `${what} — ${day}`.slice(0, 120);
}

function studioBuilderApplyGoal(draft, key) {
  const goal = studioBuilderGoal(key);
  if (!goal) return;
  draft.goalDetail = goal.key;
  draft.objective = goal.objective;
}

// A new draft with the plan's defaults: all of Libya, 18-65, everyone, 7 days, starting when approved.
function studioBuilderNewDraft(kind, options = {}) {
  const draft = newAdsStudioDraft();
  draft.id = Security.generateSecureId('campaign');
  draft.locationKeys = [STUDIO_BUILDER_LIBYA];
  draft.locations = ['All of Libya'];
  draft.startDate = studioBuilderToday();
  draft.durationDays = 7;
  draft.endDate = adsStudioEndDateFor(draft.startDate, 7) || draft.endDate;
  draft.budgetMinorUSD = 0;
  draft.budgetType = 'lifetime';
  draft.connectedAssetId = '';
  draft.goalDetail = '';
  if (kind === 'boost') {
    const boost = options.boostType === 'boost_page' ? 'boost_page' : 'boost_post';
    draft.boostType = boost;
    draft.objective = 'engagement';
    draft.goalDetail = STUDIO_BUILDER_BOOST_GOALS[boost];
    draft.callToAction = ADS_STUDIO_BOOST_DEFAULTS[boost][0];
    draft.sourcePostId = '';
    draft.sourcePostPlatform = '';
  } else {
    draft.boostType = '';
    const goal = studioBuilderGoal(String(options.goal || '')) || studioBuilderGoal('messages');
    studioBuilderApplyGoal(draft, goal.key);
    draft.callToAction = goal.cta;
  }
  draft.name = studioBuilderGoalName(draft, adsStudioIsAr() ? 'ar' : 'en');
  return draft;
}

// A stored request as a draft (arrays copied, so the stored copy never changes under the form).
function studioBuilderDraftFromCampaign(campaign) {
  const list = value => Array.isArray(value) ? value.slice() : [];
  const draft = {
    ...newAdsStudioDraft(),
    ...Security.sanitizeObject(campaign),
    platforms: list(campaign.platforms),
    locations: list(campaign.locations),
    locationKeys: list(campaign.locationKeys).filter(key => STUDIO_BUILDER_KEY_RE.test(String(key))),
    genders: Array.isArray(campaign.genders) && campaign.genders.length ? campaign.genders.slice() : ['all'],
    languages: list(campaign.languages),
    interests: list(campaign.interests),
    specialAdCategories: list(campaign.specialAdCategories),
    creativeImages: list(campaign.creativeImages).slice(0, 3)
  };
  if (!(Number.isSafeInteger(Number(campaign.durationDays)) && Number(campaign.durationDays) > 0)) {
    draft.durationDays = adsStudioCampaignDays({ startDate: campaign.startDate, endDate: campaign.endDate }) || 7;
  }
  draft.connectedAssetId = String(draft.connectedAssetId || '');
  draft.goalDetail = String(draft.goalDetail || '');
  if (!Object.prototype.hasOwnProperty.call(draft, 'sourcePostId')) draft.sourcePostId = '';
  if (!Object.prototype.hasOwnProperty.call(draft, 'sourcePostPlatform')) draft.sourcePostPlatform = '';
  return draft;
}

// The session around one draft: how it saves, what the server has, what the screen shows.
function studioBuilderOpenSession(kind, draft, extra = {}) {
  const old = _studioBuilder.session;
  if (old && old.draft !== draft) {
    studioBuilderFlush(old);  // what was typed there is sent before the form changes hands
    studioBuilderStopTimers(old);
  }
  _adsStudioPhotoToken++;  // a photo still compressing for the old draft is dropped (15c's own guard)
  _adsStudioDraft = draft;
  _adsStudioEditingId = extra.created ? draft.id : '';
  _adsStudioEditingBaseline = extra.created ? Number(extra.baseline) || 0 : 0;
  _adsStudioWizardStep = 1;
  _adsStudioConfirmationChecked = false;
  _adsStudioBudgetTyped = '';
  const start = String(draft.startDate || '');
  const session = {
    kind,
    draft,
    id: String(draft.id),
    created: !!extra.created,
    baseline: extra.created ? Number(extra.baseline) || 0 : 0,
    saved: {},
    campaignStatus: extra.created ? String(draft.status || 'Draft') : 'Draft',
    review: extra.review || null,
    dirty: false,
    touched: !!extra.created,
    timer: null,
    retryTimer: null,
    retries: 0,
    inFlight: null,
    again: false,
    status: extra.created ? 'saved' : 'new',
    statusText: '',
    savedAt: extra.created ? Date.now() : 0,
    conflict: null,
    quota: false,       // the last create was refused by the server's limit of open requests
    shown: Object.create(null),
    highlight: extra.field ? { field: extra.field } : null,
    typed: Object.create(null),
    ctaTouched: !!extra.created,
    nameTouched: !!extra.created,
    startMode: extra.created && start > studioBuilderToday() ? 'date' : 'asap',
    pasteLink: false,
    rights: false,
    sendError: '',
    resumed: false
  };
  if (extra.created) {
    session.saved = studioBuilderSnapshot(studioBuilderPayload(draft, session), session.saved);
    // A request saved on an earlier day that starts "when approved" gets today again (a past start
    // is refused at submit); it goes with the next save.
    if (session.startMode === 'asap' && start !== studioBuilderToday()) studioBuilderSetStart(session, studioBuilderToday());
    if (!draft.goalDetail && !draft.boostType) {
      const guess = { messages: 'messages', traffic: 'website_visits', leads: 'leads', sales: 'sales', engagement: 'post_engagement' }[String(draft.objective || '')];
      if (guess) studioBuilderApplyGoal(draft, guess);
    }
  }
  if (kind === 'boost') studioBuilderBoostPlatforms(draft);
  _studioBuilder.session = session;
  if (extra.created) studioBuilderRemember(session);
  return session;
}

// A quick boost has no platform choice of its own: an empty list (a full request whose two boxes were
// unticked, or a stored boost without platforms) becomes the page's own platforms, or both.
function studioBuilderBoostPlatforms(draft) {
  const list = (Array.isArray(draft.platforms) ? draft.platforms : []).filter(p => p === 'facebook' || p === 'instagram');
  if (list.length) return;
  const page = _studioBuilder.pages.list.find(item => item.id === String(draft.connectedAssetId || ''));
  const own = page ? [page.fb ? 'facebook' : '', page.ig ? 'instagram' : ''].filter(Boolean) : [];
  draft.platforms = own.length ? own : ['facebook', 'instagram'];
}

function studioBuilderSetStart(session, day) {
  const d = session.draft;
  d.startDate = day;
  const end = adsStudioEndDateFor(day, d.durationDays);
  if (end) d.endDate = end;
}

// Quick boost <-> full request on the same draft (the same saved request).
function studioBuilderConvert(session, kind) {
  const d = session.draft;
  if (session.kind === kind) return;
  if (kind === 'boost') {
    const ownAd = !!String(d.primaryText || '').trim() || (Array.isArray(d.creativeImages) && d.creativeImages.length > 0);
    d.boostType = ownAd ? 'boost_page' : 'boost_post';
    d.objective = 'engagement';
    d.goalDetail = STUDIO_BUILDER_BOOST_GOALS[d.boostType];
    if (!session.ctaTouched) d.callToAction = ADS_STUDIO_BOOST_DEFAULTS[d.boostType][0];
    studioBuilderBoostPlatforms(d);
  } else {
    if (String(d.destination || '') && String(d.destination) === String(d.sourcePostRef || '')) d.destination = '';
    d.boostType = '';
    d.sourcePostId = '';
    d.sourcePostPlatform = '';
    d.sourcePostRef = '';
    const goal = studioBuilderGoal(String(d.goalDetail || '')) || studioBuilderGoal('messages');
    studioBuilderApplyGoal(d, goal.key);
    if (!session.ctaTouched) d.callToAction = goal.cta;
  }
  session.kind = kind;
  if (!session.nameTouched) d.name = studioBuilderGoalName(d, adsStudioIsAr() ? 'ar' : 'en');
  session.shown = Object.create(null);
  studioBuilderRemember(session);
  studioBuilderTouch();
}

// ------------------------------------------------------------------ what is sent (client limits = server limits)

function studioBuilderText(value, max) {
  return Security.sanitizeInput(String(value === null || value === undefined ? '' : value), { maxLength: max }).trim();
}

// '' (empty), the cleaned value (an https link, or a phone number as +E.164: 09x becomes +2189x), or
// null when the server would refuse it.
function studioBuilderDestination(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) return '';
  const digits = normalizeDigitsAscii(text).replace(/[\s().\-\u200e\u200f]/g, '');
  if (/^(\+|00)?\d{6,20}$/.test(digits)) {
    const phone = studioParsePhone(text);
    return phone || null;
  }
  return !/\s/.test(text) && text.length <= 500 && adsStudioIsValidDestination(text) ? text : null;
}

function studioBuilderWhole(raw, min, max) {
  const text = normalizeDigitsAscii(String(raw === null || raw === undefined ? '' : raw)).trim();
  if (!/^\d{1,4}$/.test(text)) return NaN;
  const value = parseInt(text, 10);
  return value >= min && value <= max ? value : NaN;
}

function studioBuilderLocationKeys(draft) {
  const known = _studioBuilder.options.locations;
  const keys = (Array.isArray(draft.locationKeys) ? draft.locationKeys : []).map(String)
    .filter(key => STUDIO_BUILDER_KEY_RE.test(key) && (!known || known.some(item => item.key === key)));
  const unique = Array.from(new Set(keys)).slice(0, 25);
  return unique.includes(STUDIO_BUILDER_LIBYA) && unique.length > 1 ? unique.filter(key => key !== STUDIO_BUILDER_LIBYA) : unique;
}

function studioBuilderPhotos(draft) {
  return (Array.isArray(draft.creativeImages) ? draft.creativeImages : []).filter(isSafeAdsStudioCreativeSource).slice(0, 3);
}

function studioBuilderPhotoCount(draft) {
  const photos = studioBuilderPhotos(draft).length;
  if (photos) return photos;
  return draft._mediaOmitted === true && typeof getEntityPhotoCountHint === 'function' ? getEntityPhotoCountHint('adCampaignRequests', draft) : 0;
}

// The fields this draft may send now. A field whose value is not valid yet is left out, so the server
// keeps its last good value and a half-typed box never blocks the other fields from saving.
function studioBuilderPayload(d, session) {
  const limits = studioBuilderLimits();
  const out = {};
  const boost = ['boost_post', 'boost_page'].includes(String(d.boostType || '')) ? String(d.boostType) : '';
  out.boostType = boost;
  out.name = studioBuilderText(d.name, 120) || studioBuilderGoalName(d, adsStudioIsAr() ? 'ar' : 'en');
  const goal = boost ? STUDIO_BUILDER_BOOST_GOALS[boost] : String(d.goalDetail || '');
  const goalInfo = studioBuilderGoal(goal);
  out.goalDetail = goalInfo ? goalInfo.key : '';
  out.objective = goalInfo ? goalInfo.objective : (boost ? 'engagement' : studioBuilderText(d.objective, 40));
  out.platforms = Array.from(new Set((Array.isArray(d.platforms) ? d.platforms : []).filter(p => p === 'facebook' || p === 'instagram')));
  out.pageName = studioBuilderText(d.pageName, 160);
  const asset = String(d.connectedAssetId || '');
  out.connectedAssetId = STUDIO_BUILDER_ID_RE.test(asset) ? asset : '';
  out.primaryText = studioBuilderText(d.primaryText, 2200);
  out.headline = studioBuilderText(d.headline, 255);
  out.callToAction = ADS_STUDIO_CTA.some(([en]) => en === d.callToAction) ? String(d.callToAction) : 'Learn More';
  const ref = adsStudioIsValidBoostRef(d.sourcePostRef) ? studioBuilderText(d.sourcePostRef, 500) : '';
  if (ref || !String(d.sourcePostRef || '').trim()) out.sourcePostRef = boost === 'boost_post' ? ref : '';
  const postId = boost === 'boost_post' ? studioBuilderText(d.sourcePostId, 100) : '';
  const platform = postId && ['fb', 'ig'].includes(String(d.sourcePostPlatform || '')) ? String(d.sourcePostPlatform) : '';
  out.sourcePostId = platform ? postId : '';
  out.sourcePostPlatform = platform;
  const destination = studioBuilderDestination(d.destination);
  if (destination !== null) out.destination = destination || (boost === 'boost_post' && ref ? ref : '');
  // Places: the chips' keys, and their English names for the staff (an older request that has only
  // free-text places keeps them until a chip is chosen).
  const keys = studioBuilderLocationKeys(d);
  if (keys.length) {
    out.locationKeys = keys;
    out.locations = keys.map(key => studioBuilderLocationLabel(key, 'en')).slice(0, 25);
  }
  const min = Number(d.ageMin);
  const max = Number(d.ageMax);
  if (Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 18 && max <= 65 && min <= max) { out.ageMin = min; out.ageMax = max; }
  const gender = (Array.isArray(d.genders) ? d.genders : []).find(g => ['all', 'female', 'male'].includes(g)) || 'all';
  out.genders = [gender];
  out.specialAdCategories = (Array.isArray(d.specialAdCategories) ? d.specialAdCategories : [])
    .filter(item => STUDIO_BUILDER_SPECIAL.some(([key]) => key && key === item)).slice(0, 1);
  const days = Number(d.durationDays);
  const daysOk = Number.isSafeInteger(days) && days >= 1 && days <= limits.maxDays;
  const start = String(d.startDate || '');
  if (daysOk) out.durationDays = days;
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    out.startDate = start;
    const end = daysOk ? adsStudioEndDateFor(start, days) : '';
    if (end) out.endDate = end;
  }
  const budget = Number(d.budgetMinorUSD);
  if (Number.isSafeInteger(budget) && budget >= 0 && budget <= 100000000) out.budgetMinorUSD = budget;
  out.budgetType = d.budgetType === 'daily' ? 'daily' : 'lifetime';
  out.notes = studioBuilderText(d.notes, 1000);
  // Photos only when this copy holds them (a request whose photos did not load keeps the stored ones).
  if (!(d._mediaOmitted === true && typeof isEntityMediaHydrated === 'function' && !isEntityMediaHydrated('adCampaignRequests', d))) {
    out.creativeImages = studioBuilderPhotos(d);
  }
  return out;
}

function studioBuilderFieldKey(field, value) {
  if (field === 'creativeImages') {
    return (Array.isArray(value) ? value : []).map(src => `${String(src).length}:${String(src).slice(-48)}`).join('|');
  }
  return JSON.stringify(value === undefined ? null : value);
}

function studioBuilderSnapshot(payload, base = {}) {
  const out = { ...base };
  for (const [field, value] of Object.entries(payload)) out[field] = studioBuilderFieldKey(field, value);
  return out;
}

function studioBuilderChanges(session) {
  const payload = studioBuilderPayload(session.draft, session);
  const changes = {};
  for (const [field, value] of Object.entries(payload)) {
    if (session.saved[field] !== studioBuilderFieldKey(field, value)) changes[field] = value;
  }
  // The goal and its objective travel together (the server checks one against the other).
  if (('goalDetail' in changes || 'objective' in changes) && payload.goalDetail) {
    changes.goalDetail = payload.goalDetail;
    changes.objective = payload.objective;
  }
  // The days, the start and the end are one decision.
  if ('durationDays' in changes || 'startDate' in changes) {
    for (const field of ['durationDays', 'startDate', 'endDate']) if (field in payload) changes[field] = payload[field];
  }
  return { payload, changes };
}

// ------------------------------------------------------------------ saving as you go

function studioBuilderStopTimers(session) {
  if (session.timer) clearTimeout(session.timer);
  if (session.retryTimer) clearTimeout(session.retryTimer);
  session.timer = null;
  session.retryTimer = null;
}

// Something on the form changed: save about a second later (the latest values, once).
function studioBuilderTouch(field) {
  const session = _studioBuilder.session;
  if (!session) return;
  session.dirty = true;
  session.touched = true;
  if (field && session.highlight && session.highlight.field === field) {
    // The field was fixed: its highlight goes, in place (the keyboard stays).
    session.highlight = null;
    try {
      const wrap = typeof document !== 'undefined' && document.querySelector ? document.querySelector(`.studio-b [data-field="${field}"]`) : null;
      if (wrap) { wrap.classList.remove('is-fix'); wrap.removeAttribute('data-fix'); }
    } catch (_) {}
  }
  if (['conflict', 'locked'].includes(session.status)) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => { session.timer = null; studioBuilderSaveNow(session); }, STUDIO_BUILDER_SAVE_DELAY_MS);
}

function studioBuilderFlush(session = _studioBuilder.session) {
  if (!session) return null;
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
  return session.dirty && session.touched ? studioBuilderSaveNow(session) : session.inFlight;
}

// One save at a time per draft; a change made meanwhile is saved right after.
function studioBuilderSaveNow(session) {
  if (!session || ['conflict', 'locked'].includes(session.status)) return null;
  if (session.inFlight) { session.again = true; return session.inFlight; }
  if (!session.dirty) return null;
  if (typeof adsStudioCanCreate === 'function' && !adsStudioCanCreate()) return null;
  const generation = _studioBuilder.generation;
  const run = (async () => {
    session.dirty = false;
    session.again = false;
    const { payload, changes } = studioBuilderChanges(session);
    if (session.created && !Object.keys(changes).length) {
      // Nothing left to send (a refused change was undone, too): the draft is as the server has it.
      session.retries = 0;
      session.quota = false;
      if (session.status !== 'saved') studioBuilderSetStatus(session, 'saved');
      return true;
    }
    studioBuilderSetStatus(session, 'saving');
    try {
      let entity;
      if (!session.created) {
        entity = await apiCreateEntity('adCampaignRequests', { id: session.id, ...payload });
      } else {
        entity = await apiPatchEntity('adCampaignRequests', session.id, changes, session.baseline);
      }
      if (!studioBuilderCurrent(generation)) return false;
      studioBuilderSaved(session, entity, session.created ? changes : payload);
      return true;
    } catch (error) {
      if (!studioBuilderCurrent(generation)) return false;
      session.dirty = true;
      await studioBuilderSaveFailed(session, error, generation);
      return false;
    }
  })();
  session.inFlight = run;
  const done = () => {
    if (session.inFlight === run) session.inFlight = null;
    if (!studioBuilderCurrent(generation)) return;
    if ((session.again || session.dirty) && session.status === 'saved') studioBuilderSaveNow(session);
  };
  run.then(done, done);
  return run;
}

function studioBuilderSaved(session, entity, sent) {
  const data = entity && entity.data ? entity.data : {};
  const version = Number(data._lastModified || entity.lastModified);
  session.created = true;
  if (Number.isSafeInteger(version) && version > 0) session.baseline = version;
  session.saved = studioBuilderSnapshot(sent, session.saved);
  session.retries = 0;
  session.savedAt = Date.now();
  session.campaignStatus = String(data.status || session.campaignStatus || 'Draft');
  session.draft._lastModified = session.baseline;
  if (session.draft === _adsStudioDraft) {
    _adsStudioEditingId = session.id;
    _adsStudioEditingBaseline = session.baseline;
  }
  session.quota = false;
  try { upsertAdsStudioEntity(entity); } catch (_) { /* the list catches up on its next read */ }
  // A late answer for a draft the customer has already left never points the reload memory back at it.
  if (session === _studioBuilder.session) studioBuilderRemember(session);
  studioBuilderSetStatus(session, 'saved');
}

async function studioBuilderSaveFailed(session, error, generation) {
  const status = Number(error && error.status);
  const info = studioErrorInfo(error, 'action');
  if (status === 409) {
    const fresh = await adsStudioReloadCampaign(session.id);
    if (!studioBuilderCurrent(generation)) return;
    const data = fresh && fresh.data ? fresh.data : null;
    if (data && !session.created && String(data.status || 'Draft') === 'Draft') {
      // The first create reached the server before its answer was lost: build on that row.
      session.created = true;
      session.baseline = Number(data._lastModified || fresh.lastModified) || 0;
      session.saved = {};
      session.dirty = true;
      studioBuilderSetStatus(session, 'saved');
      return;
    }
    if (!session.created && !data) {
      // The request was never made (the server's limit of open requests, most often): not a version
      // conflict. The reason is shown, and the next change tries again once a slot is free.
      session.quota = STUDIO_OPEN_REQUESTS_RE.test(info.message);
      studioBuilderSetStatus(session, 'error', info.text);
      studioBuilderRedraw();
      return;
    }
    if (data && !['Draft', 'Changes Requested'].includes(String(data.status || 'Draft'))) {
      session.campaignStatus = String(data.status || '');
      if (session === _studioBuilder.session) studioBuilderForget();
      studioBuilderSetStatus(session, 'locked');
      studioBuilderRedraw();
      return;
    }
    session.conflict = data ? { version: Number(data._lastModified || fresh.lastModified) || 0 } : { version: 0 };
    studioBuilderSetStatus(session, 'conflict');
    studioBuilderRedraw();
    return;
  }
  if (status === 429 || !status || status >= 500) {
    const wait = status === 429 && Number(error && error.retryAfter) > 0
      ? Math.min(Number(error.retryAfter) * 1000, 120000)
      : STUDIO_BUILDER_RETRY_MS[Math.min(session.retries, STUDIO_BUILDER_RETRY_MS.length - 1)];
    session.retries++;
    studioBuilderSetStatus(session, 'offline', status === 429 ? info.text : '');
    if (session.retryTimer) clearTimeout(session.retryTimer);
    session.retryTimer = setTimeout(() => { session.retryTimer = null; if (session.status === 'offline') studioBuilderSaveNow(session); }, wait);
    return;
  }
  studioBuilderSetStatus(session, 'error', info.text);
}

function studioBuilderStatusText(session) {
  switch (session.status) {
    case 'saving': return studioBuilderT('Saving…', 'جارٍ الحفظ…');
    case 'saved': return studioBuilderT('Draft saved', 'حُفظت المسودة');
    case 'offline': return session.statusText || studioBuilderT('Not saved yet — no connection. We will try again.', 'لم يُحفظ بعد — لا يوجد اتصال. سنحاول مرة أخرى.');
    case 'error': return `${studioBuilderT('Not saved:', 'لم يُحفظ:')} ${session.statusText}`;
    case 'conflict': return studioBuilderT('Not saved: this draft changed on another device.', 'لم يُحفظ: تغيّرت هذه المسودة على جهاز آخر.');
    case 'locked': return studioBuilderT('This request can no longer be changed here.', 'لم يعد بالإمكان تعديل هذا الطلب هنا.');
    default: return studioBuilderT('Your draft saves as you go.', 'تُحفظ مسودتك تلقائياً أثناء الكتابة.');
  }
}

// The status line is updated in place (a full redraw would close the phone's keyboard).
function studioBuilderSetStatus(session, status, text = '') {
  session.status = status;
  session.statusText = String(text || '').slice(0, 300);
  if (session !== _studioBuilder.session) return;
  const node = studioBuilderEl('studio-b-save');
  if (node) {
    node.textContent = studioBuilderStatusText(session);
    node.setAttribute('data-state', status);
  }
}

// Leaving the page or hiding the tab sends what is waiting.
function studioBuilderListen() {
  if (_studioBuilder.listening || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  _studioBuilder.listening = true;
  window.addEventListener('pagehide', () => { try { studioBuilderFlush(); } catch (_) {} });
  try {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        try { if (document.visibilityState === 'hidden') studioBuilderFlush(); } catch (_) {}
      });
    }
  } catch (_) {}
  if (typeof studioMeSubscribe === 'function') {
    studioMeSubscribe(() => { if (_studioBuilder.session && studioBuilderOnScreen()) studioBuilderRedraw(); });
  }
}

// ------------------------------------------------------------------ problems (inline validation)

function studioBuilderStepKeys(kind) {
  return STUDIO_BUILDER_STEPS[kind === 'boost' ? 'boost' : 'full'];
}

function studioBuilderFieldStep(kind, field, draft) {
  let name = field;
  if (kind === 'boost' && String((draft && draft.boostType) || '') === 'boost_post' && ['text', 'photos', 'destination', 'cta'].includes(field)) name = 'post';
  const pair = STUDIO_BUILDER_FIELD_STEP[name] || STUDIO_BUILDER_FIELD_STEP.note;
  const key = pair[kind === 'boost' ? 1 : 0];
  return { field: name, key, step: studioBuilderStepKeys(kind).indexOf(key) + 1 };
}

function studioBuilderTotalMinor(d) {
  const budget = Math.max(0, Math.trunc(Number(d.budgetMinorUSD) || 0));
  const days = Number(d.durationDays);
  return d.budgetType === 'daily' ? (Number.isSafeInteger(days) && days > 0 ? budget * days : 0) : budget;
}

function studioBuilderBudgetProblem(session) {
  const d = session.draft;
  const limits = studioBuilderLimits();
  const typed = session.typed.budget;
  const budget = Number(d.budgetMinorUSD);
  const days = Number(d.durationDays);
  if (typed !== undefined && typed.trim() && !Number.isSafeInteger(budget)) return studioBuilderT('Write the amount in dollars, for example 50 or 12.5.', 'اكتب المبلغ بالدولار، مثل 50 أو 12.5.');
  if (!(budget > 0)) return studioBuilderT('Choose how much to spend.', 'اختر المبلغ الذي تريد صرفه.');
  if (!(Number.isSafeInteger(days) && days >= 1 && days <= limits.maxDays)) return '';
  const total = studioBuilderTotalMinor(d);
  const sum = d.budgetType === 'daily' ? ` (${studioUsd(budget)} × ${adsStudioDaysText(days)} = ${studioUsd(total)})` : '';
  if (total < limits.minTotalMinorUSD) return studioBuilderT(`The total must be at least ${studioUsd(limits.minTotalMinorUSD)}${sum}.`, `يجب ألا يقل الإجمالي عن ${studioUsd(limits.minTotalMinorUSD)}${sum}.`);
  if (total > limits.maxTotalMinorUSD) return studioBuilderT(`The total must be at most ${studioUsd(limits.maxTotalMinorUSD)}${sum}.`, `يجب ألا يزيد الإجمالي عن ${studioUsd(limits.maxTotalMinorUSD)}${sum}.`);
  if (total < limits.minPerDayMinorUSD * days) {
    return studioBuilderT(
      `Meta needs at least ${studioUsd(limits.minPerDayMinorUSD)} a day. Raise the budget or choose fewer days.`,
      `تحتاج ميتا إلى ${studioUsd(limits.minPerDayMinorUSD)} يومياً على الأقل. ارفع الميزانية أو اختر أياماً أقل.`
    );
  }
  return '';
}

function studioBuilderDaysProblem(session) {
  const limits = studioBuilderLimits();
  const days = Number(session.draft.durationDays);
  if (Number.isSafeInteger(days) && days >= 1 && days <= limits.maxDays) return '';
  return studioBuilderT(`Choose from 1 to ${limits.maxDays} days.`, `اختر من يوم واحد إلى ${adsStudioDaysText(limits.maxDays)}.`);
}

function studioBuilderPageProblem(session) {
  const d = session.draft;
  if (String(d.connectedAssetId || '') || String(d.pageName || '').trim()) return '';
  return studioBuilderT('Choose your page, or write its name.', 'اختر صفحتك أو اكتب اسمها.');
}

function studioBuilderStepProblems(session, key) {
  const d = session.draft;
  const out = {};
  const boost = String(d.boostType || '');
  const needOwnAd = key === 'content' || (key === 'promote' && boost === 'boost_page');
  if (key === 'goal' && !studioBuilderGoal(String(d.goalDetail || ''))) out.goal = studioBuilderT('Choose what the ad should bring you.', 'اختر ما تريده من الإعلان.');
  const noPost = key === 'promote' && boost === 'boost_post' && !String(d.sourcePostId || '').trim() && !adsStudioIsValidBoostRef(d.sourcePostRef);
  if (noPost) {
    out.post = String(d.sourcePostRef || '').trim()
      ? studioBuilderT('Paste the link of a Facebook or Instagram post (it starts with https://).', 'الصق رابط منشور على فيسبوك أو إنستغرام (يبدأ بـ https://).')
      : studioBuilderT('Choose a post, or paste its link.', 'اختر منشوراً أو الصق رابطه.');
  }
  if ((key === 'page' || key === 'promote') && !noPost) {
    const page = studioBuilderPageProblem(session);
    if (page) out.page = page;
  }
  if (key === 'page' && !(Array.isArray(d.platforms) && d.platforms.some(p => p === 'facebook' || p === 'instagram'))) {
    out.platforms = studioBuilderT('Choose Facebook, Instagram or both.', 'اختر فيسبوك أو إنستغرام أو كليهما.');
  }
  if (needOwnAd) {
    if (!String(d.primaryText || '').trim()) out.text = studioBuilderT('Write the text people will read.', 'اكتب النص الذي سيقرؤه الناس.');
    if (!studioBuilderPhotoCount(d)) out.photos = studioBuilderT('Add at least one photo (PNG, JPEG or WebP).', 'أضف صورة واحدة على الأقل بصيغة PNG أو JPEG أو WebP.');
    const destination = studioBuilderDestination(d.destination);
    if (destination === null) out.destination = studioBuilderT('Use a link that starts with https:// or a phone number such as 091 234 5678.', 'استخدم رابطاً يبدأ بـ https:// أو رقم هاتف مثل 091 234 5678.');
    else if (!destination) out.destination = studioBuilderT('Add where people should go: a link or a phone number.', 'أضف وجهة الناس: رابطاً أو رقم هاتف.');
  }
  if ((key === 'audience' || (key === 'budget' && session.kind === 'boost')) && !studioBuilderLocationKeys(d).length) {
    out.locations = studioBuilderT('Choose at least one place.', 'اختر مكاناً واحداً على الأقل.');
  }
  if (key === 'audience') {
    const min = Number(d.ageMin);
    const max = Number(d.ageMax);
    if (!(Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 18 && max <= 65 && min <= max)) {
      out.ages = studioBuilderT('Ages go from 18 to 65, the first no higher than the second.', 'العمر من 18 إلى 65، والأول لا يزيد عن الثاني.');
    }
  }
  if (key === 'budget') {
    const days = studioBuilderDaysProblem(session);
    if (days) out.days = days;
    const budget = studioBuilderBudgetProblem(session);
    if (budget) out.budget = budget;
    if (session.kind === 'full' && session.startMode === 'date') {
      const start = String(d.startDate || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start < studioBuilderToday()) out.start = studioBuilderT('Choose a start date from today on.', 'اختر تاريخ بدء من اليوم فصاعداً.');
    }
  }
  if (key === 'review') {
    if (!String(d.name || '').trim()) out.name = studioBuilderT('Give the request a name.', 'اكتب اسماً للطلب.');
    if (!session.rights) out.rights = studioBuilderT('Confirm the details and your rights to the text and photos.', 'أكّد صحة البيانات وحقك في النص والصور.');
  }
  return out;
}

// Every problem of the request, in step order: [{key, step, field, text}].
function studioBuilderAllProblems(session) {
  const keys = studioBuilderStepKeys(session.kind);
  const out = [];
  keys.forEach((key, index) => {
    const problems = studioBuilderStepProblems(session, key);
    for (const [field, text] of Object.entries(problems)) out.push({ key, step: index + 1, field, text });
  });
  return out;
}

// After Next showed a step's problems, each one clears in place as soon as its field is fixed.
function studioBuilderRecheck(key) {
  const session = _studioBuilder.session;
  if (!session || !session.shown[key]) return;
  const problems = studioBuilderStepProblems(session, key);
  const nodes = typeof document !== 'undefined' && document.querySelectorAll ? document.querySelectorAll('.studio-b [data-field]') : [];
  Array.prototype.forEach.call(nodes, wrap => {
    const field = wrap.getAttribute('data-field');
    const error = studioBuilderEl(`studio-b-err-${field}`);
    const text = problems[field] || '';
    wrap.classList.toggle('is-invalid', !!text);
    if (error) {
      error.textContent = text;
      error.hidden = !text;
    }
  });
}

// ------------------------------------------------------------------ actions (onclick / oninput)

function studioBuilderSession() {
  studioBuilderSync();
  return _studioBuilder.session;
}

function studioBuilderInput(field, input) {
  const session = studioBuilderSession();
  if (!session || !input) return;
  const d = session.draft;
  const value = String(input.value === null || input.value === undefined ? '' : input.value);
  switch (field) {
    case 'pageName': d.pageName = value.slice(0, 160); break;
    case 'text': d.primaryText = value.slice(0, 2200); studioBuilderPaintCount(); break;
    case 'headline': d.headline = value.slice(0, 255); break;
    case 'destination': d.destination = value.slice(0, 500); break;
    case 'postLink': d.sourcePostRef = value.slice(0, 500); d.sourcePostId = ''; d.sourcePostPlatform = ''; break;
    case 'name': d.name = value.slice(0, 120); session.nameTouched = true; break;
    case 'notes': d.notes = value.slice(0, 1000); break;
    case 'cta': if (ADS_STUDIO_CTA.some(([en]) => en === value)) { d.callToAction = value; session.ctaTouched = true; } break;
    case 'special': d.specialAdCategories = STUDIO_BUILDER_SPECIAL.some(([key]) => key && key === value) ? [value] : []; break;
    case 'ageMin':
    case 'ageMax': {
      session.typed[field] = value.slice(0, 4);
      const age = studioBuilderWhole(value, 0, 999);
      d[field] = Number.isSafeInteger(age) ? age : 0;
      break;
    }
    case 'budget': {
      session.typed.budget = value.slice(0, 40);
      const minor = studioParseAmount(value);
      d.budgetMinorUSD = Number.isSafeInteger(minor) ? minor : (value.trim() ? NaN : 0);
      studioBuilderPaintBudget();
      break;
    }
    case 'days': {
      session.typed.days = value.slice(0, 4);
      const days = studioBuilderWhole(value, 0, 9999);
      d.durationDays = Number.isSafeInteger(days) ? days : 0;
      studioBuilderSetStart(session, String(d.startDate || studioBuilderToday()));
      studioBuilderPaintBudget();
      break;
    }
    case 'start': if (/^\d{4}-\d{2}-\d{2}$/.test(value)) studioBuilderSetStart(session, value); studioBuilderPaintBudget(); break;
    default: return;
  }
  studioBuilderTouch(studioBuilderFieldOfInput(field));
  const route = studioV2Route(studioV2ReadAddress(), 'customer');
  studioBuilderRecheck(studioBuilderStepKeys(session.kind)[Math.max(0, route.step - 1)]);
}

function studioBuilderFieldOfInput(input) {
  return { pageName: 'page', text: 'text', headline: 'text', destination: 'destination', postLink: 'post', name: 'name', budget: 'budget', days: 'days', start: 'start', ageMin: 'ages', ageMax: 'ages', cta: 'cta' }[input] || input;
}

// Taps that change what the step shows redraw it (a tap has no keyboard to keep).
function studioBuilderChanged(field) {
  studioBuilderTouch(field);
  studioBuilderRedraw();
}

function studioBuilderSetGoal(index) {
  const session = studioBuilderSession();
  const goal = studioBuilderGoalList()[Number(index)];
  if (!session || !goal) return;
  const d = session.draft;
  studioBuilderApplyGoal(d, goal.key);
  if (!session.ctaTouched) d.callToAction = goal.cta;
  if (!session.nameTouched) d.name = studioBuilderGoalName(d, adsStudioIsAr() ? 'ar' : 'en');
  studioBuilderChanged('goal');
}

function studioBuilderSetBoostKind(kind) {
  const session = studioBuilderSession();
  if (!session || session.kind !== 'boost' || !STUDIO_BUILDER_BOOST_GOALS[kind]) return;
  const d = session.draft;
  if (d.boostType === kind) return;
  if (kind === 'boost_page') {
    if (String(d.destination || '') === String(d.sourcePostRef || '')) d.destination = '';
    d.sourcePostRef = '';
    d.sourcePostId = '';
    d.sourcePostPlatform = '';
  }
  d.boostType = kind;
  d.goalDetail = STUDIO_BUILDER_BOOST_GOALS[kind];
  d.objective = 'engagement';
  if (!session.ctaTouched) d.callToAction = ADS_STUDIO_BOOST_DEFAULTS[kind][0];
  if (!session.nameTouched) d.name = studioBuilderGoalName(d, adsStudioIsAr() ? 'ar' : 'en');
  session.shown = Object.create(null);
  studioBuilderChanged('post');
}

function studioBuilderChoosePage(index) {
  const session = studioBuilderSession();
  const page = _studioBuilder.pages.list[Number(index)];
  if (!session || !page) return;
  const d = session.draft;
  d.connectedAssetId = page.id;
  if (page.name) d.pageName = page.name;
  const platforms = [page.fb ? 'facebook' : '', page.ig ? 'instagram' : ''].filter(Boolean);
  if (platforms.length) d.platforms = platforms;
  if (d.sourcePostId && _studioBuilder.pages.pageId !== page.id) { d.sourcePostId = ''; d.sourcePostPlatform = ''; d.sourcePostRef = ''; }
  _studioBuilder.pages.pageId = page.id;
  studioBuilderChanged('page');
}

function studioBuilderOtherPage() {
  const session = studioBuilderSession();
  if (!session) return;
  const d = session.draft;
  if (d.sourcePostId) { d.sourcePostId = ''; d.sourcePostPlatform = ''; d.sourcePostRef = ''; }
  d.connectedAssetId = '';
  const known = _studioBuilder.pages.list.find(page => page.name && page.name === d.pageName);
  if (known) d.pageName = '';
  session.otherPage = true;
  studioBuilderChanged('page');
}

function studioBuilderTogglePlatform(name) {
  const session = studioBuilderSession();
  if (!session || !['facebook', 'instagram'].includes(name)) return;
  const d = session.draft;
  const list = Array.isArray(d.platforms) ? d.platforms.slice() : [];
  d.platforms = list.includes(name) ? list.filter(item => item !== name) : list.concat(name);
  studioBuilderChanged('platforms');
}

function studioBuilderChoosePost(index, button) {
  const session = studioBuilderSession();
  if (!session || session.draft.boostType !== 'boost_post') return;
  const pages = _studioBuilder.pages;
  const page = pages.list.find(item => item.id === pages.pageId);
  const entry = page ? pages.posts[page.id] : null;
  const post = entry ? entry.posts[Number(index)] : null;
  if (!post) return;
  // The list may have refreshed under the finger: only the post that was on the button counts.
  if (button && typeof button.getAttribute === 'function' && button.getAttribute('data-post-id') !== post.id) return;
  const d = session.draft;
  if (String(d.destination || '') === String(d.sourcePostRef || '')) d.destination = '';
  d.sourcePostId = post.id;
  d.sourcePostPlatform = post.platform;
  d.sourcePostRef = post.permalink;
  d.connectedAssetId = page.id;
  if (page.name) d.pageName = page.name;
  session.pasteLink = false;
  studioBuilderChanged('post');
}

function studioBuilderShowPasteLink() {
  const session = studioBuilderSession();
  if (!session) return;
  session.pasteLink = true;
  studioBuilderRedraw();
}

function studioBuilderRetryPosts() {
  studioBuilderLoadPosts(_studioBuilder.pages.pageId, true);
}

function studioBuilderRetryPages() {
  studioBuilderLoadPages(true);
}

function studioBuilderToggleLocation(index) {
  const session = studioBuilderSession();
  const item = studioBuilderLocationList()[Number(index)];
  if (!session || !item) return;
  const d = session.draft;
  let keys = studioBuilderLocationKeys(d);
  if (item.key === STUDIO_BUILDER_LIBYA) keys = [STUDIO_BUILDER_LIBYA];
  else {
    keys = keys.filter(key => key !== STUDIO_BUILDER_LIBYA);
    keys = keys.includes(item.key) ? keys.filter(key => key !== item.key) : keys.concat(item.key).slice(0, 25);
    if (!keys.length) keys = [STUDIO_BUILDER_LIBYA];
  }
  d.locationKeys = keys;
  d.locations = keys.map(key => studioBuilderLocationLabel(key, 'en'));
  session.audienceOpen = true;
  studioBuilderChanged('locations');
}

function studioBuilderSetGender(value) {
  const session = studioBuilderSession();
  if (!session || !['all', 'female', 'male'].includes(value)) return;
  session.draft.genders = [value];
  studioBuilderChanged('ages');
}

function studioBuilderSetBudgetType(type) {
  const session = studioBuilderSession();
  if (!session || !['daily', 'lifetime'].includes(type) || session.draft.budgetType === type) return;
  session.draft.budgetType = type;
  studioBuilderChanged('budget');
}

// A chip carries its own amount: tapping "$20.00" sets $20.00 even when the typed days changed the
// suggestions meanwhile (an amount now under the per-day floor shows the budget's own hint).
function studioBuilderPreset(minor) {
  const session = studioBuilderSession();
  const preset = Number(minor);
  if (!session || !STUDIO_BUILDER_PRESETS.includes(preset)) return;
  session.draft.budgetMinorUSD = preset;
  session.typed.budget = (preset / 100).toFixed(2).replace(/\.00$/, '');
  studioBuilderChanged('budget');
}

function studioBuilderSetDays(days) {
  const session = studioBuilderSession();
  const n = Number(days);
  if (!session || !Number.isSafeInteger(n) || n < 1) return;
  session.draft.durationDays = n;
  session.typed.days = String(n);
  studioBuilderSetStart(session, String(session.draft.startDate || studioBuilderToday()));
  studioBuilderChanged('days');
}

function studioBuilderSetStartMode(mode) {
  const session = studioBuilderSession();
  if (!session || !['asap', 'date'].includes(mode)) return;
  session.startMode = mode;
  if (mode === 'asap') studioBuilderSetStart(session, studioBuilderToday());
  else if (String(session.draft.startDate || '') <= studioBuilderToday()) studioBuilderSetStart(session, _adsStudioDateOffset(1));
  studioBuilderChanged('start');
}

function studioBuilderSetRights(input) {
  const session = studioBuilderSession();
  if (!session || !input) return;
  session.rights = input.checked === true;
  _adsStudioConfirmationChecked = session.rights;
  studioBuilderRecheck('review');
}

// Photos: the classic path (15c) compresses and checks them; this screen only asks and redraws.
function studioBuilderPickPhotos() {
  const input = studioBuilderEl('ads-studio-image-input');
  if (input && typeof input.click === 'function') input.click();
}

function studioBuilderPhotosChosen(input) {
  const files = Array.from((input && input.files) || []);
  if (input) input.value = '';
  return uploadAdsStudioCreativeFiles(files);
}

function studioBuilderPastePhoto() {
  if (typeof pastePhotoFromClipboard === 'function') pastePhotoFromClipboard('ads-studio');
}

function studioBuilderRemovePhoto(index) {
  const session = studioBuilderSession();
  if (!session) return;
  const d = session.draft;
  d.creativeImages = (Array.isArray(d.creativeImages) ? d.creativeImages : []).filter((_, i) => i !== Number(index));
  _adsStudioPhotoToken++;
  studioBuilderPhotosChanged(session);
}

function studioBuilderPhotoKey(draft) {
  return studioBuilderFieldKey('creativeImages', Array.isArray(draft && draft.creativeImages) ? draft.creativeImages : []);
}

function studioBuilderPhotosChanged(session) {
  if (session !== _studioBuilder.session) return;
  session.draft._mediaOmitted = false;
  studioBuilderTouch('photos');
  const wrap = studioBuilderEl('studio-b-photos');
  if (wrap) {
    wrap.innerHTML = studioBuilderPhotosHtml(session);
    studioBuilderIcons(wrap);
  }
  studioBuilderRecheck(studioBuilderFieldStep(session.kind, 'photos', session.draft).key);
}

// Entry points ------------------------------------------------------

function studioBuilderReady() {
  return typeof studioV2Frame === 'function' && studioV2Frame() === 'customer';
}

function studioBuilderStart(kind, options = {}) {
  if (!studioBuilderReady()) return false;
  studioBuilderSync();
  const k = kind === 'boost' ? 'boost' : 'full';
  _studioBuilder.sent = null;
  _studioBuilder.opening = null;
  studioBuilderOpenSession(k, studioBuilderNewDraft(k, options && typeof options === 'object' ? options : {}), {});
  studioBuilderForget();
  _studioBuilder.entryAt = Date.now();
  return studioV2Go({ tab: 'builder', section: k, step: 1 });
}

// A stored request, with its photos, or {error}. Only the owner's Draft / Changes Requested ones.
async function studioBuilderLoadCampaign(id) {
  // The server's copy first (without photos): the one on this device can be older (a saved copy from
  // before the last change, or a team decision live sync has not brought yet). Offline, this copy stays.
  try {
    const entity = await apiJson(`/api/collections/adCampaignRequests/${encodeURIComponent(id)}?include_media=false`, { method: 'GET' });
    if (entity && entity.data) upsertAdsStudioEntity(entity);
  } catch (_) { /* the copy on this device is used */ }
  let campaign = findVisibleAdsStudioCampaign(id);
  if (!campaign) return { error: studioBuilderT('This request was not found. Refresh the page.', 'لم نجد هذا الطلب. حدّث الصفحة.') };
  if (String(campaign.createdBy || '') !== studioBuilderUid() || !['Draft', 'Changes Requested'].includes(String(campaign.status || 'Draft'))) {
    return { error: studioBuilderT('This request can no longer be changed.', 'لم يعد بالإمكان تعديل هذا الطلب.') };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const signal = studioReadSignal();
    try {
      campaign = await ensureEntityMediaLoaded('adCampaignRequests', campaign.id) || campaign;
      break;
    } catch (error) {
      if (!studioBuilderAborted(error, signal) || attempt) { campaign = null; break; }  // cancelled by the app moving: once more
    }
  }
  const photosMissing = campaign && campaign._mediaOmitted === true && getEntityPhotoCountHint('adCampaignRequests', campaign) > 0
    && !isEntityMediaHydrated('adCampaignRequests', campaign);
  if (!campaign || photosMissing) {
    return { error: studioBuilderT('Your photos could not be loaded. They are safe; check the connection and try again.', 'تعذّر تحميل صورك. إنها محفوظة؛ تحقّق من الاتصال وأعد المحاولة.') };
  }
  return { campaign };
}

function studioBuilderSessionFromCampaign(campaign, field) {
  const draft = studioBuilderDraftFromCampaign(campaign);
  const kind = draft.boostType ? 'boost' : 'full';
  const sentBack = String(campaign.status || '') === 'Changes Requested';
  const review = sentBack ? { reason: String(campaign.reviewReasonCode || ''), note: String(campaign.reviewNote || '').slice(0, 1000) } : null;
  return studioBuilderOpenSession(kind, draft, { created: true, baseline: Number(campaign._lastModified) || 0, review, field });
}

// Continue a request (Draft or Changes Requested). options.step (a number) or options.field decides
// the step; the field is highlighted. Resolves true when the builder opened it.
async function studioBuilderEdit(campaignId, options = {}) {
  const id = String(campaignId || '');
  if (!studioBuilderReady() || !STUDIO_BUILDER_ID_RE.test(id)) return false;
  studioBuilderSync();
  const opts = options && typeof options === 'object' ? options : {};
  const field = STUDIO_BUILDER_FIELD_STEP[opts.field] ? String(opts.field) : '';
  const open = session => {
    session.highlight = field ? { field } : null;
    const place = field ? studioBuilderFieldStep(session.kind, field, session.draft) : null;
    if (place) {
      session.highlight = { field: place.field };
      session.shown[place.key] = true;
      _studioBuilder.pendingFocus = place.field;
    }
    const steps = studioBuilderStepKeys(session.kind).length;
    const asked = Number(opts.step);
    const step = place ? place.step : (Number.isSafeInteger(asked) && asked >= 1 ? Math.min(asked, steps) : 1);
    _studioBuilder.sent = null;
    _studioBuilder.entryAt = Date.now();
    return studioV2Go({ tab: 'builder', section: session.kind, step });
  };
  const current = _studioBuilder.session;
  if (current && current.id === id && current.created && current.status !== 'locked') return open(current);
  if (_studioBuilder.opening) return false;
  const token = {};
  const generation = _studioBuilder.generation;
  _studioBuilder.opening = { id, token };
  if (opts.button) setAdsStudioActionButtonBusy(opts.button, true);
  try {
    const loaded = await studioBuilderLoadCampaign(id);
    if (!studioBuilderCurrent(generation) || !_studioBuilder.opening || _studioBuilder.opening.token !== token) return false;
    _studioBuilder.opening = null;
    if (loaded.error) {
      showNotification(studioBuilderT('Could not open the request', 'تعذّر فتح الطلب'), loaded.error, 'error');
      return false;
    }
    return open(studioBuilderSessionFromCampaign(loaded.campaign, field));
  } finally {
    if (_studioBuilder.opening && _studioBuilder.opening.token === token) _studioBuilder.opening = null;
    if (opts.button) setAdsStudioActionButtonBusy(opts.button, false);
  }
}

// P2-05e: "Fix: <field>" on a request sent back for changes.
function studioBuilderFix(campaignId, reasonCode, button) {
  const code = String(reasonCode || '');
  const field = STUDIO_BUILDER_FIX[code] || 'note';
  return studioBuilderEdit(campaignId, { field, button });
}

function studioBuilderFixLabel(reasonCode, kind = 'full', draft = null) {
  const field = STUDIO_BUILDER_FIX[String(reasonCode || '')] || 'note';
  const place = studioBuilderFieldStep(kind, field, draft);
  const name = STUDIO_BUILDER_FIELD_NAMES[place.field] || STUDIO_BUILDER_FIELD_NAMES.note;
  return studioBuilderT(`Fix: ${name[0]}`, `أصلح: ${name[1]}`);
}

// Inside the builder: go to the step of a field and highlight it.
function studioBuilderGoToField(field) {
  const session = studioBuilderSession();
  if (!session || !STUDIO_BUILDER_FIELD_STEP[field]) return false;
  const place = studioBuilderFieldStep(session.kind, field, session.draft);
  session.highlight = { field: place.field };
  session.shown[place.key] = true;
  _studioBuilder.pendingFocus = place.field;
  if (place.field === 'locations' && session.kind === 'boost') session.audienceOpen = true;
  return studioV2Go({ tab: 'builder', section: session.kind, step: place.step });
}

function studioBuilderSwitchKind(kind) {
  const session = studioBuilderSession();
  if (!session || !['boost', 'full'].includes(kind)) return false;
  studioBuilderConvert(session, kind);
  _studioBuilder.entryAt = Date.now();
  return studioV2Go({ tab: 'builder', section: kind, step: 1 });
}

function studioBuilderStartOver() {
  const session = studioBuilderSession();
  if (!session) return false;
  return studioBuilderStart(session.kind);
}

function studioBuilderNext() {
  const session = studioBuilderSession();
  if (!session) return false;
  const route = studioV2Route(studioV2ReadAddress(), 'customer');
  const keys = studioBuilderStepKeys(session.kind);
  const key = keys[Math.max(0, route.step - 1)];
  const problems = studioBuilderStepProblems(session, key);
  const first = Object.keys(problems)[0];
  if (first) {
    session.shown[key] = true;
    session.highlight = { field: first };
    _studioBuilder.pendingFocus = first;
    studioBuilderRedraw();
    return false;
  }
  session.resumed = false;
  if (!session.touched) session.touched = true;
  session.dirty = true;
  studioBuilderFlush(session);
  return studioV2BuilderStep(1);
}

// Wallet's Add money (15m, ?tab=wallet&id=add-money), already on "my ads" with the missing amount.
function studioBuilderAddMoney() {
  const short = studioBuilderShortMinor(_studioBuilder.session);
  studioBuilderFlush();
  if (typeof studioWalletOpenAdd === 'function') return studioWalletOpenAdd('ads', short);
  return studioV2Go({ tab: 'wallet', id: 'add-money' });
}

function studioBuilderOpenPages() {
  studioBuilderFlush();
  return studioV2Go({ tab: 'replies', section: 'pages' });
}

function studioBuilderOpenMyAds() {
  return studioV2Go({ tab: 'campaigns' });
}

function studioBuilderViewSent() {
  const sent = _studioBuilder.sent;
  return studioV2Go(sent ? { tab: 'campaigns', id: sent.id } : { tab: 'campaigns' });
}

function studioBuilderDone() {
  return studioV2Go({ tab: 'home' });
}

// A version conflict: take the other device's version, or keep this one on top of it.
async function studioBuilderUseOther(button) {
  const session = studioBuilderSession();
  if (!session || session.status !== 'conflict') return false;
  setAdsStudioActionButtonBusy(button, true);
  try {
    const loaded = await studioBuilderLoadCampaign(session.id);
    if (session !== _studioBuilder.session) return false;
    if (loaded.error) { showNotification(studioBuilderT('Could not load the other version', 'تعذّر تحميل النسخة الأخرى'), loaded.error, 'error'); return false; }
    studioBuilderSessionFromCampaign(loaded.campaign, '');
    studioBuilderRedraw();
    return true;
  } finally { setAdsStudioActionButtonBusy(button, false); }
}

function studioBuilderKeepMine() {
  const session = studioBuilderSession();
  if (!session || session.status !== 'conflict' || !session.conflict) return false;
  session.baseline = session.conflict.version || session.baseline;
  session.conflict = null;
  session.saved = {};
  session.dirty = true;
  session.touched = true;
  session.status = 'saved';
  studioBuilderSaveNow(session);
  studioBuilderRedraw();
  return true;
}

// ------------------------------------------------------------------ sending

// The dollars missing for this request (0 when the wallet covers it or is not known yet).
function studioBuilderShortMinor(session) {
  const wallet = studioBuilderWallet();
  if (!session || !wallet.value || wallet.value.availableMinor === null) return 0;
  const total = studioBuilderTotalMinor(session.draft);
  return total > 0 && wallet.value.availableMinor < total ? total - Math.max(0, wallet.value.availableMinor) : 0;
}

function studioBuilderWalletShort(session) {
  return studioBuilderShortMinor(session) > 0;
}

function studioBuilderIntakePaused() {
  const me = typeof studioMe === 'function' ? studioMe() : null;
  return !!(me && me.intakeOpen === false);
}

function studioBuilderSend(button) {
  if (_studioBuilder.submit) return _studioBuilder.submit;
  setAdsStudioActionButtonBusy(button, true);
  const operation = studioBuilderSendOnce();
  _studioBuilder.submit = operation;
  const cleanup = () => {
    if (_studioBuilder.submit === operation) _studioBuilder.submit = null;
    setAdsStudioActionButtonBusy(button, false);
  };
  operation.then(cleanup, cleanup);
  return operation;
}

// Waits for the saves of this draft to settle (a change typed during a save is saved too).
async function studioBuilderSettle(session) {
  for (let round = 0; round < 4; round++) {
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    if (session.inFlight) { await session.inFlight; continue; }
    if (session.status === 'error' && session.created && !Object.keys(studioBuilderChanges(session).changes).length) {
      // The refused change was undone: nothing is left to save.
      session.dirty = false;
      session.retries = 0;
      session.quota = false;
      studioBuilderSetStatus(session, 'saved');
    }
    if (session.dirty && session.touched && !['conflict', 'locked', 'error'].includes(session.status)) { await studioBuilderSaveNow(session); continue; }
    break;
  }
  return session.created && !session.dirty && session.status === 'saved';
}

async function studioBuilderSendOnce() {
  const session = studioBuilderSession();
  if (!session) return false;
  const generation = _studioBuilder.generation;
  const keys = studioBuilderStepKeys(session.kind);
  const rights = studioBuilderEl('studio-b-rights');
  if (rights) session.rights = rights.checked === true;
  session.sendError = '';
  keys.forEach(key => { session.shown[key] = true; });
  const problems = studioBuilderAllProblems(session);
  if (problems.length) {
    const earlier = problems.find(item => item.key !== 'review');
    _studioBuilder.pendingFocus = earlier ? 'problems' : problems[0].field;
    studioBuilderRedraw();
    return false;
  }
  // Intake (P1-22): /me is read again unless it was read moments ago.
  try { await studioLoadMe(15000); } catch (_) {}
  if (!studioBuilderCurrent(generation) || session !== _studioBuilder.session) return false;
  if (studioBuilderIntakePaused()) { studioBuilderRedraw(); return false; }
  // "As soon as approved": today is the start (a start in the past is refused).
  if (session.kind === 'boost' || session.startMode === 'asap') studioBuilderSetStart(session, studioBuilderToday());
  session.dirty = true;
  session.touched = true;
  const saved = await studioBuilderSettle(session);
  if (!studioBuilderCurrent(generation) || session !== _studioBuilder.session) return false;
  if (!saved) {
    session.sendError = session.status === 'error' && session.statusText
      ? session.statusText
      : studioBuilderT('Your latest changes are not saved yet, so nothing was sent. Check the connection and try again.', 'لم تُحفظ تعديلاتك الأخيرة بعد، لذلك لم يُرسل شيء. تحقّق من الاتصال وأعد المحاولة.');
    studioBuilderRedraw();
    return false;
  }
  let entity;
  try {
    const attempt = adsStudioActionAttempt('submit', session.id, session.baseline);
    try {
      entity = await apiSubmitAdCampaignRequest(session.id, attempt.expectedLastModified, attempt.operationId);
    } catch (error) {
      const fresh = error && error.status === 409 ? await adsStudioReloadCampaign(session.id) : null;
      if (!fresh || String((fresh.data && fresh.data.status) || '') !== 'Submitted') throw error;
      entity = fresh;  // the first tap already sent it
    }
  } catch (error) {
    if (!studioBuilderCurrent(generation) || session !== _studioBuilder.session) return false;
    const info = studioErrorInfo(error, 'action');
    session.sendError = info.text;
    if (/New ad requests are paused|limit of new ad requests/i.test(info.message)) { try { studioLoadMe(0); } catch (_) {} }
    if (/Insufficient wallet balance/i.test(info.message)) studioBuilderLoadWallet(true);
    studioBuilderRedraw();
    return false;
  }
  if (!studioBuilderCurrent(generation)) return false;
  try { upsertAdsStudioEntity(entity); } catch (_) {}
  const data = entity && entity.data ? entity.data : {};
  const total = Number.isSafeInteger(data.totalBudgetMinorUSD) && data.totalBudgetMinorUSD > 0 ? data.totalBudgetMinorUSD : studioBuilderTotalMinor(session.draft);
  _studioBuilder.sent = { id: session.id, totalMinor: total, name: String(data.name || session.draft.name || '').slice(0, 160) };
  studioBuilderStopTimers(session);
  _studioBuilder.session = null;
  if (_adsStudioDraft === session.draft) {
    _adsStudioDraft = null;
    _adsStudioEditingId = '';
    _adsStudioEditingBaseline = 0;
    _adsStudioConfirmationChecked = false;
  }
  studioBuilderForget();
  // The money is reserved now and the request is waiting: both summaries, for every screen.
  if (typeof studioDataRefresh === 'function') studioDataRefresh();
  else studioBuilderLoadWallet(true);
  studioBuilderRedraw();
  try { if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) {}
  return true;
}

// ------------------------------------------------------------------ drawing

function studioBuilderLabel(forId, text) {
  return `<label class="studio-b-label" for="${forId}">${studioEsc(text)}</label>`;
}

// One field: its label, its control, a hint and its problem (shown after Next or a Fix).
function studioBuilderField(session, key, field, label, control, options = {}) {
  const problems = session.shown[key] ? studioBuilderStepProblems(session, key) : {};
  const problem = problems[field] || '';
  const fix = session.highlight && session.highlight.field === field;
  const title = label ? (options.forId ? studioBuilderLabel(options.forId, label) : `<p class="studio-b-label">${studioEsc(label)}</p>`) : '';
  return `
            <div class="studio-b-field${fix ? ' is-fix' : ''}${problem ? ' is-invalid' : ''}" data-field="${field}"${fix ? ' data-fix="1"' : ''}>
              ${title}${control}
              ${options.hint ? `<p class="studio-b-hint">${studioEsc(options.hint)}</p>` : ''}
              <p class="studio-b-error" id="studio-b-err-${field}" data-testid="studio-builder-error-${field}" role="alert"${problem ? '' : ' hidden'}>${studioEsc(problem)}</p>
            </div>`;
}

function studioBuilderChip(label, pressed, onclick, testid = '', icon = '') {
  return `<button type="button" class="studio-b-chip" aria-pressed="${pressed ? 'true' : 'false'}" onclick="${onclick}"${testid ? ` data-testid="${testid}"` : ''}>${icon ? studioV2Icon(icon) : ''}<span>${studioEsc(label)}</span></button>`;
}

function studioBuilderChoice(title, hint, pressed, onclick, icon, testid = '') {
  return `<button type="button" class="studio-b-choice" aria-pressed="${pressed ? 'true' : 'false'}" onclick="${onclick}"${testid ? ` data-testid="${testid}"` : ''}>
              <span class="studio-b-choice-icon" aria-hidden="true">${studioV2Icon(icon)}</span>
              <span class="studio-b-choice-text"><span class="studio-b-choice-title">${studioEsc(title)}</span>${hint ? `<span class="studio-b-choice-hint">${studioEsc(hint)}</span>` : ''}</span>
            </button>`;
}

function studioBuilderNote(text, tone = '', icon = 'info') {
  return `<p class="studio-b-note${tone ? ` is-${tone}` : ''}">${studioV2Icon(icon)}<span>${text}</span></p>`;
}

function studioBuilderInputHtml(id, field, value, options = {}) {
  const attrs = [
    `id="${id}"`, `class="studio-b-input"`, `type="${options.type || 'text'}"`, `value="${studioEsc(value)}"`,
    `oninput="studioBuilderInput('${field}', this)"`, 'autocomplete="off"'
  ];
  if (options.inputmode) attrs.push(`inputmode="${options.inputmode}"`);
  if (options.maxlength) attrs.push(`maxlength="${options.maxlength}"`);
  if (options.dir) attrs.push(`dir="${options.dir}"`);
  if (options.placeholder) attrs.push(`placeholder="${studioEsc(options.placeholder)}"`);
  if (options.min) attrs.push(`min="${options.min}"`);
  if (options.onchange) attrs.push(`onchange="studioBuilderInput('${field}', this)"`);
  return `<input ${attrs.join(' ')} />`;
}

// ---- step: goal (full 1)

function studioBuilderGoalStep(session) {
  const d = session.draft;
  const cards = studioBuilderGoalList().map((goal, index) => studioBuilderChoice(
    adsStudioIsAr() ? goal.ar : goal.en, adsStudioIsAr() ? goal.hintAr : goal.hintEn,
    d.goalDetail === goal.key, `studioBuilderSetGoal(${index})`, goal.icon, `studio-builder-goal-${goal.key}`
  )).join('');
  return `
          <h2 class="studio-b-title">${studioEsc(studioBuilderT('What should this ad bring you?', 'ماذا تريد أن يحقق لك هذا الإعلان؟'))}</h2>
          <button type="button" class="studio-b-shortcut" data-testid="studio-builder-to-boost" onclick="studioBuilderSwitchKind('boost')">
            ${studioV2Icon('rocket')}
            <span><span class="studio-b-choice-title">${studioEsc(studioBuilderT('Only want to promote a post?', 'تريد ترويج منشور فقط؟'))}</span>
            <span class="studio-b-choice-hint">${studioEsc(studioBuilderT('Quick boost: three short steps.', 'ترويج سريع: ثلاث خطوات قصيرة.'))}</span></span>
          </button>
          ${studioBuilderField(session, 'goal', 'goal', '', `<div class="studio-b-choices" role="group" aria-label="${studioEsc(studioBuilderT('Goal', 'الهدف'))}">${cards}</div>`)}`;
}

// ---- the page picker (full 2, quick boost 1)

function studioBuilderPagePicker(session, key) {
  const d = session.draft;
  const pages = _studioBuilder.pages;
  studioBuilderLoadPages();
  let body = '';
  const manual = !String(d.connectedAssetId || '');
  if (pages.state === '' || pages.state === 'loading') {
    body = studioBuilderNote(studioEsc(studioBuilderT('Loading your linked pages…', 'نحمّل صفحاتك المرتبطة…')), '', 'loader');
  } else if (pages.state === 'failed') {
    body = studioBuilderNote(studioEsc(studioBuilderT('Your linked pages could not be loaded. You can write the page name below.', 'تعذّر تحميل صفحاتك المرتبطة. يمكنك كتابة اسم الصفحة بالأسفل.') + (pages.error ? ` (${pages.error})` : '')), 'warn', 'triangle-alert')
      + `<button type="button" class="studio-b-link" onclick="studioBuilderRetryPages()">${studioV2Icon('refresh-cw')}<span>${studioEsc(studioBuilderT('Try again', 'أعد المحاولة'))}</span></button>`;
  } else if (pages.list.length) {
    body = `<div class="studio-b-choices" role="group" aria-label="${studioEsc(studioBuilderT('Your linked pages', 'صفحاتك المرتبطة'))}">${pages.list.map((page, index) => {
      const where = [page.fb ? 'Facebook' : '', page.ig ? 'Instagram' : ''].filter(Boolean).join(' · ');
      const health = page.healthy ? '' : studioBuilderT(' · needs attention', ' · تحتاج انتباهاً');
      return studioBuilderChoice(page.name || studioBuilderT('Page', 'صفحة'), `${where}${health}`, d.connectedAssetId === page.id, `studioBuilderChoosePage(${index})`, page.ig && !page.fb ? 'instagram' : 'facebook', `studio-builder-page-${index}`);
    }).join('')}${studioBuilderChoice(studioBuilderT('Another page', 'صفحة أخرى'), studioBuilderT('Not linked yet: write its name.', 'غير مرتبطة بعد: اكتب اسمها.'), manual && (session.otherPage || !!String(d.pageName || '').trim()), 'studioBuilderOtherPage()', 'pencil', 'studio-builder-page-other')}</div>`;
  } else {
    body = studioBuilderNote(studioEsc(studioBuilderT('No page is linked to your account yet. Write the page name, and ask us to link it so you can pick posts from a list.', 'لا توجد صفحة مرتبطة بحسابك بعد. اكتب اسم الصفحة، واطلب منا ربطها لتختار منشوراتك من قائمة.')), '', 'info');
  }
  const showName = manual && (pages.state !== 'done' || !pages.list.length || session.otherPage || !!String(d.pageName || '').trim());
  const nameBox = showName ? `
            <div class="studio-b-sub">
              ${studioBuilderLabel('studio-b-page-name', studioBuilderT('Page or account name', 'اسم الصفحة أو الحساب'))}
              ${studioBuilderInputHtml('studio-b-page-name', 'pageName', d.pageName || '', { maxlength: 160, placeholder: studioBuilderT('As it appears on Facebook or Instagram', 'كما يظهر على فيسبوك أو إنستغرام') })}
              ${pages.state === 'done' ? `<button type="button" class="studio-b-link" data-testid="studio-builder-request-link" onclick="studioBuilderOpenPages()">${studioV2Icon('link')}<span>${studioEsc(studioBuilderT('Ask us to link your page', 'اطلب منا ربط صفحتك'))}</span></button>` : ''}
            </div>` : '';
  return studioBuilderField(session, key, 'page', studioBuilderT('Which page runs the ad?', 'أي صفحة ستعرض الإعلان؟'), `<div aria-live="polite">${body}</div>${nameBox}`);
}

function studioBuilderPlatforms(session, key) {
  const list = Array.isArray(session.draft.platforms) ? session.draft.platforms : [];
  const chips = [['facebook', 'Facebook', 'فيسبوك'], ['instagram', 'Instagram', 'إنستغرام']]
    .map(([id, en, ar]) => studioBuilderChip(studioBuilderT(en, ar), list.includes(id), `studioBuilderTogglePlatform('${id}')`, `studio-builder-platform-${id}`, id)).join('');
  return studioBuilderField(session, key, 'platforms', studioBuilderT('Show it on', 'اعرضه على'), `<div class="studio-b-chips" role="group">${chips}</div>`);
}

function studioBuilderPageStep(session) {
  return `
          <h2 class="studio-b-title">${studioEsc(studioBuilderT('Your page', 'صفحتك'))}</h2>
          ${studioBuilderPagePicker(session, 'page')}
          ${studioBuilderPlatforms(session, 'page')}`;
}

// ---- photos (the classic upload path)

function studioBuilderPhotosHtml(session) {
  const d = session.draft;
  const images = studioBuilderPhotos(d);
  const omitted = !images.length && studioBuilderPhotoCount(d) > 0;
  const tiles = images.map((src, index) => `
              <div class="studio-b-photo">
                <img src="${studioEsc(src)}" alt="${studioEsc(studioBuilderT(`Ad photo ${index + 1}`, `صورة الإعلان ${index + 1}`))}" />
                <button type="button" class="studio-b-photo-remove" onclick="studioBuilderRemovePhoto(${index})" aria-label="${studioEsc(studioBuilderT('Remove photo', 'حذف الصورة'))}" title="${studioEsc(studioBuilderT('Remove photo', 'حذف الصورة'))}">${studioV2Icon('trash-2')}</button>
              </div>`).join('');
  const add = images.length < 3 ? `
              <button type="button" class="studio-b-photo-add" data-testid="studio-builder-add-photo" onclick="studioBuilderPickPhotos()">${studioV2Icon('image-plus')}<span>${studioEsc(studioBuilderT('Add photos', 'أضف صوراً'))}</span></button>` : '';
  return `${omitted ? studioBuilderNote(studioEsc(studioBuilderT('Your saved photos are kept.', 'صورك المحفوظة باقية.')), '', 'image') : ''}<div class="studio-b-photo-grid">${tiles}${add}</div>
            <p class="studio-b-hint">${studioEsc(studioBuilderT(`${images.length} of 3 · PNG, JPEG or WebP. You can also paste a photo here.`, `${images.length} من 3 · PNG أو JPEG أو WebP. يمكنك أيضاً لصق صورة هنا.`))}</p>`;
}

function studioBuilderPhotosField(session, key, label) {
  const control = `
            <div class="studio-b-photos" data-photo-paste-target="ads-studio" tabindex="0">
              <div id="studio-b-photos">${studioBuilderPhotosHtml(session)}</div>
              <div class="studio-b-row">
                <button type="button" class="studio-b-link" onclick="studioBuilderPastePhoto()">${studioV2Icon('clipboard-paste')}<span>${studioEsc(studioBuilderT('Paste a photo', 'الصق صورة'))}</span></button>
              </div>
              <input id="ads-studio-image-input" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onchange="studioBuilderPhotosChosen(this)" />
            </div>`;
  return studioBuilderField(session, key, 'photos', label, control);
}

function studioBuilderTextField(session, key, label, required) {
  const d = session.draft;
  const length = String(d.primaryText || '').length;
  const control = `<textarea id="studio-b-text" class="studio-b-input" rows="5" maxlength="2200" oninput="studioBuilderInput('text', this)" placeholder="${studioEsc(studioBuilderT('What should people know? Offer, price, how to order…', 'ماذا يجب أن يعرف الناس؟ العرض، السعر، طريقة الطلب…'))}">${studioEsc(d.primaryText || '')}</textarea>
              <p class="studio-b-count" id="studio-b-text-count">${length}/2200</p>`;
  return studioBuilderField(session, key, 'text', label, control, { forId: 'studio-b-text', hint: required ? '' : studioBuilderT('Optional.', 'اختياري.') });
}

function studioBuilderDestinationField(session, key) {
  const d = session.draft;
  return studioBuilderField(session, key, 'destination', studioBuilderT('Where should people go?', 'إلى أين يذهب الناس؟'),
    studioBuilderInputHtml('studio-b-destination', 'destination', d.destination || '', { maxlength: 500, dir: 'ltr', inputmode: 'url', placeholder: 'https://… · 091 234 5678' }),
    { forId: 'studio-b-destination', hint: studioBuilderT('A website, WhatsApp or Messenger link (https://…), or a phone number.', 'رابط موقع أو واتساب أو ماسنجر (https://…) أو رقم هاتف.') });
}

function studioBuilderPaintCount() {
  const session = _studioBuilder.session;
  const node = studioBuilderEl('studio-b-text-count');
  if (session && node) node.textContent = `${String(session.draft.primaryText || '').length}/2200`;
}

// ---- step: content (full 3)

function studioBuilderContentStep(session) {
  const d = session.draft;
  const options = ADS_STUDIO_CTA.map(([en, ar]) => `<option value="${studioEsc(en)}"${d.callToAction === en ? ' selected' : ''}>${studioEsc(studioBuilderT(en, ar))}</option>`).join('');
  return `
          <h2 class="studio-b-title">${studioEsc(studioBuilderT('What the ad says', 'محتوى الإعلان'))}</h2>
          ${studioBuilderTextField(session, 'content', studioBuilderT('Ad text', 'نص الإعلان'), true)}
          ${studioBuilderPhotosField(session, 'content', studioBuilderT('Photos (up to 3)', 'الصور (حتى 3)'))}
          ${studioBuilderField(session, 'content', 'headline', studioBuilderT('Headline', 'العنوان'), studioBuilderInputHtml('studio-b-headline', 'headline', d.headline || '', { maxlength: 255 }), { forId: 'studio-b-headline', hint: studioBuilderT('Optional: a few words under the photo.', 'اختياري: كلمات قليلة تحت الصورة.') })}
          ${studioBuilderField(session, 'content', 'cta', studioBuilderT('Button', 'الزر'), `<select id="studio-b-cta" class="studio-b-input" onchange="studioBuilderInput('cta', this)">${options}</select>`, { forId: 'studio-b-cta' })}
          ${studioBuilderDestinationField(session, 'content')}`;
}

// ---- audience (full 4; the places also on the quick boost's budget step)

function studioBuilderLocationChips(session) {
  const keys = studioBuilderLocationKeys(session.draft);
  const options = _studioBuilder.options;
  studioBuilderLoadOptions();
  const chips = studioBuilderLocationList().map((item, index) => studioBuilderChip(
    adsStudioIsAr() ? item.ar : item.en, keys.includes(item.key), `studioBuilderToggleLocation(${index})`, `studio-builder-place-${item.key}`, item.key === STUDIO_BUILDER_LIBYA ? 'map' : ''
  )).join('');
  const more = options.state === 'failed'
    ? studioBuilderNote(studioEsc(studioBuilderT('The list of cities could not be loaded.', 'تعذّر تحميل قائمة المدن.')), 'warn', 'triangle-alert')
    : (options.state !== 'done' ? studioBuilderNote(studioEsc(studioBuilderT('Loading the cities…', 'نحمّل المدن…')), '', 'loader') : '');
  return `<div class="studio-b-chips" role="group" aria-label="${studioEsc(studioBuilderT('Places', 'الأماكن'))}">${chips}</div>${more}`;
}

function studioBuilderAudienceStep(session) {
  const d = session.draft;
  const gender = (Array.isArray(d.genders) ? d.genders : [])[0] || 'all';
  const genders = [['all', 'Everyone', 'الجميع'], ['female', 'Women', 'النساء'], ['male', 'Men', 'الرجال']]
    .map(([id, en, ar]) => studioBuilderChip(studioBuilderT(en, ar), gender === id, `studioBuilderSetGender('${id}')`, `studio-builder-gender-${id}`)).join('');
  const typedMin = session.typed.ageMin !== undefined ? session.typed.ageMin : String(Number(d.ageMin) || 18);
  const typedMax = session.typed.ageMax !== undefined ? session.typed.ageMax : String(Number(d.ageMax) || 65);
  const special = (Array.isArray(d.specialAdCategories) ? d.specialAdCategories : [])[0] || '';
  const specialOptions = STUDIO_BUILDER_SPECIAL.map(([key, en, ar]) => `<option value="${key}"${special === key ? ' selected' : ''}>${studioEsc(studioBuilderT(en, ar))}</option>`).join('');
  return `
          <h2 class="studio-b-title">${studioEsc(studioBuilderT('Who should see it?', 'من يجب أن يرى الإعلان؟'))}</h2>
          ${studioBuilderField(session, 'audience', 'locations', studioBuilderT('Where in Libya', 'أين في ليبيا'), studioBuilderLocationChips(session), { hint: studioBuilderT('Pick cities, or keep all of Libya.', 'اختر مدناً أو اترك كل ليبيا.') })}
          ${studioBuilderField(session, 'audience', 'ages', studioBuilderT('Age', 'العمر'), `
            <div class="studio-b-pair">
              <div>${studioBuilderLabel('studio-b-age-min', studioBuilderT('From', 'من'))}${studioBuilderInputHtml('studio-b-age-min', 'ageMin', typedMin, { inputmode: 'numeric', maxlength: 3 })}</div>
              <div>${studioBuilderLabel('studio-b-age-max', studioBuilderT('To', 'إلى'))}${studioBuilderInputHtml('studio-b-age-max', 'ageMax', typedMax, { inputmode: 'numeric', maxlength: 3 })}</div>
            </div>
            <div class="studio-b-chips" role="group" aria-label="${studioEsc(studioBuilderT('Gender', 'الجنس'))}">${genders}</div>`)}
          ${studioBuilderField(session, 'audience', 'special', studioBuilderT('Is the ad about any of these?', 'هل يتعلق الإعلان بأحد هذه المواضيع؟'), `<select id="studio-b-special" class="studio-b-input" onchange="studioBuilderInput('special', this)">${specialOptions}</select>`, { forId: 'studio-b-special', hint: studioBuilderT('Meta has extra rules for these ads; the team checks them.', 'لدى ميتا قواعد إضافية لهذه الإعلانات، ويراجعها الفريق.') })}
          ${studioBuilderNote(studioEsc(studioBuilderT('Meta finds the people most likely to respond inside what you choose here.', 'تجد ميتا الأشخاص الأكثر تفاعلاً ضمن ما تختاره هنا.')), '', 'sparkles')}`;
}

// ---- budget & days (full 5, quick boost 2)

function studioBuilderPresets(session) {
  const limits = studioBuilderLimits();
  const days = Number(session.draft.durationDays);
  const floor = Number.isSafeInteger(days) && days > 0 ? limits.minPerDayMinorUSD * days : limits.minPerDayMinorUSD;
  return STUDIO_BUILDER_PRESETS
    .filter(minor => minor >= limits.minTotalMinorUSD && minor <= limits.maxTotalMinorUSD && minor >= floor).slice(0, 4);
}

function studioBuilderPresetChips(session) {
  const d = session.draft;
  return studioBuilderPresets(session).map((minor, index) => studioBuilderChip(studioUsd(minor), Number(d.budgetMinorUSD) === minor, `studioBuilderPreset(${minor})`, `studio-builder-preset-${index}`)).join('');
}

function studioBuilderTotalText(session) {
  const d = session.draft;
  const days = Number(d.durationDays);
  const total = studioBuilderTotalMinor(d);
  if (!(Number.isSafeInteger(days) && days > 0) || !(total > 0)) return studioBuilderT('Choose the amount and the days to see the total.', 'اختر المبلغ والأيام لترى الإجمالي.');
  if (d.budgetType === 'daily') {
    return studioBuilderT(`Total: ${studioUsd(total)} (${studioUsd(d.budgetMinorUSD)} a day × ${adsStudioDaysText(days)})`, `الإجمالي: ${studioUsd(total)} (${studioUsd(d.budgetMinorUSD)} يومياً × ${adsStudioDaysText(days)})`);
  }
  return studioBuilderT(`Total: ${studioUsd(total)} for ${adsStudioDaysText(days)} (about ${studioUsd(Math.floor(total / days))} a day)`, `الإجمالي: ${studioUsd(total)} لمدة ${adsStudioDaysText(days)} (نحو ${studioUsd(Math.floor(total / days))} يومياً)`);
}

function studioBuilderLimitsText() {
  const limits = studioBuilderLimits();
  return studioBuilderT(
    `A request totals ${studioUsd(limits.minTotalMinorUSD)} – ${studioUsd(limits.maxTotalMinorUSD)}, at least ${studioUsd(limits.minPerDayMinorUSD)} a day, up to ${adsStudioDaysText(limits.maxDays)}.`,
    `إجمالي الطلب من ${studioUsd(limits.minTotalMinorUSD)} إلى ${studioUsd(limits.maxTotalMinorUSD)}، ولا يقل عن ${studioUsd(limits.minPerDayMinorUSD)} يومياً، وحتى ${adsStudioDaysText(limits.maxDays)}.`
  );
}

function studioBuilderWalletHtml(session) {
  studioBuilderLoadWallet();
  const wallet = studioBuilderWallet();
  if (wallet.failed) {
    return `<p class="studio-b-wallet-line">${studioEsc(studioBuilderT('We could not read your wallet right now. It is checked again when you send.', 'تعذّرت قراءة محفظتك الآن. نتحقق منها مرة أخرى عند الإرسال.'))}</p>`;
  }
  if (!wallet.value) return `<p class="studio-b-wallet-line">${studioEsc(studioBuilderT('Checking your wallet…', 'نتحقق من محفظتك…'))}</p>`;
  const available = wallet.value.availableMinor;
  if (available === null) return '';
  const total = studioBuilderTotalMinor(session.draft);
  let html = `<p class="studio-b-wallet-line" data-testid="studio-builder-wallet">${studioBuilderT(`You have ${studioLtr(studioUsd(available))} available.`, `لديك ${studioLtr(studioUsd(available))} متاحة.`)}</p>`;
  if (total > 0 && available >= total) {
    html += `<p class="studio-b-wallet-line is-ok">${studioBuilderT(`Enough. Sending holds ${studioLtr(studioUsd(total))}; it is charged only if the team approves.`, `يكفي. عند الإرسال نحجز ${studioLtr(studioUsd(total))}، ولا تُخصم إلا إذا وافق الفريق.`)}</p>`;
  } else if (total > 0) {
    const short = total - Math.max(0, available);
    html += `<p class="studio-b-wallet-line is-short" data-testid="studio-builder-wallet-short">${studioBuilderT(`Short by ${studioLtr(studioUsd(short))} for this ad.`, `ينقصك ${studioLtr(studioUsd(short))} لهذا الإعلان.`)}</p>`;
    const pending = wallet.value.pending[0];
    if (pending) {
      const amount = pending.amountMinor !== null ? ` (${studioLtr(studioUsd(pending.amountMinor))})` : '';
      html += `<p class="studio-b-wallet-line is-pending" data-testid="studio-builder-pending">${studioBuilderT(`Waiting for your payment ${studioLtr(pending.reference)}${amount} to be confirmed. You can send once it is.`, `بانتظار تأكيد دفعتك ${studioLtr(pending.reference)}${amount}. يمكنك الإرسال بعد تأكيدها.`)}</p>`;
    }
    html += `<button type="button" class="studio-b-link is-strong" data-testid="studio-builder-add-money" onclick="studioBuilderAddMoney()">${studioV2Icon('wallet')}<span>${studioEsc(studioBuilderT('Add money', 'أضف رصيداً'))}</span></button>`;
  }
  return html;
}

// The budget lines update in place while the customer types (the keyboard stays open), the
// suggested totals too (typed days move the per-day floor).
function studioBuilderPaintBudget() {
  const session = _studioBuilder.session;
  if (!session) return;
  const total = studioBuilderEl('studio-b-total');
  if (total) total.textContent = studioBuilderTotalText(session);
  const presets = studioBuilderEl('studio-b-presets');
  if (presets) {
    const chips = session.draft.budgetType === 'daily' ? '' : studioBuilderPresetChips(session);
    presets.innerHTML = chips;
    presets.hidden = !chips;
  }
  studioBuilderPaintWallet();
}

function studioBuilderPaintWallet() {
  const session = _studioBuilder.session;
  if (!session) return;
  const box = studioBuilderEl('studio-b-wallet');
  if (box) {
    box.innerHTML = studioBuilderWalletHtml(session);
    studioBuilderIcons(box);
  }
  const send = studioBuilderEl('studio-b-send');
  if (send && send.getAttribute('aria-busy') !== 'true') send.disabled = studioBuilderSendBlocked(session);
}

function studioBuilderBudgetStep(session) {
  const d = session.draft;
  const limits = studioBuilderLimits();
  const daily = d.budgetType === 'daily';
  const typedBudget = session.typed.budget !== undefined ? session.typed.budget
    : (Number(d.budgetMinorUSD) > 0 ? (Number(d.budgetMinorUSD) / 100).toFixed(2).replace(/\.00$/, '') : '');
  const days = Number(d.durationDays);
  const typedDays = session.typed.days !== undefined ? session.typed.days : (Number.isSafeInteger(days) && days > 0 ? String(days) : '');
  const types = [['lifetime', 'Total for the whole ad', 'مبلغ إجمالي للإعلان كله'], ['daily', 'An amount per day', 'مبلغ لكل يوم']]
    .map(([id, en, ar]) => studioBuilderChip(studioBuilderT(en, ar), d.budgetType === id, `studioBuilderSetBudgetType('${id}')`, `studio-builder-budget-${id}`)).join('');
  const presets = daily ? '' : studioBuilderPresetChips(session);
  const dayChips = [3, 7, 14, 30].filter(n => n <= limits.maxDays)
    .map(n => studioBuilderChip(adsStudioDaysText(n), days === n, `studioBuilderSetDays(${n})`, `studio-builder-days-${n}`)).join('');
  const amount = `
            <div class="studio-b-money" dir="ltr">
              <span class="studio-b-money-sign" aria-hidden="true">$</span>
              ${studioBuilderInputHtml('studio-b-budget', 'budget', typedBudget, { inputmode: 'decimal', maxlength: 20, dir: 'ltr' })}
            </div>
            ${daily ? '' : `<div class="studio-b-chips" id="studio-b-presets" role="group" aria-label="${studioEsc(studioBuilderT('Suggested totals', 'مبالغ مقترحة'))}"${presets ? '' : ' hidden'}>${presets}</div>`}`;
  let start = '';
  if (session.kind === 'full') {
    const modes = [['asap', 'As soon as approved (recommended)', 'فور الموافقة (مُستحسن)'], ['date', 'On a date I choose', 'في تاريخ أختاره']]
      .map(([id, en, ar]) => studioBuilderChip(studioBuilderT(en, ar), session.startMode === id, `studioBuilderSetStartMode('${id}')`, `studio-builder-start-${id}`)).join('');
    const picker = session.startMode === 'date'
      ? `<div class="studio-b-sub">${studioBuilderLabel('studio-b-start', studioBuilderT('Start date (Libya time)', 'تاريخ البدء (بتوقيت ليبيا)'))}${studioBuilderInputHtml('studio-b-start', 'start', d.startDate || '', { type: 'date', min: studioBuilderToday(), onchange: true })}</div>`
      : '';
    start = studioBuilderField(session, 'budget', 'start', studioBuilderT('When should it start?', 'متى يبدأ؟'), `<div class="studio-b-chips" role="group">${modes}</div>${picker}`);
  }
  const places = session.kind === 'boost' ? `
          <details class="studio-b-details"${session.audienceOpen || (session.highlight && session.highlight.field === 'locations') || session.shown.budget ? ' open' : ''}>
            <summary>${studioV2Icon('map-pin')}<span>${studioEsc(studioBuilderT('Who sees it:', 'من يراه:'))} ${studioEsc(studioBuilderPlacesText(d) || '—')}</span></summary>
            ${studioBuilderField(session, 'budget', 'locations', '', studioBuilderLocationChips(session))}
          </details>` : '';
  const budgetControl = `<div class="studio-b-chips" role="group" aria-label="${studioEsc(studioBuilderT('Budget type', 'نوع الميزانية'))}">${types}</div>
            <div class="studio-b-sub">
              ${studioBuilderLabel('studio-b-budget', daily ? studioBuilderT('Amount per day in US dollars', 'المبلغ لكل يوم بالدولار الأمريكي') : studioBuilderT('Total in US dollars', 'الإجمالي بالدولار الأمريكي'))}
              ${amount}
            </div>`;
  return `
          <h2 class="studio-b-title">${studioEsc(studioBuilderT('Budget and days', 'الميزانية والمدة'))}</h2>
          ${studioBuilderField(session, 'budget', 'budget', studioBuilderT('How much do you want to spend?', 'كم تريد أن تصرف؟'), budgetControl)}
          ${studioBuilderField(session, 'budget', 'days', studioBuilderT('How many days?', 'كم يوماً؟'), `<div class="studio-b-chips" role="group">${dayChips}</div>
            <div class="studio-b-sub">${studioBuilderLabel('studio-b-days', studioBuilderT('Or type the number of days', 'أو اكتب عدد الأيام'))}${studioBuilderInputHtml('studio-b-days', 'days', typedDays, { inputmode: 'numeric', maxlength: 3 })}</div>`)}
          ${start}
          <div class="studio-b-box" aria-live="polite">
            <p class="studio-b-total" id="studio-b-total" data-testid="studio-builder-total">${studioEsc(studioBuilderTotalText(session))}</p>
            <p class="studio-b-hint">${studioEsc(studioBuilderLimitsText())}</p>
            <div class="studio-b-wallet${session.highlight && session.highlight.field === 'wallet' ? ' is-fix' : ''}" id="studio-b-wallet" data-field="wallet">${studioBuilderWalletHtml(session)}</div>
          </div>
          ${places}`;
}

// ---- quick boost 1: what to promote

function studioBuilderPostPicker(session) {
  const d = session.draft;
  const pages = _studioBuilder.pages;
  studioBuilderLoadPages();
  const linkedPage = pages.state === 'done' ? pages.list.find(page => page.id === pages.pageId) : null;
  let list = '';
  let fallback = pages.state === 'failed' || (pages.state === 'done' && !pages.list.length) || session.pasteLink
    || (!String(d.sourcePostId || '') && !!String(d.sourcePostRef || '').trim());
  if (linkedPage) {
    studioBuilderLoadPosts(linkedPage.id);
    const entry = pages.posts[linkedPage.id];
    const pageChips = pages.list.length > 1 ? `<div class="studio-b-chips" role="group" aria-label="${studioEsc(studioBuilderT('Your linked pages', 'صفحاتك المرتبطة'))}">${pages.list.map((page, index) => studioBuilderChip(page.name || studioBuilderT('Page', 'صفحة'), page.id === linkedPage.id, `studioBuilderChoosePage(${index})`, `studio-builder-page-${index}`)).join('')}</div>` : '';
    if (!entry || (entry.state === 'loading' && !entry.posts.length)) {
      list = studioBuilderNote(studioEsc(studioBuilderT('Loading your recent posts…', 'نحمّل آخر منشوراتك…')), '', 'loader');
    } else {
      const unread = entry.state === 'done' ? adsStudioUnreadPostPlatforms(entry) : [];
      let problem = '';
      if (entry.state === 'failed' || unread.length) {
        fallback = true;
        const detail = entry.state === 'failed' ? entry.error : adsStudioUnreadPostsDetail(entry, unread);
        problem = studioBuilderNote(studioEsc(studioBuilderT('We could not read your posts from Meta right now. You can paste the post link below.', 'تعذّر علينا قراءة منشوراتك من ميتا الآن. يمكنك لصق رابط المنشور بالأسفل.') + (detail ? ` (${detail})` : '')), 'warn', 'triangle-alert')
          + `<button type="button" class="studio-b-link" onclick="studioBuilderRetryPosts()">${studioV2Icon('refresh-cw')}<span>${studioEsc(studioBuilderT('Try again', 'أعد المحاولة'))}</span></button>`;
      }
      const posts = entry.posts.map((post, index) => {
        const excerpt = post.excerpt.length > 140 ? `${post.excerpt.slice(0, 140)}…` : post.excerpt;
        const date = adsStudioPostDateText(post.createdAt);
        return `<button type="button" class="studio-b-post" data-post-id="${studioEsc(post.id)}" data-testid="studio-builder-post-${index}" aria-pressed="${d.sourcePostId === post.id ? 'true' : 'false'}" onclick="studioBuilderChoosePost(${index}, this)">
                ${post.imageUrl ? `<img src="${studioEsc(post.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<span class="studio-b-post-empty" aria-hidden="true">${studioV2Icon('image')}</span>`}
                <span class="studio-b-post-text"><span class="studio-b-post-excerpt">${studioEsc(excerpt || studioBuilderT('A post without text', 'منشور بدون نص'))}</span><span class="studio-b-post-meta">${studioV2Icon(post.platform === 'ig' ? 'instagram' : 'facebook')}${studioEsc(date)}</span></span>
              </button>`;
      }).join('');
      const empty = entry.state === 'done' && !entry.posts.length && !problem
        ? studioBuilderNote(studioEsc(studioBuilderT('No recent posts on this page. Post something and try again, or choose "A new ad without a post".', 'لا توجد منشورات حديثة على هذه الصفحة. انشر شيئاً ثم أعد المحاولة، أو اختر «إعلان جديد بدون منشور».')), '', 'info')
          + `<button type="button" class="studio-b-link" onclick="studioBuilderRetryPosts()">${studioV2Icon('refresh-cw')}<span>${studioEsc(studioBuilderT('Try again', 'أعد المحاولة'))}</span></button>`
        : '';
      list = `${problem}${empty}${posts ? `<div class="studio-b-posts">${posts}</div>` : ''}`;
    }
    list = pageChips + list;
    if (!fallback) list += `<button type="button" class="studio-b-link" data-testid="studio-builder-paste-link" onclick="studioBuilderShowPasteLink()">${studioV2Icon('link')}<span>${studioEsc(studioBuilderT('Paste a post link instead', 'الصق رابط منشور بدلاً من ذلك'))}</span></button>`;
  } else if (pages.state === '' || pages.state === 'loading') {
    list = studioBuilderNote(studioEsc(studioBuilderT('Loading your linked pages…', 'نحمّل صفحاتك المرتبطة…')), '', 'loader');
  } else if (pages.state === 'failed') {
    list = studioBuilderNote(studioEsc(studioBuilderT('Your pages could not be loaded. Paste the post link below.', 'تعذّر تحميل صفحاتك. الصق رابط المنشور بالأسفل.') + (pages.error ? ` (${pages.error})` : '')), 'warn', 'triangle-alert')
      + `<button type="button" class="studio-b-link" onclick="studioBuilderRetryPages()">${studioV2Icon('refresh-cw')}<span>${studioEsc(studioBuilderT('Try again', 'أعد المحاولة'))}</span></button>`;
  } else {
    list = studioBuilderNote(studioEsc(studioBuilderT('No page is linked to your account yet, so paste the link of the post below. Ask us to link your page to pick posts from a list next time.', 'لا توجد صفحة مرتبطة بحسابك بعد، فالصق رابط المنشور بالأسفل. اطلب منا ربط صفحتك لتختار منشوراتك من قائمة في المرة القادمة.')), '', 'info')
      + `<button type="button" class="studio-b-link" data-testid="studio-builder-request-link" onclick="studioBuilderOpenPages()">${studioV2Icon('link')}<span>${studioEsc(studioBuilderT('Ask us to link your page', 'اطلب منا ربط صفحتك'))}</span></button>`;
  }
  const link = fallback ? `
            <div class="studio-b-sub">
              ${studioBuilderLabel('studio-b-post-link', studioBuilderT('Link to your post', 'رابط منشورك'))}
              ${studioBuilderInputHtml('studio-b-post-link', 'postLink', d.sourcePostRef || '', { maxlength: 500, dir: 'ltr', inputmode: 'url', placeholder: 'https://www.facebook.com/…' })}
              <p class="studio-b-hint">${studioEsc(studioBuilderT('Open the post on Facebook or Instagram, copy its link and paste it here.', 'افتح المنشور على فيسبوك أو إنستغرام وانسخ رابطه والصقه هنا.'))}</p>
            </div>` : '';
  const needsName = !String(d.connectedAssetId || '');
  const name = needsName && (pages.state !== 'done' || !pages.list.length || fallback) ? `
            <div class="studio-b-sub" data-field="page">
              ${studioBuilderLabel('studio-b-page-name', studioBuilderT('Page or account name', 'اسم الصفحة أو الحساب'))}
              ${studioBuilderInputHtml('studio-b-page-name', 'pageName', d.pageName || '', { maxlength: 160 })}
              <p class="studio-b-error" id="studio-b-err-page" data-testid="studio-builder-error-page" role="alert"${session.shown.promote && studioBuilderPageProblem(session) ? '' : ' hidden'}>${studioEsc(session.shown.promote ? studioBuilderPageProblem(session) : '')}</p>
            </div>` : '';
  return studioBuilderField(session, 'promote', 'post', studioBuilderT('Choose the post', 'اختر المنشور'), `<div aria-live="polite">${list}</div>${link}`) + name;
}

function studioBuilderPromoteStep(session) {
  const d = session.draft;
  const kinds = studioBuilderChoice(studioBuilderT('A post from your page', 'منشور من صفحتك'), studioBuilderT('Promote something you already posted.', 'روّج لشيء نشرته من قبل.'), d.boostType === 'boost_post', "studioBuilderSetBoostKind('boost_post')", 'rocket', 'studio-builder-kind-post')
    + studioBuilderChoice(studioBuilderT('A new ad without a post', 'إعلان جديد بدون منشور'), studioBuilderT('Your own photo and a short text.', 'صورتك ونص قصير.'), d.boostType === 'boost_page', "studioBuilderSetBoostKind('boost_page')", 'image-plus', 'studio-builder-kind-new');
  const body = d.boostType === 'boost_page' ? `
          ${studioBuilderPagePicker(session, 'promote')}
          ${studioBuilderTextField(session, 'promote', studioBuilderT('A short text', 'نص قصير'), true)}
          ${studioBuilderPhotosField(session, 'promote', studioBuilderT('Photo', 'الصورة'))}
          ${studioBuilderDestinationField(session, 'promote')}` : studioBuilderPostPicker(session);
  return `
          <h2 class="studio-b-title">${studioEsc(studioBuilderT('What do you want to promote?', 'ماذا تريد أن تروّج؟'))}</h2>
          <div class="studio-b-choices is-two" role="group">${kinds}</div>
          ${body}
          <button type="button" class="studio-b-link" data-testid="studio-builder-to-full" onclick="studioBuilderSwitchKind('full')">${studioV2Icon('sliders-horizontal')}<span>${studioEsc(studioBuilderT('More options (full request)', 'خيارات أكثر (طلب كامل)'))}</span></button>`;
}

// ---- review & send

function studioBuilderSummaryRows(session) {
  const d = session.draft;
  const rows = [];
  const pageText = [String(d.pageName || '').trim(), (Array.isArray(d.platforms) ? d.platforms : []).map(p => p === 'instagram' ? studioBuilderT('Instagram', 'إنستغرام') : studioBuilderT('Facebook', 'فيسبوك')).join(' + ')].filter(Boolean).join(' · ');
  if (session.kind === 'boost') {
    if (d.boostType === 'boost_post') {
      const chosen = String(d.sourcePostId || '') ? studioBuilderT('A post from your page', 'منشور من صفحتك') : (String(d.sourcePostRef || '') || '—');
      rows.push(['post', studioBuilderT('Post', 'المنشور'), chosen]);
    } else {
      rows.push(['text', studioBuilderT('Text', 'النص'), String(d.primaryText || '').slice(0, 140) || '—']);
      rows.push(['photos', studioBuilderT('Photos', 'الصور'), String(studioBuilderPhotoCount(d))]);
      rows.push(['destination', studioBuilderT('Link', 'الرابط'), studioBuilderDestination(d.destination) || '—']);
    }
    rows.push(['page', studioBuilderT('Page', 'الصفحة'), pageText || '—']);
  } else {
    const goal = studioBuilderGoal(String(d.goalDetail || ''));
    rows.push(['goal', studioBuilderT('Goal', 'الهدف'), goal ? (adsStudioIsAr() ? goal.ar : goal.en) : '—']);
    rows.push(['page', studioBuilderT('Page', 'الصفحة'), pageText || '—']);
    rows.push(['text', studioBuilderT('Text', 'النص'), String(d.primaryText || '').slice(0, 140) || '—']);
    rows.push(['photos', studioBuilderT('Photos', 'الصور'), String(studioBuilderPhotoCount(d))]);
    const cta = ADS_STUDIO_CTA.find(([en]) => en === d.callToAction);
    rows.push(['cta', studioBuilderT('Button', 'الزر'), cta ? studioBuilderT(cta[0], cta[1]) : '—']);
    rows.push(['destination', studioBuilderT('Link', 'الرابط'), studioBuilderDestination(d.destination) || '—']);
  }
  const places = studioBuilderPlacesText(d);
  const gender = { all: studioBuilderT('everyone', 'الجميع'), female: studioBuilderT('women', 'النساء'), male: studioBuilderT('men', 'الرجال') }[(d.genders || [])[0] || 'all'];
  rows.push(['locations', studioBuilderT('Audience', 'الجمهور'), `${places || '—'} · ${Number(d.ageMin) || 18}–${Number(d.ageMax) || 65} · ${gender}`]);
  rows.push(['budget', studioBuilderT('Budget', 'الميزانية'), studioBuilderTotalText(session)]);
  const days = Number(d.durationDays) || 0;
  const schedule = session.kind === 'boost' || session.startMode === 'asap'
    ? studioBuilderT(`Starts when approved and runs ${adsStudioDaysText(days)}`, `يبدأ عند الموافقة ويعمل ${adsStudioDaysText(days)}`)
    : studioBuilderT(`From ${d.startDate} for ${adsStudioDaysText(days)}`, `من ${d.startDate} لمدة ${adsStudioDaysText(days)}`);
  rows.push(['days', studioBuilderT('Days', 'المدة'), schedule]);
  return rows;
}

function studioBuilderSendBlocked(session) {
  return !!_studioBuilder.submit || studioBuilderIntakePaused() || studioBuilderWalletShort(session)
    || ['conflict', 'locked'].includes(session.status) || !adsStudioCanUse();
}

function studioBuilderReviewStep(session) {
  const d = session.draft;
  if (typeof studioLoadMe === 'function') studioLoadMe(60000);  // the intake switch can change while the form is open
  const problems = studioBuilderAllProblems(session).filter(item => item.key !== 'review');
  const rows = studioBuilderSummaryRows(session).map(([field, label, value]) => `
              <div class="studio-b-summary-row"><dt>${studioEsc(label)}</dt><dd>${studioEsc(value)}</dd>
                <button type="button" class="studio-b-edit" onclick="studioBuilderGoToField('${field}')" aria-label="${studioEsc(studioBuilderT(`Change: ${label}`, `تغيير: ${label}`))}" title="${studioEsc(studioBuilderT('Change', 'تغيير'))}">${studioV2Icon('pencil')}</button></div>`).join('');
  const list = problems.length ? `
          <div class="studio-b-problems${_studioBuilder.pendingFocus === 'problems' ? ' is-fix' : ''}" data-field="problems" data-testid="studio-builder-problems" role="alert">
            <p class="studio-b-label">${studioEsc(studioBuilderT('Before you send, fix these:', 'قبل الإرسال، أصلح ما يلي:'))}</p>
            <ul>${problems.map(item => {
              const name = STUDIO_BUILDER_FIELD_NAMES[item.field] || STUDIO_BUILDER_FIELD_NAMES.note;
              return `<li><span>${studioEsc(item.text)}</span><button type="button" class="studio-b-link is-strong" data-testid="studio-builder-fix-${item.field}" onclick="studioBuilderGoToField('${item.field}')">${studioEsc(studioBuilderT(`Fix: ${name[0]}`, `أصلح: ${name[1]}`))}</button></li>`;
            }).join('')}</ul>
          </div>` : '';
  const total = studioBuilderTotalMinor(d);
  const days = Number(d.durationDays) || 0;
  const paused = studioBuilderIntakePaused();
  const next = [
    studioBuilderT(`We hold ${studioLtr(studioUsd(total))} in your wallet. It is not charged yet.`, `نحجز ${studioLtr(studioUsd(total))} في محفظتك، ولا تُخصم بعد.`),
    studioEsc(studioBuilderT('The Albayan team checks your request on working days.', 'يراجع فريق البيان طلبك في أيام العمل.')),
    studioEsc(studioBuilderT('If it is approved we charge it and set the ad up in Meta; Meta reviews it too, usually within a day.', 'إذا وافقنا نخصم المبلغ ونجهّز الإعلان في ميتا، وتراجعه ميتا أيضاً عادةً خلال يوم.')),
    studioEsc(studioBuilderT(`It runs ${adsStudioDaysText(days)}. What Meta does not use comes back to your wallet.`, `يعمل ${adsStudioDaysText(days)}، وما لا تصرفه ميتا يعود إلى محفظتك.`))
  ];
  return `
          <h2 class="studio-b-title">${studioEsc(studioBuilderT('Check and send', 'راجع وأرسل'))}</h2>
          ${list}
          <dl class="studio-b-summary">${rows}</dl>
          ${studioBuilderField(session, 'review', 'name', studioBuilderT('Request name (for you and the team)', 'اسم الطلب (لك وللفريق)'), studioBuilderInputHtml('studio-b-name', 'name', d.name || '', { maxlength: 120 }), { forId: 'studio-b-name' })}
          ${studioBuilderField(session, 'review', 'notes', studioBuilderT('Anything the team should know?', 'هل هناك ما يجب أن يعرفه الفريق؟'), `<textarea id="studio-b-notes" class="studio-b-input" rows="3" maxlength="1000" oninput="studioBuilderInput('notes', this)">${studioEsc(d.notes || '')}</textarea>`, { forId: 'studio-b-notes', hint: studioBuilderT('Optional.', 'اختياري.') })}
          <div class="studio-b-box">
            <p class="studio-b-label">${studioEsc(studioBuilderT('What happens next', 'ماذا يحدث بعد ذلك'))}</p>
            <ol class="studio-b-steps-next">${next.map(line => `<li>${line}</li>`).join('')}</ol>
            <div class="studio-b-wallet" id="studio-b-wallet" data-field="wallet">${studioBuilderWalletHtml(session)}</div>
          </div>
          ${studioBuilderField(session, 'review', 'rights', '', `<label class="studio-b-check" for="studio-b-rights"><input id="studio-b-rights" type="checkbox"${session.rights ? ' checked' : ''} onchange="studioBuilderSetRights(this)" /><span>${studioEsc(studioBuilderT('The details are correct, and I have the right to use this text, these photos and this page.', 'البيانات صحيحة، ولي الحق في استخدام هذا النص وهذه الصور وهذه الصفحة.'))}</span></label>`)}
          ${paused ? `<p class="studio-b-banner is-warn" data-testid="studio-builder-paused" role="status">${studioV2Icon('pause')}<span>${studioEsc(studioBuilderT('Sending is paused for now — we will let you know when it is back. Your draft is saved.', 'الإرسال متوقف مؤقتاً — سنخبرك عند الاستئناف. مسودتك محفوظة.'))}</span></p>` : ''}
          ${session.sendError ? `<p class="studio-b-banner is-danger" data-testid="studio-builder-send-error" role="alert">${studioV2Icon('triangle-alert')}<span>${studioEsc(session.sendError)}</span></p>` : ''}`;
}

// ---- the frame of the builder: banners, steps, body, footer

function studioBuilderBanners(session) {
  const out = [];
  if (session.status === 'locked') {
    out.push(`<div class="studio-b-banner is-warn" data-testid="studio-builder-locked" role="status">${studioV2Icon('lock')}<span>${studioEsc(studioBuilderT('This request was already sent or decided, so it can no longer be changed here.', 'أُرسل هذا الطلب أو اتُّخذ فيه قرار، فلم يعد بالإمكان تعديله هنا.'))}</span>
            <button type="button" class="studio-b-link is-strong" onclick="studioBuilderOpenMyAds()">${studioEsc(studioBuilderT('Open My ads', 'افتح إعلاناتي'))}</button></div>`);
  } else if (session.status === 'error' && session.quota) {
    out.push(`<div class="studio-b-banner is-warn" data-testid="studio-builder-quota" role="alert">${studioV2Icon('triangle-alert')}<span>${studioEsc(session.statusText)}</span>
            <button type="button" class="studio-b-link is-strong" onclick="studioBuilderOpenMyAds()">${studioEsc(studioBuilderT('Open My ads', 'افتح إعلاناتي'))}</button></div>`);
  } else if (session.status === 'conflict') {
    out.push(`<div class="studio-b-banner is-warn" data-testid="studio-builder-conflict" role="alert">${studioV2Icon('triangle-alert')}<span>${studioEsc(studioBuilderT('This draft was changed on another device. Nothing was overwritten.', 'تغيّرت هذه المسودة على جهاز آخر. لم يُستبدل شيء.'))}</span>
            <span class="studio-b-banner-actions"><button type="button" class="studio-b-link is-strong" onclick="studioBuilderUseOther(this)">${studioEsc(studioBuilderT('Show the other version', 'اعرض النسخة الأخرى'))}</button>
            <button type="button" class="studio-b-link" onclick="studioBuilderKeepMine()">${studioEsc(studioBuilderT('Keep mine', 'احتفظ بنسختي'))}</button></span></div>`);
  }
  if (session.review && session.campaignStatus === 'Changes Requested') {
    const reason = adsStudioReviewReasonLabel(session.review.reason);
    const field = STUDIO_BUILDER_FIX[session.review.reason] || 'note';
    const fix = session.highlight && session.highlight.field === 'note';
    out.push(`<div class="studio-b-banner is-orange${fix ? ' is-fix' : ''}" data-field="note" data-testid="studio-builder-fix-banner" role="status">${studioV2Icon('message-square-warning')}
            <span><strong>${studioEsc(studioBuilderT('The team asked for a change', 'طلب الفريق تعديلاً'))}${reason ? ` · ${studioEsc(reason)}` : ''}</strong>${session.review.note ? `<span class="studio-b-banner-note">${studioEsc(session.review.note)}</span>` : ''}</span>
            <button type="button" class="studio-b-link is-strong" data-testid="studio-builder-fix-reason" onclick="studioBuilderGoToField('${field}')">${studioEsc(studioBuilderFixLabel(session.review.reason, session.kind, session.draft))}</button></div>`);
  }
  if (session.resumed) {
    out.push(`<div class="studio-b-banner" data-testid="studio-builder-resumed" role="status">${studioV2Icon('history')}<span>${studioEsc(studioBuilderT('You are continuing your saved draft.', 'أنت تكمل مسودتك المحفوظة.'))}</span>
            <button type="button" class="studio-b-link is-strong" onclick="studioBuilderStartOver()">${studioEsc(studioBuilderT('Start a new request', 'ابدأ طلباً جديداً'))}</button></div>`);
  }
  if (!adsStudioCanUse()) {
    out.push(`<div class="studio-b-banner is-warn" role="status">${studioV2Icon('badge-alert')}<span>${studioEsc(studioBuilderT('Your plan is not active. Your draft is kept; activate the plan to save changes and send.', 'اشتراكك غير نشط. مسودتك محفوظة؛ فعّل الاشتراك لحفظ التعديلات والإرسال.'))}</span>
            <button type="button" class="studio-b-link is-strong" onclick="showSubscriptionModal('ad_maker', 'ad_maker')">${studioEsc(studioBuilderT('Activate the plan', 'فعّل الاشتراك'))}</button></div>`);
  }
  return out.join('');
}

function studioBuilderStepsList(route, kind) {
  const names = studioV2BuilderSteps(kind);
  return `<ol class="studio-v2-steps">${names.map((name, index) => {
    const number = index + 1;
    const mark = number === route.step ? ' is-current' : (number < route.step ? ' is-done' : '');
    return `<li class="studio-v2-step${mark}"${number === route.step ? ' aria-current="step"' : ''}><span class="studio-v2-step-dot" aria-hidden="true">${number}</span><span class="studio-v2-step-name">${studioEsc(studioBuilderT(name[0], name[1]))}</span></li>`;
  }).join('')}</ol>`;
}

function studioBuilderShell(route, kind, inner, footer = '') {
  const steps = studioV2BuilderSteps(kind).length;
  return `
          <div class="studio-v2-builder studio-b" data-testid="studio-builder" data-kind="${kind}" data-step="${route.step}" data-steps="${steps}">
            <p class="studio-v2-step-text" data-testid="studio-builder-step">${studioEsc(studioV2BuilderStepText({ ...route, section: kind }))}</p>
            ${studioBuilderStepsList(route, kind)}
            ${inner}
            ${footer}
          </div>`;
}

function studioBuilderWaiting(route, kind, text) {
  return studioBuilderShell(route, kind, `<div class="studio-v2-loading studio-b-waiting" role="status"><span class="studio-v2-spinner" aria-hidden="true"></span><p>${studioEsc(text)}</p></div>`);
}

function studioBuilderSentPanel(route, kind) {
  const sent = _studioBuilder.sent;
  return `
          <div class="studio-v2-builder studio-b" data-testid="studio-builder" data-kind="${kind}" data-step="${route.step}" data-steps="${studioV2BuilderSteps(kind).length}">
            <div class="studio-b-sent" data-testid="studio-builder-sent" role="status">
              <span class="studio-b-sent-icon" aria-hidden="true">${studioV2Icon('circle-check')}</span>
              <h2 class="studio-b-title">${studioEsc(studioBuilderT('Sent for review', 'أُرسل للمراجعة'))}</h2>
              <p class="studio-b-sent-money" data-testid="studio-builder-sent-money">${studioBuilderT(`Sent. ${studioLtr(studioUsd(sent.totalMinor))} is reserved, not charged.`, `أُرسل. حجزنا ${studioLtr(studioUsd(sent.totalMinor))} ولم نخصمها.`)}</p>
              <p class="studio-b-hint">${studioEsc(studioBuilderT('We charge it only if the team approves the ad. Until then you can withdraw the request from My ads and the money is free again.', 'لا نخصمها إلا إذا وافق الفريق على الإعلان. وحتى ذلك الحين يمكنك سحب الطلب من «إعلاناتي» فتعود متاحة.'))}</p>
              <div class="studio-b-row">
                <button type="button" class="studio-v2-action is-primary" data-testid="studio-builder-view-sent" onclick="studioBuilderViewSent()">${studioEsc(studioBuilderT('View request', 'عرض الطلب'))}</button>
                <button type="button" class="studio-v2-action" onclick="studioBuilderDone()">${studioEsc(studioBuilderT('Home', 'الرئيسية'))}</button>
              </div>
            </div>
          </div>`;
}

function studioBuilderFooter(session, route, kind) {
  const last = route.step >= studioBuilderStepKeys(kind).length;
  const blocked = studioBuilderSendBlocked(session);
  const primary = last
    ? `<button type="button" id="studio-b-send" data-testid="studio-builder-send" class="studio-v2-action is-primary" onclick="studioBuilderSend(this)"${blocked ? ' disabled' : ''}>${studioV2Icon('send')}<span>${studioEsc(studioBuilderT('Send request', 'أرسل الطلب'))}</span></button>`
    : `<button type="button" data-testid="studio-builder-next" class="studio-v2-action is-primary" onclick="studioBuilderNext()">${studioEsc(studioBuilderT('Next', 'التالي'))}</button>`;
  return `
            <div class="studio-b-footer">
              <p class="studio-b-save" id="studio-b-save" data-testid="studio-builder-save" data-state="${session.status}" role="status" aria-live="polite">${studioEsc(studioBuilderStatusText(session))}</p>
              ${primary}
            </div>`;
}

function studioBuilderEntering() {
  try {
    return typeof document !== 'undefined' && typeof document.querySelector === 'function' && !document.querySelector('[data-testid="studio-builder"]');
  } catch (_) { return false; }
}

// Opening the builder through a plain address (a link, the browser's Forward, a reload), not through
// studioBuilderStart / Edit / Fix (their own draw comes first and is not an entry).
function studioBuilderOnEnter(kind) {
  const b = _studioBuilder;
  b.sent = null;
  const session = b.session;
  if (session && session.kind !== kind) studioBuilderOpenSession(kind, studioBuilderNewDraft(kind), {});
  else if (session && session.touched && session.status !== 'locked') session.resumed = true;
}

// Reload: the draft this tab had open comes back (sessionStorage keeps only its id).
async function studioBuilderRestore(id) {
  const generation = _studioBuilder.generation;
  const token = {};
  _studioBuilder.opening = { id, token };
  const loaded = await studioBuilderLoadCampaign(id).catch(() => ({ error: 'failed' }));
  if (!studioBuilderCurrent(generation) || !_studioBuilder.opening || _studioBuilder.opening.token !== token) return;
  _studioBuilder.opening = null;
  if (loaded.error) studioBuilderForget();
  else if (!_studioBuilder.session) studioBuilderSessionFromCampaign(loaded.campaign, '');
  studioBuilderRedraw();
}

function studioBuilderScheduleFocus() {
  if (!_studioBuilder.pendingFocus || _studioBuilder.focusTimer || typeof setTimeout !== 'function') return;
  // After the app's own scroll restore (two animation frames after a draw).
  _studioBuilder.focusTimer = setTimeout(() => {
    _studioBuilder.focusTimer = null;
    const field = _studioBuilder.pendingFocus;
    _studioBuilder.pendingFocus = '';
    try {
      const wrap = document.querySelector(`.studio-b [data-field="${field}"]`);
      if (!wrap) return;
      if (typeof wrap.scrollIntoView === 'function') wrap.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const control = wrap.querySelector('input:not([type="file"]), textarea, select, button');
      if (control && typeof control.focus === 'function') control.focus({ preventScroll: true });
    } catch (_) {}
  }, 180);
}

// The kind of request an address shows. No section (the shell reads it as a full request) keeps the
// open draft's kind: the app's start-up address rewrite (after sign-in) keeps only ?tab=, and a quick
// boost started meanwhile must not turn into a full request.
function studioBuilderKindFor(route) {
  if (route.section === 'boost' || route.section === 'full') return route.section;
  if (_studioBuilder.session) return _studioBuilder.session.kind;
  const memory = studioBuilderMemory();
  return memory ? memory.kind : 'full';
}

// Where an open draft is drawn. The address may not name the draft's kind: the app's start-up
// rewrite keeps only ?tab= (moments after sign-in), and while the history walks back to rewrite the
// builder's entries it draws an older one first. An address never converts a draft (only
// studioBuilderSwitchKind does); the draft keeps its kind and its last step, and the address is put
// right after this draw when it still disagrees. Returns the step to draw.
function studioBuilderPlace(address, session, step) {
  const b = _studioBuilder;
  const kind = session.kind;
  if (address.section === kind) {
    b.lastRoute = { id: session.id, kind, step };
    return step;
  }
  const last = b.lastRoute && b.lastRoute.id === session.id && b.lastRoute.kind === kind ? b.lastRoute : null;
  const target = last ? last.step : Math.min(Math.max(step, 1), studioBuilderStepKeys(kind).length);
  // A full request at an address without a section and no step of its own yet (a plain link) is right.
  if ((address.section || last || kind === 'boost') && typeof setTimeout === 'function') {
    setTimeout(() => {
      try {
        const now = studioV2Route(studioV2ReadAddress(), 'customer');
        if (now.tab !== 'builder' || now.section === kind || _studioBuilder.session !== session) return;
        studioV2Go({ tab: 'builder', section: kind, step: target });
      } catch (_) { /* the screen stays right; only the address disagrees */ }
    }, 0);
  }
  return target;
}

// The shell's builder hook (below): the whole screen for one builder address.
function studioBuilderRender(address) {
  studioBuilderSync();
  studioBuilderListen();
  const b = _studioBuilder;
  let kind = studioBuilderKindFor(address);
  const clamp = step => Math.min(Math.max(Number(step) || 1, 1), studioBuilderStepKeys(kind).length);
  if (!adsStudioCanCreate()) {
    return studioBuilderShell({ ...address, step: clamp(address.step) }, kind, studioBuilderNote(studioEsc(studioBuilderT('This account cannot create ad requests.', 'هذا الحساب لا يستطيع إنشاء طلبات إعلانات.')), 'warn', 'lock'));
  }
  if (b.opening) return studioBuilderWaiting({ ...address, step: clamp(address.step) }, kind, studioBuilderT('Opening your request…', 'نفتح طلبك…'));
  const fresh = b.entryAt && Date.now() - b.entryAt < STUDIO_BUILDER_ENTRY_MS;
  b.entryAt = 0;
  if (!fresh && studioBuilderEntering()) studioBuilderOnEnter(kind);
  if (b.sent && !b.session) return studioBuilderSentPanel({ ...address, step: clamp(address.step) }, kind);
  if (!b.session) {
    const memory = studioBuilderMemory();
    if (memory && memory.kind === kind && !b.memoryTried) {
      b.memoryTried = true;
      studioBuilderRestore(memory.id);
      return studioBuilderWaiting({ ...address, step: clamp(address.step) }, kind, studioBuilderT('Opening your draft…', 'نفتح مسودتك…'));
    }
    b.memoryTried = true;
    studioBuilderOpenSession(kind, studioBuilderNewDraft(kind), {});
  }
  const session = b.session;
  kind = session.kind;
  if (session.draft !== _adsStudioDraft) _adsStudioDraft = session.draft;  // the photo path always sees this draft
  const route = { ...address, section: kind, step: studioBuilderPlace(address, session, clamp(address.step)) };
  const keys = studioBuilderStepKeys(kind);
  const key = keys[route.step - 1];
  studioBuilderLoadOptions();
  let body;
  if (key === 'goal') body = studioBuilderGoalStep(session);
  else if (key === 'page') body = studioBuilderPageStep(session);
  else if (key === 'content') body = studioBuilderContentStep(session);
  else if (key === 'audience') body = studioBuilderAudienceStep(session);
  else if (key === 'budget') body = studioBuilderBudgetStep(session);
  else if (key === 'promote') body = studioBuilderPromoteStep(session);
  else body = studioBuilderReviewStep(session);
  studioBuilderScheduleFocus();
  const inner = `${studioBuilderBanners(session)}
            <div class="studio-b-body" data-testid="studio-builder-body-${key}">${body}
            </div>`;
  return studioBuilderShell(route, kind, inner, studioBuilderFooter(session, route, kind));
}

// ------------------------------------------------------------------ hooks into the shell and the photo path

// The builder is the shell's 'builder' screen (the shell's placeholder stays the fallback if a draw
// fails); a wallet answer while it is on screen repaints its wallet lines in place.
studioV2RegisterScreen('builder', route => studioBuilderRender(route));
if (typeof studioDataPaintInPlace === 'function') studioDataPaintInPlace('builder', () => studioBuilderPaintWallet());

// Photos added by the file input, a paste or the camera all go through uploadAdsStudioCreativeFiles
// (15c); afterwards the builder redraws its photos and saves. The classic screens are unchanged.
const _studioBuilderClassicUpload = typeof uploadAdsStudioCreativeFiles === 'function' ? uploadAdsStudioCreativeFiles : null;
if (_studioBuilderClassicUpload) {
  uploadAdsStudioCreativeFiles = async function uploadAdsStudioCreativeFilesForBuilder(fileList) {
    const session = _studioBuilder.session;
    const before = session ? studioBuilderPhotoKey(session.draft) : '';
    try {
      return await _studioBuilderClassicUpload(fileList);
    } finally {
      if (session && session === _studioBuilder.session && studioBuilderPhotoKey(session.draft) !== before) studioBuilderPhotosChanged(session);
    }
  };
}
