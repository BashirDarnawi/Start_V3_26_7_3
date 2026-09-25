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
// - the studio jobs heartbeat and the Meta lanes (P5-05) from GET /api/studio/admin/diagnostics,
//   read at most every 10 minutes (a heavier read than the facts);
// - "Test alert channel" (P3-25): POST /api/studio/admin/alert-channel/test, one press per 10 minutes
//   for the whole team; the answer {sent, configured} in words, a 429 shows the wait;
// - a "What to do" line under every item (P5-05): the runbook page it belongs to and a link to the
//   desk section or settings form that fixes or verifies it (the runbook itself is not served).
// The page list comes from /api/social-studio/pages (admins see every linked page). This file
// never sees a Meta token: the server does every Meta call.

const STUDIO_HEALTH_RELOAD_MS = 60000;
const STUDIO_HEALTH_META_TIMEOUT_MS = 45000; // a Meta refresh or test makes several paced calls
const STUDIO_HEALTH_DIAG_MAX_AGE_MS = 10 * 60000;  // the heartbeat and lanes come from /diagnostics: at most every 10 min
const STUDIO_HEALTH_ALERT_KEY = 'alert';  // the busy / results slot of the alert-channel test
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
  diag: null,       // the last /diagnostics answer (jobs, metaLanes)
  diagAt: 0,        // when it was asked for (a failed read waits like a good one)
  diagError: '',
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
  _studioHealth.diag = null;
  _studioHealth.diagAt = 0;
  _studioHealth.diagError = '';
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
  // The heartbeat and the lanes (P5-05) ride along at most every 10 minutes; the 60 s reload skips them.
  const wantDiag = !_studioHealth.diagAt || Date.now() - _studioHealth.diagAt >= STUDIO_HEALTH_DIAG_MAX_AGE_MS;
  try {
    const [facts, token, pages, diag] = await Promise.allSettled([
      studioHealthApi('/api/studio/admin/facts'),
      studioHealthApi('/api/meta-ads/token-health'),
      studioHealthApi('/api/social-studio/pages'),
      wantDiag ? studioHealthApi('/api/studio/admin/diagnostics') : Promise.resolve(null)
    ]);
    if (!studioHealthContextIsCurrent(context)) return;
    _studioHealth.facts = facts.status === 'fulfilled' ? facts.value : _studioHealth.facts;
    _studioHealth.factsError = facts.status === 'fulfilled' ? '' : studioHealthErrorText(facts.reason);
    _studioHealth.token = token.status === 'fulfilled' ? token.value : null;
    _studioHealth.tokenError = token.status === 'fulfilled' ? '' : studioHealthErrorText(token.reason);
    if (pages.status === 'fulfilled') _studioHealth.pages = Array.isArray(pages.value?.pages) ? pages.value.pages : [];
    if (wantDiag) {
      _studioHealth.diagAt = Date.now();
      if (diag.status === 'fulfilled') { _studioHealth.diag = diag.value && typeof diag.value === 'object' ? diag.value : null; _studioHealth.diagError = ''; }
      else _studioHealth.diagError = studioHealthErrorText(diag.reason);
    }
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

// ---------- "Test alert channel" (P3-25) ----------

// {sent, configured} from POST /api/studio/admin/alert-channel/test, in words.
function studioHealthAlertResult(result) {
  if (result?.configured === false) {
    return { tone: 'amber', text: studioHealthText('No staff alert channel is set up (ALBAYAN_ALERT_WEBHOOK_URL), so nothing was sent. Alerts stay in the Alerts list only.', 'قناة تنبيهات الفريق غير مُعدّة (ALBAYAN_ALERT_WEBHOOK_URL)، لذلك لم يُرسل شيء. تبقى التنبيهات في قائمة التنبيهات فقط.') };
  }
  if (result?.sent === true) return { tone: 'emerald', text: studioHealthText('The test alert was sent. Check that it arrived in the staff channel.', 'أُرسل التنبيه التجريبي. تأكد من وصوله إلى قناة الفريق.') };
  return { tone: 'rose', text: studioHealthText('The channel is set up but did not accept the test alert. Check the webhook address in Jelastic and the container log (runbook 0.5); until it works, the on-duty rule applies.', 'القناة مُعدّة لكنها لم تقبل التنبيه التجريبي. راجع عنوان الويب هوك في Jelastic وسجل الحاوية (دليل التشغيل 0.5)؛ وحتى تعمل، تسري قاعدة المناوبة.') };
}

// A refused test: the 429 shows the wait (Retry-After through apiJson's retryAfter; one press per
// 10 minutes for the whole team), the other refusals through the studio map.
function studioHealthAlertErrorText(error) {
  if (Number(error?.status) === 429) {
    const minutes = Math.max(1, Math.ceil((Number(error?.retryAfter) || 600) / 60));
    return studioHealthText(`One test alert every 10 minutes for the whole team. Try again in about ${minutes} min.`, `تنبيه تجريبي واحد كل 10 دقائق للفريق كله. أعد المحاولة بعد نحو ${minutes} دقيقة.`);
  }
  return studioHealthErrorText(error);
}

async function studioHealthTestAlertChannel() {
  const key = STUDIO_HEALTH_ALERT_KEY;
  if (!isCurrentUserAdmin() || _studioHealth.busy[key]) return;
  const context = captureStudioHealthContext();
  _studioHealth.busy[key] = true;
  delete _studioHealth.results[key];
  studioHealthRerender();
  try {
    const result = await studioHealthApi('/api/studio/admin/alert-channel/test', { method: 'POST', body: {} }, { timeoutMs: STUDIO_HEALTH_META_TIMEOUT_MS });
    if (!studioHealthContextIsCurrent(context)) return;
    _studioHealth.results[key] = studioHealthAlertResult(result);
  } catch (error) {
    if (!studioHealthContextIsCurrent(context)) return;
    _studioHealth.results[key] = { tone: 'amber', text: studioHealthAlertErrorText(error) };
  } finally {
    if (studioHealthGenerationIsCurrent(context)) { delete _studioHealth.busy[key]; studioHealthRerender(); }
  }
}

// ---------- "What to do" (P5-05) ----------

// The runbook (docs/studio-redesign/RUNBOOK.md) is not served by the site, so every item's line names
// its runbook page and links the desk section or settings form that fixes or verifies it: a button
// in the Team desk (studioDeskGo, 15p); the classic review tab has no desk, so it names the place in
// words. 'pages' scrolls to the Meta tests of the linked pages below, in both layouts.
// key: [desk section, id, English, Arabic]
const STUDIO_HEALTH_FIXES = Object.freeze({
  diagnostics: ['more', 'diagnostics', 'Diagnostics', 'التشخيص'],
  alerts: ['more', 'alerts', 'Alerts', 'التنبيهات'],
  requests: ['requests', '', 'Requests', 'الطلبات'],
  capabilities: ['more', 'settings-capabilities', 'Reply channels', 'قنوات الردود'],
  limits: ['more', 'settings-limits', 'Budget limits', 'حدود الميزانية'],
  settlement: ['more', 'settings-settlement', 'Settlement', 'التسوية'],
  intake: ['more', 'settings-intake', 'Intake', 'استقبال الطلبات'],
  pages: ['', 'studio-health-pages', 'Linked pages: Meta tests', 'الصفحات المربوطة: اختبارات ميتا']
});

function studioHealthDeskOpen() {
  return typeof studioDeskGo === 'function' && typeof studioV2Frame === 'function' && studioV2Frame() === 'staff';
}

function studioHealthGoFix(key) {
  const fix = STUDIO_HEALTH_FIXES[String(key || '')];
  if (!fix) return false;
  if (key === 'pages') {
    try {
      const el = typeof document !== 'undefined' ? document.getElementById(fix[1]) : null;
      if (el && typeof el.scrollIntoView === 'function') { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return true; }
    } catch (_) { /* nothing to scroll to */ }
    return false;
  }
  return studioHealthDeskOpen() ? studioDeskGo(fix[0], fix[1]) === true : false;
}

// One item's line: "What to do (runbook §x): <the steps> <the link>". id names the item in tests.
function studioHealthFix(id, key, runbook, en, ar) {
  const fix = STUDIO_HEALTH_FIXES[key];
  const label = studioHealthText(fix[2], fix[3]);
  const linked = key === 'pages' || studioHealthDeskOpen();
  const where = linked
    ? `<button type="button" data-testid="studio-health-fix-link-${id}" onclick="studioHealthGoFix('${key}')" class="touch-target min-h-11 inline-flex items-center gap-1 rounded-xl border border-blue-200 dark:border-blue-800 px-3 text-xs font-bold text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 align-middle"><i data-lucide="${key === 'pages' ? 'arrow-down' : 'arrow-right'}" class="w-3.5 h-3.5" aria-hidden="true"></i>${label}</button>`
    : `<span class="font-bold text-slate-800 dark:text-slate-100">${studioHealthText(`Team desk → More → ${fix[2]}`, `مكتب الفريق ← المزيد ← ${fix[3]}`)}</span>`;
  return `<p class="mt-2 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300" data-testid="studio-health-fix-${id}" data-fix="${key}" data-linked="${linked ? '1' : '0'}"><strong>${studioHealthText(`What to do (runbook ${runbook})`, `ماذا تفعل (دليل التشغيل ${runbook})`)}:</strong> ${studioHealthText(en, ar)} ${where}</p>`;
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

function studioHealthNote(note, testId = '') {
  return note ? `<p class="mt-2 rounded-xl ${studioHealthTone(note.tone)} p-3 text-sm" role="status"${testId ? ` data-testid="${testId}" data-tone="${studioHealthEsc(note.tone)}"` : ''}>${note.text}</p>` : '';
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

// The token's "what to do" (runbook 3.1 expiring, 3.2 invalid) and the webhook counters' (3.10).
function studioHealthTokenFix() {
  return studioHealthFix('token', 'diagnostics', '3.1 / 3.2',
    'Few days left, or not valid: make a new system-user token in Meta Business Settings, put it in ALBAYAN_META_ACCESS_TOKEN in Jelastic and restart; then confirm "valid" in',
    'أيام قليلة متبقية أو الرمز غير صالح: أنشئ رمزاً جديداً للمستخدم النظامي في إعدادات أعمال ميتا، وضعه في ALBAYAN_META_ACCESS_TOKEN في Jelastic ثم أعد التشغيل؛ ثم تأكد من «صالح» في');
}

function studioHealthWebhooksFix() {
  return studioHealthFix('webhooks', 'pages', '3.10',
    'No deliveries while pages are linked: press Test subscription on each linked page in',
    'لا تسليمات مع وجود صفحات مربوطة: اضغط اختبار الاشتراك لكل صفحة مربوطة في');
}

function renderStudioHealthToken() {
  const t = _studioHealth.token;
  if (!t) return studioHealthCard('key-round', studioHealthText('Meta token', 'رمز ميتا'), studioHealthEsc(_studioHealth.tokenError || studioHealthText('Loading…', 'جارٍ التحميل…')) + studioHealthTokenFix());
  const webhooks = Object.values(t.webhookCounts?.countsByObjectField || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
  let body;
  if (t.configured === false) body = `<p>${studioHealthText('The token check is not set up (ALBAYAN_META_APP_ID).', 'فحص الرمز غير مُعدّ (ALBAYAN_META_APP_ID).')}</p>`;
  else if (!t.checked) body = `<p>${studioHealthText('Not checked yet for the current token.', 'لم يُفحص الرمز الحالي بعد.')}</p>`;
  else body = [
    studioHealthLine(studioHealthText('Valid', 'صالح'), studioHealthYesNo(t.isValid === true)),
    studioHealthLine(studioHealthText('Days left', 'الأيام المتبقية'), t.expiresNever ? studioHealthText('never expires', 'لا ينتهي') : studioHealthEsc(t.daysLeft ?? '—')),
    studioHealthLine(studioHealthText('Missing permissions', 'صلاحيات ناقصة'), studioHealthEsc((t.missingScopes || []).length))
  ].join('');
  body += studioHealthTokenFix();
  body += studioHealthLine(studioHealthText('Webhook deliveries counted', 'تسليمات الويب هوك المحسوبة'), studioHealthEsc(webhooks));
  body += studioHealthWebhooksFix();
  return studioHealthCard('key-round', studioHealthText('Meta token', 'رمز ميتا'), body);
}

// The Meta lanes (runbook 3.4) as the diagnostics report them: the app-wide pause, then each lane.
const STUDIO_HEALTH_LANES = Object.freeze([['admin', 'Manager sync', 'مزامنة المدير'], ['studio_results', 'Studio results', 'نتائج الاستوديو'], ['page', 'Page replies', 'ردود الصفحات']]);

function studioHealthMinutes(seconds) {
  return Math.max(1, Math.ceil((Number(seconds) || 0) / 60));
}

function studioHealthLaneValue(lane) {
  if (!lane || typeof lane !== 'object') return studioHealthText('unknown', 'غير معروف');
  if (lane.paused) return studioHealthText(`paused ${studioHealthMinutes(lane.retryAfterSeconds)} min`, `متوقف ${studioHealthMinutes(lane.retryAfterSeconds)} دقيقة`);
  const parks = Number(lane.parkCount) || 0;
  const usage = Number.isFinite(Number(lane.usagePercent)) ? `${Math.max(0, Math.min(100, Math.trunc(Number(lane.usagePercent))))}%` : '—';
  return parks
    ? studioHealthText(`usage ${usage} · ${parks} parked`, `الاستخدام ${usage} · ${parks} موقوفة`)
    : studioHealthText(`usage ${usage}`, `الاستخدام ${usage}`);
}

// The studio jobs heartbeat (runbook 3.6) and the Meta lanes (3.4), from the last /diagnostics read.
function renderStudioHealthJobsAndLanes() {
  const report = _studioHealth.diag;
  const readNote = _studioHealth.diagAt ? `<p class="text-[11px] text-slate-500">${studioHealthText('Read', 'قُرئ')} ${studioHealthAge((Date.now() - _studioHealth.diagAt) / 1000)} · ${studioHealthText('read again after 10 min', 'يُقرأ مجدداً بعد 10 دقائق')}</p>` : '';
  const jobs = report && report.jobs && typeof report.jobs === 'object' ? report.jobs : null;
  const lanesReport = report && report.metaLanes && typeof report.metaLanes === 'object' ? report.metaLanes : null;
  let jobsBody;
  if (!report) jobsBody = `<p>${studioHealthEsc(_studioHealth.diagError || studioHealthText('Loading…', 'جارٍ التحميل…'))}</p>`;
  else if (!jobs) jobsBody = `<p>${studioHealthText('No heartbeat in the report.', 'لا نبض في التقرير.')}</p>`;
  else {
    const late = jobs.enabled === false || jobs.late === true;
    const stateText = jobs.enabled === false
      ? studioHealthText('switched off here (ALBAYAN_STUDIO_JOBS)', 'متوقفة هنا (ALBAYAN_STUDIO_JOBS)')
      : jobs.late === true ? studioHealthText('LATE', 'متأخر') : studioHealthText('fine', 'سليم');
    const tick = jobs.lastTickAt ? studioHealthAge(Number(jobs.ageSeconds)) : studioHealthText('never ticked', 'لم تنبض بعد');
    const lastError = jobs.lastError && typeof jobs.lastError === 'object' && jobs.lastError.job ? studioHealthLine(studioHealthText('Last error', 'آخر خطأ'), `<span dir="ltr">${studioHealthEsc(String(jobs.lastError.job).slice(0, 40))}: ${studioHealthEsc(String(jobs.lastError.error || '').slice(0, 80))}</span>`) : '';
    jobsBody = studioHealthLine(studioHealthText('Heartbeat', 'النبض'), `<span data-testid="studio-health-heartbeat" data-late="${late ? '1' : '0'}" class="${late ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}">${stateText}</span>`)
      + studioHealthLine(studioHealthText('Last tick', 'آخر نبضة'), tick) + lastError;
  }
  const jobsFix = studioHealthFix('heartbeat', 'diagnostics', '3.6',
    'Late: restart the app container in Libyan Spider (redeploy only if the restart fails); "switched off" means ALBAYAN_STUDIO_JOBS is set to off in Jelastic. Follow it in',
    'متأخر: أعد تشغيل حاوية التطبيق في Libyan Spider (أعد النشر فقط إن فشلت إعادة التشغيل)؛ «متوقفة» تعني أن ALBAYAN_STUDIO_JOBS مضبوط على off في Jelastic. تابعه في');
  let lanesBody;
  if (!report) lanesBody = `<p>${studioHealthEsc(_studioHealth.diagError || studioHealthText('Loading…', 'جارٍ التحميل…'))}</p>`;
  else if (!lanesReport) lanesBody = `<p>${studioHealthText('No lane state in the report.', 'لا حالة مسارات في التقرير.')}</p>`;
  else {
    const app = lanesReport.appWide && typeof lanesReport.appWide === 'object' ? lanesReport.appWide : {};
    const lanes = lanesReport.lanes && typeof lanesReport.lanes === 'object' ? lanesReport.lanes : {};
    const anyPaused = app.paused === true || STUDIO_HEALTH_LANES.some(([key]) => lanes[key] && lanes[key].paused === true);
    lanesBody = studioHealthLine(studioHealthText('All lanes', 'كل المسارات'), `<span data-testid="studio-health-lanes" data-paused="${anyPaused ? '1' : '0'}" class="${anyPaused ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}">${app.paused === true ? studioHealthText(`paused ${studioHealthMinutes(app.retryAfterSeconds)} min${app.reason ? ` (${studioHealthEsc(app.reason)})` : ''}`, `متوقفة ${studioHealthMinutes(app.retryAfterSeconds)} دقيقة${app.reason ? ` (${studioHealthEsc(app.reason)})` : ''}`) : studioHealthText('running', 'تعمل')}</span>`)
      + STUDIO_HEALTH_LANES.map(([key, en, ar]) => studioHealthLine(studioHealthText(en, ar), studioHealthLaneValue(lanes[key]))).join('');
  }
  const lanesFix = studioHealthFix('lanes', 'intake', '3.4',
    'Paused: wait, the pause ends by itself; do not keep pressing the Meta buttons. Page replies paused for more than 6 hours: the pilot stop rule, pause new requests in',
    'متوقفة: انتظر، فالتوقف ينتهي وحده؛ ولا تكرر الضغط على أزرار ميتا. إن توقفت ردود الصفحات أكثر من 6 ساعات: قاعدة توقف التجربة، أوقف الطلبات الجديدة في');
  return studioHealthCard('heart-pulse', studioHealthText('Studio jobs heartbeat', 'نبض مهام الاستوديو'), readNote + jobsBody + jobsFix)
    + studioHealthCard('route', studioHealthText('Meta lanes', 'مسارات ميتا'), readNote + lanesBody + lanesFix);
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
      + studioHealthCounts(b.byClass, studioHealthCodeLabel) + studioHealthCounts(b.byCode, studioHealthProviderCodeLabel)
      + studioHealthFix('private-replies', 'capabilities', '3.10',
        'Failures with a Meta code: open the page\'s reason in Pages & replies and follow its fix row. A channel shown as waiting for Meta or not available sends nothing by decision; its state is in',
        'إخفاقات برمز من ميتا: افتح سبب الصفحة في الصفحات والردود واتبع صف الإصلاح. القناة التي تظهر «بانتظار ميتا» أو «غير متاحة» لا ترسل شيئاً بقرار؛ حالتها في')),
    studioHealthCard('message-circle-reply', studioHealthText(`Facebook public replies without error (${days} days)`, `الردود العامة على فيسبوك دون خطأ (${days} يوماً)`),
      studioHealthLine(studioHealthText('Replies', 'ردود'), studioHealthEsc(g.publicRepliesWithoutError || 0))
      + studioHealthLine(studioHealthText('Different commenters', 'معلّقون مختلفون'), studioHealthEsc(g.distinctCommenters || 0))
      + `<p class="text-[11px] text-slate-500">${studioHealthText('Staff and test accounts cannot be told apart, so every commenter is counted.', 'لا يمكن تمييز حسابات الفريق أو الاختبار، لذلك يُحسب كل المعلّقين.')}</p>`
      + studioHealthFix('public-replies', 'capabilities', '3.10',
        'Fewer than expected: check that the Facebook public reply channel is on, in',
        'أقل من المتوقع: تأكد أن قناة الردود العامة على فيسبوك مفعّلة في')),
    studioHealthCard('calendar-days', studioHealthText('Requests with a daily budget', 'طلبات بميزانية يومية'),
      studioHealthLine(studioHealthText('Now', 'الآن'), studioHealthEsc(c.total || 0))
      + studioHealthCounts(c.byStatus, studioHealthStatusLabel)
      + studioHealthLine(studioHealthText('Archived', 'مؤرشفة'), studioHealthEsc(c.archived || 0))
      + studioHealthFix('daily-requests', 'requests', '§7.1',
        'A daily budget holds its whole total (days × amount) from the send; review the waiting ones by their due time in',
        'الميزانية اليومية تحجز مجموعها كاملاً (الأيام × المبلغ) منذ الإرسال؛ راجع الطلبات المنتظرة حسب موعدها في')),
    studioHealthCard('list-checks', studioHealthText('Ad-account allowlist', 'قائمة الحسابات الإعلانية المسموحة'),
      studioHealthLine(studioHealthText('Configured', 'مُعدّة'), studioHealthYesNo(f.d?.allowlistConfigured === true))
      + studioHealthFix('allowlist', 'diagnostics', '0.3',
        'Not configured: set ALBAYAN_STUDIO_AD_ACCOUNT_IDS in Jelastic and restart before any studio link (PLAN 12.2(f)); the Meta connection is checked in',
        'غير مُعدّة: اضبط ALBAYAN_STUDIO_AD_ACCOUNT_IDS في Jelastic وأعد التشغيل قبل أي ربط في الاستوديو (الخطة 12.2(f))؛ اتصال ميتا يُفحص في')),
    studioHealthCard('wallet', studioHealthText('Meta minimum daily budget', 'الحد الأدنى اليومي لميزانية ميتا'),
      `<p class="text-[11px] text-slate-500">${budget.checked ? studioHealthAge(budget.ageSeconds) : studioHealthText('Not read yet: press Refresh from Meta.', 'لم تُقرأ بعد: اضغط تحديث من ميتا.')}${budget.stale && budget.checked ? ` · ${studioHealthText('older than 24 h', 'أقدم من 24 ساعة')}` : ''}</p>`
      + (budget.accounts || []).filter(a => a && typeof a === 'object').map(studioHealthBudgetRow).join('')
      + studioHealthFix('min-budget', 'limits', '§7.1',
        'Keep the per-day floor of the budget limits at or above every account\'s minimum, in',
        'أبقِ حد اليوم الأدنى في حدود الميزانية عند الحد الأدنى لكل حساب أو فوقه، في')),
    studioHealthCard('webhook', studioHealthText('Page webhook subscription', 'اشتراك الصفحات في الويب هوك'),
      `<p class="text-[11px] text-slate-500">${i.checked ? studioHealthAge(i.ageSeconds) : studioHealthText('Not read yet: press Refresh from Meta.', 'لم تُقرأ بعد: اضغط تحديث من ميتا.')}</p>`
      + studioHealthLine(studioHealthText('Linked pages', 'الصفحات المربوطة'), studioHealthEsc(i.linkedPages || 0))
      + (i.checked ? studioHealthLine(studioHealthText('Subscribed', 'مشتركة'), studioHealthEsc(i.subscribed || 0))
        + studioHealthLine(studioHealthText('Not subscribed', 'غير مشتركة'), studioHealthEsc(i.notSubscribed || 0))
        + studioHealthLine(studioHealthText('Could not check', 'تعذّر الفحص'), studioHealthEsc((i.error || 0) + (i.notChecked || 0)))
        + (Number(i.kept) > 0 ? studioHealthLine(studioHealthText('Earlier value kept (the last try failed)', 'قيمة سابقة محفوظة (فشلت آخر محاولة)'), studioHealthEsc(i.kept)) : '') : '')
      + studioHealthCounts(i.errorCodes, studioHealthCodeLabel)
      + (i.checked && !i.appIdConfigured ? `<p class="text-[11px] text-slate-500">${studioHealthText('ALBAYAN_META_APP_ID is not set: any app with the feed field counted.', 'ALBAYAN_META_APP_ID غير مُعدّ: احتُسب أي تطبيق يشترك في feed.')}</p>` : '')
      + studioHealthFix('pages', 'pages', '3.10',
        'A page not subscribed: press Test subscription on it (that subscribes it) in',
        'صفحة غير مشتركة: اضغط اختبار الاشتراك عليها (فهو يشترك بها) في')),
    studioHealthCard('landmark', studioHealthText('Ad account funds (last reading)', 'أموال الحسابات الإعلانية (آخر قراءة)'),
      ((f.n1?.accounts || []).map(a => studioHealthLine(studioHealthEsc(a.account), a.readError
        ? studioHealthText('not readable', 'غير مقروء')
        : `${studioHealthEsc(a.currency)} · ${studioHealthText('prepaid', 'مسبق الدفع')}: ${studioHealthYesNo(a.isPrepay)} · ${studioHealthText('funds shown', 'الأموال ظاهرة')}: ${studioHealthYesNo(a.fundsHidden ? false : a.fundsTextPresent)}`)).join('')
      || `<p>${studioHealthText('No reading stored yet.', 'لا توجد قراءة محفوظة بعد.')}</p>`)
      + studioHealthFix('funds', 'alerts', '3.9',
        'Low, hidden or not readable: top up or fix the payment method in Meta Business Manager → Billing, give the system user Full control on the account, press Refresh from Meta, then acknowledge the alert in',
        'منخفضة أو مخفية أو غير مقروءة: اشحن الحساب أو أصلح وسيلة الدفع في Meta Business Manager ← Billing، وامنح المستخدم النظامي «تحكماً كاملاً» على الحساب، واضغط تحديث من ميتا، ثم أكّد الاطلاع على التنبيه في')),
    studioHealthCard('trending-up', studioHealthText('Meta spend after confirmation (Manager ads)', 'إنفاق ميتا بعد التأكيد (إعلانات المدير)'),
      studioHealthLine(studioHealthText('Confirmed ads', 'إعلانات مؤكدة'), studioHealthEsc(s.confirmed || 0))
      + studioHealthLine(studioHealthText('Compared later', 'قورنت لاحقاً'), studioHealthEsc(s.compared || 0))
      + studioHealthLine(studioHealthText('Higher / lower / same', 'أعلى / أقل / نفسه'), `${studioHealthEsc(s.higher || 0)} / ${studioHealthEsc(s.lower || 0)} / ${studioHealthEsc(s.unchanged || 0)}`)
      + `<p class="text-[11px] text-slate-500">${studioHealthText('Change (cents)', 'التغيّر (سنت)')}: ${studioHealthPercentiles(s.driftMinor, '')}</p>`
      + `<p class="text-[11px] text-slate-500">${studioHealthText('Hours from planned end to confirmation', 'الساعات من النهاية المخططة حتى التأكيد')}: ${studioHealthPercentiles(s.hoursEndToConfirmation, studioHealthText('h', 'س'))}</p>`
      + studioHealthFix('spend-drift', 'settlement', '3.3',
        'Often higher after confirmation: lengthen the wait after delivery ends or the drift watch, in',
        'أعلى غالباً بعد التأكيد: أطِل مدة الانتظار بعد انتهاء العرض أو مراقبة تغيّر الصرف، في'))
  ];
  return `<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${renderStudioHealthToken()}${renderStudioHealthJobsAndLanes()}${cards.join('')}</div>`;
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

// The staff alert channel (P3-25): one test press, its answer in words.
function renderStudioHealthAlertChannel() {
  const busy = !!_studioHealth.busy[STUDIO_HEALTH_ALERT_KEY];
  return `<div class="mt-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/70 dark:bg-slate-800/70 p-4" data-testid="studio-health-alert-channel">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0"><h4 class="text-sm font-black text-slate-900 dark:text-white"><i data-lucide="bell-ring" class="w-4 h-4 inline-block align-[-2px] text-blue-600" aria-hidden="true"></i> ${studioHealthText('Staff alert channel', 'قناة تنبيهات الفريق')}</h4><p class="text-[11px] text-slate-500">${studioHealthText('Sends one test message to the staff channel (ALBAYAN_ALERT_WEBHOOK_URL). One press per 10 minutes for the whole team; the press is audited.', 'يرسل رسالة تجريبية واحدة إلى قناة الفريق (ALBAYAN_ALERT_WEBHOOK_URL). ضغطة واحدة كل 10 دقائق للفريق كله؛ الضغطة مدقّقة.')}</p></div>
        <button type="button" data-testid="studio-health-alert-test" onclick="studioHealthTestAlertChannel()" ${busy ? 'disabled aria-busy="true"' : ''} class="touch-target min-h-11 rounded-xl border border-blue-200 dark:border-blue-800 px-3 text-xs font-bold text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-60 inline-flex items-center gap-1.5"><i data-lucide="send" class="w-3.5 h-3.5" aria-hidden="true"></i>${busy ? studioHealthText('Sending…', 'جارٍ الإرسال…') : studioHealthText('Test alert channel', 'اختبار قناة التنبيهات')}</button>
      </div>
      ${studioHealthNote(_studioHealth.results[STUDIO_HEALTH_ALERT_KEY], 'studio-health-alert-result')}
    </div>`;
}

function renderStudioHealthSection() {
  if (!isCurrentUserAdmin()) return '';
  studioHealthEnsureLoaded();
  const report = _studioHealth.facts;
  const pages = (_studioHealth.pages || []).filter(p => p && p.id);
  return `<section class="mt-6" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}" data-testid="studio-health">
    <div class="glass-panel rounded-3xl p-5 sm:p-7">
      <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div><h2 class="text-2xl font-black text-slate-900 dark:text-white">${studioHealthText('Studio health', 'صحة الاستوديو')}</h2><p class="text-sm text-slate-500">${studioHealthText('Admin checks for Meta and the studio. Counts only, no customer data. Every item says what to do and where (the runbook page is named).', 'فحوص المدير لميتا والاستوديو. أرقام فقط، دون بيانات العملاء. كل بند يقول ماذا تفعل وأين (مع رقم صفحة دليل التشغيل).')}</p></div>
        <button type="button" onclick="studioHealthRefreshFacts()" ${_studioHealth.refreshing ? 'disabled' : ''} class="touch-target min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-black text-white hover:bg-blue-700 disabled:opacity-60 inline-flex items-center gap-2"><i data-lucide="refresh-cw" class="w-4 h-4"></i>${_studioHealth.refreshing ? studioHealthText('Reading from Meta…', 'جارٍ القراءة من ميتا…') : studioHealthText('Refresh from Meta', 'تحديث من ميتا')}</button>
      </div>
      ${report ? `<p class="mb-3 text-[11px] text-slate-500">${studioHealthText('Meta readings are kept 24 h; refresh at most twice in 10 minutes.', 'تُحفظ قراءات ميتا 24 ساعة؛ التحديث مرتان كحد أقصى كل 10 دقائق.')}</p>` : ''}
      ${studioHealthNote(_studioHealth.refreshNote)}
      ${renderStudioHealthAlertChannel()}
      <div class="mt-3">${renderStudioHealthFacts()}</div>
      <h3 id="studio-health-pages" class="mt-6 mb-3 text-lg font-black text-slate-900 dark:text-white">${studioHealthText('Linked pages: Meta tests', 'الصفحات المربوطة: اختبارات ميتا')}</h3>
      <p class="mb-3 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300" data-testid="studio-health-fix-page-tests"><strong>${studioHealthText('What to do (runbook 3.10)', 'ماذا تفعل (دليل التشغيل 3.10)')}:</strong> ${studioHealthText('Test subscription subscribes a page whose comments do not arrive; Read test and Check recent comments now prove an Instagram account. A page whose access stopped needs its owner to share it with Albayan again: the fix they see in Pages & replies is the one to send them.', 'اختبار الاشتراك يشترك بالصفحة التي لا تصل تعليقاتها؛ واختبار القراءة و«افحص التعليقات الأخيرة الآن» يثبتان حساب إنستغرام. الصفحة التي توقف وصولها تحتاج أن يشاركها مالكها مع البيان مرة أخرى: الإصلاح الذي يراه في الصفحات والردود هو ما ترسله له.')}</p>
      <div class="space-y-3">${pages.length ? pages.map(renderStudioHealthPage).join('') : `<p class="text-sm text-slate-500">${studioHealthText('No linked pages yet.', 'لا توجد صفحات مربوطة بعد.')}</p>`}</div>
    </div>
  </section>`;
}
// ==========================================
// ALBAYAN STUDIO v2 — TEAM DESK (plan tasks P3-06b/c/d, P3-09, P3-13, P3-17, M12; studio-staff.js lazy bundle)
// ==========================================
// The sections of the v2 Team desk frame (15h, tab=review&section=…), drawn through the loader in
// studio.js (15o0 renderStudioStaffSection) once this bundle is here. Nothing runs at load time.
// - requests: the review queue (Submitted requests, never the reviewer's own), 20 a page; a request
//   opens (&id=) with the customer's texts, photos, budget (total, or daily × days), page and post;
//   the decision box has the 7 reason codes (15c ADS_STUDIO_REVIEW_REASONS) and the note; approval
//   confirms in an in-page sheet, then shows the studio name with Copy;
// - launch: Approved requests not linked yet (checklist, the studio name with Copy, the classic
//   "Link Meta campaign" sheet of 15c: account picker or typed id, NEEDS_MANUAL_RENAME with Copy,
//   kept and removed Manager copies, warnings) and the linked ones (Meta stage, "Check Meta now",
//   the classic Unlink sheet with its reason);
// - settle: ended requests (the server's stage 10 from GET /api/studio/campaigns/{id}/results, or
//   never linked past the end date) with the countdown to the final Meta read; "Check Meta now";
//   the Finish & settle sheet (pre-filled paid − Meta spend, capped; a never-delivered ad returns
//   everything); the admin override sheet (amount + reason, POST …/settle-override). A refusal is
//   shown in the reader's language (SETTLE_NOT_READY carries readyAt: the countdown);
// - tickets: the staff tickets section of 15n; health: the admin checks of 15i (and the pulse card);
// - more: the admin tools of 15q, the desk sound switch and the basics (language, theme, sign out).
// The staff pulse (GET /api/studio/staff/pulse, every 20 s while visible through the 15g hook)
// drives the badges on the desk nav, the count in the document title and, for a new stop request,
// a short generated sound (switch in More, this browser only) and a vibration where supported.
// Every action is single-flight with one operationId per (action, version) (15c
// adsStudioActionAttempt); every server string is escaped; no native dialogs anywhere.

const STUDIO_DESK_PAGE = 20;
const STUDIO_DESK_RESULTS_TTL_MS = 2 * 60 * 1000;
const STUDIO_DESK_RESULTS_RETRY_MS = 60 * 1000;
const STUDIO_DESK_RESULTS_MAX_READS = 4;
const STUDIO_DESK_PULSE_MS = 20000;
const STUDIO_DESK_COUNTDOWN_MS = 60 * 1000;
const STUDIO_DESK_SOUND_KEY = 'albayan.studio.desk.sound.';
const STUDIO_DESK_OVERRIDE_REASON = [10, 300];
const STUDIO_DESK_SECTIONS = Object.freeze(['requests', 'launch', 'settle', 'tickets', 'health', 'more']);
// A refusal of the settle routes (/api/ad-studio …/stop and …/settle-override: a plain English prefix)
// is read through the ONE Arabic map (15c, via 15g studioErrorInfo). SETTLE_NOT_READY comes as {code,
// message, messageAr, readyAt} and is shown from that shape with its countdown.

const _studioDesk = {
  forUser: '', generation: 0,
  shown: Object.create(null),   // section -> rows shown (P3-13 paging)
  results: new Map(),           // request id -> {state, view, staff, results, at, promise}
  decisions: new Map(),         // request id -> {reason, note, error, outcome}
  settle: new Map(),            // request id -> {refund, reason, error, readyAt}
  sheet: { kind: '', id: '', el: null, opener: null },
  runs: new Map(),              // `${kind}:${id}` -> the action in flight (single flight)
  pulse: { value: null, at: 0, watching: false, baseTitle: '', shownCount: -1 },
  audio: null, redrawTimer: null, countdownTimer: null, paintTimer: null
};

// ------------------------------------------------------------------ small helpers

function studioDeskUserId() {
  return typeof studioMeUserId === 'function' ? studioMeUserId() : String((state.currentUser && state.currentUser.id) || '');
}

function studioDeskScope() {
  const uid = studioDeskUserId();
  if (_studioDesk.forUser !== uid) {
    _studioDesk.generation++;
    _studioDesk.forUser = uid;
    _studioDesk.shown = Object.create(null);
    _studioDesk.results = new Map();
    _studioDesk.decisions = new Map();
    _studioDesk.settle = new Map();
    _studioDesk.runs = new Map();
    _studioDesk.pulse.value = null;
    _studioDesk.pulse.shownCount = -1;
    _studioDesk.pulse.watching = false;  // the 15g watch stops itself on a user change: start it again
  }
  return uid;
}

function studioDeskIsAdmin() {
  return typeof isCurrentUserAdmin === 'function' && isCurrentUserAdmin();
}

function studioDeskCan() {
  return typeof adsStudioCanReview === 'function' && adsStudioCanReview();
}

function studioDeskServer() {
  return typeof isServerModeEnabled === 'function' && isServerModeEnabled();
}

function studioDeskIcon(name, className = 'studio-v2-icon') {
  return studioV2Icon(name, className);
}

function studioDeskRedraw() {
  if (_studioDesk.redrawTimer) return;
  _studioDesk.redrawTimer = setTimeout(() => {
    _studioDesk.redrawTimer = null;
    if (studioDeskOnScreen()) studioV2Rerender();
  }, 30);
}

// The desk is on screen: the studio view with the staff frame (the classic review tab has its own draw).
function studioDeskOnScreen() {
  return typeof state !== 'undefined' && state.currentView === 'ads-studio' && typeof studioV2Frame === 'function' && studioV2Frame() === 'staff';
}

function studioDeskGo(section, id = '') {
  return studioV2Go({ tab: 'review', section: String(section || 'requests'), id: String(id || '') });
}

function studioDeskShown(section) {
  return Math.max(STUDIO_DESK_PAGE, Number(_studioDesk.shown[section]) || 0);
}

function studioDeskMore(section) {
  const key = String(section || '');
  if (!STUDIO_DESK_SECTIONS.includes(key)) return;
  _studioDesk.shown[key] = studioDeskShown(key) + STUDIO_DESK_PAGE;
  studioV2Rerender();
}

function studioDeskName(request) {
  return typeof studioDataName === 'function' ? studioDataName(request) : String((request && request.name) || '').slice(0, 160);
}

function studioDeskCustomer(request) {
  return typeof adsStudioCreatorName === 'function' ? String(adsStudioCreatorName(request) || '') : '';
}

function studioDeskMinor(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function studioDeskPaid(request) {
  const paid = studioDeskMinor(request && request.paidMinorUSD);
  return paid || (typeof adsStudioHeldMinorFor === 'function' ? adsStudioHeldMinorFor(request) : 0);
}

function studioDeskLinked(request) {
  return /^\d{1,40}$/.test(String((request && request.metaCampaignId) || '').trim());
}

// The Meta campaign a request carried once and lost since (an unlink; the server keeps
// lastLinkedMetaCampaignId / everLinked, ad_campaign_actions._link_history): '' when never linked.
function studioDeskLastLinkedId(request) {
  const last = String((request && request.lastLinkedMetaCampaignId) || '').trim();
  return /^\d{1,40}$/.test(last) ? last : '';
}

// Linked now, or linked before: the server settles such a request on that campaign's results row
// (never as a "never linked" full return), so the settle section reads its results and shows the cap.
function studioDeskWasLinked(request) {
  return studioDeskLinked(request) || !!studioDeskLastLinkedId(request) || !!(request && request.everLinked === true);
}

function studioDeskLibyaToday() {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch (_) { return new Date().toISOString().slice(0, 10); }
}

function studioDeskWhen(iso) {
  if (typeof studioHelpWhen === 'function') return studioHelpWhen(iso);
  const at = Date.parse(String(iso || ''));
  return Number.isFinite(at) ? new Date(at).toLocaleString(adsStudioIsAr() ? 'ar-LY' : 'en-GB') : '';
}

function studioDeskArCount(count, one, two, few, many) {
  if (typeof studioHelpArCount === 'function') return studioHelpArCount(count, one, two, few, many);
  return count === 1 ? one : count === 2 ? two : `${count} ${count >= 3 && count <= 10 ? few : many}`;
}

// "in 47 h 12 min" / "due now" for a time the server gave; '' when it is not a time.
function studioDeskCountdown(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const left = Math.ceil((at - Date.now()) / 60000);
  if (left <= 0) return adsStudioText('due now — waiting for Meta\'s final read', 'حان الموعد — بانتظار قراءة ميتا النهائية');
  const hours = Math.floor(left / 60);
  const minutes = left % 60;
  if (!hours) return adsStudioText(`in ${minutes} min`, `بعد ${minutes} دقيقة`);
  return adsStudioText(`in ${hours} h ${minutes} min`, `بعد ${hours} س ${minutes} د`);
}

function studioDeskErrorInfo(error) {
  const detail = error && error.payload ? error.payload.detail : null;
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && String(detail.code || '') === 'SETTLE_NOT_READY') {
    const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    const readyAt = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(detail.readyAt || '')) ? String(detail.readyAt) : '';
    const countdown = readyAt ? studioDeskCountdown(readyAt) : '';
    const base = adsStudioText(clean(detail.message) || 'The final amount is not ready yet.', clean(detail.messageAr) || 'المبلغ النهائي غير جاهز بعد.');
    return { code: 'SETTLE_NOT_READY', readyAt, text: countdown ? `${base} (${countdown})` : base };
  }
  const info = studioErrorInfo(error, 'action');
  return { code: info.code || '', readyAt: '', text: info.text };
}

function studioDeskNotify(ok, title, text) {
  try { showNotification(title, text, ok ? 'success' : 'error'); } catch (_) {}
}

// ------------------------------------------------------------------ the lists

function studioDeskQueue() {
  return typeof adsStudioReviewQueue === 'function' ? adsStudioReviewQueue() : [];
}

function studioDeskApproved() {
  return getVisibleAdsStudioCampaigns().filter(item => String(item.status || '') === 'Approved');
}

function studioDeskLaunchQueue() {
  return studioDeskApproved().filter(item => !String(item.metaCampaignId || '').trim());
}

function studioDeskLinkedList() {
  return studioDeskApproved().filter(item => studioDeskLinked(item) && studioDeskStage(item).stage !== 10);
}

function studioDeskEndedList() {
  return studioDeskApproved().filter(item => !String(item.settleBasis || '').trim() && studioDeskStage(item).stage === 10);
}

// One request's display stage for the desk: the server's (the results read, staff view), else a plain
// guess: linked = "checking Meta", not linked past its end = ended (a full return), else approved.
function studioDeskStage(request) {
  const entry = _studioDesk.results.get(String((request && request.id) || ''));
  if (entry && entry.view && entry.view.stage) return entry.view;
  const linked = studioDeskLinked(request);
  const end = String((request && request.endDate) || '');
  const endPassed = /^\d{4}-\d{2}-\d{2}$/.test(end) && studioDeskLibyaToday() > end;
  const raw = linked
    ? { stage: 4, labels: { en: 'Approved — checking Meta', ar: 'مقبول — نتحقق من ميتا' }, linked: true, checking: true }
    : endPassed
      ? (studioDeskWasLinked(request)
        ? { stage: 10, labels: { en: 'Ended — final amount being calculated', ar: 'انتهى — نحسب المبلغ النهائي' } }  // was linked: no "never showed" guess
        : { stage: 10, labels: { en: 'Ended — final amount being calculated', ar: 'انتهى — نحسب المبلغ النهائي' }, variantLabels: { en: 'Meta never showed this ad: a full return', ar: 'لم تعرض ميتا هذا الإعلان: يعود المبلغ كاملاً' } })
      : { stage: 4, labels: { en: 'Approved — being set up in Meta', ar: 'مقبول — نجهّزه في ميتا' } };
  const view = studioStageView(raw);
  view.fromServer = false;
  return view;
}

// The staff results read of one linked request (stage, Meta spend, the settle times), kept 2 minutes.
function studioDeskReadResults(id, force = false) {
  const requestId = String(id || '');
  if (!requestId || !studioDeskServer()) return null;
  let entry = _studioDesk.results.get(requestId);
  if (!entry) {
    entry = { state: '', view: null, staff: null, results: null, at: 0, promise: null };
    _studioDesk.results.set(requestId, entry);
  }
  if (entry.promise) return entry.promise;
  const age = Date.now() - entry.at;
  if (!force && ((entry.state === 'done' && age < STUDIO_DESK_RESULTS_TTL_MS) || (entry.state === 'failed' && age < STUDIO_DESK_RESULTS_RETRY_MS))) return null;
  let reading = 0;
  _studioDesk.results.forEach(item => { if (item.promise) reading += 1; });
  if (reading >= STUDIO_DESK_RESULTS_MAX_READS && !force) return null;
  const generation = _studioDesk.generation;
  const signal = studioReadSignal();
  entry.promise = studioApi(`/api/studio/campaigns/${encodeURIComponent(requestId)}/results`, { method: 'GET' }).then(body => {
    if (generation !== _studioDesk.generation) return;
    const view = body && typeof body === 'object' ? studioStageView(body.stage) : null;
    if (!view) { entry.state = 'failed'; return; }
    entry.view = view;
    entry.staff = body.staff && typeof body.staff === 'object' ? body.staff : null;
    entry.results = body.results && typeof body.results === 'object' ? body.results : null;
    entry.state = 'done';
  }, error => {
    if (generation !== _studioDesk.generation || studioReadCancelled(error, signal)) return;
    entry.state = 'failed';
  }).finally(() => {
    if (generation !== _studioDesk.generation) return;
    entry.at = Date.now();
    entry.promise = null;
    studioDeskRedraw();
  });
  if (!entry.view) entry.state = 'loading';
  return entry.promise;
}

function studioDeskWantResults(list) {
  for (const request of list) if (studioDeskWasLinked(request)) studioDeskReadResults(request.id);
}

// "Check Meta now": the classic single-flight call (15c), then this desk's own read of the answer.
function studioDeskCheckMeta(id, button = null) {
  const requestId = String(id || '');
  if (!requestId || typeof checkAdsStudioMetaNow !== 'function') return Promise.resolve(false);
  const uid = studioDeskUserId();
  return Promise.resolve(checkAdsStudioMetaNow(requestId, button)).then(done => {
    if (uid === studioDeskUserId()) studioDeskReadResults(requestId, true);
    return done;
  });
}

// ------------------------------------------------------------------ shared pieces

function renderStudioDeskEmpty(icon, title, text, testId) {
  return `
          <div class="studio-desk-empty" data-testid="${studioEsc(testId)}">
            ${studioDeskIcon(icon, 'studio-desk-empty-icon')}
            <h3 class="studio-desk-h3">${studioEsc(title)}</h3>
            ${text ? `<p class="studio-desk-note">${studioEsc(text)}</p>` : ''}
          </div>`;
}

function renderStudioDeskIntro(title, text, testId, extra = '') {
  return `
          <div class="studio-desk-head" data-testid="${studioEsc(testId)}">
            <div class="studio-desk-heading"><h2 class="studio-desk-h2">${studioEsc(title)}</h2>${text ? `<p class="studio-desk-note">${studioEsc(text)}</p>` : ''}</div>
            ${extra}
          </div>`;
}

function renderStudioDeskMoreButton(section, total) {
  if (total <= studioDeskShown(section)) return '';
  return `<button type="button" class="studio-v2-action studio-desk-more" data-testid="studio-desk-more-${studioEsc(section)}" onclick="studioDeskMore('${studioEsc(section)}')">${studioEsc(adsStudioText(`Show more (${total - studioDeskShown(section)} left)`, `اعرض المزيد (بقي ${total - studioDeskShown(section)})`))}</button>`;
}

function renderStudioDeskMeta(request) {
  const parts = [];
  const customer = studioDeskCustomer(request);
  if (customer) parts.push(`<span>${studioDeskIcon('user', 'studio-desk-meta-icon')}<span dir="auto">${studioEsc(customer)}</span></span>`);
  const budget = typeof adsStudioBudgetLine === 'function' ? adsStudioBudgetLine(request) : studioUsd(studioDeskPaid(request));
  if (budget) parts.push(`<span>${studioDeskIcon('wallet-cards', 'studio-desk-meta-icon')}<span dir="auto">${studioEsc(budget)}</span></span>`);
  const days = Number(request.durationDays);
  if (Number.isSafeInteger(days) && days > 0) parts.push(`<span>${studioDeskIcon('calendar-days', 'studio-desk-meta-icon')}<span>${studioEsc(adsStudioDaysText(days))}</span></span>`);
  if (request.pageName) parts.push(`<span>${studioDeskIcon('flag', 'studio-desk-meta-icon')}<span dir="auto">${studioEsc(String(request.pageName).slice(0, 80))}</span></span>`);
  return `<p class="studio-desk-meta">${parts.join('')}</p>`;
}

// The studio name ("ALB-S-XXXXXXXX · name", assigned at approval) with one-tap Copy (15c's copy).
function renderStudioDeskNameRow(request) {
  const name = typeof adsStudioStudioName === 'function' ? adsStudioStudioName(request) : String((request && request.studioName) || '').trim();
  if (!name) return `<p class="studio-desk-note" data-testid="studio-desk-no-name">${studioEsc(adsStudioText('This request has no studio name yet.', 'لا يوجد اسم استوديو لهذا الطلب بعد.'))}</p>`;
  return `
            <div class="studio-desk-name" data-testid="studio-desk-name-${studioEsc(request.id)}">
              <div class="studio-desk-name-text"><span class="studio-desk-label">${studioEsc(adsStudioText('Campaign name in Meta', 'اسم الحملة في ميتا'))}</span><code class="studio-desk-code" dir="ltr" data-testid="studio-desk-studio-name">${studioEsc(name)}</code></div>
              <button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-desk-copy-${studioEsc(request.id)}" onclick="adsStudioCopyStudioName('${studioEsc(request.id)}', this)">${studioDeskIcon('copy')}<span aria-live="polite">${studioEsc(adsStudioText('Copy', 'نسخ'))}</span></button>
            </div>`;
}

function renderStudioDeskStageLine(request) {
  const stage = studioDeskStage(request);
  const ago = stage.checkedAgo ? `<span class="studio-checked${stage.stale ? ' is-stale' : ''}">${studioEsc(stage.checkedAgo)}</span>` : '';
  const flags = stage.flags.map(flag => `<span class="studio-flag">${studioEsc(flag.text)}</span>`).join('');
  return `<p class="studio-desk-stage">${renderStudioStageChip(stage)}${ago}${flags ? `<span class="studio-flags">${flags}</span>` : ''}</p>`;
}

// ------------------------------------------------------------------ requests (the review queue)

function studioDeskDecision(id) {
  const key = String(id || '');
  let draft = _studioDesk.decisions.get(key);
  if (!draft) {
    const request = findVisibleAdsStudioCampaign(key);
    const legacy = typeof adsStudioIsLegacyDailyRequest === 'function' && adsStudioIsLegacyDailyRequest(request);
    draft = { reason: legacy ? 'budget_dates' : '', note: legacy && typeof adsStudioLegacyDailyNote === 'function' ? adsStudioLegacyDailyNote() : '', error: '', outcome: null };
    _studioDesk.decisions.set(key, draft);
  }
  return draft;
}

function studioDeskPickReason(id, code) {
  const draft = studioDeskDecision(id);
  draft.reason = ADS_STUDIO_REVIEW_REASONS.some(([known]) => known === String(code || '')) ? String(code) : '';
  draft.error = '';
  studioV2Rerender();
}

function studioDeskNoteInput(id, input) {
  const draft = studioDeskDecision(id);
  draft.note = String((input && input.value) || '').slice(0, 1000);
}

function renderStudioDeskRequestCard(request) {
  const id = studioEsc(request.id);
  const legacy = typeof adsStudioIsLegacyDailyRequest === 'function' && adsStudioIsLegacyDailyRequest(request);
  const since = request.submittedAt ? studioDeskWhen(request.submittedAt) : '';
  return `
              <li>
                <button type="button" class="studio-desk-card" data-testid="studio-desk-request-${id}" onclick="studioDeskGo('requests', '${id}')">
                  <span class="studio-desk-card-name" dir="auto">${studioEsc(studioDeskName(request))}</span>
                  ${renderStudioDeskMeta(request)}
                  ${since ? `<span class="studio-desk-note">${studioEsc(adsStudioText(`Sent ${since}`, `أُرسل ${since}`))}</span>` : ''}
                  ${legacy ? `<span class="studio-flag">${studioEsc(adsStudioText('Old daily request: send it back (budget or dates)', 'طلب يومي قديم: أعده للعميل (الميزانية أو التواريخ)'))}</span>` : ''}
                </button>
              </li>`;
}

function renderStudioDeskRequests(route) {
  if (route && route.id) return renderStudioDeskRequestDetail(route.id);
  const queue = studioDeskQueue();
  const shown = queue.slice(0, studioDeskShown('requests'));
  const intro = renderStudioDeskIntro(
    adsStudioText(`Waiting for review (${queue.length})`, `بانتظار المراجعة (${queue.length})`),
    adsStudioText("Approval charges the customer's held budget; the Meta setup is the next section.", 'الموافقة تخصم الميزانية المحجوزة من محفظة العميل؛ تجهيز ميتا في القسم التالي.'),
    'studio-desk-requests-head');
  if (!queue.length) return intro + renderStudioDeskEmpty('badge-check', adsStudioText('The review queue is clear', 'لا طلبات تنتظر المراجعة'), adsStudioText('New requests appear here as soon as customers send them.', 'تظهر الطلبات الجديدة هنا فور إرسالها.'), 'studio-desk-requests-empty');
  return `${intro}
          <ul class="studio-desk-list" data-testid="studio-desk-requests">${shown.map(renderStudioDeskRequestCard).join('')}</ul>
          ${renderStudioDeskMoreButton('requests', queue.length)}`;
}

function renderStudioDeskBrief(request) {
  const text = value => String(value || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim();
  const list = value => (Array.isArray(value) ? value.map(item => text(item)).filter(Boolean).join(', ') : '');
  const link = value => (typeof adsStudioSafeHttpsUrl === 'function' ? adsStudioSafeHttpsUrl(value) : '');
  const post = request.boostType === 'boost_post' ? link(request.sourcePostRef) : '';
  const destination = link(request.destination) || text(request.destination);
  const photos = typeof getEntityPhotoCountHint === 'function' ? Number(getEntityPhotoCountHint('adCampaignRequests', request)) || 0 : 0;
  const total = studioDeskPaid(request);
  const rows = [
    [adsStudioText('Goal', 'الهدف'), typeof adsStudioObjectiveLabel === 'function' ? text(adsStudioObjectiveLabel(request.objective)) : text(request.objective)],
    [adsStudioText('Budget', 'الميزانية'), `${typeof adsStudioBudgetLine === 'function' ? adsStudioBudgetLine(request) : ''}${total ? ` · ${adsStudioText('holds', 'محجوز')} ${studioUsd(total)}` : ''}`],
    [adsStudioText('Dates', 'التواريخ'), request.startDate ? `${adsStudioFormatDate(request.startDate)} → ${adsStudioFormatDate(request.endDate)}` : ''],
    [adsStudioText('Page', 'الصفحة'), text(request.pageName)],
    [adsStudioText('Where', 'المنصات'), list(request.platforms)],
    [adsStudioText('Audience', 'الجمهور'), [list(request.locations), `${Number(request.ageMin) || 18}–${Number(request.ageMax) || 65}`, list(request.genders), list(request.interests)].filter(Boolean).join(' · ')],
    [adsStudioText('Ad text', 'نص الإعلان'), text(request.primaryText)],
    [adsStudioText('Headline', 'العنوان'), text(request.headline)],
    [adsStudioText('Description', 'الوصف'), text(request.description)],
    [adsStudioText('Button', 'الزر'), text(request.callToAction)],
    [adsStudioText('Notes', 'ملاحظات'), text(request.notes)]
  ].filter(([, value]) => value);
  const links = [];
  if (post) links.push(`<a class="studio-v2-action studio-desk-small" data-testid="studio-desk-post-link" href="${studioEsc(post)}" target="_blank" rel="noopener noreferrer">${studioDeskIcon('external-link')}<span>${studioEsc(adsStudioText('Open the boosted post', 'افتح المنشور المروَّج'))}</span></a>`);
  if (link(request.destination)) links.push(`<a class="studio-v2-action studio-desk-small" data-testid="studio-desk-destination-link" href="${studioEsc(link(request.destination))}" target="_blank" rel="noopener noreferrer">${studioDeskIcon('link')}<span>${studioEsc(adsStudioText('Open the destination', 'افتح الوجهة'))}</span></a>`);
  else if (destination) rows.push([adsStudioText('Destination', 'الوجهة'), destination]);
  if (photos) links.push(`<button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-desk-photos" onclick="openAdsStudioCreativeViewer('${studioEsc(request.id)}', 0, this)">${studioDeskIcon('images')}<span>${studioEsc(adsStudioText(`View the photos (${photos})`, `اعرض الصور (${photos})`))}</span></button>`);
  return `
          <section class="studio-desk-box" data-testid="studio-desk-brief" aria-labelledby="studio-desk-brief-title">
            <h3 id="studio-desk-brief-title" class="studio-desk-h3">${studioEsc(adsStudioText("The customer's request", 'طلب العميل'))}</h3>
            <dl class="studio-desk-dl">${rows.map(([label, value]) => `<div><dt>${studioEsc(label)}</dt><dd dir="auto">${studioEsc(String(value).slice(0, 3000))}</dd></div>`).join('')}</dl>
            ${links.length ? `<div class="studio-desk-actions">${links.join('')}</div>` : ''}
            ${typeof renderAdsStudioReviewHistory === 'function' ? renderAdsStudioReviewHistory(request) : ''}
          </section>`;
}

function renderStudioDeskDecisionBox(request) {
  const id = studioEsc(request.id);
  const draft = studioDeskDecision(request.id);
  const busy = ['Approved', 'Changes Requested', 'Rejected'].some(kind => _studioDesk.runs.has(`review:${kind}:${request.id}`));
  const chips = ADS_STUDIO_REVIEW_REASONS.map(([code, en, ar]) =>
    `<button type="button" class="studio-help-chip" data-testid="studio-desk-reason-${code}" aria-pressed="${draft.reason === code ? 'true' : 'false'}" onclick="studioDeskPickReason('${id}', '${code}')">${studioEsc(adsStudioText(en, ar))}</button>`).join('');
  const days = Number(request.durationDays);
  const held = studioDeskPaid(request);
  return `
          <section class="studio-desk-box studio-desk-decision" data-testid="studio-desk-decision" aria-labelledby="studio-desk-decision-title">
            <h3 id="studio-desk-decision-title" class="studio-desk-h3">${studioEsc(adsStudioText('Your decision', 'قرارك'))}</h3>
            <p class="studio-desk-note">${studioEsc(adsStudioText(`Approve charges the held ${studioUsd(held)}${Number.isSafeInteger(days) && days > 0 ? ` and runs the ad for ${adsStudioDaysText(days)} from the start` : ''}. Send back or reject needs a reason and a note the customer will read.`,
              `الموافقة تخصم ${studioUsd(held)} المحجوزة${Number.isSafeInteger(days) && days > 0 ? ` ويعمل الإعلان ${adsStudioDaysText(days)} من بدايته` : ''}. طلب التعديل أو الرفض يحتاج سبباً وملاحظة يقرؤها العميل.`))}</p>
            <p class="studio-desk-label">${studioEsc(adsStudioText('Reason', 'السبب'))}</p>
            <div class="studio-help-chips" role="group" aria-label="${studioEsc(adsStudioText('Reason', 'السبب'))}" data-testid="studio-desk-reasons">${chips}</div>
            <label class="studio-desk-label" for="studio-desk-note-${id}">${studioEsc(adsStudioText('Note to the customer', 'ملاحظة للعميل'))}</label>
            <textarea id="studio-desk-note-${id}" class="studio-desk-input" rows="3" maxlength="1000" data-testid="studio-desk-note" oninput="studioDeskNoteInput('${id}', this)" placeholder="${studioEsc(adsStudioText('What should change, in plain words', 'ما الذي يجب تعديله، بكلمات بسيطة'))}">${studioEsc(draft.note)}</textarea>
            <p class="studio-ads-sheet-error" role="alert" data-testid="studio-desk-decision-error"${draft.error ? '' : ' hidden'}>${studioEsc(draft.error)}</p>
            <div class="studio-desk-actions studio-desk-decision-actions">
              <button type="button" class="studio-v2-action" data-testid="studio-desk-changes" onclick="studioDeskDecide('${id}', 'Changes Requested', this)"${busy ? ' disabled' : ''}>${studioDeskIcon('message-square-warning')}<span>${studioEsc(adsStudioText('Send back', 'أعده للتعديل'))}</span></button>
              <button type="button" class="studio-v2-action studio-ads-danger" data-testid="studio-desk-reject" onclick="studioDeskDecide('${id}', 'Rejected', this)"${busy ? ' disabled' : ''}>${studioDeskIcon('x')}<span>${studioEsc(adsStudioText('Reject', 'ارفض'))}</span></button>
              <button type="button" class="studio-v2-action is-primary" data-testid="studio-desk-approve" onclick="studioDeskDecide('${id}', 'Approved', this)"${busy ? ' disabled' : ''}>${studioDeskIcon('badge-check')}<span>${studioEsc(adsStudioText('Approve', 'وافق'))}</span></button>
            </div>
          </section>`;
}

// request: the row when it is still in the desk lists; a request sent back leaves a reviewer's lists
// (Changes Requested is not a workflow-visible status), so the decision this desk just recorded is
// drawn from its own note (draft.outcome) with no row at all.
function renderStudioDeskOutcome(request, requestId = '') {
  const draft = _studioDesk.decisions.get(String((request && request.id) || requestId));
  const status = request ? String(request.status || '') : '';
  if (status === 'Submitted' || (!request && !(draft && draft.outcome))) return '';
  const decided = draft && draft.outcome ? draft.outcome.decision : status;
  const meta = adsStudioStatusMeta(decided);
  const words = decided === 'Approved'
    ? adsStudioText('Approved. The budget is charged; set the ad up in Meta from the Launch section.', 'تمت الموافقة. خُصمت الميزانية؛ جهّز الإعلان في ميتا من قسم الإطلاق.')
    : decided === 'Rejected'
      ? adsStudioText('Rejected. The customer sees the reason and your note; the held money is released.', 'رُفض الطلب. يرى العميل السبب وملاحظتك؛ أُفرج عن المبلغ المحجوز.')
      : decided === 'Changes Requested'
        ? adsStudioText('Sent back. The customer sees the reason and your note; the held money is released.', 'أُعيد للتعديل. يرى العميل السبب وملاحظتك؛ أُفرج عن المبلغ المحجوز.')
        : adsStudioText('This request has left the review queue.', 'خرج هذا الطلب من قائمة المراجعة.');
  return `
          <section class="studio-desk-box studio-desk-outcome" data-testid="studio-desk-outcome" data-decision="${studioEsc(decided)}" data-tone="${decided === 'Approved' ? 'green' : decided === 'Rejected' ? 'red' : 'orange'}">
            <p class="studio-desk-outcome-title">${studioDeskIcon(meta.icon || 'check')}<span>${studioEsc(adsStudioText(meta.label, meta.labelAr))}</span></p>
            <p class="studio-desk-note">${studioEsc(words)}</p>
            ${request && status === 'Approved' ? renderStudioDeskNameRow(request) : ''}
            <div class="studio-desk-actions">
              ${request && status === 'Approved' ? `<button type="button" class="studio-v2-action is-primary" data-testid="studio-desk-to-launch" onclick="studioDeskGo('launch')">${studioDeskIcon('rocket')}<span>${studioEsc(adsStudioText('Go to Launch', 'إلى الإطلاق'))}</span></button>` : ''}
              <button type="button" class="studio-v2-action" data-testid="studio-desk-back-queue" onclick="studioDeskGo('requests')">${studioEsc(adsStudioText('Back to the queue', 'عودة إلى القائمة'))}</button>
            </div>
          </section>`;
}

function renderStudioDeskRequestDetail(id) {
  const request = findVisibleAdsStudioCampaign(id);
  if (!request) {
    const decided = renderStudioDeskOutcome(null, id);  // the decision this desk just recorded, when the row left the lists
    if (decided) return `<article class="studio-desk-detail" data-testid="studio-desk-request-detail" data-status="gone">${decided}</article>`;
    return renderStudioDeskEmpty('search-x', adsStudioText('This request is not in the desk lists.', 'هذا الطلب ليس في قوائم المكتب.'),
      adsStudioText('It may have been withdrawn, archived or moved on.', 'ربما سُحب أو أُرشف أو تغيّرت حالته.'), 'studio-desk-request-missing')
      + `<div class="studio-desk-actions"><button type="button" class="studio-v2-action" onclick="studioDeskGo('requests')">${studioEsc(adsStudioText('Back to the queue', 'عودة إلى القائمة'))}</button></div>`;
  }
  const own = String(request.createdBy || '') === studioDeskUserId();
  const status = String(request.status || '');
  const legacy = typeof adsStudioIsLegacyDailyRequest === 'function' && adsStudioIsLegacyDailyRequest(request);
  const ref = String(request.studioRef || '');
  return `
          <article class="studio-desk-detail" data-testid="studio-desk-request-detail" data-status="${studioEsc(status)}">
            <header class="studio-desk-box studio-desk-detail-head">
              <h2 class="studio-desk-h2" dir="auto">${studioEsc(studioDeskName(request))}</h2>
              ${renderStudioDeskMeta(request)}
              <p class="studio-desk-stage">${renderStudioStageChip(studioDeskStageOf(request))}${/^ALB-S-/.test(ref) ? `<code class="studio-desk-code" dir="ltr">${studioEsc(ref)}</code>` : ''}</p>
              ${legacy && status === 'Submitted' ? `<p class="studio-flag" data-testid="studio-desk-legacy">${studioEsc(adsStudioText('Old daily request: it holds one day only. Send it back with "Budget or dates" so the customer re-sends the total.', 'طلب يومي قديم: يحجز يوماً واحداً فقط. أعده بسبب «الميزانية أو التواريخ» ليرسله العميل بالإجمالي.'))}</p>` : ''}
              ${own && status === 'Submitted' && !studioDeskIsAdmin() ? `<p class="studio-desk-note" data-testid="studio-desk-own">${studioEsc(adsStudioText('This is your own request: another team member reviews it.', 'هذا طلبك أنت: يراجعه عضو آخر من الفريق.'))}</p>` : ''}
            </header>
            ${renderStudioDeskBrief(request)}
            ${status === 'Submitted' && (!own || studioDeskIsAdmin()) ? renderStudioDeskDecisionBox(request) : renderStudioDeskOutcome(request)}
          </article>`;
}

// The stage chip of any visible request: the plain status for one still under review.
function studioDeskStageOf(request) {
  const status = String((request && request.status) || 'Draft');
  if (status === 'Approved') return studioDeskStage(request);
  const number = { Draft: 1, Submitted: 2, 'Changes Requested': 3, Stopped: 12, Rejected: 13 }[status] || 1;
  const meta = adsStudioStatusMeta(status);
  return studioStageView({ stage: number, labels: { en: meta.label, ar: meta.labelAr } });
}

// One decision per request at a time. Approval opens the confirm sheet first (money moves).
function studioDeskDecide(id, decision, button = null, confirmed = false) {
  const requestId = String(id || '');
  const key = `review:${decision}:${requestId}`;
  if (_studioDesk.runs.has(key)) return _studioDesk.runs.get(key);
  const draft = studioDeskDecision(requestId);
  const noteBox = typeof document !== 'undefined' && typeof document.getElementById === 'function' ? document.getElementById(`studio-desk-note-${requestId}`) : null;
  if (noteBox) draft.note = String(noteBox.value || '').slice(0, 1000);
  const note = Security.sanitizeInput(String(draft.note || ''), { maxLength: 1000 }).trim();
  draft.error = '';
  if (decision !== 'Approved' && !draft.reason) draft.error = adsStudioText('Choose a reason for this decision.', 'اختر سبباً لهذا القرار.');
  else if (decision !== 'Approved' && !note) draft.error = adsStudioText('Write what the customer should change.', 'اكتب للعميل ما الذي يجب تعديله.');
  else if (!studioDeskServer()) draft.error = adsStudioText('Reviewing needs the connection to Albayan.', 'المراجعة تحتاج الاتصال بالبيان.');
  if (draft.error) { studioV2Rerender(); return Promise.resolve({ ok: false, text: draft.error }); }
  if (decision === 'Approved' && !confirmed) {
    studioDeskSheetOpen('approve', requestId, button);
    return Promise.resolve({ ok: true, pending: true });
  }
  if (button) setAdsStudioActionButtonBusy(button, true);
  const operation = studioDeskDecideOnce(requestId, decision, note, decision === 'Approved' ? '' : draft.reason)
    .catch(error => ({ ok: false, text: studioDeskErrorInfo(error).text }));
  _studioDesk.runs.set(key, operation);
  const cleanup = () => {
    if (_studioDesk.runs.get(key) === operation) _studioDesk.runs.delete(key);
    if (button) setAdsStudioActionButtonBusy(button, false);
    studioV2Rerender();
  };
  operation.then(cleanup, cleanup);
  return operation;
}

async function studioDeskDecideOnce(requestId, decision, note, reasonCode) {
  const request = findVisibleAdsStudioCampaign(requestId);
  if (!request || String(request.status || '') !== 'Submitted') {
    return { ok: false, text: adsStudioText('This request changed meanwhile. Check its new state.', 'تغيّر هذا الطلب في الأثناء. راجع حالته الجديدة.') };
  }
  const attempt = adsStudioActionAttempt('review', request.id, Number(request._lastModified));
  let entity;
  try {
    entity = await adsStudioApiReview(request.id, attempt.expectedLastModified, decision, note, attempt.operationId, reasonCode);
  } catch (error) {
    const fresh = error && error.status === 409 ? await adsStudioReloadCampaign(request.id) : null;
    if (!fresh || String((fresh.data && fresh.data.status) || '') !== decision) throw error;
    entity = fresh;  // the first tap already recorded this decision
  }
  _adsStudioActionAttempts.delete(attempt.key);
  const saved = upsertAdsStudioEntity(entity);
  const draft = studioDeskDecision(requestId);
  draft.outcome = { decision, studioName: typeof adsStudioStudioName === 'function' ? adsStudioStudioName(saved) : '' };
  draft.error = '';
  studioDeskPulseRefresh();
  studioDeskNotify(true, adsStudioText('Decision saved', 'تم حفظ القرار'), adsStudioText(`The request is now: ${adsStudioStatusMeta(decision).label}.`, `حالة الطلب الآن: ${adsStudioStatusMeta(decision).labelAr}.`));
  return { ok: true };
}

// ------------------------------------------------------------------ launch (P3-06b)

function renderStudioDeskLaunchCard(request) {
  const id = studioEsc(request.id);
  const paid = studioDeskPaid(request);
  const checklist = [
    adsStudioText('Create the ad in Meta on one of Albayan\'s ad accounts (any name).', 'أنشئ الإعلان في ميتا على أحد حسابات البيان الإعلانية (بأي اسم).'),
    adsStudioText('Put the studio code in the campaign name, or let Albayan rename it at the link.', 'ضع رمز الاستوديو في اسم الحملة، أو دع البيان يغيّر الاسم عند الربط.'),
    adsStudioText(`Keep the budget in Meta within what was paid${paid ? ` (${studioUsd(paid)})` : ''}: ${String(request.budgetType || '') === 'daily' ? 'daily × days' : 'lifetime'}.`, `اجعل الميزانية في ميتا ضمن المدفوع${paid ? ` (${studioUsd(paid)})` : ''}: ${String(request.budgetType || '') === 'daily' ? 'يومي × الأيام' : 'إجمالي'}.`)
  ];
  return `
              <li class="studio-desk-box studio-desk-launch" data-testid="studio-desk-launch-${id}">
                <h3 class="studio-desk-h3" dir="auto">${studioEsc(studioDeskName(request))}</h3>
                ${renderStudioDeskMeta(request)}
                ${renderStudioDeskNameRow(request)}
                <ol class="studio-desk-checklist">${checklist.map(item => `<li>${studioEsc(item)}</li>`).join('')}</ol>
                <div class="studio-desk-actions">
                  <button type="button" class="studio-v2-action is-primary" data-testid="studio-desk-link-${id}" onclick="openAdsStudioLinkSheet('${id}')">${studioDeskIcon('link-2')}<span>${studioEsc(adsStudioText('Link Meta campaign', 'اربط حملة ميتا'))}</span></button>
                  <button type="button" class="studio-v2-action" onclick="studioDeskGo('requests', '${id}')">${studioDeskIcon('file-text')}<span>${studioEsc(adsStudioText('The request', 'تفاصيل الطلب'))}</span></button>
                </div>
              </li>`;
}

function renderStudioDeskLinkedCard(request) {
  const id = studioEsc(request.id);
  const entry = _studioDesk.results.get(String(request.id));
  const stage = studioDeskStage(request);
  const busy = typeof _adsStudioResultsChecks !== 'undefined' && _adsStudioResultsChecks.has(String(request.id));
  const used = stage.metaUsedMinor !== null ? adsStudioText(`Meta used ${studioUsd(stage.metaUsedMinor)} of ${studioUsd(studioDeskPaid(request))}`, `استخدمت ميتا ${studioUsd(stage.metaUsedMinor)} من ${studioUsd(studioDeskPaid(request))}`) : '';
  const problem = entry && entry.staff && ['error', 'throttled', 'not_found', 'not_allowed'].includes(String(entry.staff.syncState || ''))
    ? adsStudioText(`Last Meta check failed (${String(entry.staff.lastErrorCode || entry.staff.syncState).slice(0, 40)})`, `فشل آخر فحص لميتا (${String(entry.staff.lastErrorCode || entry.staff.syncState).slice(0, 40)})`) : '';
  return `
              <li class="studio-desk-box" data-testid="studio-desk-linked-${id}" data-stage="${stage.stage}">
                <h3 class="studio-desk-h3" dir="auto">${studioEsc(studioDeskName(request))}</h3>
                ${renderStudioDeskMeta(request)}
                ${renderStudioDeskStageLine(request)}
                <p class="studio-desk-note">${studioEsc(adsStudioText('Meta campaign', 'حملة ميتا'))} <code class="studio-desk-code" dir="ltr">${studioEsc(String(request.metaCampaignId))}</code>${used ? ` · <span data-testid="studio-desk-meta-used">${studioEsc(used)}</span>` : ''}</p>
                ${problem ? `<p class="studio-desk-problem">${studioEsc(problem)}</p>` : ''}
                <div class="studio-desk-actions">
                  <button type="button" class="studio-v2-action" data-testid="studio-desk-check-${id}" onclick="studioDeskCheckMeta('${id}', this)"${busy ? ' disabled aria-busy="true"' : ''}>${studioDeskIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Check Meta now', 'افحص ميتا الآن'))}</span></button>
                  <button type="button" class="studio-v2-action studio-ads-danger" data-testid="studio-desk-unlink-${id}" onclick="openAdsStudioUnlinkSheet('${id}')">${studioDeskIcon('unlink')}<span>${studioEsc(adsStudioText('Unlink', 'ألغِ الربط'))}</span></button>
                </div>
              </li>`;
}

function renderStudioDeskLaunch() {
  const queue = studioDeskLaunchQueue();
  const linked = studioDeskLinkedList();
  studioDeskWantResults(linked);
  const shown = queue.slice(0, studioDeskShown('launch'));
  const intro = renderStudioDeskIntro(
    adsStudioText(`Approved — set up in Meta (${queue.length})`, `مقبولة — تجهيزها في ميتا (${queue.length})`),
    adsStudioText('Build the ad in Ads Manager, then link it here: Albayan renames the campaign to the name shown and keeps it out of Albayan Manager.', 'أنشئ الإعلان في مدير الإعلانات ثم اربطه هنا: يغيّر البيان اسم الحملة إلى الاسم الظاهر ويُبقيها خارج مدير البيان.'),
    'studio-desk-launch-head');
  const body = queue.length
    ? `<ul class="studio-desk-list" data-testid="studio-desk-launch">${shown.map(renderStudioDeskLaunchCard).join('')}</ul>${renderStudioDeskMoreButton('launch', queue.length)}`
    : renderStudioDeskEmpty('rocket', adsStudioText('Nothing waits for a Meta link', 'لا طلب ينتظر ربط ميتا'), '', 'studio-desk-launch-empty');
  const linkedShown = linked.slice(0, studioDeskShown('launch'));
  const linkedPart = linked.length ? `
          <h2 class="studio-desk-h2 studio-desk-h2-later">${studioEsc(adsStudioText(`In Meta (${linked.length})`, `في ميتا (${linked.length})`))}</h2>
          <ul class="studio-desk-list" data-testid="studio-desk-linked">${linkedShown.map(renderStudioDeskLinkedCard).join('')}</ul>` : '';
  return intro + body + linkedPart;
}

// ------------------------------------------------------------------ settle (P3-06c, P3-06d)

function studioDeskSettleEntry(id) {
  const key = String(id || '');
  let entry = _studioDesk.settle.get(key);
  if (!entry) {
    entry = { refund: '', reason: '', error: '', readyAt: '' };
    _studioDesk.settle.set(key, entry);
  }
  return entry;
}

// What the sheet starts from: paid, Meta's confirmed spend (null = unknown), the cap and the basis.
// A request linked before and unlinked since (wasLinked) is judged by the server on the old
// campaign's results row (ad_campaign_actions.settle_plan, last_linked_meta_ids): its spend comes
// from the staff row of THAT campaign (confirmed, USD), else the cap is unknown and the amount empty.
function studioDeskSettleNumbers(request) {
  const paid = studioDeskPaid(request);
  const entry = _studioDesk.results.get(String(request.id));
  const stage = studioDeskStage(request);
  const staff = entry && entry.staff ? entry.staff : {};
  const linked = studioDeskLinked(request);
  const wasLinked = !linked && studioDeskWasLinked(request);
  let spend = null;
  let never = false;
  if (linked) {
    // Never delivered (the server's flag on the results row): the whole payment returns.
    never = stage.stage === 10 && staff.neverDelivered === true;
    spend = never ? 0 : stage.metaUsedMinor;
  } else if (wasLinked) {
    const lastId = studioDeskLastLinkedId(request);
    const sameRow = !!lastId && String(staff.metaCampaignId || '') === lastId;
    const confirmed = sameRow && !!staff.spendConfirmedAt && String(staff.currency || 'USD') === 'USD' && Number.isSafeInteger(staff.spendMinorUSD) && staff.spendMinorUSD >= 0;
    never = sameRow && staff.neverDelivered === true && confirmed && staff.spendMinorUSD === 0;
    spend = confirmed ? staff.spendMinorUSD : null;
  } else {
    never = true;  // never linked: the whole payment returns
    spend = 0;
  }
  const cap = spend === null ? null : Math.max(paid - spend, 0);
  return {
    paid, spend, cap, never, wasLinked,
    readyAt: String(staff.settleReadDueAt || studioDeskSettleEntry(request.id).readyAt || ''),
    finalRead: !!staff.settleReadAt,
    confirmedAt: String(staff.spendConfirmedAt || '')
  };
}

function renderStudioDeskSettleCard(request) {
  const id = studioEsc(request.id);
  const numbers = studioDeskSettleNumbers(request);
  const linked = studioDeskLinked(request);
  const busy = typeof _adsStudioResultsChecks !== 'undefined' && _adsStudioResultsChecks.has(String(request.id));
  const wasLinked = numbers.wasLinked;
  const countdown = !linked && !wasLinked
    ? adsStudioText('Never linked to Meta: the full amount goes back now.', 'لم يُربط بميتا: يعود المبلغ كاملاً الآن.')
    : numbers.finalRead
      ? adsStudioText('Final Meta read done: ready to settle.', 'تمت قراءة ميتا النهائية: جاهز للتسوية.')
      : numbers.never
        ? adsStudioText('Meta never showed this ad: the full amount can go back now.', 'لم تعرض ميتا هذا الإعلان: يمكن إعادة المبلغ كاملاً الآن.')
        : numbers.readyAt
          ? adsStudioText(`Final Meta read ${studioDeskCountdown(numbers.readyAt)}`, `قراءة ميتا النهائية ${studioDeskCountdown(numbers.readyAt)}`)
          : wasLinked
            ? adsStudioText('Was linked to Meta before: the server sets the cap from that campaign\'s final Meta reading.', 'كان مربوطاً بميتا من قبل: يحدد الخادم الحد الأقصى من قراءة ميتا النهائية لتلك الحملة.')
            : adsStudioText('The final Meta read is scheduled after delivery ends; the countdown appears here then.', 'تُجدول قراءة ميتا النهائية بعد انتهاء العرض؛ ويظهر العدّ التنازلي هنا حينها.');
  const money = [
    `${adsStudioText('Paid', 'مدفوع')} ${studioUsd(numbers.paid)}`,
    numbers.spend === null ? adsStudioText('Meta used: not confirmed yet', 'صرف ميتا: غير مؤكد بعد') : `${adsStudioText('Meta used', 'صرف ميتا')} ${studioUsd(numbers.spend)}`,
    numbers.cap === null ? '' : `${adsStudioText('Return up to', 'يعود حتى')} ${studioUsd(numbers.cap)}`
  ].filter(Boolean).join(' · ');
  return `
              <li class="studio-desk-box" data-testid="studio-desk-settle-${id}" data-ready="${numbers.finalRead || numbers.never || (!linked && !wasLinked) ? '1' : '0'}"${wasLinked ? ' data-was-linked="1"' : ''}>
                <h3 class="studio-desk-h3" dir="auto">${studioEsc(studioDeskName(request))}</h3>
                ${renderStudioDeskMeta(request)}
                ${renderStudioDeskStageLine(request)}
                <p class="studio-desk-money" data-testid="studio-desk-settle-money">${studioEsc(money)}</p>
                <p class="studio-desk-countdown" data-testid="studio-desk-countdown-${id}">${studioDeskIcon('hourglass', 'studio-desk-meta-icon')}<span>${studioEsc(countdown)}</span></p>
                <div class="studio-desk-actions">
                  ${linked ? `<button type="button" class="studio-v2-action" data-testid="studio-desk-check-${id}" onclick="studioDeskCheckMeta('${id}', this)"${busy ? ' disabled aria-busy="true"' : ''}>${studioDeskIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Check Meta now', 'افحص ميتا الآن'))}</span></button>` : ''}
                  <button type="button" class="studio-v2-action is-primary" data-testid="studio-desk-finish-${id}" onclick="studioDeskSheetOpen('settle', '${id}', this)">${studioDeskIcon('scale')}<span>${studioEsc(adsStudioText('Finish & settle', 'إنهاء وتسوية'))}</span></button>
                  ${studioDeskIsAdmin() ? `<button type="button" class="studio-v2-action studio-ads-danger" data-testid="studio-desk-override-${id}" onclick="studioDeskSheetOpen('override', '${id}', this)">${studioDeskIcon('shield-alert')}<span>${studioEsc(adsStudioText('Admin override', 'تجاوز المدير'))}</span></button>` : ''}
                </div>
              </li>`;
}

function renderStudioDeskSettle() {
  const approved = studioDeskApproved();
  studioDeskWantResults(approved.filter(item => !String(item.settleBasis || '').trim()));
  const ended = studioDeskEndedList();
  const shown = ended.slice(0, studioDeskShown('settle'));
  const intro = renderStudioDeskIntro(
    adsStudioText(`Ended — settle (${ended.length})`, `منتهية — التسوية (${ended.length})`),
    adsStudioText("The final amount comes from Meta's confirmed spend after the final Meta reading (each row counts down to it; the wait is the Settlement setting). An ad Meta never showed returns everything at once.", 'يُحسب المبلغ النهائي من صرف ميتا المؤكد بعد قراءة ميتا النهائية (يعدّ كل صف تنازلياً إليها؛ ومدة الانتظار في إعداد التسوية). الإعلان الذي لم تعرضه ميتا يعود مبلغه كاملاً فوراً.'),
    'studio-desk-settle-head');
  if (!ended.length) return intro + renderStudioDeskEmpty('scale', adsStudioText('No ended ad waits for its settlement', 'لا إعلان منتهٍ ينتظر التسوية'), '', 'studio-desk-settle-empty');
  return `${intro}
          <ul class="studio-desk-list" data-testid="studio-desk-settle">${shown.map(renderStudioDeskSettleCard).join('')}</ul>
          ${renderStudioDeskMoreButton('settle', ended.length)}`;
}

function studioDeskRefundInput(id, input) {
  studioDeskSettleEntry(id).refund = String((input && input.value) || '').slice(0, 24);
}

function studioDeskOverrideReasonInput(id, input) {
  studioDeskSettleEntry(id).reason = String((input && input.value) || '').slice(0, STUDIO_DESK_OVERRIDE_REASON[1]);
}

// POST …/stop (closeReason completed) or …/settle-override: one operationId per (action, version).
async function studioDeskSettleOnce(requestId, kind, refundMinor, reason) {
  const request = findVisibleAdsStudioCampaign(requestId);
  if (!request || String(request.status || '') !== 'Approved') {
    return { ok: false, text: adsStudioText('This request changed meanwhile. Check its new state.', 'تغيّر هذا الطلب في الأثناء. راجع حالته الجديدة.') };
  }
  const attempt = adsStudioActionAttempt(kind === 'override' ? 'settle-override' : 'stop', request.id, Number(request._lastModified));
  const identity = getServerSessionIdentity();
  const path = kind === 'override' ? 'settle-override' : 'stop';
  const body = { expectedLastModified: attempt.expectedLastModified, operationId: attempt.operationId, refundMinorUSD: refundMinor, closeReason: 'completed' };
  if (kind === 'override') body.reason = reason; else body.reason = null;
  let entity;
  try {
    entity = await apiJson(`/api/ad-studio/campaigns/${encodeURIComponent(request.id)}/${path}`, { method: 'POST', body }, { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS });
    if (serverSessionIdentityChanged(identity)) throw makeSessionChangedError();
    validateServerEntityResponse('adCampaignRequests', entity, path);
  } catch (error) {
    const fresh = error && error.status === 409 && !(error.payload && error.payload.detail && error.payload.detail.code) ? await adsStudioReloadCampaign(request.id) : null;
    if (!fresh || String((fresh.data && fresh.data.status) || '') !== 'Stopped') throw error;
    entity = fresh;  // the first tap already settled it
  }
  _adsStudioActionAttempts.delete(attempt.key);
  const saved = upsertAdsStudioEntity(entity);
  _studioDesk.settle.delete(request.id);
  if (typeof resetAdsStudioWalletCache === 'function') resetAdsStudioWalletCache();
  studioDeskPulseRefresh();
  const returned = studioDeskMinor(saved && saved.refundMinorUSD);
  studioDeskNotify(true, adsStudioText('Settled', 'تمت التسوية'), returned
    ? adsStudioText(`${studioUsd(returned)} goes back to the customer's available money.`, `يعود ${studioUsd(returned)} إلى رصيد العميل المتاح.`)
    : adsStudioText('The ad is closed; nothing goes back.', 'أُغلق الإعلان؛ لا يعود شيء.'));
  return { ok: true };
}

function studioDeskSettleRun(kind, requestId, refundMinor, reason) {
  const key = `${kind}:${requestId}`;
  if (_studioDesk.runs.has(key)) return _studioDesk.runs.get(key);
  const operation = studioDeskSettleOnce(requestId, kind, refundMinor, reason).catch(error => {
    const info = studioDeskErrorInfo(error);
    if (info.readyAt) studioDeskSettleEntry(requestId).readyAt = info.readyAt;
    return { ok: false, text: info.text };
  });
  _studioDesk.runs.set(key, operation);
  const cleanup = () => {
    if (_studioDesk.runs.get(key) === operation) _studioDesk.runs.delete(key);
    studioV2Rerender();
  };
  operation.then(cleanup, cleanup);
  return operation;
}

// ------------------------------------------------------------------ sheets (approve, settle, override)

function renderStudioDeskSheet(kind, request) {
  const id = studioEsc(request.id);
  const name = `<p class="studio-ads-sheet-name" dir="auto">${studioEsc(studioDeskName(request))}</p>`;
  let title = '';
  let body = '';
  let confirmLabel = '';
  let danger = false;
  if (kind === 'approve') {
    const held = studioDeskPaid(request);
    const days = Number(request.durationDays);
    title = adsStudioText('Approve this request?', 'الموافقة على هذا الطلب؟');
    body = `<p class="studio-ads-sheet-text">${studioEsc(adsStudioText(`This charges the held ${studioUsd(held)} from the customer's wallet${Number.isSafeInteger(days) && days > 0 ? ` and promises ${adsStudioDaysText(days)} from the start` : ''}. Albayan then assigns the studio name (ALB-S-…) for the campaign in Meta; the Meta setup is the next section.`,
      `يخصم هذا ${studioUsd(held)} المحجوزة من محفظة العميل${Number.isSafeInteger(days) && days > 0 ? ` ويَعِد بمدة ${adsStudioDaysText(days)} من البداية` : ''}. ثم يخصص البيان اسم الاستوديو (ALB-S-…) لحملة ميتا؛ تجهيز ميتا في القسم التالي.`))}</p>`;
    confirmLabel = adsStudioText('Confirm approval', 'تأكيد الموافقة');
  } else {
    const numbers = studioDeskSettleNumbers(request);
    const entry = studioDeskSettleEntry(request.id);
    const override = kind === 'override';
    const start = entry.refund !== '' ? entry.refund : (numbers.cap === null ? '' : (numbers.cap / 100).toFixed(2));
    title = override ? adsStudioText('Admin override: settle past the rules', 'تجاوز المدير: تسوية خارج القواعد') : adsStudioText('Finish & settle', 'إنهاء وتسوية');
    const lines = [
      `${adsStudioText('Paid', 'مدفوع')} ${studioUsd(numbers.paid)}`,
      numbers.spend === null ? adsStudioText("Meta's spend is not confirmed yet", 'صرف ميتا غير مؤكد بعد') : `${adsStudioText('Meta used', 'صرف ميتا')} ${studioUsd(numbers.spend)}${numbers.confirmedAt ? ` (${adsStudioText('confirmed', 'أُكّد')} ${studioDeskWhen(numbers.confirmedAt)})` : ''}`,
      numbers.cap === null ? '' : `${adsStudioText('Return up to', 'يعود حتى')} ${studioUsd(numbers.cap)}`
    ].filter(Boolean);
    body = `
        <ul class="studio-desk-sheet-lines" data-testid="studio-desk-sheet-lines">${lines.map(line => `<li>${studioEsc(line)}</li>`).join('')}</ul>
        <label class="studio-desk-label" for="studio-desk-refund">${studioEsc(adsStudioText('Amount to return (USD)', 'المبلغ المعاد (بالدولار)'))}</label>
        <input id="studio-desk-refund" class="studio-desk-input" type="text" inputmode="decimal" autocomplete="off" dir="ltr" maxlength="24" value="${studioEsc(start)}" data-testid="studio-desk-refund" oninput="studioDeskRefundInput('${id}', this)" placeholder="0.00" />
        <p class="studio-ads-sheet-note">${studioEsc(override
          ? adsStudioText('An override lifts every gate and the cap: the return may reach the whole payment, never more. Albayan absorbs what comes back above paid minus Meta spend. It is audited and kept forever.', 'التجاوز يلغي كل الشروط والحد الأقصى: قد يصل المبلغ المعاد إلى كامل المدفوع، لا أكثر. يتحمل البيان ما يُعاد فوق المدفوع ناقص صرف ميتا. يُسجَّل في السجل ويُحفظ للأبد.')
          : adsStudioText('Pre-filled with paid minus Meta spend. It may be lowered, never raised above that cap. An ad Meta never showed returns everything.', 'مُعبّأ مسبقاً بالمدفوع ناقص صرف ميتا. يمكن خفضه، ولا يمكن رفعه فوق هذا الحد. الإعلان الذي لم تعرضه ميتا يعود مبلغه كاملاً.'))}</p>
        ${override ? `
        <label class="studio-desk-label" for="studio-desk-override-reason">${studioEsc(adsStudioText('Why the rules are lifted (10–300 characters)', 'سبب تجاوز القواعد (من 10 إلى 300 حرف)'))}</label>
        <textarea id="studio-desk-override-reason" class="studio-desk-input" rows="3" maxlength="${STUDIO_DESK_OVERRIDE_REASON[1]}" data-testid="studio-desk-override-reason" oninput="studioDeskOverrideReasonInput('${id}', this)">${studioEsc(entry.reason)}</textarea>` : ''}`;
    confirmLabel = override ? adsStudioText('Settle with the override', 'سوِّ بالتجاوز') : adsStudioText('Settle and return the amount', 'سوِّ وأعد المبلغ');
    danger = override;
  }
  return `
    <div class="mobile-dialog-overlay studio-ads-sheet studio-desk-sheet" data-testid="studio-desk-sheet-${kind}" onclick="if (event.target === this) studioDeskSheetClose()">
      <div class="studio-ads-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="studio-desk-sheet-title" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}">
        <h2 id="studio-desk-sheet-title" class="studio-ads-sheet-title">${studioEsc(title)}</h2>
        ${name}
        ${body}
        <p class="studio-ads-sheet-error" role="alert" data-testid="studio-desk-sheet-error" hidden></p>
        <div class="studio-ads-sheet-actions">
          <button type="button" class="studio-v2-action" data-testid="studio-desk-sheet-cancel" data-sheet-focus="1" onclick="studioDeskSheetClose()">${studioEsc(adsStudioText('Cancel', 'إلغاء'))}</button>
          <button type="button" class="studio-v2-action is-primary${danger ? ' studio-ads-danger' : ''}" data-testid="studio-desk-sheet-confirm" onclick="studioDeskSheetConfirm()">${studioEsc(confirmLabel)}</button>
        </div>
      </div>
    </div>`;
}

function studioDeskSheetOpen(kind, id, opener = null) {
  if (typeof document === 'undefined' || !document.body || !['approve', 'settle', 'override'].includes(kind)) return false;
  const request = findVisibleAdsStudioCampaign(id);
  if (!request) return false;
  if (kind === 'override' && !studioDeskIsAdmin()) return false;
  const holder = document.createElement('div');
  holder.innerHTML = renderStudioDeskSheet(kind, request).trim();
  const el = holder.firstElementChild;
  if (!el) return false;
  const previous = _studioDesk.sheet.el;
  Object.assign(_studioDesk.sheet, { kind, id: String(request.id), el, opener: opener || _studioDesk.sheet.opener });
  el.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (_studioDesk.sheet.el === el) studioDeskSheetClose();
    }
  });
  if (previous && previous.isConnected) previous.replaceWith(el);
  else document.body.appendChild(el);
  if (typeof IconQueue !== 'undefined' && IconQueue && typeof IconQueue.schedule === 'function') IconQueue.schedule(el);
  const focus = el.querySelector(kind === 'approve' ? '[data-sheet-focus]' : '#studio-desk-refund');
  try { if (focus) focus.focus(); } catch (_) {}
  return true;
}

function studioDeskSheetClose() {
  const { el, opener } = _studioDesk.sheet;
  Object.assign(_studioDesk.sheet, { kind: '', id: '', el: null, opener: null });
  if (el && el.isConnected) el.remove();
  try { if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus(); } catch (_) {}
}

function studioDeskSheetBusy(el, busy, errorText = '') {
  if (!el) return;
  const confirm = el.querySelector('[data-testid="studio-desk-sheet-confirm"]');
  if (confirm) {
    confirm.disabled = !!busy;
    if (busy) confirm.setAttribute('aria-busy', 'true'); else confirm.removeAttribute('aria-busy');
  }
  const error = el.querySelector('.studio-ads-sheet-error');
  if (error) {
    error.textContent = errorText;
    error.hidden = !errorText;
  }
}

function studioDeskSheetConfirm() {
  const { el, kind, id } = _studioDesk.sheet;
  if (!el || !el.isConnected || !id) return null;
  let operation;
  if (kind === 'approve') {
    operation = studioDeskDecide(id, 'Approved', null, true);
  } else {
    const refundBox = el.querySelector('#studio-desk-refund');
    const raw = refundBox ? refundBox.value : studioDeskSettleEntry(id).refund;
    const refund = studioParseAmount(raw);
    const reasonBox = el.querySelector('#studio-desk-override-reason');
    const reason = String(reasonBox ? reasonBox.value : studioDeskSettleEntry(id).reason).trim();
    let problem = '';
    const request = findVisibleAdsStudioCampaign(id);
    const numbers = request ? studioDeskSettleNumbers(request) : { paid: 0, cap: null };
    if (!Number.isSafeInteger(refund)) problem = adsStudioText('Enter the amount to return as a number (0 closes the ad without a return).', 'أدخل المبلغ المعاد رقماً (0 يغلق الإعلان دون إعادة).');
    else if (refund > numbers.paid) problem = adsStudioText(`The return cannot be above what was paid (${studioUsd(numbers.paid)}).`, `لا يمكن أن يزيد المبلغ المعاد عن المدفوع (${studioUsd(numbers.paid)}).`);
    else if (kind === 'settle' && numbers.cap !== null && refund > numbers.cap) problem = adsStudioText(`The return cannot be above ${studioUsd(numbers.cap)} (paid minus Meta spend). An admin may override with a reason.`, `لا يمكن أن يزيد المبلغ المعاد عن ${studioUsd(numbers.cap)} (المدفوع ناقص صرف ميتا). يمكن للمدير التجاوز مع كتابة السبب.`);
    else if (kind === 'override' && (reason.length < STUDIO_DESK_OVERRIDE_REASON[0] || reason.length > STUDIO_DESK_OVERRIDE_REASON[1])) problem = adsStudioText('Write why the rules are lifted (10 to 300 characters).', 'اكتب سبب تجاوز القواعد (من 10 إلى 300 حرف).');
    else if (!studioDeskServer()) problem = adsStudioText('This moves wallet money, which needs the connection to Albayan.', 'هذا الإجراء يحرّك أموال المحفظة، ويحتاج الاتصال بالبيان.');
    if (problem) { studioDeskSheetBusy(el, false, problem); return null; }
    operation = studioDeskSettleRun(kind, id, refund, reason);
  }
  studioDeskSheetBusy(el, true);
  operation.then(outcome => {
    const open = _studioDesk.sheet.el === el && el.isConnected;
    if (!outcome || !outcome.ok) {
      const text = (outcome && outcome.text) || adsStudioText('The action could not be completed. Nothing changed in the balance.', 'تعذّر إتمام العملية. لم يتغير شيء في الرصيد.');
      if (open) studioDeskSheetBusy(el, false, text);
      else studioDeskNotify(false, adsStudioText('Not done', 'لم يتم'), text);
      return;
    }
    if (outcome.pending) { studioDeskSheetBusy(el, false); return; }
    if (_studioDesk.sheet.el === el) studioDeskSheetClose();
  });
  return operation;
}

// ------------------------------------------------------------------ tickets, health, more

function renderStudioDeskTickets() {
  if (typeof renderStudioStaffTicketsClassic !== 'function') {
    return renderStudioDeskEmpty('ticket', adsStudioText('Tickets are not available in this build.', 'التذاكر غير متاحة في هذه النسخة.'), '', 'studio-desk-tickets-missing');
  }
  const html = renderStudioStaffTicketsClassic();
  return html || renderStudioDeskEmpty('ticket', adsStudioText('Tickets need the connection to Albayan.', 'التذاكر تحتاج الاتصال بالبيان.'), '', 'studio-desk-tickets-offline');
}

function renderStudioDeskPulseCard() {
  const pulse = _studioDesk.pulse.value;
  const cell = (key, label, value, testId) => `<div class="studio-desk-pulse-cell" data-testid="${testId}" data-count="${Number(value) || 0}"><span class="studio-desk-pulse-value">${studioEsc(String(Number(value) || 0))}</span><span class="studio-desk-pulse-label">${studioEsc(label)}</span></div>`;
  const cells = pulse ? [
    cell('waitingReview', adsStudioText('Waiting for review', 'بانتظار المراجعة'), pulse.waitingReview, 'studio-desk-pulse-review'),
    cell('stopRequests', adsStudioText('Stop requests', 'طلبات الإيقاف'), pulse.stopRequests, 'studio-desk-pulse-stops'),
    cell('openTickets', adsStudioText('Tickets for the team', 'تذاكر للفريق'), pulse.openTickets, 'studio-desk-pulse-tickets'),
    cell('alerts', adsStudioText('Open alerts', 'تنبيهات مفتوحة'), pulse.alerts, 'studio-desk-pulse-alerts'),
    pulse.paymentsWaiting === null ? '' : cell('paymentsWaiting', adsStudioText('Payments waiting', 'مدفوعات بانتظار التأكيد'), pulse.paymentsWaiting, 'studio-desk-pulse-payments')
  ].join('') : `<p class="studio-desk-note">${studioEsc(adsStudioText('Reading the desk counters…', 'نقرأ عدّادات المكتب…'))}</p>`;
  return `
          <section class="studio-desk-box studio-desk-pulse" data-testid="studio-desk-pulse" aria-labelledby="studio-desk-pulse-title">
            <h3 id="studio-desk-pulse-title" class="studio-desk-h3">${studioEsc(adsStudioText('Desk pulse', 'نبض المكتب'))}</h3>
            <div class="studio-desk-pulse-grid">${cells}</div>
            <p class="studio-desk-note">${studioEsc(adsStudioText('Refreshed every 20 seconds while this page is open.', 'يتحدث كل 20 ثانية ما دامت هذه الصفحة مفتوحة.'))}</p>
          </section>`;
}

function renderStudioDeskHealth() {
  const pulse = renderStudioDeskPulseCard();
  if (!studioDeskIsAdmin()) {
    return pulse + `<p class="studio-desk-note" data-testid="studio-desk-health-reviewer">${studioEsc(adsStudioText('The Meta checks, alerts and diagnostics are admin tools.', 'فحوص ميتا والتنبيهات والتشخيص أدوات للمدير.'))}</p>`;
  }
  const alerts = `<div class="studio-desk-actions"><button type="button" class="studio-v2-action" data-testid="studio-desk-to-alerts" onclick="studioDeskGo('more', 'alerts')">${studioDeskIcon('bell-ring')}<span>${studioEsc(adsStudioText('Alerts list', 'قائمة التنبيهات'))}</span></button><button type="button" class="studio-v2-action" data-testid="studio-desk-to-diagnostics" onclick="studioDeskGo('more', 'diagnostics')">${studioDeskIcon('activity')}<span>${studioEsc(adsStudioText('Diagnostics', 'التشخيص'))}</span></button></div>`;
  return pulse + alerts + `<div class="studio-desk-classic">${typeof renderStudioHealthSection === 'function' ? renderStudioHealthSection() : ''}</div>`;
}

function studioDeskSoundOn() {
  try { return window.localStorage.getItem(STUDIO_DESK_SOUND_KEY + studioDeskUserId()) === 'on'; } catch (_) { return false; }
}

function studioDeskToggleSound() {
  const next = !studioDeskSoundOn();
  try {
    if (next) window.localStorage.setItem(STUDIO_DESK_SOUND_KEY + studioDeskUserId(), 'on');
    else window.localStorage.removeItem(STUDIO_DESK_SOUND_KEY + studioDeskUserId());
  } catch (_) { /* a private window: the switch does not stick */ }
  if (next) studioDeskPlaySound();  // a user gesture: the browser allows the sound now
  studioV2Rerender();
}

function renderStudioDeskSoundRow() {
  const on = studioDeskSoundOn();
  return `
          <div class="studio-v2-list studio-desk-sound" data-testid="studio-desk-sound">
            <button type="button" class="studio-v2-row" data-testid="studio-desk-sound-toggle" aria-pressed="${on ? 'true' : 'false'}" onclick="studioDeskToggleSound()">
              ${studioDeskIcon(on ? 'volume-2' : 'volume-x')}
              <span class="studio-v2-row-label">${studioEsc(adsStudioText('Sound for a new stop request', 'صوت عند طلب إيقاف جديد'))}</span>
              <span class="studio-v2-row-value">${studioEsc(on ? adsStudioText('On', 'مفعّل') : adsStudioText('Off', 'متوقف'))}</span>
            </button>
          </div>`;
}

function renderStudioDeskMore(route) {
  const admin = typeof renderStudioAdminMore === 'function' ? renderStudioAdminMore(route) : '';
  const sub = !!(route && route.id) && studioDeskIsAdmin();  // an admin sub-page (payments, alerts, a setting) stands alone
  return admin + (sub ? '' : renderStudioDeskSoundRow() + renderStudioV2Basics());
}

// ------------------------------------------------------------------ the staff pulse (P3-17)

// The pulse's numbers. openTickets includes the urgent ticket every open stop request opens
// (studio_stop.create_stop_ticket); stopTicketsOpen is that overlap (stop tickets still open), so
// the badge and the title count one stop request once: openTickets + the stop requests whose ticket
// was answered but whose ad is not stopped yet (studioDeskStopsNotTicketed).
function studioDeskCleanPulse(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const whole = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    waitingReview: whole(raw.waitingReview),
    stopRequests: whole(raw.stopRequests),
    openTickets: whole(raw.openTickets),
    stopTicketsOpen: whole(raw.stopTicketsOpen),
    alerts: whole(raw.alerts),
    paymentsWaiting: Number.isSafeInteger(raw.paymentsWaiting) ? whole(raw.paymentsWaiting) : null
  };
}

function studioDeskStopsNotTicketed(pulse) {
  return pulse ? Math.max(0, pulse.stopRequests - (pulse.stopTicketsOpen || 0)) : 0;
}

function studioDeskPulseStart() {
  if (_studioDesk.pulse.watching || !studioDeskServer()) return;
  _studioDesk.pulse.watching = true;
  studioPulseWatch('desk', { path: '/api/studio/staff/pulse', field: 'updatedAt', intervalMs: STUDIO_DESK_PULSE_MS, onChange: (_value, reply) => studioDeskOnPulse(reply) });
  studioDeskPulseRefresh();  // the watch reports changes only: the first numbers come from this read
}

function studioDeskPulseStop() {
  if (!_studioDesk.pulse.watching) return;
  _studioDesk.pulse.watching = false;
  studioPulseStop('desk');
  studioDeskTitle(0);
}

function studioDeskPulseRefresh() {
  if (!studioDeskServer()) return null;
  const uid = studioDeskUserId();
  return studioApi('/api/studio/staff/pulse', { method: 'GET' }).then(reply => { if (uid === studioDeskUserId()) studioDeskOnPulse(reply); }).catch(() => {});
}

function studioDeskOnPulse(reply) {
  if (!studioDeskOnScreen()) { studioDeskPulseStop(); return; }
  const clean = studioDeskCleanPulse(reply);
  if (!clean) return;
  const previous = _studioDesk.pulse.value;
  _studioDesk.pulse.value = clean;
  _studioDesk.pulse.at = Date.now();
  if (previous && clean.stopRequests > previous.stopRequests) studioDeskPlaySound();
  studioDeskPaintBadges();
  studioDeskTitle(studioDeskTitleCount(clean));
  // A section that draws the counters (health) or the queues follows the new numbers.
  if (!previous || JSON.stringify(previous) !== JSON.stringify(clean)) studioDeskRedraw();
}

function studioDeskTitleCount(pulse) {
  return pulse ? pulse.waitingReview + pulse.openTickets + studioDeskStopsNotTicketed(pulse) + (pulse.paymentsWaiting || 0) : 0;
}

// The document title carries the count of items waiting for the team while the desk is open.
function studioDeskTitle(count) {
  if (typeof document === 'undefined') return;
  try {
    const current = String(document.title || '');
    const base = current.replace(/^\(\d+\+?\)\s/, '');
    if (_studioDesk.pulse.baseTitle !== base) _studioDesk.pulse.baseTitle = base;
    const next = count > 0 ? `(${count > 99 ? '99+' : count}) ${base}` : base;
    if (next !== current) document.title = next;
    _studioDesk.pulse.shownCount = count;
  } catch (_) {}
}

function studioDeskBadgeCounts() {
  const pulse = _studioDesk.pulse.value;
  return {
    requests: pulse ? pulse.waitingReview : 0,
    launch: studioDeskLaunchQueue().length,
    settle: studioDeskEndedList().length,
    tickets: pulse ? pulse.openTickets + studioDeskStopsNotTicketed(pulse) : 0,
    health: pulse ? pulse.alerts : 0,
    more: pulse && pulse.paymentsWaiting ? pulse.paymentsWaiting : 0
  };
}

function studioDeskPaintBadges() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const counts = studioDeskBadgeCounts();
  const urgent = _studioDesk.pulse.value ? _studioDesk.pulse.value.stopRequests : 0;
  for (const section of STUDIO_DESK_SECTIONS) {
    const button = document.querySelector(`[data-testid="studio-staffnav-${section}"]`);
    if (!button) continue;
    let badge = button.querySelector('.studio-desk-badge');
    const count = counts[section] || 0;
    if (!count) { if (badge) badge.remove(); continue; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'studio-desk-badge';
      badge.setAttribute('data-testid', `studio-desk-badge-${section}`);
      badge.setAttribute('aria-hidden', 'true');
      button.appendChild(badge);
    }
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.setAttribute('data-count', String(count));
    badge.classList.toggle('is-urgent', section === 'tickets' && urgent > 0);
  }
}

// After every draw of the desk: the badges (the nav is redrawn with the screen) and the settle countdowns.
function studioDeskAfterDraw(section) {
  if (typeof setTimeout !== 'function') return;
  if (!_studioDesk.paintTimer) {
    _studioDesk.paintTimer = setTimeout(() => {
      _studioDesk.paintTimer = null;
      if (studioDeskOnScreen()) { studioDeskPaintBadges(); studioDeskTitle(studioDeskTitleCount(_studioDesk.pulse.value)); }
    }, 0);
  }
  if (_studioDesk.countdownTimer) { clearTimeout(_studioDesk.countdownTimer); _studioDesk.countdownTimer = null; }
  if (section === 'settle') {
    _studioDesk.countdownTimer = setTimeout(() => {
      _studioDesk.countdownTimer = null;
      if (studioDeskOnScreen()) studioV2Rerender();
    }, STUDIO_DESK_COUNTDOWN_MS);
  }
}

// A short generated sound (no file) and a vibration where supported: a new stop request arrived.
function studioDeskPlaySound() {
  if (!studioDeskSoundOn()) return;
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (Context) {
      const context = _studioDesk.audio || (_studioDesk.audio = new Context());
      if (context.state === 'suspended' && typeof context.resume === 'function') context.resume().catch(() => {});
      const at = context.currentTime;
      [[880, 0], [1175, 0.18]].forEach(([frequency, offset]) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, at + offset);
        gain.gain.exponentialRampToValueAtTime(0.2, at + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + offset + 0.16);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(at + offset);
        oscillator.stop(at + offset + 0.18);
      });
    }
  } catch (_) { /* no audio here */ }
  try { if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate([120, 80, 120]); } catch (_) {}
}

// ------------------------------------------------------------------ the section (called by the loader)

function renderStudioDeskDenied() {
  return renderStudioDeskEmpty('lock', adsStudioText('The Team desk is for the Albayan team.', 'مكتب الفريق لفريق البيان.'), '', 'studio-desk-denied');
}

function renderStudioDeskSection(section, route) {
  if (!studioDeskCan()) return renderStudioDeskDenied();
  studioDeskScope();
  const key = STUDIO_DESK_SECTIONS.includes(String(section || '')) ? String(section) : 'requests';
  studioDeskPulseStart();
  studioDeskAfterDraw(key);
  let body = '';
  try {
    if (key === 'launch') body = renderStudioDeskLaunch(route);
    else if (key === 'settle') body = renderStudioDeskSettle(route);
    else if (key === 'tickets') body = renderStudioDeskTickets(route);
    else if (key === 'health') body = renderStudioDeskHealth(route);
    else if (key === 'more') body = renderStudioDeskMore(route);
    else body = renderStudioDeskRequests(route);
  } catch (error) {
    try { console.warn('[studio desk] the section could not be drawn:', error); } catch (_) {}
    body = renderStudioDeskEmpty('triangle-alert', adsStudioText('This section could not be drawn. Refresh the page.', 'تعذّر رسم هذا القسم. حدّث الصفحة.'), '', 'studio-desk-broken');
  }
  // The classic link and unlink sheets (15c) draw nothing unless one is open.
  const sheets = (typeof renderAdsStudioLinkSheet === 'function' ? renderAdsStudioLinkSheet() : '') + (typeof renderAdsStudioUnlinkSheet === 'function' ? renderAdsStudioUnlinkSheet() : '');
  return `
        <div class="studio-desk" data-testid="studio-desk" data-section="${studioEsc(key)}">${body}
        </div>${sheets}`;
}
// ==========================================
// ALBAYAN STUDIO v2 — ADMIN TOOLS (plan tasks P3-16, P3-19, P3-21, P0-10 report, M12 "More"; studio-staff.js lazy bundle)
// ==========================================
// The More section of the Team desk (15p renderStudioDeskMore -> renderStudioAdminMore), admin only:
// - payments waiting for confirmation (the classic rows and decisions of 15c, with the waiting time
//   against the payment target);
// - the alerts list (GET /api/studio/admin/alerts, the server's bilingual labels, paged) with the
//   jobs heartbeat;
// - the diagnostics summary (GET /api/studio/admin/diagnostics): queues met %, capacity, USD owed to
//   customers against the studio funds, the go/no-go rows, the heartbeat, the token and storage;
// - the collision report (GET /api/meta-ads/collisions): counts and rows with why each row is kept
//   or removable. No apply button: the owner runs scripts/studio_collision_repair.py;
// - one form per admin setting (GET/PUT /api/studio/admin/settings/{key}) with expectedVersion, an
//   explanation line per setting and field, the server's validation message when it refuses a
//   value, and a reload flow on 409 (someone saved first, or the desk cannot go off while in use).
// Sub-pages live on &id= (payments, alerts, diagnostics, collisions, settings-<key>), so Back
// returns to the More menu. Every server string is escaped; every input keeps a stable id.

const STUDIO_ADMIN_TTL_MS = 60 * 1000;
const STUDIO_ADMIN_RETRY_MS = 30 * 1000;
const STUDIO_ADMIN_MODES = Object.freeze(['off', 'pilot', 'on']);
const STUDIO_ADMIN_CAPABILITY_STATES = Object.freeze(['on', 'gated', 'off', 'unavailable']);
const STUDIO_ADMIN_WEEK = Object.freeze([['sun', 'Sunday', 'الأحد'], ['mon', 'Monday', 'الاثنين'], ['tue', 'Tuesday', 'الثلاثاء'], ['wed', 'Wednesday', 'الأربعاء'], ['thu', 'Thursday', 'الخميس'], ['fri', 'Friday', 'الجمعة'], ['sat', 'Saturday', 'السبت']]);
const STUDIO_ADMIN_SETTING_KEYS = Object.freeze(['rollout', 'intake', 'capabilities', 'limits', 'settlement', 'hours', 'contact', 'targets', 'thresholds']);
// [id, icon, English, Arabic, what it is for (EN), (AR)]
const STUDIO_ADMIN_PAGES = Object.freeze([
  ['payments', 'landmark', 'Payments waiting', 'مدفوعات بانتظار التأكيد', "Confirm or cancel the customers' top-up requests.", 'أكّد طلبات شحن العملاء أو ألغِها.'],
  ['alerts', 'bell-ring', 'Alerts', 'التنبيهات', 'What the studio jobs and the Meta checks raised.', 'ما أثارته مهام الاستوديو وفحوص ميتا.'],
  ['diagnostics', 'activity', 'Diagnostics', 'التشخيص', 'Queues, capacity, money and the go/no-go rows.', 'الطوابير والسعة والأموال وصفوف القرار.'],
  ['collisions', 'git-merge', 'Collision report', 'تقرير التعارض', "Studio campaigns that appear in Albayan Manager's books.", 'حملات الاستوديو التي تظهر في دفاتر مدير البيان.'],
  ['settings-rollout', 'toggle-right', 'Rollout', 'الإطلاق التدريجي', 'The new layout, the services and this desk.', 'الواجهة الجديدة والخدمات وهذا المكتب.'],
  ['settings-intake', 'inbox', 'Intake', 'استقبال الطلبات', 'Pause new requests; the daily cap.', 'إيقاف الطلبات الجديدة مؤقتاً؛ الحد اليومي.'],
  ['settings-capabilities', 'message-circle-reply', 'Reply channels', 'قنوات الردود', 'The honest label of every reply channel.', 'التسمية الصادقة لكل قناة ردود.'],
  ['settings-limits', 'wallet-cards', 'Budget limits', 'حدود الميزانية', 'Smallest and largest request, per-day floor, most days.', 'أصغر طلب وأكبره، وحد اليوم الأدنى، وأقصى مدة.'],
  ['settings-settlement', 'scale', 'Settlement', 'التسوية', 'The wait after delivery ends and the drift watch.', 'مدة الانتظار بعد انتهاء العرض ومراقبة تغيّر الصرف.'],
  ['settings-hours', 'clock', 'Service hours', 'ساعات العمل', 'The week, holidays, Ramadan and the on-duty hour.', 'أيام الأسبوع والعطل ورمضان وساعة المناوبة.'],
  ['settings-contact', 'phone', 'Contact numbers', 'أرقام التواصل', 'What customers see on the login page and in Help.', 'ما يراه العملاء في صفحة الدخول وفي المساعدة.'],
  ['settings-targets', 'target', 'Service targets', 'أهداف الخدمة', 'How fast the team promises to act.', 'السرعة التي يَعِد بها الفريق.'],
  ['settings-thresholds', 'sliders-horizontal', 'Thresholds', 'العتبات', 'The go/no-go and stop-rule numbers.', 'أرقام قرار المتابعة وقواعد الإيقاف.']
]);
// The forms: field = [path, kind, [label EN, AR], [hint EN, AR], options or [min, max]].
const STUDIO_ADMIN_MODE_HINT = ['off = nobody; pilot = only the allowlist; on = everyone.', 'off = لا أحد؛ pilot = القائمة المسموحة فقط؛ on = الجميع.'];
const STUDIO_ADMIN_SETTINGS = Object.freeze({
  rollout: {
    about: ['Which customers see the new layout, which services are open and who uses this desk. A change applies at the next page load; services and the desk are independent of the layout.', 'من يرى واجهة العملاء الجديدة، وأي الخدمات مفتوحة، ومن يستخدم هذا المكتب. يسري التغيير عند تحميل الصفحة التالي؛ الخدمات والمكتب مستقلان عن الواجهة.'],
    fields: [
      ['ui', 'mode', ['Customer layout', 'واجهة العملاء'], STUDIO_ADMIN_MODE_HINT, STUDIO_ADMIN_MODES],
      ['uiAllowlist', 'ids', ['Customer allowlist (user ids, one per line)', 'القائمة المسموحة للعملاء (معرّفات المستخدمين، واحد في كل سطر)'], ['Read only while the layout is "pilot". At most 200 ids.', 'تُقرأ فقط عندما تكون الواجهة "pilot". 200 معرّف كحد أقصى.']],
      ['services.help', 'mode', ['Help tickets', 'تذاكر المساعدة'], ['Opens tickets in both layouts.', 'يفتح التذاكر في الواجهتين.'], STUDIO_ADMIN_MODES],
      ['services.stopRequest', 'mode', ['Ask to stop', 'طلب الإيقاف'], ['The urgent stop request on a running ad, in both layouts.', 'طلب الإيقاف العاجل لإعلان يعمل، في الواجهتين.'], STUDIO_ADMIN_MODES],
      ['services.tiktok', 'mode', ['TikTok service', 'خدمة تيك توك'], ['The managed TikTok help request.', 'طلب مساعدة تيك توك اليدوي.'], STUDIO_ADMIN_MODES],
      ['staffDesk', 'mode', ['Team desk', 'مكتب الفريق'], ['This desk for the team. It cannot go off while open tickets or stop requests exist.', 'هذا المكتب للفريق. لا يمكن إيقافه ما دامت هناك تذاكر أو طلبات إيقاف مفتوحة.'], STUDIO_ADMIN_MODES],
      ['staffAllowlist', 'ids', ['Staff allowlist (user ids, one per line)', 'القائمة المسموحة للفريق (معرّفات المستخدمين، واحد في كل سطر)'], ['Read only while the desk is "pilot".', 'تُقرأ فقط عندما يكون المكتب "pilot".']]
    ]
  },
  intake: {
    about: ['Whether customers may send new requests, and how many a day. Drafts always save; a paused intake refuses only the send.', 'هل يستطيع العملاء إرسال طلبات جديدة، وكم طلباً في اليوم. المسودات تُحفظ دائماً؛ الإيقاف يرفض الإرسال فقط.'],
    fields: [
      ['open', 'flag', ['New requests are accepted', 'الطلبات الجديدة مقبولة'], ['Off = "New ad requests are paused" at the send button.', 'متوقف = «استقبال طلبات الإعلانات الجديدة متوقف مؤقتاً» عند زر الإرسال.']],
      ['maxSubmissionsPerDay', 'whole', ['Most sends per day (Tripoli day)', 'أقصى عدد إرسالات في اليوم (بتوقيت طرابلس)'], ['The capacity cap of D29: from 1 to 500 (500 = no cap in practice).', 'حد السعة (D29): من 1 إلى 500 (500 = لا حد عملياً).'], [1, 500]]
    ]
  },
  capabilities: {
    about: ['The label each reply channel shows customers: on = working; poll = Instagram comments checked every 5 minutes; gated = waiting for Meta approval; off = hidden; unavailable = "not available now".', 'التسمية التي تعرضها كل قناة ردود للعملاء: on = تعمل؛ poll = تُفحص تعليقات إنستغرام كل 5 دقائق؛ gated = بانتظار موافقة ميتا؛ off = مخفية؛ unavailable = «غير متاح حالياً».'],
    fields: [
      ['fbPublicReply', 'select', ['Facebook public replies', 'ردود فيسبوك العامة'], ['On only after the delivery check passed and the page is subscribed.', 'تعمل فقط بعد نجاح فحص التسليم واشتراك الصفحة.'], STUDIO_ADMIN_CAPABILITY_STATES],
      ['fbPrivateReply', 'select', ['Facebook private messages', 'رسائل فيسبوك الخاصة'], ['Needs Meta approval first.', 'تحتاج موافقة ميتا أولاً.'], STUDIO_ADMIN_CAPABILITY_STATES],
      ['igPublicReply', 'select', ['Instagram public replies', 'ردود إنستغرام العامة'], ['poll after the read test passed; on after Meta approval.', 'poll بعد نجاح اختبار القراءة؛ on بعد موافقة ميتا.'], ['on', 'poll', 'gated', 'off', 'unavailable']],
      ['igPrivateReply', 'select', ['Instagram private messages', 'رسائل إنستغرام الخاصة'], ['Needs Meta approval first.', 'تحتاج موافقة ميتا أولاً.'], STUDIO_ADMIN_CAPABILITY_STATES],
      ['tiktokService', 'select', ['TikTok service label', 'تسمية خدمة تيك توك'], ['A manual service: on when the team offers it.', 'خدمة يدوية: on عندما يقدمها الفريق.'], STUDIO_ADMIN_CAPABILITY_STATES]
    ]
  },
  limits: {
    about: ['The budget rules for NEW requests (older rows keep theirs): the total a customer pays per request, the per-day floor and the most days an ad may run.', 'قواعد الميزانية للطلبات الجديدة (الطلبات الأقدم تبقى على قواعدها): إجمالي ما يدفعه العميل للطلب، وحد اليوم الأدنى، وأقصى عدد أيام.'],
    fields: [
      ['minTotalMinorUSD', 'money', ['Smallest total per request (USD)', 'أصغر إجمالي للطلب (بالدولار)'], ['At least $1.', '1 دولار على الأقل.']],
      ['maxTotalMinorUSD', 'money', ['Largest total per request (USD)', 'أكبر إجمالي للطلب (بالدولار)'], ['Not below the smallest total.', 'لا يقل عن أصغر إجمالي.']],
      ['minPerDayMinorUSD', 'money', ['Per-day floor (USD)', 'حد اليوم الأدنى (بالدولار)'], ["Meta's own minimum daily budget: read it in Health.", 'الحد الأدنى اليومي لدى ميتا: اقرأه في التنبيهات.']],
      ['maxDays', 'whole', ['Most days an ad may run', 'أقصى عدد أيام يعمل فيها الإعلان'], ['1 to 90.', 'من 1 إلى 90.'], [1, 90]],
      ['p1CutoverAt', 'readonly', ['Release stamp of the P1 budget rules', 'ختم إصدار قواعد الميزانية P1'], ['Set at deploy; rows sent before it keep the old rules.', 'يُضبط عند النشر؛ الطلبات المرسلة قبله تبقى على القواعد القديمة.']]
    ]
  },
  settlement: {
    about: ["When an ended ad may be settled: the final Meta read comes this many hours after delivery ended, an ad Meta never showed may settle at once, and Meta's spend is watched for changes this many days.", 'متى يمكن تسوية إعلان منتهٍ: تُقرأ أرقام ميتا النهائية بعد هذا العدد من الساعات من انتهاء العرض، والإعلان الذي لم تعرضه ميتا يُسوّى فوراً، ويُراقب صرف ميتا لهذا العدد من الأيام.'],
    fields: [
      ['spendDelayHours', 'whole', ['Hours to wait after delivery ends', 'ساعات الانتظار بعد انتهاء العرض'], ['0 to 168 (D28 recommends 48).', 'من 0 إلى 168 (توصية D28: 48).'], [0, 168]],
      ['neverDeliveredImmediate', 'flag', ['Never-delivered ads settle at once', 'الإعلانات التي لم تُعرض تُسوّى فوراً'], ['A full return without the wait.', 'إعادة كاملة دون انتظار.']],
      ['driftWatchDays', 'whole', ['Days to watch for spend changes', 'أيام مراقبة تغيّر الصرف'], ['1 to 90; must outlive the wait (Meta is final after 28 days).', 'من 1 إلى 90؛ يجب أن تتجاوز مدة الانتظار (أرقام ميتا نهائية بعد 28 يوماً).'], [1, 90]]
    ]
  },
  hours: {
    about: ['The team\'s working hours in Tripoli time: due times of reviews, tickets, stop requests and payments count only inside them. Holidays and the Ramadan hours override the week; the on-duty hour is when the urgent WhatsApp line closes.', 'ساعات عمل الفريق بتوقيت طرابلس: مواعيد المراجعة والتذاكر وطلبات الإيقاف والمدفوعات تُحسب داخلها فقط. العطل وساعات رمضان تتقدم على الأسبوع؛ وساعة المناوبة هي موعد إغلاق خط واتساب العاجل.'],
    fields: []
  },
  contact: {
    about: ['The numbers customers see on the studio login page and in Help (D16, D23), and the on-duty WhatsApp for urgent stop requests outside working hours. International form, for example +218912345678.', 'الأرقام التي يراها العملاء في صفحة دخول الاستوديو وفي المساعدة (D16، D23)، وواتساب المناوبة لطلبات الإيقاف العاجلة خارج ساعات العمل. بالصيغة الدولية، مثل +218912345678.'],
    fields: [
      ['whatsapp', 'phone', ['WhatsApp', 'واتساب'], ['Shown to customers.', 'يظهر للعملاء.']],
      ['phone', 'phone', ['Phone', 'الهاتف'], ['Shown to customers.', 'يظهر للعملاء.']],
      ['email', 'email', ['Email', 'البريد'], ['Shown to customers.', 'يظهر للعملاء.']],
      ['urgentWhatsapp', 'phone', ['On-duty WhatsApp (urgent stops)', 'واتساب المناوبة (إيقاف عاجل)'], ['Shown only in the stop-request sheet outside working hours.', 'يظهر فقط في ورقة طلب الإيقاف خارج ساعات العمل.']]
    ]
  },
  targets: {
    about: ['How fast the team promises to act (D11). Minutes count only inside the service hours; business days skip holidays.', 'السرعة التي يَعِد بها الفريق (D11). الدقائق تُحسب داخل ساعات العمل فقط؛ وأيام العمل تتخطى العطل.'],
    fields: [
      ['reviewBusinessDays', 'whole', ['Review a request (business days)', 'مراجعة الطلب (أيام عمل)'], ['1 to 10.', 'من 1 إلى 10.'], [1, 10]],
      ['ticketFirstResponseMinutes', 'whole', ['First ticket answer (working minutes)', 'أول رد على التذكرة (دقائق عمل)'], ['15 to 2400.', 'من 15 إلى 2400.'], [15, 2400]],
      ['stopRequestMinutes', 'whole', ['Stop request (working minutes)', 'طلب الإيقاف (دقائق عمل)'], ['15 to 480; never above the ticket answer.', 'من 15 إلى 480؛ لا يزيد عن الرد على التذكرة.'], [15, 480]],
      ['paymentConfirmMinutes', 'whole', ['Payment confirmation (working minutes)', 'تأكيد الدفع (دقائق عمل)'], ['15 to 2400 (admins confirm).', 'من 15 إلى 2400 (المديرون يؤكدون).'], [15, 2400]],
      ['settlementBusinessDays', 'whole', ['Settlement after the final read (business days)', 'التسوية بعد القراءة النهائية (أيام عمل)'], ['1 to 10.', 'من 1 إلى 10.'], [1, 10]],
      ['tiktokBusinessDays', 'whole', ['TikTok request (business days)', 'طلب تيك توك (أيام عمل)'], ['1 to 10.', 'من 1 إلى 10.'], [1, 10]]
    ]
  },
  thresholds: {
    about: ['The numbers behind the go/no-go rows and the stop rules (D32). The zero-tolerance rules (money identity, duplicate charges, studio ads in the core books) are fixed and not here.', 'الأرقام خلف صفوف قرار المتابعة وقواعد الإيقاف (D32). قواعد الصفر (هوية الأموال، الخصم المكرر، إعلانات الاستوديو في دفاتر المدير) ثابتة وليست هنا.'],
    fields: [
      ['goConsecutiveWeeks', 'whole', ['Green weeks in a row needed', 'الأسابيع الخضراء المتتالية المطلوبة'], ['1 to 8.', 'من 1 إلى 8.'], [1, 8]],
      ['reconcileToleranceMinorUSD', 'money', ['Reconciliation tolerance (USD)', 'سماحية المطابقة (بالدولار)'], ['The difference allowed each month, at least this.', 'الفرق المسموح به شهرياً، على الأقل.']],
      ['reconcileToleranceBasisPoints', 'whole', ['Reconciliation tolerance (basis points)', 'سماحية المطابقة (نقاط أساس)'], ['100 = 1% of the month\'s studio spend.', '100 = 1% من صرف الاستوديو في الشهر.'], [0, 1000]],
      ['queueOnTargetPercent', 'whole', ['Queues on target (%)', 'الطوابير في الهدف (%)'], ['50 to 100.', 'من 50 إلى 100.'], [50, 100]],
      ['resultsFreshPercent', 'whole', ['Linked ads checked recently (%)', 'الإعلانات المربوطة المفحوصة حديثاً (%)'], ['50 to 100.', 'من 50 إلى 100.'], [50, 100]],
      ['resultsFreshHours', 'whole', ['"Recently" means within (hours)', '«حديثاً» تعني خلال (ساعات)'], ['1 to 48.', 'من 1 إلى 48.'], [1, 48]],
      ['webhookReplyP95Seconds', 'whole', ['Webhook reply p95 (seconds)', 'الرد عبر الويب هوك p95 (ثوانٍ)'], ['10 to 3600.', 'من 10 إلى 3600.'], [10, 3600]],
      ['pollReplyP95Seconds', 'whole', ['Poll reply p95 (seconds)', 'الرد عبر الفحص الدوري p95 (ثوانٍ)'], ['60 to 7200.', 'من 60 إلى 7200.'], [60, 7200]],
      ['replyFailureMaxPercent', 'whole', ['Most reply failures (%)', 'أقصى نسبة فشل الردود (%)'], ['0 to 50.', 'من 0 إلى 50.'], [0, 50]],
      ['restoreProofMaxDays', 'whole', ['Restore proven within (days)', 'إثبات الاستعادة خلال (أيام)'], ['1 to 30.', 'من 1 إلى 30.'], [1, 30]],
      ['tokenMinDaysLeft', 'whole', ['Meta token: least days left', 'رمز ميتا: أقل أيام متبقية'], ['1 to 60.', 'من 1 إلى 60.'], [1, 60]],
      ['strandedCaptureMaxMinutes', 'whole', ['Stop rule: "being returned" older than (minutes)', 'قاعدة إيقاف: «في طريقه إليك» أقدم من (دقائق)'], ['5 to 1440.', 'من 5 إلى 1440.'], [5, 1440]],
      ['replyOutageMaxHours', 'whole', ['Stop rule: replies down longer than (hours)', 'قاعدة إيقاف: توقف الردود أطول من (ساعات)'], ['1 to 72.', 'من 1 إلى 72.'], [1, 72]],
      ['heartbeatLateMaxMinutes', 'whole', ['Stop rule: jobs heartbeat late by (minutes)', 'قاعدة إيقاف: تأخر نبض المهام (دقائق)'], ['5 to 240.', 'من 5 إلى 240.'], [5, 240]],
      ['tokenExpiryWarnDays', 'days', ['Token expiry warnings (days before, comma separated)', 'تنبيهات انتهاء الرمز (أيام قبل الانتهاء، مفصولة بفواصل)'], ['1 to 5 numbers, each 1 to 60.', 'من رقم إلى 5 أرقام، كل منها من 1 إلى 60.']]
    ]
  }
});
const STUDIO_ADMIN_GO_LABELS = Object.freeze({
  integrityViolations: ['Daily money check: violations', 'فحص الأموال اليومي: مخالفات'],
  refundsAboveCap: ['Refunds above the cap without an override', 'إعادات فوق الحد دون تجاوز'],
  reconciliation: ['Reconciliation within tolerance (difference, cents)', 'المطابقة ضمن السماحية (الفرق بالسنت)'],
  reviewsOnTarget: ['Reviews on target (%)', 'المراجعات في الهدف (%)'],
  stopRequestsOnTarget: ['Stop requests on target (%)', 'طلبات الإيقاف في الهدف (%)'],
  paymentsOnTarget: ['Payment confirmations on target (%)', 'تأكيدات الدفع في الهدف (%)'],
  ticketsOnTarget: ['Ticket answers on target (%)', 'الردود على التذاكر في الهدف (%)'],
  resultsFresh: ['Linked ads checked recently (%)', 'الإعلانات المربوطة المفحوصة حديثاً (%)'],
  webhookReplyP95: ['Webhook reply p95 (seconds)', 'الرد عبر الويب هوك p95 (ثوانٍ)'],
  pollReplyP95: ['Poll reply p95 (seconds)', 'الرد عبر الفحص الدوري p95 (ثوانٍ)'],
  replyFailureRate: ['Reply failures (%)', 'فشل الردود (%)'],
  commentsLostToOutage: ['Comments lost to an outage', 'تعليقات ضاعت أثناء انقطاع'],
  noOpenMoneyIncident: ['Open money incidents', 'حوادث أموال مفتوحة'],
  runbookRehearsed: ['Runbook rehearsed (ticked by hand)', 'التدرب على دليل الطوارئ (يُحدَّد يدوياً)'],
  restoreProven: ['Restore proven (ticked by hand)', 'إثبات الاستعادة (يُحدَّد يدوياً)'],
  tokenValid: ['Meta token valid with enough days left', 'رمز ميتا صالح وبأيام كافية']
});
const STUDIO_ADMIN_STOP_LABELS = Object.freeze({
  walletIdentityBreak: ['Wallet identity break', 'كسر في هوية المحفظة'],
  duplicateCharge: ['Duplicate charge or return', 'خصم أو إعادة مكررة'],
  strandedCapture: ['Stranded capture ("being returned" too long)', 'مبلغ عالق («في طريقه إليك» طويلاً)'],
  studioInCoreBooks: ['A studio ad in the core books', 'إعلان استوديو في دفاتر المدير'],
  replyOutage: ['Comment replies down too long', 'توقف الردود على التعليقات طويلاً'],
  heartbeatLate: ['Studio jobs heartbeat late', 'تأخر نبض مهام الاستوديو']
});
const STUDIO_ADMIN_COLLISION_REASONS = Object.freeze({
  studio_name: ['the campaign name carries the studio code', 'اسم الحملة يحمل رمز الاستوديو'],
  studio_campaign_id: ['a studio request linked this campaign', 'ربط طلبٌ في الاستوديو هذه الحملة']
});

const _studioAdmin = { forUser: '', generation: 0, reads: Object.create(null), settings: Object.create(null), alertsPages: [], acks: new Map(), scan: null };
// acks: alert id -> the acknowledge in flight (single flight); scan: the last on-demand money scan
// ({promise, value, error, at}; renderStudioAdminScanRow).

// ------------------------------------------------------------------ small helpers

function studioAdminUserId() {
  return typeof studioMeUserId === 'function' ? studioMeUserId() : String((state.currentUser && state.currentUser.id) || '');
}

function studioAdminScope() {
  const uid = studioAdminUserId();
  if (_studioAdmin.forUser !== uid) {
    _studioAdmin.generation++;
    _studioAdmin.forUser = uid;
    _studioAdmin.reads = Object.create(null);
    _studioAdmin.settings = Object.create(null);
    _studioAdmin.alertsPages = [];
    _studioAdmin.acks = new Map();
    _studioAdmin.scan = null;
  }
  return uid;
}

function studioAdminIsAdmin() {
  return typeof isCurrentUserAdmin === 'function' && isCurrentUserAdmin();
}

function studioAdminServer() {
  return typeof isServerModeEnabled === 'function' && isServerModeEnabled();
}

function studioAdminIcon(name, className = 'studio-v2-icon') {
  return studioV2Icon(name, className);
}

function studioAdminRedraw() {
  if (typeof studioDeskRedraw === 'function') studioDeskRedraw();
  else studioV2Rerender();
}

function studioAdminOpen(id) {
  return studioV2Go({ tab: 'review', section: 'more', id: String(id || '') });
}

function studioAdminPage(id) {
  return STUDIO_ADMIN_PAGES.find(page => page[0] === String(id || '')) || null;
}

function studioAdminWhen(iso) {
  if (typeof studioDeskWhen === 'function') return studioDeskWhen(iso);
  const at = Date.parse(String(iso || ''));
  return Number.isFinite(at) ? new Date(at).toLocaleString(adsStudioIsAr() ? 'ar-LY' : 'en-GB') : '';
}

function studioAdminAgo(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(Math.floor((Date.now() - at) / 60000), 0);
  if (minutes < 60) return adsStudioText(`${minutes} min ago`, `قبل ${minutes} دقيقة`);
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return adsStudioText(`${hours} h ago`, `قبل ${hours} ساعة`);
  return adsStudioText(`${Math.floor(hours / 24)} days ago`, `قبل ${Math.floor(hours / 24)} يوماً`);
}

function studioAdminNumber(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  try { return number.toLocaleString('en-US', { maximumFractionDigits: digits }); } catch (_) { return String(number); }
}

function studioAdminBytes(bytes) {
  const number = Number(bytes);
  if (!Number.isFinite(number) || number < 0) return '—';
  if (number < 1024 * 1024) return `${studioAdminNumber(number / 1024)} KB`;
  if (number < 1024 * 1024 * 1024) return `${studioAdminNumber(number / (1024 * 1024), 1)} MB`;
  return `${studioAdminNumber(number / (1024 * 1024 * 1024), 2)} GB`;
}

function studioAdminYesNo(value) {
  if (value === true) return adsStudioText('yes', 'نعم');
  if (value === false) return adsStudioText('no', 'لا');
  return adsStudioText('unknown', 'غير معروف');
}

// One admin read, kept a minute; a failed read waits 30 s (Retry asks at once).
function studioAdminRead(key, path, force = false) {
  studioAdminScope();
  let slot = _studioAdmin.reads[key];
  if (!slot) {
    slot = { value: null, loadedAt: 0, failedAt: 0, error: null, promise: null };
    _studioAdmin.reads[key] = slot;
  }
  if (!studioAdminServer() || slot.promise) return slot;
  const age = Date.now() - slot.loadedAt;
  if (!force) {
    if (slot.failedAt && Date.now() - slot.failedAt < STUDIO_ADMIN_RETRY_MS) return slot;
    if (slot.value !== null && age >= 0 && age < STUDIO_ADMIN_TTL_MS) return slot;
  }
  const generation = _studioAdmin.generation;
  const signal = studioReadSignal();
  slot.promise = studioApi(path, { method: 'GET' }).then(raw => {
    if (generation !== _studioAdmin.generation) return;
    slot.value = raw && typeof raw === 'object' ? raw : {};
    slot.loadedAt = Date.now();
    slot.failedAt = 0;
    slot.error = null;
  }, error => {
    if (generation !== _studioAdmin.generation || studioReadCancelled(error, signal)) return;
    slot.failedAt = Date.now();
    slot.error = (error && error.studio) || studioErrorInfo(error, 'read');
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    slot.promise = null;
    studioAdminRedraw();
  });
  return slot;
}

function studioAdminRetry(key, path) {
  studioAdminRead(String(key || ''), String(path || ''), true);
  studioAdminRedraw();
}

function renderStudioAdminProblem(slot, retryCode, testId) {
  if (slot.promise && slot.value === null) return `<p class="studio-desk-note" data-testid="${studioEsc(testId)}-loading">${studioEsc(adsStudioText('Reading…', 'جارٍ القراءة…'))}</p>`;
  if (slot.value === null && slot.error) {
    return `<div class="studio-desk-problem" role="alert" data-testid="${studioEsc(testId)}-problem"><p>${studioEsc(slot.error.text || '')}</p><button type="button" class="studio-v2-action studio-desk-small" onclick="${retryCode}">${studioEsc(adsStudioText('Try again', 'أعد المحاولة'))}</button></div>`;
  }
  return '';
}

function renderStudioAdminPageHead(id, extra = '') {
  const page = studioAdminPage(id);
  if (!page) return '';
  return `
          <div class="studio-desk-head" data-testid="studio-admin-head-${studioEsc(id)}">
            <div class="studio-desk-heading"><h2 class="studio-desk-h2">${studioAdminIcon(page[1], 'studio-desk-meta-icon')}<span>${studioEsc(adsStudioText(page[2], page[3]))}</span></h2><p class="studio-desk-note">${studioEsc(adsStudioText(page[4], page[5]))}</p></div>
            ${extra}
          </div>`;
}

function renderStudioAdminLine(label, value, tone = '', testId = '') {
  return `<div class="studio-desk-line"${tone ? ` data-tone="${studioEsc(tone)}"` : ''}${testId ? ` data-testid="${studioEsc(testId)}"` : ''}><span class="studio-desk-line-label">${studioEsc(label)}</span><span class="studio-desk-line-value" dir="auto">${studioEsc(value)}</span></div>`;
}

function studioAdminOkTone(ok) {
  return ok === true ? 'green' : ok === false ? 'red' : 'slate';
}

// ------------------------------------------------------------------ the menu

function renderStudioAdminMenu() {
  const pulse = typeof _studioDesk !== 'undefined' && _studioDesk.pulse ? _studioDesk.pulse.value : null;
  const counts = { payments: pulse && pulse.paymentsWaiting ? pulse.paymentsWaiting : 0, alerts: pulse ? pulse.alerts : 0 };
  const row = ([id, icon, en, ar, hintEn, hintAr]) => `
            <button type="button" class="studio-v2-row studio-admin-row" data-testid="studio-admin-open-${studioEsc(id)}" onclick="studioAdminOpen('${studioEsc(id)}')">
              ${studioAdminIcon(icon)}
              <span class="studio-admin-row-text"><span class="studio-v2-row-label">${studioEsc(adsStudioText(en, ar))}</span><span class="studio-desk-note">${studioEsc(adsStudioText(hintEn, hintAr))}</span></span>
              ${counts[id] ? `<span class="studio-desk-count" data-testid="studio-admin-count-${studioEsc(id)}">${studioEsc(String(counts[id]))}</span>` : ''}
            </button>`;
  const tools = STUDIO_ADMIN_PAGES.filter(page => !page[0].startsWith('settings-'));
  const settings = STUDIO_ADMIN_PAGES.filter(page => page[0].startsWith('settings-'));
  return `
          <h2 class="studio-desk-h2">${studioEsc(adsStudioText('Admin tools', 'أدوات المدير'))}</h2>
          <div class="studio-v2-list" data-testid="studio-admin-menu">${tools.map(row).join('')}</div>
          <h2 class="studio-desk-h2 studio-desk-h2-later">${studioEsc(adsStudioText('Settings', 'الإعدادات'))}</h2>
          <div class="studio-v2-list" data-testid="studio-admin-settings-menu">${settings.map(row).join('')}</div>`;
}

// ------------------------------------------------------------------ payments waiting

function studioAdminPaymentsWant(force = false) {
  const uid = studioAdminUserId();
  if (typeof refreshAdsStudioWallet !== 'function') return;
  if (force || _adsStudioWalletForUser !== uid) {
    if (typeof resetAdsStudioWalletCache === 'function') resetAdsStudioWalletCache();
    refreshAdsStudioWallet();
  } else if (_adsStudioWalletMine === null) {
    refreshAdsStudioWallet();
  }
}

function studioAdminPaymentsRefresh() {
  studioAdminPaymentsWant(true);
  studioAdminRedraw();
}

function renderStudioAdminPayments() {
  studioAdminPaymentsWant();
  const targets = studioAdminRead('targets', '/api/studio/admin/settings/targets');
  const minutes = targets.value && targets.value.value ? Number(targets.value.value.paymentConfirmMinutes) : 240;
  const pending = Array.isArray(_adsStudioWalletPendingAll) ? _adsStudioWalletPendingAll : null;
  const loading = pending === null;
  const rows = (pending || []).map(entity => {
    const data = entity && entity.data ? entity.data : {};
    const createdAt = String(data.createdAt || '');
    const waitedMinutes = createdAt && Number.isFinite(Date.parse(createdAt)) ? (Date.now() - Date.parse(createdAt)) / 60000 : null;
    const overdue = waitedMinutes !== null && waitedMinutes > (Number.isFinite(minutes) ? minutes : 240);
    const wait = createdAt ? `<p class="studio-desk-note studio-admin-payment-wait" data-testid="studio-admin-payment-wait" data-overdue="${overdue ? '1' : '0'}">${studioEsc(adsStudioText(`Waiting since ${studioAdminWhen(createdAt)} (${studioAdminAgo(createdAt)})`, `بانتظار التأكيد منذ ${studioAdminWhen(createdAt)} (${studioAdminAgo(createdAt)})`))}${overdue ? ` <span class="studio-flag">${studioEsc(adsStudioText('Past the target', 'تجاوز الهدف'))}</span>` : ''}</p>` : '';
    return `<li class="studio-admin-payment">${typeof _adsStudioWalletRequestRow === 'function' ? _adsStudioWalletRequestRow(entity, true) : ''}${wait}</li>`;
  });
  const refresh = `<button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-payments-refresh" onclick="studioAdminPaymentsRefresh()">${studioAdminIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Refresh', 'تحديث'))}</span></button>`;
  let body;
  if (loading) body = `<p class="studio-desk-note" data-testid="studio-admin-payments-loading">${studioEsc(adsStudioText('Reading the payment requests…', 'نقرأ طلبات الدفع…'))}</p>`;
  else if (!rows.length) body = renderStudioDeskEmpty('landmark', adsStudioText('No payment waits for confirmation', 'لا دفعة تنتظر التأكيد'), '', 'studio-admin-payments-empty');
  else body = `<ul class="studio-desk-list studio-desk-classic" data-testid="studio-admin-payments">${rows.join('')}</ul>`;
  return renderStudioAdminPageHead('payments', refresh) + `<p class="studio-desk-note">${studioEsc(adsStudioText(`Target: confirm within ${Number.isFinite(minutes) ? minutes : 240} working minutes. A confirmed USD payment adds to the customer's available money; a LYD one to the plan balance.`, `الهدف: التأكيد خلال ${Number.isFinite(minutes) ? minutes : 240} دقيقة عمل. الدفعة المؤكدة بالدولار تُضاف إلى رصيد العميل المتاح، وبالدينار إلى رصيد الاشتراك.`))}</p>` + body;
}

// ------------------------------------------------------------------ alerts

function studioAdminAlertsPath() {
  const last = _studioAdmin.alertsPages[_studioAdmin.alertsPages.length - 1];
  return last && last.nextBefore ? `/api/studio/admin/alerts?limit=20&before=${encodeURIComponent(last.nextBefore)}` : '/api/studio/admin/alerts?limit=20';
}

function studioAdminAlertsMore() {
  const slot = _studioAdmin.reads.alerts;
  if (!slot || !slot.value || !slot.value.nextBefore || slot.promise) return;
  _studioAdmin.alertsPages.push({ alerts: Array.isArray(slot.value.alerts) ? slot.value.alerts : [], nextBefore: String(slot.value.nextBefore) });
  studioAdminRead('alerts', studioAdminAlertsPath(), true);
  studioAdminRedraw();
}

function studioAdminAlertsRefresh() {
  _studioAdmin.alertsPages = [];
  studioAdminRetry('alerts', '/api/studio/admin/alerts?limit=20');
}

function renderStudioAdminAlert(alert) {
  const kind = String((alert && alert.kind) || '').replace(/[^a-z_]/g, '').slice(0, 60);
  const label = studioPickText(alert && alert.labels, 300) || kind;
  const count = Number(alert && alert.count) || 0;
  const ack = !!(alert && alert.acknowledgedAt);
  const details = alert && alert.details && typeof alert.details === 'object' ? alert.details : {};
  const bits = [];
  if (alert && alert.lastAt) bits.push(adsStudioText(`last ${studioAdminAgo(alert.lastAt)}`, `آخر مرة ${studioAdminAgo(alert.lastAt)}`));
  if (count > 1) bits.push(adsStudioText(`${count} times`, `${count} مرات`));
  if (alert && alert.relatedId) bits.push(`${String(alert.relatedType || '').slice(0, 30)}: ${String(alert.relatedId).slice(0, 80)}`);
  if (Number.isSafeInteger(details.absorbedMinorUSD) && details.absorbedMinorUSD > 0) bits.push(adsStudioText(`Albayan absorbs ${studioUsd(details.absorbedMinorUSD)}`, `يتحمل البيان ${studioUsd(details.absorbedMinorUSD)}`));
  if (Number.isSafeInteger(details.daysLeft)) bits.push(adsStudioText(`${details.daysLeft} days left`, `بقي ${details.daysLeft} يوماً`));
  const id = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(String((alert && alert.id) || '')) ? String(alert.id) : '';
  const busy = !!id && _studioAdmin.acks.has(id);
  const ackButton = !ack && id
    ? `<div class="studio-desk-actions"><button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-alert-ack-${studioEsc(id)}" onclick="studioAdminAlertAck('${studioEsc(id)}', this)"${busy ? ' disabled aria-busy="true"' : ''}>${studioAdminIcon('check')}<span>${studioEsc(busy ? adsStudioText('Acknowledging…', 'جارٍ التأكيد…') : adsStudioText('Acknowledge', 'تأكيد الاطلاع'))}</span></button></div>` : '';
  return `
              <li class="studio-desk-box studio-admin-alert" data-testid="studio-admin-alert" data-kind="${studioEsc(kind)}" data-acknowledged="${ack ? '1' : '0'}"${id ? ` data-id="${studioEsc(id)}"` : ''}>
                <p class="studio-admin-alert-title">${studioAdminIcon(ack ? 'check' : 'bell-ring', 'studio-desk-meta-icon')}<span dir="auto">${studioEsc(label)}</span></p>
                <p class="studio-desk-note"><code class="studio-desk-code" dir="ltr">${studioEsc(kind)}</code>${bits.length ? ` · <span dir="auto">${studioEsc(bits.join(' · '))}</span>` : ''}${ack ? ` · ${studioEsc(adsStudioText('acknowledged', 'تم الاطلاع'))}` : ''}</p>
                ${ackButton}
              </li>`;
}

// "Acknowledge" (P3-23): POST /api/studio/admin/alerts/{id}/ack, single flight per alert. The
// server stamps acknowledgedAt (a replay answers the stamped alert as it is), so the row leaves
// the open list at once and the pulse count follows on its next read. UNKNOWN_ALERT (archived or a
// stale entry) is shown through the ONE error map and the list is read again.
function studioAdminAlertAck(id, button = null) {
  const alertId = String(id || '');
  if (!alertId || !studioAdminIsAdmin() || !studioAdminServer() || _studioAdmin.acks.has(alertId)) return null;
  if (button) setAdsStudioActionButtonBusy(button, true);
  const generation = _studioAdmin.generation;
  const promise = studioApi(`/api/studio/admin/alerts/${encodeURIComponent(alertId)}/ack`, { method: 'POST', body: {} }).then(reply => {
    if (generation !== _studioAdmin.generation) return null;
    const alert = reply && reply.alert && typeof reply.alert === 'object' ? reply.alert : null;
    if (!alert || !alert.acknowledgedAt) return null;
    studioAdminAlertLeft(alertId);
    if (typeof studioDeskPulseRefresh === 'function') studioDeskPulseRefresh();
    studioAdminNotify(true, adsStudioText('Alert acknowledged', 'تم تأكيد الاطلاع على التنبيه'), reply.replay === true ? adsStudioText('It was already acknowledged.', 'كان قد تم تأكيد الاطلاع عليه من قبل.') : '');
    return alert;
  }, error => {
    if (generation !== _studioAdmin.generation) return null;
    const info = (error && error.studio) || studioErrorInfo(error, 'action');
    studioAdminNotify(false, adsStudioText('Could not acknowledge the alert', 'تعذّر تأكيد الاطلاع على التنبيه'), info.text || '');
    if (info.code === 'UNKNOWN_ALERT') studioAdminAlertsRefresh();
    return null;
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    _studioAdmin.acks.delete(alertId);
    if (button) setAdsStudioActionButtonBusy(button, false);
    studioAdminRedraw();
  });
  _studioAdmin.acks.set(alertId, promise);
  studioAdminRedraw();
  return promise;
}

// An acknowledged alert leaves the open list this screen holds (the current page and the earlier ones).
function studioAdminAlertLeft(alertId) {
  const slot = _studioAdmin.reads.alerts;
  const drop = list => (Array.isArray(list) ? list.filter(item => !(item && String(item.id || '') === alertId)) : list);
  if (slot && slot.value && Array.isArray(slot.value.alerts)) slot.value.alerts = drop(slot.value.alerts);
  _studioAdmin.alertsPages = _studioAdmin.alertsPages.map(page => ({ ...page, alerts: drop(page.alerts) }));
}

function studioAdminNotify(ok, title, text) {
  try { showNotification(title, text, ok ? 'success' : 'error'); } catch (_) {}
}

function renderStudioAdminJobs(jobs) {
  if (!jobs || typeof jobs !== 'object') return '';
  const late = jobs.late === true;
  const tick = jobs.lastTickAt ? adsStudioText(`last tick ${studioAdminAgo(jobs.lastTickAt)}`, `آخر نبضة ${studioAdminAgo(jobs.lastTickAt)}`) : adsStudioText('never ticked', 'لم تنبض بعد');
  const text = jobs.enabled === false
    ? adsStudioText('The studio jobs loop is switched off here.', 'حلقة مهام الاستوديو متوقفة هنا.')
    : late ? adsStudioText(`Studio jobs heartbeat LATE (${tick}).`, `نبض مهام الاستوديو متأخر (${tick}).`) : adsStudioText(`Studio jobs heartbeat fine (${tick}).`, `نبض مهام الاستوديو سليم (${tick}).`);
  return `<p class="studio-desk-line" data-tone="${late ? 'red' : 'green'}" data-testid="studio-admin-heartbeat" data-late="${late ? '1' : '0'}"><span class="studio-desk-line-label">${studioAdminIcon('heart-pulse', 'studio-desk-meta-icon')}${studioEsc(text)}</span></p>`;
}

function renderStudioAdminAlerts() {
  const slot = studioAdminRead('alerts', studioAdminAlertsPath());
  const refresh = `<button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-alerts-refresh" onclick="studioAdminAlertsRefresh()"${slot.promise ? ' disabled' : ''}>${studioAdminIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Refresh', 'تحديث'))}</span></button>`;
  const head = renderStudioAdminPageHead('alerts', refresh);
  const problem = renderStudioAdminProblem(slot, "studioAdminRetry('alerts', '/api/studio/admin/alerts?limit=20')", 'studio-admin-alerts');
  if (problem) return head + problem;
  const earlier = _studioAdmin.alertsPages.flatMap(page => page.alerts);
  const current = slot.value && Array.isArray(slot.value.alerts) ? slot.value.alerts : [];
  const alerts = earlier.concat(current).filter(item => item && typeof item === 'object');
  const list = alerts.length
    ? `<ul class="studio-desk-list" data-testid="studio-admin-alerts">${alerts.map(renderStudioAdminAlert).join('')}</ul>`
    : renderStudioDeskEmpty('bell-off', adsStudioText('No alerts', 'لا تنبيهات'), adsStudioText('The jobs loop and the Meta checks raised nothing.', 'لم تُثر حلقة المهام وفحوص ميتا شيئاً.'), 'studio-admin-alerts-empty');
  const more = slot.value && slot.value.nextBefore ? `<button type="button" class="studio-v2-action studio-desk-more" data-testid="studio-admin-alerts-more" onclick="studioAdminAlertsMore()"${slot.promise ? ' disabled' : ''}>${studioEsc(adsStudioText('Show older alerts', 'اعرض التنبيهات الأقدم'))}</button>` : '';
  return head + renderStudioAdminJobs(slot.value && slot.value.jobs) + list + more;
}

// ------------------------------------------------------------------ diagnostics

function studioAdminPercentText(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? adsStudioText('no data', 'لا بيانات') : `${studioAdminNumber(value, 1)}%`;
}

function renderStudioAdminQueues(operations) {
  const queues = operations && operations.queues && typeof operations.queues === 'object' ? operations.queues : {};
  const names = { reviews: ['Reviews', 'المراجعات'], tickets: ['Ticket answers', 'الردود على التذاكر'], stopRequests: ['Stop requests', 'طلبات الإيقاف'], payments: ['Payment confirmations', 'تأكيدات الدفع'] };
  const lines = Object.entries(names).map(([key, [en, ar]]) => {
    const queue = queues[key] && typeof queues[key] === 'object' ? queues[key] : {};
    const value = `${studioAdminPercentText(queue.percent)} ${adsStudioText(`met (${Number(queue.met) || 0} of ${Number(queue.sample) || 0}), ${Number(queue.waitingOverdue) || 0} waiting past the target`, `في الهدف (${Number(queue.met) || 0} من ${Number(queue.sample) || 0})، ${Number(queue.waitingOverdue) || 0} ينتظر بعد الموعد`)}`;
    return renderStudioAdminLine(adsStudioText(en, ar), value, studioAdminOkTone(queue.onTarget), `studio-admin-queue-${key}`);
  });
  const window = operations && operations.window ? Number(operations.window.queueDays) || 7 : 7;
  return `<section class="studio-desk-box" data-testid="studio-admin-queues"><h3 class="studio-desk-h3">${studioEsc(adsStudioText(`Queues on target (last ${window} days)`, `الطوابير في الهدف (آخر ${window} أيام)`))}</h3>${lines.join('')}</section>`;
}

function renderStudioAdminCapacity(operations) {
  const capacity = operations && operations.capacity && typeof operations.capacity === 'object' ? operations.capacity : {};
  const intake = capacity.intake && typeof capacity.intake === 'object' ? capacity.intake : {};
  const sends = capacity.sendsPerDay && typeof capacity.sendsPerDay === 'object' ? capacity.sendsPerDay : {};
  return `<section class="studio-desk-box" data-testid="studio-admin-capacity"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Capacity', 'السعة'))}</h3>
    ${renderStudioAdminLine(adsStudioText('Intake', 'الاستقبال'), intake.open === false ? adsStudioText('paused', 'متوقف مؤقتاً') : adsStudioText(`open, cap ${studioAdminNumber(intake.maxSubmissionsPerDay)} a day`, `مفتوح، الحد ${studioAdminNumber(intake.maxSubmissionsPerDay)} يومياً`), intake.open === false ? 'amber' : 'green')}
    ${renderStudioAdminLine(adsStudioText('Sends today', 'الإرسالات اليوم'), `${studioAdminNumber(capacity.submissionsToday)}${capacity.usedPercent !== null && capacity.usedPercent !== undefined ? ` (${studioAdminNumber(capacity.usedPercent, 1)}% ${adsStudioText('of the cap', 'من الحد')})` : ''}`)}
    ${renderStudioAdminLine(adsStudioText('Sends a day (average / max)', 'الإرسالات يومياً (المتوسط / الأعلى)'), `${studioAdminNumber(sends.average, 2)} / ${studioAdminNumber(sends.max)}`)}
    ${renderStudioAdminLine(adsStudioText('Waiting for review now', 'بانتظار المراجعة الآن'), studioAdminNumber(capacity.waitingReview))}
  </section>`;
}

function renderStudioAdminMoney(operations) {
  const money = operations && operations.money && typeof operations.money === 'object' ? operations.money : {};
  const owed = money.owed && typeof money.owed === 'object' ? money.owed : {};
  const absorbed = money.absorbedOverspend && typeof money.absorbedOverspend === 'object' ? money.absorbedOverspend : {};
  const reconciliation = money.reconciliation && typeof money.reconciliation === 'object' ? money.reconciliation : {};
  const funds = money.studioFunds && typeof money.studioFunds === 'object' ? money.studioFunds : {};
  const margin = owed.fundsMinusOwedMinorUSD;
  return `<section class="studio-desk-box" data-testid="studio-admin-money"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Money', 'الأموال'))}</h3>
    ${renderStudioAdminLine(adsStudioText('USD owed to customers (wallets + in ads)', 'الدولارات المستحقة للعملاء (المحافظ + في الإعلانات)'), studioUsd(owed.owedMinorUSD), '', 'studio-admin-owed')}
    ${renderStudioAdminLine(adsStudioText('Studio ad-account funds', 'أموال الحسابات الإعلانية للاستوديو'), funds.fundsMinorUSD === null || funds.fundsMinorUSD === undefined ? (funds.allowlistConfigured === false ? adsStudioText('no allowlisted account', 'لا حساب في القائمة المسموحة') : adsStudioText('unreadable', 'غير مقروءة')) : studioUsd(funds.fundsMinorUSD))}
    ${renderStudioAdminLine(adsStudioText('Funds minus owed', 'الأموال ناقص المستحق'), margin === null || margin === undefined ? '—' : studioUsd(margin), margin === null || margin === undefined ? 'slate' : margin < 0 ? 'red' : 'green')}
    ${renderStudioAdminLine(adsStudioText('Absorbed overspend (this month / total)', 'الصرف الزائد المتحمَّل (هذا الشهر / الإجمالي)'), `${studioUsd(absorbed.thisMonthMinorUSD)} / ${studioUsd(absorbed.totalMinorUSD)}`)}
    ${renderStudioAdminLine(adsStudioText(`Reconciliation ${reconciliation.month || ''}: difference vs tolerance`, `المطابقة ${reconciliation.month || ''}: الفرق مقابل السماحية`), `${studioUsd(reconciliation.differenceMinorUSD)} / ${studioUsd(reconciliation.toleranceMinorUSD)}`, studioAdminOkTone(reconciliation.withinTolerance))}
    ${renderStudioAdminLine(adsStudioText('Open money incidents', 'حوادث أموال مفتوحة'), studioAdminNumber(money.openIncidents), Number(money.openIncidents) > 0 ? 'red' : 'green')}
  </section>`;
}

function renderStudioAdminGoNoGo(operations) {
  const go = operations && operations.goNoGo && typeof operations.goNoGo === 'object' ? operations.goNoGo : null;
  if (!go) return '';
  const rows = Object.entries(go.go && typeof go.go === 'object' ? go.go : {}).map(([key, row]) => {
    const label = STUDIO_ADMIN_GO_LABELS[key] ? adsStudioText(STUDIO_ADMIN_GO_LABELS[key][0], STUDIO_ADMIN_GO_LABELS[key][1]) : key;
    const ok = row && typeof row === 'object' ? row.ok : null;
    const value = row && typeof row === 'object' && row.value !== null && row.value !== undefined ? studioAdminNumber(row.value, 1) : '—';
    return renderStudioAdminLine(label, `${ok === true ? adsStudioText('go', 'متابعة') : ok === false ? adsStudioText('no-go', 'توقف') : adsStudioText('unknown', 'غير معروف')} · ${value}`, studioAdminOkTone(ok), `studio-admin-go-${key}`);
  });
  const stops = Object.entries(go.stop && typeof go.stop === 'object' ? go.stop : {}).map(([key, row]) => {
    const label = STUDIO_ADMIN_STOP_LABELS[key] ? adsStudioText(STUDIO_ADMIN_STOP_LABELS[key][0], STUDIO_ADMIN_STOP_LABELS[key][1]) : key;
    const fired = row && typeof row === 'object' ? row.fired : null;
    return renderStudioAdminLine(label, fired === true ? adsStudioText('FIRED', 'انطلقت') : fired === false ? adsStudioText('quiet', 'هادئة') : adsStudioText('unknown', 'غير معروف'), fired === true ? 'red' : fired === false ? 'green' : 'slate', `studio-admin-stop-${key}`);
  });
  const verdict = go.stopVerdict === true
    ? adsStudioText('A stop rule fired: pause intake and the customer layout, take a backup, investigate.', 'انطلقت قاعدة إيقاف: أوقف الاستقبال وواجهة العملاء، خذ نسخة احتياطية، وحقّق.')
    : go.goVerdict === true ? adsStudioText(`Every go row is green (needed ${go.consecutiveWeeksNeeded || 2} weeks in a row).`, `كل صفوف المتابعة خضراء (المطلوب ${go.consecutiveWeeksNeeded || 2} أسابيع متتالية).`)
      : go.goVerdict === false ? adsStudioText('At least one go row is red.', 'صف واحد على الأقل أحمر.')
        : adsStudioText(`Some rows are unknown (${Array.isArray(go.unknown) ? go.unknown.length : 0}); the owner ticks the manual ones.`, `بعض الصفوف غير معروفة (${Array.isArray(go.unknown) ? go.unknown.length : 0})؛ يحدّد المالك اليدوية منها.`);
  return `<section class="studio-desk-box" data-testid="studio-admin-gonogo" data-stop="${go.stopVerdict === true ? '1' : '0'}"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Pilot go/no-go', 'قرار المتابعة في التجربة'))}</h3><p class="studio-desk-note">${studioEsc(verdict)}</p>${rows.join('')}<h4 class="studio-desk-label">${studioEsc(adsStudioText('Stop rules', 'قواعد الإيقاف'))}</h4>${stops.join('')}</section>`;
}

function renderStudioAdminDiagnostics() {
  const slot = studioAdminRead('diagnostics', '/api/studio/admin/diagnostics');
  const refresh = `<button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-diagnostics-refresh" onclick="studioAdminRetry('diagnostics', '/api/studio/admin/diagnostics')"${slot.promise ? ' disabled' : ''}>${studioAdminIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Refresh', 'تحديث'))}</span></button>`;
  const head = renderStudioAdminPageHead('diagnostics', refresh);
  const problem = renderStudioAdminProblem(slot, "studioAdminRetry('diagnostics', '/api/studio/admin/diagnostics')", 'studio-admin-diagnostics');
  if (problem) return head + problem;
  const report = slot.value || {};
  const operations = report.operations && typeof report.operations === 'object' ? report.operations : {};
  const meta = operations.meta && typeof operations.meta === 'object' ? operations.meta : {};
  const token = meta.token && typeof meta.token === 'object' ? meta.token : {};
  const storage = operations.storage && typeof operations.storage === 'object' ? operations.storage : {};
  const baselines = report.baselines && typeof report.baselines === 'object' ? report.baselines : {};
  const baselineNames = { B1: ['Submit → decision (median hours)', 'الإرسال ← القرار (الوسيط بالساعات)'], B2: ['Sent back for changes (%)', 'أُعيدت للتعديل (%)'], B3: ['Holds older than 14 days', 'حجوزات أقدم من 14 يوماً'], B4: ['Ended, unsettled 7+ days', 'انتهت ولم تُسوَّ منذ 7 أيام أو أكثر'], B5: ['Draft → submit (median hours)', 'المسودة ← الإرسال (الوسيط بالساعات)'], B6: ['Account → first approval (median hours)', 'الحساب ← أول موافقة (الوسيط بالساعات)'] };
  const baselineLines = Object.entries(baselineNames).map(([key, [en, ar]]) => {
    const row = baselines[key] && typeof baselines[key] === 'object' ? baselines[key] : null;
    return renderStudioAdminLine(`${key} · ${adsStudioText(en, ar)}`, row ? `${studioAdminNumber(row.value, 1)} (${adsStudioText(`sample ${studioAdminNumber(row.sample)}`, `العينة ${studioAdminNumber(row.sample)}`)})` : adsStudioText('no data yet', 'لا بيانات بعد'));
  });
  const tokenLine = token.configured === false
    ? adsStudioText('token check not set up', 'فحص الرمز غير مُعدّ')
    : token.checked ? `${token.isValid === true ? adsStudioText('valid', 'صالح') : adsStudioText('NOT valid', 'غير صالح')} · ${token.expiresNever ? adsStudioText('never expires', 'لا ينتهي') : adsStudioText(`${studioAdminNumber(token.daysLeft)} days left`, `بقي ${studioAdminNumber(token.daysLeft)} يوماً`)}` : adsStudioText('not checked yet', 'لم يُفحص بعد');
  const generated = report.generatedAt ? `<p class="studio-desk-note">${studioEsc(adsStudioText(`Generated ${studioAdminWhen(report.generatedAt)}. Counts only, no personal data.`, `أُنشئ ${studioAdminWhen(report.generatedAt)}. أرقام فقط، دون بيانات شخصية.`))}</p>` : '';
  return head + generated
    + renderStudioAdminScanRow()
    + renderStudioAdminJobs(report.jobs)
    + renderStudioAdminQueues(operations)
    + renderStudioAdminCapacity(operations)
    + renderStudioAdminMoney(operations)
    + renderStudioAdminGoNoGo(operations)
    + `<section class="studio-desk-box" data-testid="studio-admin-system"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Meta and storage', 'ميتا والتخزين'))}</h3>
        ${renderStudioAdminLine(adsStudioText('Meta token', 'رمز ميتا'), tokenLine, token.checked ? studioAdminOkTone(token.isValid === true) : 'slate', 'studio-admin-token')}
        ${renderStudioAdminLine(adsStudioText('Meta connection', 'اتصال ميتا'), meta.connection && meta.connection.state ? String(meta.connection.state).slice(0, 20) : adsStudioText('unknown', 'غير معروف'), meta.connection && meta.connection.state === 'down' ? 'red' : 'slate')}
        ${renderStudioAdminLine(adsStudioText('Database size', 'حجم قاعدة البيانات'), storage.databaseBytes === null || storage.databaseBytes === undefined ? '—' : studioAdminBytes(storage.databaseBytes))}
        ${renderStudioAdminLine(adsStudioText('Rows (all types)', 'الصفوف (كل الأنواع)'), studioAdminNumber(storage.totalRows))}
        ${renderStudioAdminLine(adsStudioText('Last backup', 'آخر نسخة احتياطية'), storage.backup && storage.backup.at ? `${studioAdminAgo(storage.backup.at)} (${studioAdminBytes(storage.backup.bytes)})` : adsStudioText('none recorded', 'لا شيء مسجل'))}
      </section>`
    + `<section class="studio-desk-box" data-testid="studio-admin-baselines"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Baselines B1–B6 (before the pilot)', 'خطوط الأساس B1–B6 (قبل التجربة)'))}</h3>${baselineLines.join('')}</section>`;
}

// ------------------------------------------------------------------ the on-demand money scan (P3-24)

// "Scan money now": POST /api/studio/admin/integrity/scan (admin, one per 10 minutes on the server),
// single flight; the answer's counts are shown and the diagnostics and alerts reads are asked again.
// A 429 shows the wait through the ONE error map (Retry-After); nothing else changes.
function studioAdminScanNow(button = null) {
  if (!studioAdminIsAdmin() || !studioAdminServer() || (_studioAdmin.scan && _studioAdmin.scan.promise)) return null;
  const slot = _studioAdmin.scan || (_studioAdmin.scan = { promise: null, value: null, error: null, at: 0 });
  if (button) setAdsStudioActionButtonBusy(button, true);
  const generation = _studioAdmin.generation;
  slot.promise = studioApi('/api/studio/admin/integrity/scan', { method: 'POST', body: {} }, { timeoutMs: 45000 }).then(reply => {
    if (generation !== _studioAdmin.generation) return null;
    const counts = reply && reply.counts && typeof reply.counts === 'object' ? reply.counts : {};
    slot.value = { total: Number.isSafeInteger(counts.total) && counts.total >= 0 ? counts.total : 0, scannedAt: String((reply && reply.scannedAt) || ''), alertId: String((reply && reply.alertId) || '') };
    slot.error = null;
    slot.at = Date.now();
    if (_studioAdmin.reads.diagnostics) studioAdminRead('diagnostics', '/api/studio/admin/diagnostics', true);
    if (_studioAdmin.reads.alerts) { _studioAdmin.alertsPages = []; studioAdminRead('alerts', '/api/studio/admin/alerts?limit=20', true); }
    if (typeof studioDeskPulseRefresh === 'function') studioDeskPulseRefresh();
    return slot.value;
  }, error => {
    if (generation !== _studioAdmin.generation) return null;
    slot.error = error && typeof error === 'object' ? error : new Error(String(error || 'Request failed'));  // its words are picked at draw time (the reader may switch language)
    slot.value = null;
    return null;
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    slot.promise = null;
    if (button) setAdsStudioActionButtonBusy(button, false);
    studioAdminRedraw();
  });
  studioAdminRedraw();
  return slot.promise;
}

function renderStudioAdminScanRow() {
  const slot = _studioAdmin.scan;
  let note = '';
  let tone = '';
  if (slot && slot.value) {
    const total = slot.value.total;
    tone = total ? 'red' : 'green';
    note = total
      ? adsStudioText(`Scan done: ${total} finding${total === 1 ? '' : 's'}. The alert is in the alerts list.`, `اكتمل الفحص: ${studioAdminArCount(total, 'مخالفة واحدة', 'مخالفتان', 'مخالفات', 'مخالفة')}. التنبيه في قائمة التنبيهات.`)
      : adsStudioText('Scan done: the money adds up, no finding.', 'اكتمل الفحص: الأموال متطابقة، لا مخالفات.');
  } else if (slot && slot.error) {
    tone = 'red';
    try { note = studioErrorInfo(slot.error, 'action').text || ''; } catch (_) { note = adsStudioText('The scan could not be run.', 'تعذّر تشغيل الفحص.'); }
  }
  return `
          <div class="studio-v2-list studio-admin-scan" data-testid="studio-admin-scan">
            <button type="button" class="studio-v2-row" data-testid="studio-admin-scan-now" onclick="studioAdminScanNow(this)"${slot && slot.promise ? ' disabled aria-busy="true"' : ''}>
              ${studioAdminIcon('scan-search')}
              <span class="studio-admin-row-text"><span class="studio-v2-row-label">${studioEsc(slot && slot.promise ? adsStudioText('Scanning…', 'جارٍ الفحص…') : adsStudioText('Scan money now', 'افحص الأموال الآن'))}</span><span class="studio-desk-note">${studioEsc(adsStudioText('The daily money check on demand: once every 10 minutes. Counts only.', 'فحص الأموال اليومي عند الطلب: مرة كل 10 دقائق. أرقام فقط.'))}</span></span>
            </button>
            ${note ? `<p class="studio-desk-line" data-tone="${studioEsc(tone)}" data-testid="studio-admin-scan-note" data-total="${slot && slot.value ? slot.value.total : ''}"><span class="studio-desk-line-label">${studioEsc(note)}</span></p>` : ''}
          </div>`;
}

function studioAdminArCount(count, one, two, few, many) {
  if (typeof studioDeskArCount === 'function') return studioDeskArCount(count, one, two, few, many);
  return count === 1 ? one : count === 2 ? two : `${count} ${count >= 3 && count <= 10 ? few : many}`;
}

// ------------------------------------------------------------------ the collision report (P0-10)

function studioAdminCollisionWhy(row) {
  if (row.kept) return adsStudioText("kept by the owner's signed choice", 'أُبقي بقرار المالك الموقّع');
  if (row.hasMoney) return adsStudioText('has money records (receipts, collections, wallet or funding): never removed by the script', 'له سجلات أموال (إيصالات أو تحصيلات أو محفظة أو تمويل): لا يحذفه السكربت أبداً');
  if (row.hasCustomer) return adsStudioText('has a customer: the owner decides', 'له عميل: يقرر المالك');
  if (row.removable && row.untouched) return adsStudioText('an untouched imported copy: removable', 'نسخة مستوردة لم تُمس: قابلة للحذف');
  return adsStudioText('removable after the owner\'s choice', 'قابل للحذف بعد قرار المالك');
}

function renderStudioAdminCollisions() {
  const slot = studioAdminRead('collisions', '/api/meta-ads/collisions');
  const refresh = `<button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-collisions-refresh" onclick="studioAdminRetry('collisions', '/api/meta-ads/collisions')"${slot.promise ? ' disabled' : ''}>${studioAdminIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Refresh', 'تحديث'))}</span></button>`;
  const head = renderStudioAdminPageHead('collisions', refresh);
  const problem = renderStudioAdminProblem(slot, "studioAdminRetry('collisions', '/api/meta-ads/collisions')", 'studio-admin-collisions');
  if (problem) return head + problem;
  const report = slot.value || {};
  const counts = report.counts && typeof report.counts === 'object' ? report.counts : {};
  const rows = Array.isArray(report.rows) ? report.rows.filter(row => row && typeof row === 'object') : [];
  const byReason = counts.byReason && typeof counts.byReason === 'object' ? counts.byReason : {};
  const summary = `<section class="studio-desk-box" data-testid="studio-admin-collision-counts" data-total="${Number(counts.total) || 0}"><h3 class="studio-desk-h3">${studioEsc(adsStudioText('Counts', 'الأعداد'))}</h3>
    ${renderStudioAdminLine(adsStudioText('Core ads that belong to the studio', 'إعلانات المدير التابعة للاستوديو'), studioAdminNumber(counts.total), Number(counts.total) > 0 ? 'amber' : 'green')}
    ${renderStudioAdminLine(adsStudioText('Open (no owner decision yet)', 'مفتوحة (دون قرار من المالك بعد)'), studioAdminNumber(counts.open))}
    ${renderStudioAdminLine(adsStudioText('Kept by decision', 'أُبقيت بقرار'), studioAdminNumber(counts.kept))}
    ${renderStudioAdminLine(adsStudioText('Removable (untouched copies)', 'قابلة للحذف (نسخ لم تُمس)'), studioAdminNumber(counts.removable))}
    ${renderStudioAdminLine(adsStudioText('With money records', 'لها سجلات أموال'), studioAdminNumber(counts.withMoney))}
    ${renderStudioAdminLine(adsStudioText('With a customer', 'لها عميل'), studioAdminNumber(counts.withCustomer))}
    ${renderStudioAdminLine(adsStudioText('By reason: studio code in the name / linked campaign', 'بحسب السبب: رمز الاستوديو في الاسم / حملة مربوطة'), `${studioAdminNumber(byReason.studio_name)} / ${studioAdminNumber(byReason.studio_campaign_id)}`)}
    <p class="studio-desk-note">${studioEsc(adsStudioText('Nothing is changed from here. The owner runs scripts/studio_collision_repair.py with a signed choices file (dry run first); rows with money are never removed.', 'لا يتغير شيء من هنا. يشغّل المالك scripts/studio_collision_repair.py بملف قرارات موقّع (تجربة أولاً)؛ الصفوف التي لها أموال لا تُحذف أبداً.'))}</p>
  </section>`;
  const list = rows.length ? `<ul class="studio-desk-list" data-testid="studio-admin-collision-rows">${rows.slice(0, 200).map(row => {
    const reasons = (Array.isArray(row.reasons) ? row.reasons : []).map(code => STUDIO_ADMIN_COLLISION_REASONS[code] ? adsStudioText(STUDIO_ADMIN_COLLISION_REASONS[code][0], STUDIO_ADMIN_COLLISION_REASONS[code][1]) : String(code).slice(0, 40)).join(' · ');
    const spend = row.spend && typeof row.spend === 'object' ? row.spend : {};
    const requests = Array.isArray(row.studioRequestIds) ? row.studioRequestIds.map(String).slice(0, 5).join(', ') : '';
    return `<li class="studio-desk-box studio-admin-collision" data-testid="studio-admin-collision" data-kept="${row.kept ? '1' : '0'}" data-removable="${row.removable && !row.kept ? '1' : '0'}">
      <p class="studio-admin-alert-title">${studioAdminIcon(row.kept ? 'lock' : row.hasMoney ? 'shield-alert' : 'trash-2', 'studio-desk-meta-icon')}<span>${studioEsc(adsStudioText('Manager ad', 'إعلان المدير'))} <code class="studio-desk-code" dir="ltr">${studioEsc(String(row.adId || '').slice(0, 80))}</code></span></p>
      <p class="studio-desk-note">${studioEsc(reasons)}${requests ? ` · ${studioEsc(adsStudioText('studio request', 'طلب الاستوديو'))} <code class="studio-desk-code" dir="ltr">${studioEsc(requests)}</code>` : ''}</p>
      <p class="studio-desk-note">${studioEsc(studioAdminCollisionWhy(row))}${row.importState ? ` · ${studioEsc(String(row.importState).slice(0, 30))}` : ''}${Number(spend.metaSpendMinor) > 0 ? ` · ${studioEsc(adsStudioText('Meta spend', 'صرف ميتا'))} ${studioEsc(`${studioMinorText(spend.metaSpendMinor)} ${String(spend.metaCurrency || 'USD').slice(0, 3)}`)}` : ''}</p>
    </li>`;
  }).join('')}</ul>` : renderStudioDeskEmpty('check', adsStudioText('No collision: the core books hold no studio ad', 'لا تعارض: دفاتر المدير لا تحوي إعلان استوديو'), '', 'studio-admin-collisions-empty');
  return head + summary + list;
}

// ------------------------------------------------------------------ settings forms

function studioAdminSetting(key) {
  studioAdminScope();
  let slot = _studioAdmin.settings[key];
  if (!slot) {
    slot = { record: null, version: 0, raw: null, loading: null, error: '', serverMessage: '', conflict: '', saving: false, savedAt: 0, failedAt: 0, readError: null };
    _studioAdmin.settings[key] = slot;
  }
  return slot;
}

function studioAdminGet(value, path) {
  return String(path || '').split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), value);
}

