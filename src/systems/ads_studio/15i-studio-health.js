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
