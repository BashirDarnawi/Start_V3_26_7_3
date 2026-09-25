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
// Refusals of the settle routes (/api/ad-studio …/stop and …/settle-override: a plain English
// prefix): [prefix, English, Arabic]. SETTLE_NOT_READY comes as {code, message, messageAr, readyAt}.
const STUDIO_DESK_REFUSALS = Object.freeze([
  ['Meta is still delivering this ad', 'Meta is still delivering this ad. Pause it in Meta first, then settle after the final read.', 'ما زالت ميتا تعرض هذا الإعلان. أوقفه في ميتا أولاً، ثم سوِّ الحساب بعد القراءة النهائية.'],
  ['Meta has not confirmed that this ad ended', 'Meta has not confirmed that this ad ended yet. Check Meta now, then try again.', 'لم تؤكد ميتا انتهاء هذا الإعلان بعد. افحص ميتا الآن ثم أعد المحاولة.'],
  ['The final amount is not ready', 'The final amount is not ready: the final Meta read is still pending.', 'المبلغ النهائي غير جاهز: قراءة ميتا النهائية لم تصل بعد.'],
  ['This ad account does not bill in USD', 'This ad account does not bill in USD, so the final amount needs an admin override.', 'هذا الحساب الإعلاني لا يُحاسب بالدولار، لذلك يحتاج المبلغ النهائي إلى تجاوز من المدير.'],
  ['refundMinorUSD is above paid minus Meta spend', "The return is above what is left after Meta's spend. Lower it (an admin can override with a written reason).", 'المبلغ المعاد أكبر مما تبقى بعد صرف ميتا. اخفضه (يمكن للمدير التجاوز مع كتابة السبب).'],
  ['refundMinorUSD must be between 0 and the paid budget', 'The return must be between 0 and what the customer paid.', 'يجب أن يكون المبلغ المعاد بين 0 وما دفعه العميل.'],
  ['refundMinorUSD is required for a launched campaign', 'Enter the amount to return (0 closes the ad without a return).', 'أدخل المبلغ المعاد (0 يغلق الإعلان دون إعادة).'],
  ['refundMinorUSD must be between 0 and the unspent captured budget', 'The return must be between 0 and the unspent budget.', 'يجب أن يكون المبلغ المعاد بين 0 والميزانية غير المصروفة.'],
  ['Only an admin can override the settlement rules', 'Only an admin can override the settlement rules.', 'تجاوز قواعد التسوية للمدير فقط.'],
  ['Nobody can override the settlement of their own request', 'Nobody can override the settlement of their own request.', 'لا يمكن لأحد تجاوز تسوية طلبه هو.'],
  ['Write why the settlement rules are lifted', 'Write why the rules are lifted (10 to 300 characters).', 'اكتب سبب تجاوز القواعد (من 10 إلى 300 حرف).'],
  ['refundMinorUSD is required for an override', 'Enter the amount to return for the override (0 closes the ad without a return).', 'أدخل المبلغ المعاد للتجاوز (0 يغلق الإعلان دون إعادة).'],
  ['Only Approved campaigns can be stopped', 'Only an approved request can be settled.', 'لا يمكن تسوية إلا طلب معتمد.'],
  ['Conflict: record has changed', 'This request changed meanwhile. Refresh and try again.', 'تغيّر هذا الطلب في الأثناء. حدّث الصفحة وأعد المحاولة.'],
  ['Financial period', 'This month is closed in the books. An admin must unlock it first.', 'هذا الشهر مقفل في الدفاتر. يجب أن يفتحه المدير أولاً.']
]);

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
  const info = adsStudioErrorInfo(error);
  const hit = STUDIO_DESK_REFUSALS.find(([needle]) => String(info.message || '').includes(needle));
  if (hit) return { code: info.code || '', readyAt: '', text: adsStudioText(hit[1], hit[2]) };
  return { code: info.code || '', readyAt: '', text: studioErrorInfo(error, 'action').text };
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
      ? { stage: 10, labels: { en: 'Ended — final amount being calculated', ar: 'انتهى — نحسب المبلغ النهائي' }, variantLabels: { en: 'Meta never showed this ad: a full return', ar: 'لم تعرض ميتا هذا الإعلان: يعود المبلغ كاملاً' } }
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
  for (const request of list) if (studioDeskLinked(request)) studioDeskReadResults(request.id);
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
function studioDeskSettleNumbers(request) {
  const paid = studioDeskPaid(request);
  const entry = _studioDesk.results.get(String(request.id));
  const stage = studioDeskStage(request);
  const staff = entry && entry.staff ? entry.staff : {};
  const linked = studioDeskLinked(request);
  // Never delivered (the server's flag on the results row) or never linked: the whole payment returns.
  const never = linked ? (stage.stage === 10 && staff.neverDelivered === true) : true;
  const spend = never ? 0 : stage.metaUsedMinor;
  const cap = spend === null ? null : Math.max(paid - spend, 0);
  return {
    paid, spend, cap, never,
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
  const countdown = !linked
    ? adsStudioText('Never linked to Meta: the full amount goes back now.', 'لم يُربط بميتا: يعود المبلغ كاملاً الآن.')
    : numbers.finalRead
      ? adsStudioText('Final Meta read done: ready to settle.', 'تمت قراءة ميتا النهائية: جاهز للتسوية.')
      : numbers.never
        ? adsStudioText('Meta never showed this ad: the full amount can go back now.', 'لم تعرض ميتا هذا الإعلان: يمكن إعادة المبلغ كاملاً الآن.')
        : numbers.readyAt
          ? adsStudioText(`Final Meta read ${studioDeskCountdown(numbers.readyAt)}`, `قراءة ميتا النهائية ${studioDeskCountdown(numbers.readyAt)}`)
          : adsStudioText('The final Meta read is scheduled 48 h after delivery ends.', 'تُجدول قراءة ميتا النهائية بعد 48 ساعة من انتهاء العرض.');
  const money = [
    `${adsStudioText('Paid', 'مدفوع')} ${studioUsd(numbers.paid)}`,
    numbers.spend === null ? adsStudioText('Meta used: not confirmed yet', 'صرف ميتا: غير مؤكد بعد') : `${adsStudioText('Meta used', 'صرف ميتا')} ${studioUsd(numbers.spend)}`,
    numbers.cap === null ? '' : `${adsStudioText('Return up to', 'يعود حتى')} ${studioUsd(numbers.cap)}`
  ].filter(Boolean).join(' · ');
  return `
              <li class="studio-desk-box" data-testid="studio-desk-settle-${id}" data-ready="${numbers.finalRead || numbers.never || !linked ? '1' : '0'}">
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
    adsStudioText("The final amount comes from Meta's confirmed spend, read 48 h after delivery ended. An ad Meta never showed returns everything at once.", 'يُحسب المبلغ النهائي من صرف ميتا المؤكد، ويُقرأ بعد 48 ساعة من انتهاء العرض. الإعلان الذي لم تعرضه ميتا يعود مبلغه كاملاً فوراً.'),
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

function studioDeskCleanPulse(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const whole = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    waitingReview: whole(raw.waitingReview),
    stopRequests: whole(raw.stopRequests),
    openTickets: whole(raw.openTickets),
    alerts: whole(raw.alerts),
    paymentsWaiting: Number.isSafeInteger(raw.paymentsWaiting) ? whole(raw.paymentsWaiting) : null
  };
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
  return pulse ? pulse.waitingReview + pulse.stopRequests + pulse.openTickets + (pulse.paymentsWaiting || 0) : 0;
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
    tickets: pulse ? pulse.openTickets + pulse.stopRequests : 0,
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