// The typed value of one field as the text an input holds.
function studioAdminRawOf(kind, value) {
  if (kind === 'flag') return value === true ? '1' : '';
  if (kind === 'money') return Number.isSafeInteger(value) ? (value / 100).toFixed(2) : '';
  if (kind === 'ids') return Array.isArray(value) ? value.map(String).join('\n') : '';
  if (kind === 'days') return Array.isArray(value) ? value.map(String).join(', ') : '';
  return value === null || value === undefined ? '' : String(value);
}

function studioAdminRawFrom(key, value) {
  const raw = Object.create(null);
  const spec = STUDIO_ADMIN_SETTINGS[key];
  if (key === 'hours') {
    const week = value && value.week && typeof value.week === 'object' ? value.week : {};
    for (const [day] of STUDIO_ADMIN_WEEK) {
      const hours = week[day] && typeof week[day] === 'object' ? week[day] : null;
      raw[`week.${day}.on`] = hours ? '1' : '';
      raw[`week.${day}.open`] = hours ? String(hours.open || '09:00') : '09:00';
      raw[`week.${day}.close`] = hours ? String(hours.close || '17:00') : '17:00';
    }
    raw.holidays = (Array.isArray(value && value.holidays) ? value.holidays : []).filter(item => item && typeof item === 'object')
      .map(item => ({ date: String(item.date || ''), labelEn: String(item.labelEn || ''), labelAr: String(item.labelAr || '') }));
    const ramadan = value && value.ramadan && typeof value.ramadan === 'object' ? value.ramadan : null;
    raw['ramadan.on'] = ramadan ? '1' : '';
    raw['ramadan.from'] = ramadan ? String(ramadan.from || '') : '';
    raw['ramadan.to'] = ramadan ? String(ramadan.to || '') : '';
    raw['ramadan.open'] = ramadan ? String(ramadan.open || '09:00') : '09:00';
    raw['ramadan.close'] = ramadan ? String(ramadan.close || '15:00') : '15:00';
    raw.onDutyUntil = value && value.onDutyUntil ? String(value.onDutyUntil) : '';
    return raw;
  }
  for (const [path, kind] of spec.fields) raw[path] = studioAdminRawOf(kind, studioAdminGet(value, path));
  return raw;
}

function studioAdminLoadSetting(key, force = false) {
  const slot = studioAdminSetting(key);
  if (!studioAdminServer() || slot.loading) return slot;
  if (!force && slot.record) return slot;
  if (!force && slot.failedAt && Date.now() - slot.failedAt < STUDIO_ADMIN_RETRY_MS) return slot;
  const generation = _studioAdmin.generation;
  const signal = studioReadSignal();
  slot.loading = studioApi(`/api/studio/admin/settings/${encodeURIComponent(key)}`, { method: 'GET' }).then(raw => {
    if (generation !== _studioAdmin.generation) return;
    const record = raw && typeof raw === 'object' ? raw : {};
    slot.record = record;
    slot.version = Number.isSafeInteger(record.version) ? record.version : 0;
    slot.raw = studioAdminRawFrom(key, record.value && typeof record.value === 'object' ? record.value : {});
    slot.readError = null;
    slot.failedAt = 0;
    slot.conflict = '';
    slot.error = '';
    slot.serverMessage = '';
  }, error => {
    if (generation !== _studioAdmin.generation || studioReadCancelled(error, signal)) return;
    slot.failedAt = Date.now();
    slot.readError = (error && error.studio) || studioErrorInfo(error, 'read');
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    slot.loading = null;
    studioAdminRedraw();
  });
  return slot;
}

function studioAdminReload(key) {
  studioAdminLoadSetting(String(key || ''), true);
  studioAdminRedraw();
}

function studioAdminInput(key, path, input) {
  const slot = studioAdminSetting(key);
  if (!slot.raw) return;
  const field = input && input.type === 'checkbox' ? (input.checked ? '1' : '') : String((input && input.value) || '');
  slot.raw[String(path)] = field.slice(0, 20000);
  if (slot.savedAt) slot.savedAt = 0;
}

function studioAdminHolidayInput(key, index, field, input) {
  const slot = studioAdminSetting(key);
  const list = slot.raw && Array.isArray(slot.raw.holidays) ? slot.raw.holidays : null;
  if (!list || !list[index] || !['date', 'labelEn', 'labelAr'].includes(field)) return;
  list[index][field] = String((input && input.value) || '').slice(0, 60);
}

function studioAdminHolidayAdd(key) {
  const slot = studioAdminSetting(key);
  if (!slot.raw) return;
  if (!Array.isArray(slot.raw.holidays)) slot.raw.holidays = [];
  if (slot.raw.holidays.length >= 60) return;
  slot.raw.holidays.push({ date: '', labelEn: '', labelAr: '' });
  studioAdminRedraw();
}

function studioAdminHolidayRemove(key, index) {
  const slot = studioAdminSetting(key);
  if (!slot.raw || !Array.isArray(slot.raw.holidays)) return;
  slot.raw.holidays.splice(Number(index), 1);
  studioAdminRedraw();
}

// The typed value of one field from its text, or {error} in the reader's language.
function studioAdminValueOf(kind, raw, label, range) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (kind === 'flag') return { value: text === '1' };
  if (kind === 'readonly') return { skip: true };
  if (kind === 'mode' || kind === 'select') return { value: text };
  if (kind === 'whole') {
    const number = Number(normalizeDigitsAscii(text));
    if (!text || !Number.isSafeInteger(number)) return { error: adsStudioText(`${label}: enter a whole number.`, `${label}: أدخل عدداً صحيحاً.`) };
    if (Array.isArray(range) && (number < range[0] || number > range[1])) return { error: adsStudioText(`${label}: must be from ${range[0]} to ${range[1]}.`, `${label}: يجب أن يكون من ${range[0]} إلى ${range[1]}.`) };
    return { value: number };
  }
  if (kind === 'money') {
    const minor = studioParseAmount(text);
    if (!Number.isSafeInteger(minor)) return { error: adsStudioText(`${label}: enter an amount in dollars, for example 5 or 12.50.`, `${label}: أدخل مبلغاً بالدولار، مثل 5 أو 12.50.`) };
    return { value: minor };
  }
  if (kind === 'ids') {
    const ids = text.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean);
    const bad = ids.find(id => !Security.isValidRecordId(id));
    if (bad) return { error: adsStudioText(`${label}: "${bad.slice(0, 30)}" is not a user id.`, `${label}: «${bad.slice(0, 30)}» ليس معرّف مستخدم.`) };
    return { value: Array.from(new Set(ids)).slice(0, 200) };
  }
  if (kind === 'days') {
    const numbers = text.split(/[\s,،;]+/).filter(Boolean).map(item => Number(normalizeDigitsAscii(item)));
    if (!numbers.length || numbers.length > 5 || numbers.some(number => !Number.isSafeInteger(number) || number < 1 || number > 60)) return { error: adsStudioText(`${label}: 1 to 5 whole numbers from 1 to 60.`, `${label}: من رقم إلى 5 أرقام صحيحة من 1 إلى 60.`) };
    return { value: numbers };
  }
  if (kind === 'phone') {
    if (!text) return { value: null };
    const phone = studioParsePhone(text);
    if (!phone) return { error: adsStudioText(`${label}: not a phone number we can use (international form, e.g. +218912345678).`, `${label}: ليس رقماً صالحاً (بالصيغة الدولية، مثل +218912345678).`) };
    return { value: phone };
  }
  if (kind === 'email') {
    if (!text) return { value: null };
    if (text.length > 254 || !/^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/.test(text)) return { error: adsStudioText(`${label}: not an email address.`, `${label}: ليس عنوان بريد.`) };
    return { value: text };
  }
  return { value: text };
}

function studioAdminBuildValue(key, slot) {
  const raw = slot.raw || {};
  if (key === 'hours') {
    const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const week = {};
    for (const [name, en, ar] of STUDIO_ADMIN_WEEK) {
      if (raw[`week.${name}.on`] !== '1') { week[name] = null; continue; }
      const open = String(raw[`week.${name}.open`] || '');
      const close = String(raw[`week.${name}.close`] || '');
      if (!clock.test(open) || !clock.test(close) || open >= close) return { error: adsStudioText(`${en}: opening and closing times as HH:MM, closing later than opening.`, `${ar}: وقت الفتح والإغلاق بصيغة HH:MM، والإغلاق بعد الفتح.`) };
      week[name] = { open, close };
    }
    if (!Object.values(week).some(Boolean)) return { error: adsStudioText('Keep at least one working day.', 'أبقِ يوم عمل واحداً على الأقل.') };
    const holidays = [];
    for (const item of Array.isArray(raw.holidays) ? raw.holidays : []) {
      if (!day.test(item.date)) return { error: adsStudioText('Every holiday needs a date (YYYY-MM-DD).', 'كل عطلة تحتاج تاريخاً (YYYY-MM-DD).') };
      if (!item.labelEn.trim() || !item.labelAr.trim()) return { error: adsStudioText(`Holiday ${item.date}: give it a name in English and in Arabic.`, `العطلة ${item.date}: أعطها اسماً بالإنجليزية وبالعربية.`) };
      holidays.push({ date: item.date, labelEn: item.labelEn.trim().slice(0, 60), labelAr: item.labelAr.trim().slice(0, 60) });
    }
    let ramadan = null;
    if (raw['ramadan.on'] === '1') {
      const from = String(raw['ramadan.from'] || '');
      const to = String(raw['ramadan.to'] || '');
      const open = String(raw['ramadan.open'] || '');
      const close = String(raw['ramadan.close'] || '');
      if (!day.test(from) || !day.test(to) || !clock.test(open) || !clock.test(close) || open >= close) return { error: adsStudioText('Ramadan: first and last day (YYYY-MM-DD) and the hours (HH:MM).', 'رمضان: أول يوم وآخره (YYYY-MM-DD) والساعات (HH:MM).') };
      ramadan = { from, to, open, close };
    }
    const onDuty = String(raw.onDutyUntil || '').trim();
    if (onDuty && !clock.test(onDuty)) return { error: adsStudioText('On duty until: a time as HH:MM, or empty.', 'المناوبة حتى: وقت بصيغة HH:MM، أو فارغ.') };
    return { value: { week, holidays, ramadan, onDutyUntil: onDuty || null } };
  }
  const value = {};
  for (const [path, kind, [en, ar], , options] of STUDIO_ADMIN_SETTINGS[key].fields) {
    const out = studioAdminValueOf(kind, raw[path], adsStudioText(en, ar), Array.isArray(options) && typeof options[0] === 'number' ? options : null);
    if (out.error) return { error: out.error };
    if (out.skip) continue;
    const parts = path.split('.');
    let node = value;
    for (const part of parts.slice(0, -1)) node = node[part] = node[part] && typeof node[part] === 'object' ? node[part] : {};
    node[parts[parts.length - 1]] = out.value;
  }
  return { value };
}

function studioAdminSave(key) {
  const name = String(key || '');
  if (!STUDIO_ADMIN_SETTING_KEYS.includes(name)) return Promise.resolve(false);
  const slot = studioAdminSetting(name);
  if (slot.saving || !slot.raw) return Promise.resolve(false);
  const built = studioAdminBuildValue(name, slot);
  if (built.error) {
    slot.error = built.error;
    slot.serverMessage = '';
    studioAdminRedraw();
    return Promise.resolve(false);
  }
  if (!studioAdminServer()) {
    slot.error = adsStudioText('Saving needs the connection to Albayan.', 'الحفظ يحتاج الاتصال بالبيان.');
    studioAdminRedraw();
    return Promise.resolve(false);
  }
  slot.saving = true;
  slot.error = '';
  slot.serverMessage = '';
  slot.conflict = '';
  studioAdminRedraw();
  const generation = _studioAdmin.generation;
  return studioApi(`/api/studio/admin/settings/${encodeURIComponent(name)}`, { method: 'PUT', body: { expectedVersion: slot.version, value: built.value } }).then(saved => {
    if (generation !== _studioAdmin.generation) return false;
    const record = saved && typeof saved === 'object' ? saved : {};
    slot.record = record;
    slot.version = Number.isSafeInteger(record.version) ? record.version : slot.version + 1;
    slot.raw = studioAdminRawFrom(name, record.value && typeof record.value === 'object' ? record.value : built.value);
    slot.savedAt = Date.now();
    if (name === 'rollout' || name === 'contact' || name === 'hours' || name === 'limits' || name === 'intake') { try { studioLoadMe(0); } catch (_) {} }
    return true;
  }, error => {
    if (generation !== _studioAdmin.generation) return false;
    const info = (error && error.studio) || studioErrorInfo(error, 'action');
    if (info.code === 'VERSION_CONFLICT' || info.code === 'STAFF_DESK_IN_USE') {
      slot.conflict = info.code;
      slot.error = info.text;
    } else if (['INVALID_VALUE', 'UNKNOWN_FIELD', 'INVALID_REQUEST'].includes(info.code)) {
      slot.error = adsStudioText('The server refused this value:', 'رفض الخادم هذه القيمة:');
      slot.serverMessage = String(info.message || '').slice(0, 300);
    } else {
      slot.error = info.text;
    }
    return false;
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    slot.saving = false;
    studioAdminRedraw();
  });
}

function renderStudioAdminField(key, [path, kind, [en, ar], [hintEn, hintAr], options], raw) {
  const id = `studio-admin-${key}-${path.replace(/\./g, '-')}`;
  const value = raw[path] === undefined ? '' : String(raw[path]);
  const label = adsStudioText(en, ar);
  const hint = `<span class="studio-desk-note">${studioEsc(adsStudioText(hintEn, hintAr))}</span>`;
  const on = `oninput="studioAdminInput('${key}', '${studioEsc(path)}', this)"`;
  let control;
  if (kind === 'flag') {
    control = `<label class="studio-admin-flag" for="${id}"><input id="${id}" type="checkbox" data-testid="${id}" ${value === '1' ? 'checked ' : ''}onchange="studioAdminInput('${key}', '${studioEsc(path)}', this)" /><span>${studioEsc(label)}</span></label>${hint}`;
    return `<div class="studio-admin-field" data-field="${studioEsc(path)}">${control}</div>`;
  }
  if (kind === 'mode' || kind === 'select') {
    const choices = (Array.isArray(options) ? options : []).map(option => `<option value="${studioEsc(option)}"${option === value ? ' selected' : ''}>${studioEsc(option)}</option>`).join('');
    control = `<select id="${id}" class="studio-desk-input" data-testid="${id}" onchange="studioAdminInput('${key}', '${studioEsc(path)}', this)" dir="ltr">${choices}</select>`;
  } else if (kind === 'ids') {
    control = `<textarea id="${id}" class="studio-desk-input" rows="3" data-testid="${id}" dir="ltr" ${on}>${studioEsc(value)}</textarea>`;
  } else if (kind === 'readonly') {
    control = `<p class="studio-desk-line-value" data-testid="${id}" dir="ltr">${studioEsc(value || '—')}</p>`;
  } else {
    const mode = kind === 'whole' ? 'numeric' : kind === 'money' ? 'decimal' : kind === 'phone' ? 'tel' : kind === 'email' ? 'email' : 'text';
    control = `<input id="${id}" class="studio-desk-input" type="text" inputmode="${mode}" autocomplete="off" dir="ltr" maxlength="${kind === 'days' ? 40 : 254}" value="${studioEsc(value)}" data-testid="${id}" ${on} />`;
  }
  return `<div class="studio-admin-field" data-field="${studioEsc(path)}"><label class="studio-desk-label" for="${id}">${studioEsc(label)}</label>${control}${hint}</div>`;
}

function renderStudioAdminHoursForm(key, raw) {
  const clockInput = (path, testId) => `<input id="studio-admin-hours-${path.replace(/\./g, '-')}" class="studio-desk-input studio-admin-clock" type="time" data-testid="${testId}" value="${studioEsc(String(raw[path] || ''))}" oninput="studioAdminInput('${key}', '${path}', this)" dir="ltr" />`;
  const week = STUDIO_ADMIN_WEEK.map(([day, en, ar]) => {
    const on = raw[`week.${day}.on`] === '1';
    return `<div class="studio-admin-day" data-day="${day}" data-open="${on ? '1' : '0'}">
      <label class="studio-admin-flag" for="studio-admin-hours-week-${day}-on"><input id="studio-admin-hours-week-${day}-on" type="checkbox" data-testid="studio-admin-hours-${day}" ${on ? 'checked ' : ''}onchange="studioAdminInput('${key}', 'week.${day}.on', this); studioAdminRedraw();" /><span>${studioEsc(adsStudioText(en, ar))}</span></label>
      ${on ? `<div class="studio-admin-times">${clockInput(`week.${day}.open`, `studio-admin-hours-${day}-open`)}<span>–</span>${clockInput(`week.${day}.close`, `studio-admin-hours-${day}-close`)}</div>` : `<span class="studio-desk-note">${studioEsc(adsStudioText('closed', 'مغلق'))}</span>`}
    </div>`;
  }).join('');
  const holidays = (Array.isArray(raw.holidays) ? raw.holidays : []).map((item, index) => `<div class="studio-admin-holiday" data-testid="studio-admin-holiday">
      <input id="studio-admin-holiday-${index}-date" class="studio-desk-input" type="date" value="${studioEsc(item.date)}" dir="ltr" aria-label="${studioEsc(adsStudioText('Date', 'التاريخ'))}" oninput="studioAdminHolidayInput('${key}', ${index}, 'date', this)" />
      <input id="studio-admin-holiday-${index}-en" class="studio-desk-input" type="text" maxlength="60" value="${studioEsc(item.labelEn)}" placeholder="${studioEsc(adsStudioText('Name (English)', 'الاسم (بالإنجليزية)'))}" oninput="studioAdminHolidayInput('${key}', ${index}, 'labelEn', this)" />
      <input id="studio-admin-holiday-${index}-ar" class="studio-desk-input" type="text" maxlength="60" value="${studioEsc(item.labelAr)}" placeholder="${studioEsc(adsStudioText('Name (Arabic)', 'الاسم (بالعربية)'))}" dir="rtl" oninput="studioAdminHolidayInput('${key}', ${index}, 'labelAr', this)" />
      <button type="button" class="studio-v2-action studio-desk-small" aria-label="${studioEsc(adsStudioText('Remove this holiday', 'احذف هذه العطلة'))}" onclick="studioAdminHolidayRemove('${key}', ${index})">${studioAdminIcon('trash-2')}</button>
    </div>`).join('');
  const ramadanOn = raw['ramadan.on'] === '1';
  return `
        <h3 class="studio-desk-h3">${studioEsc(adsStudioText('The week (Tripoli time)', 'الأسبوع (بتوقيت طرابلس)'))}</h3>
        <div class="studio-admin-week" data-testid="studio-admin-week">${week}</div>
        <h3 class="studio-desk-h3">${studioEsc(adsStudioText('Holidays (closed all day)', 'العطل (مغلق طوال اليوم)'))}</h3>
        <div class="studio-admin-holidays" data-testid="studio-admin-holidays">${holidays || `<p class="studio-desk-note">${studioEsc(adsStudioText('No holiday yet.', 'لا عطلة بعد.'))}</p>`}</div>
        <button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-holiday-add" onclick="studioAdminHolidayAdd('${key}')">${studioAdminIcon('plus')}<span>${studioEsc(adsStudioText('Add a holiday', 'أضف عطلة'))}</span></button>
        <h3 class="studio-desk-h3">${studioEsc(adsStudioText('Ramadan hours', 'ساعات رمضان'))}</h3>
        <label class="studio-admin-flag" for="studio-admin-hours-ramadan-on"><input id="studio-admin-hours-ramadan-on" type="checkbox" data-testid="studio-admin-ramadan" ${ramadanOn ? 'checked ' : ''}onchange="studioAdminInput('${key}', 'ramadan.on', this); studioAdminRedraw();" /><span>${studioEsc(adsStudioText('Different hours during Ramadan', 'ساعات مختلفة في رمضان'))}</span></label>
        ${ramadanOn ? `<div class="studio-admin-times studio-admin-ramadan">
          <input id="studio-admin-hours-ramadan-from" class="studio-desk-input" type="date" value="${studioEsc(String(raw['ramadan.from'] || ''))}" dir="ltr" aria-label="${studioEsc(adsStudioText('First day', 'أول يوم'))}" oninput="studioAdminInput('${key}', 'ramadan.from', this)" />
          <input id="studio-admin-hours-ramadan-to" class="studio-desk-input" type="date" value="${studioEsc(String(raw['ramadan.to'] || ''))}" dir="ltr" aria-label="${studioEsc(adsStudioText('Last day', 'آخر يوم'))}" oninput="studioAdminInput('${key}', 'ramadan.to', this)" />
          ${clockInput('ramadan.open', 'studio-admin-ramadan-open')}<span>–</span>${clockInput('ramadan.close', 'studio-admin-ramadan-close')}
        </div>` : ''}
        <span class="studio-desk-note">${studioEsc(adsStudioText('At most 31 days; the hours replace the week\'s on those days.', '31 يوماً كحد أقصى؛ تحل الساعات محل ساعات الأسبوع في تلك الأيام.'))}</span>
        <div class="studio-admin-field"><label class="studio-desk-label" for="studio-admin-hours-onDutyUntil">${studioEsc(adsStudioText('On duty until (urgent WhatsApp line)', 'المناوبة حتى (خط واتساب العاجل)'))}</label>
          <input id="studio-admin-hours-onDutyUntil" class="studio-desk-input studio-admin-clock" type="time" data-testid="studio-admin-hours-onduty" value="${studioEsc(String(raw.onDutyUntil || ''))}" dir="ltr" oninput="studioAdminInput('${key}', 'onDutyUntil', this)" />
          <span class="studio-desk-note">${studioEsc(adsStudioText('Empty = no urgent line after hours. D29 suggests 23:00.', 'فارغ = لا خط عاجل بعد الدوام. توصية D29: 23:00.'))}</span></div>`;
}

function renderStudioAdminSetting(key) {
  const name = String(key || '');
  if (!STUDIO_ADMIN_SETTING_KEYS.includes(name)) return renderStudioAdminMenu();
  const slot = studioAdminLoadSetting(name);
  const spec = STUDIO_ADMIN_SETTINGS[name];
  const page = `settings-${name}`;
  const head = renderStudioAdminPageHead(page);
  const about = `<p class="studio-desk-note studio-admin-about" data-testid="studio-admin-about">${studioEsc(adsStudioText(spec.about[0], spec.about[1]))}</p>`;
  if (!slot.raw) {
    if (slot.readError && !slot.loading) {
      return head + about + `<div class="studio-desk-problem" role="alert" data-testid="studio-admin-setting-problem"><p>${studioEsc(slot.readError.text || '')}</p><button type="button" class="studio-v2-action studio-desk-small" onclick="studioAdminReload('${name}')">${studioEsc(adsStudioText('Try again', 'أعد المحاولة'))}</button></div>`;
    }
    return head + about + `<p class="studio-desk-note" data-testid="studio-admin-setting-loading">${studioEsc(adsStudioText('Reading the setting…', 'نقرأ الإعداد…'))}</p>`;
  }
  const raw = slot.raw;
  const fields = name === 'hours' ? renderStudioAdminHoursForm(name, raw) : spec.fields.map(field => renderStudioAdminField(name, field, raw)).join('');
  const env = name === 'rollout' && slot.record && slot.record.envSwitch
    ? `<p class="studio-desk-note" data-testid="studio-admin-env">${studioEsc(adsStudioText(`Server switch ALBAYAN_STUDIO_V2 = ${String(slot.record.envSwitch).slice(0, 10)}: "off" hides the new layout whatever is saved here.`, `مفتاح الخادم ALBAYAN_STUDIO_V2 = ${String(slot.record.envSwitch).slice(0, 10)}: «off» يخفي الواجهة الجديدة مهما حُفظ هنا.`))}</p>`
    : '';
  const conflict = slot.conflict
    ? `<div class="studio-desk-problem" role="alert" data-testid="studio-admin-conflict" data-code="${studioEsc(slot.conflict)}"><p>${studioEsc(slot.error)}</p><button type="button" class="studio-v2-action studio-desk-small" data-testid="studio-admin-reload" onclick="studioAdminReload('${name}')">${studioAdminIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Reload the setting (your edits are dropped)', 'أعد تحميل الإعداد (تُلغى تعديلاتك)'))}</span></button></div>`
    : slot.error
      ? `<div class="studio-desk-problem" role="alert" data-testid="studio-admin-error"><p>${studioEsc(slot.error)}</p>${slot.serverMessage ? `<p class="studio-desk-code" dir="ltr" data-testid="studio-admin-server-message">${studioEsc(slot.serverMessage)}</p>` : ''}</div>`
      : '';
  const saved = slot.savedAt && !slot.error ? `<p class="studio-desk-line" data-tone="green" data-testid="studio-admin-saved" data-version="${slot.version}"><span class="studio-desk-line-label">${studioEsc(adsStudioText(`Saved as version ${slot.version}.`, `حُفظ كنسخة ${slot.version}.`))}</span></p>` : '';
  const updated = slot.record && slot.record.updatedAt ? adsStudioText(`Version ${slot.version}, saved ${studioAdminWhen(slot.record.updatedAt)}.`, `النسخة ${slot.version}، حُفظت ${studioAdminWhen(slot.record.updatedAt)}.`) : adsStudioText('Never saved: the defaults are shown.', 'لم يُحفظ قط: تظهر القيم الافتراضية.');
  return head + about + env + `
          <form class="studio-desk-box studio-admin-form" data-testid="studio-admin-form-${name}" data-version="${slot.version}" onsubmit="event.preventDefault(); studioAdminSave('${name}');">
            <p class="studio-desk-note" data-testid="studio-admin-version">${studioEsc(updated)}</p>
            ${fields}
            ${conflict}
            ${saved}
            <div class="studio-desk-actions">
              <button type="submit" class="studio-v2-action is-primary" data-testid="studio-admin-save"${slot.saving || slot.conflict ? ' disabled aria-busy="true"' : ''}>${studioAdminIcon('save')}<span>${studioEsc(slot.saving ? adsStudioText('Saving…', 'جارٍ الحفظ…') : adsStudioText('Save', 'حفظ'))}</span></button>
              <button type="button" class="studio-v2-action" data-testid="studio-admin-discard" onclick="studioAdminReload('${name}')"${slot.saving ? ' disabled' : ''}>${studioEsc(adsStudioText('Discard changes', 'تجاهل التعديلات'))}</button>
            </div>
          </form>`;
}

// ------------------------------------------------------------------ the alert channel test (P3-21)

function studioAdminAlertTest(button = null) {
  if (!studioAdminIsAdmin() || _studioAdmin.reads.alertTest && _studioAdmin.reads.alertTest.promise) return null;
  const slot = _studioAdmin.reads.alertTest || (_studioAdmin.reads.alertTest = { value: null, loadedAt: 0, failedAt: 0, error: null, promise: null });
  if (button) setAdsStudioActionButtonBusy(button, true);
  const generation = _studioAdmin.generation;
  slot.promise = studioApi('/api/studio/admin/alert-channel/test', { method: 'POST', body: {} }, { timeoutMs: 45000 }).then(reply => {
    if (generation !== _studioAdmin.generation) return;
    slot.value = reply && typeof reply === 'object' ? reply : {};
    slot.error = null;
    slot.loadedAt = Date.now();
  }, error => {
    if (generation !== _studioAdmin.generation) return;
    slot.error = (error && error.studio) || studioErrorInfo(error, 'action');
    slot.value = null;
  }).finally(() => {
    if (generation !== _studioAdmin.generation) return;
    slot.promise = null;
    if (button) setAdsStudioActionButtonBusy(button, false);
    studioAdminRedraw();
  });
  return slot.promise;
}

function renderStudioAdminAlertTestRow() {
  const slot = _studioAdmin.reads.alertTest;
  let note = '';
  if (slot && slot.value) {
    note = slot.value.sent ? adsStudioText('Sent: the staff channel received the test alert.', 'أُرسل: وصل التنبيه التجريبي إلى قناة الفريق.')
      : slot.value.configured === false ? adsStudioText('No staff channel is configured on the server (ALBAYAN_ALERT_WEBHOOK_URL).', 'لا قناة للفريق مُعدّة على الخادم (ALBAYAN_ALERT_WEBHOOK_URL).')
        : adsStudioText('The channel did not accept the test alert.', 'لم تقبل القناة التنبيه التجريبي.');
  } else if (slot && slot.error) note = slot.error.text || '';
  return `
          <div class="studio-v2-list studio-admin-alert-test" data-testid="studio-admin-alert-test">
            <button type="button" class="studio-v2-row" data-testid="studio-admin-alert-test-button" onclick="studioAdminAlertTest(this)"${slot && slot.promise ? ' disabled aria-busy="true"' : ''}>
              ${studioAdminIcon('radio')}
              <span class="studio-admin-row-text"><span class="studio-v2-row-label">${studioEsc(adsStudioText('Send a test alert to the staff channel', 'أرسل تنبيهاً تجريبياً إلى قناة الفريق'))}</span><span class="studio-desk-note">${studioEsc(adsStudioText('Once every 10 minutes. No customer data.', 'مرة كل 10 دقائق. دون بيانات العملاء.'))}</span></span>
            </button>
            ${note ? `<p class="studio-desk-note studio-admin-alert-test-note" data-testid="studio-admin-alert-test-note" data-sent="${slot && slot.value && slot.value.sent ? '1' : '0'}">${studioEsc(note)}</p>` : ''}
          </div>`;
}

// ------------------------------------------------------------------ the More section (called by 15p)

function renderStudioAdminMore(route) {
  studioAdminScope();
  if (!studioAdminIsAdmin()) {
    return `<p class="studio-desk-note" data-testid="studio-admin-reviewer">${studioEsc(adsStudioText('Payments, alerts, diagnostics and the settings are admin tools.', 'المدفوعات والتنبيهات والتشخيص والإعدادات أدوات للمدير.'))}</p>`;
  }
  const id = String((route && route.id) || '');
  if (!id) return renderStudioAdminMenu() + renderStudioAdminAlertTestRow();
  if (id === 'payments') return renderStudioAdminPayments();
  if (id === 'alerts') return renderStudioAdminAlerts();
  if (id === 'diagnostics') return renderStudioAdminDiagnostics();
  if (id === 'collisions') return renderStudioAdminCollisions();
  if (id.startsWith('settings-')) return renderStudioAdminSetting(id.slice(9));
  return renderStudioAdminMenu() + renderStudioAdminAlertTestRow();
}
