// ==========================================
// ALBAYAN STUDIO v2 — EXTRAS (plan tasks P5-02, P3-05 client, P3-04b, P2-09; studio.js lazy bundle)
// ==========================================
// Four small pieces that plug into the screens before this file. Every call site guards with typeof,
// nothing here wraps another file's function, and nothing runs while the bundle loads except the two
// registrations at the end (the /me listener for the bell and the login help line's mount).
// - TikTok service requests (P5-02; PLAN.md §8.4 and journey J9): a service the Albayan team does BY
//   HAND, never a connection. renderStudioTikTokSection(route) draws the request form and the
//   customer's own requests (state words from the server), renderStudioTikTokEntry() is the Help
//   screen's row to it, studioTikTokOpen() goes there (?tab=help&section=tiktok) and
//   renderStudioTikTokDeskRows(items, options) draws the team's compact rows for the desk
//   (studio-staff.js calls it; the status change POSTs through studioTikTokDeskSend).
// - The bell's unread count (P3-05): the pulse hook (15g) polls GET /api/studio/activity every 30 s
//   while the page is visible; a moved unreadCount asks the Inbox (15n) to read again, and that read
//   redraws the badge. Started from the /me listener whenever the customer layout is on.
// - A results card (P3-04b): renderStudioResultsCard(campaignId): "Meta used $Y of $X", impressions,
//   reach, results, "checked X ago"; the last good values while a read fails; NOTHING before a link.
// - The login help line (P2-09; journey J0): renderStudioLoginHelp() from a cached copy of the public
//   GET /api/studio/public/contact (no login), filled into #studio-login-help on the studio front door.

// ------------------------------------------------------------------ small helpers

const STUDIO_EXTRAS_OPERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;  // ad_campaign_actions.py / studio_support.py

function studioExtrasUserId() {
  return typeof studioMeUserId === 'function' ? studioMeUserId() : '';
}

function studioExtrasServer() {
  return typeof isServerModeEnabled === 'function' && isServerModeEnabled();
}

function studioExtrasRedraw() {
  try {
    if (typeof state === 'undefined' || state.currentView !== 'ads-studio') return;
    if (typeof studioV2Rerender === 'function') studioV2Rerender();
    else if (typeof render === 'function') render();
  } catch (_) { /* the next draw shows the state */ }
}

// One operation id per attempt of an action (kept for its retries, so the server replays instead of
// repeating): the platform's secure id, in the shape the routes accept.
function studioExtrasOperationId(prefix) {
  let id = '';
  try { id = String(Security.generateSecureId(prefix)); } catch (_) { id = ''; }
  if (!STUDIO_EXTRAS_OPERATION_RE.test(id)) id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return id;
}

function studioExtrasErrorText(error, kind = 'action') {
  if (error && error.studio && error.studio.text) return error.studio.text;
  try { return studioErrorInfo(error, kind).text; } catch (_) {
    return kind === 'read'
      ? adsStudioText('This could not be loaded. Try again in a moment.', 'تعذّر التحميل. أعد المحاولة بعد لحظات.')
      : adsStudioText('The action could not be completed. Nothing changed in your balance.', 'تعذّر إتمام العملية. لم يتغير شيء في رصيدك.');
  }
}

function studioExtrasErrorCode(error) {
  return String((error && error.studio && error.studio.code) || '');
}

function studioExtrasText(value, max = 300) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function studioExtrasTime(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text)) ? text : '';
}

function studioExtrasAgo(iso) {
  return typeof studioHelpAgo === 'function' ? studioHelpAgo(iso) : '';
}

function studioExtrasIcon(name, className = 'studio-v2-icon') {
  return typeof studioV2Icon === 'function' ? studioV2Icon(name, className) : '';
}

function studioExtrasNotify(ok, title, text) {
  if (typeof showNotification === 'function') showNotification(title, text, ok ? 'success' : 'error');
}

function studioExtrasWhole(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

// ------------------------------------------------------------------ TikTok service requests (P5-02)

// Every customer- and team-facing TikTok word lives in the marked block below. scripts/test-mobile-ui.js
// reads it (and the drawn HTML): none of the words a connection would use may appear there, because
// the team helps BY HAND and TikTok runs its own auto-messages (PLAN.md §8.4, D14; the forbidden list
// is the server's, server/test_studio_tiktok.py). [English, Arabic] pairs; the states are the
// server's words as a fallback.
// TIKTOK-TEXTS-BEGIN
const STUDIO_TIKTOK_TEXTS = Object.freeze({
  title: ['TikTok help', 'مساعدة تيك توك'],
  service: ['TikTok service: hands-on help from the Albayan team, without automatic replies', 'خدمة تيك توك — مساعدة يدوية من فريق البيان، بدون ردود تلقائية'],
  notice: ['Albayan cannot reply on TikTok for you yet, because TikTok has not opened that service to us. We help you by hand and tell you as soon as it becomes available.',
    'لا يستطيع البيان حالياً الرد تلقائياً على تيك توك، لأن تيك توك لم يفتح هذه الخدمة لنا بعد. سنساعدك يدوياً ونخبرك فور توفرها.'],
  promise: ['A team member contacts you within one business day, in the ticket or on WhatsApp.', 'يتواصل معك أحد أعضاء الفريق خلال يوم عمل، في التذكرة أو عبر واتساب.'],
  today: ['What you get today', 'ماذا تحصل عليه اليوم'],
  todayItems: Object.freeze([
    ['Your TikTok username is saved with a service request, not as an account inside the studio.', 'يُحفظ اسم حسابك في تيك توك مع طلب خدمة، لا كحساب داخل الاستوديو.'],
    ["Hands-on help setting up TikTok's own built-in auto-messages, where your account has them. TikTok runs them, not Albayan.", 'مساعدة يدوية في إعداد الرسائل التلقائية المدمجة في تيك توك حيث تتوفر لحسابك. تيك توك يشغّلها، لا البيان.'],
    ['Advice on answering comments by hand and on TikTok ads.', 'نصائح للرد على التعليقات يدوياً وعلى إعلانات تيك توك.'],
    ['The request is tracked here, and every step reaches your inbox.', 'يُتابَع الطلب هنا، وتصلك كل خطوة في الإشعارات.']
  ]),
  handle: ['Your TikTok username', 'اسم حسابك في تيك توك'],
  handleHint: ['@name, or the link to your profile', '@name أو رابط ملفك الشخصي'],
  wants: ['What do you want from us?', 'ماذا تريد منا؟'],
  wantLabels: Object.freeze({
    auto_replies_help: ["Help setting up TikTok's own built-in auto-messages (TikTok runs them, not Albayan)", 'مساعدة في إعداد الرسائل التلقائية المدمجة في تيك توك (تيك توك يشغّلها، لا البيان)'],
    advice: ['Advice on answering comments by hand and on TikTok ads', 'نصائح للرد على التعليقات يدوياً وعلى إعلانات تيك توك']
  }),
  note: ['Anything we should know? (optional)', 'هل من شيء يجب أن نعرفه؟ (اختياري)'],
  send: ['Send the request', 'أرسل الطلب'],
  sending: ['Sending…', 'جارٍ الإرسال…'],
  sent: ['We received your request. The team contacts you within one business day.', 'وصلنا طلبك. يتواصل معك الفريق خلال يوم عمل.'],
  off: ['The TikTok service is not open for your account yet. Ask us in a ticket if you would like it.', 'خدمة تيك توك غير مفتوحة لحسابك بعد. اطلبها منا في تذكرة إن رغبت.'],
  full: ['You already have {n} requests in progress. Wait for the team, then send a new one.', 'لديك {n} طلبات قيد العمل بالفعل. انتظر الفريق ثم أرسل طلباً جديداً.'],
  yours: ['Your requests', 'طلباتك'],
  none: ['No TikTok requests yet.', 'لا توجد طلبات تيك توك بعد.'],
  reading: ['Reading your requests…', 'نقرأ طلباتك…'],
  open: ['Open the ticket', 'افتح التذكرة'],
  cancelHint: ['To cancel a request, open its ticket and mark it solved.', 'لإلغاء طلب، افتح تذكرته وعلّمها كمحلولة.'],
  older: ['Show older', 'اعرض الأقدم'],
  teamNote: ['Note from the team', 'ملاحظة من الفريق'],
  entryHint: ['Hands-on help from our team with your TikTok account', 'مساعدة يدوية من فريقنا في حسابك على تيك توك'],
  states: Object.freeze({
    open: ['Received: the team contacts you within one business day', 'وصل الطلب: يتواصل معك الفريق خلال يوم عمل'],
    in_progress: ['In progress with the Albayan team', 'قيد العمل مع فريق البيان'],
    done: ['Done', 'تم'],
    declined: ['Not possible right now', 'غير ممكن حالياً'],
    cancelled: ['Cancelled by you', 'ألغيته']
  }),
  problems: Object.freeze({
    handle: ['Type your TikTok username: 2 to 24 letters, digits, underscores or periods (not ending with a period), with or without @, or your profile link.',
      'اكتب اسم حسابك في تيك توك: من 2 إلى 24 حرفاً أو رقماً أو شرطة سفلية أو نقطة (لا ينتهي بنقطة)، مع @ أو بدونها، أو رابط ملفك الشخصي.'],
    wants: ['Choose at least one kind of help.', 'اختر نوعاً واحداً من المساعدة على الأقل.'],
    note: ['The note is too long (1,000 characters at most).', 'الملاحظة طويلة جداً (1,000 حرف على الأكثر).']
  }),
  deskEmpty: ['No TikTok requests in this list.', 'لا توجد طلبات تيك توك في هذه القائمة.'],
  deskWants: ['Wants', 'يريد'],
  deskStart: ['Start', 'ابدأ'],
  deskDone: ['Done', 'تم'],
  deskDecline: ['Not possible', 'غير ممكن'],
  deskNoteEn: ['Note to the customer (English)', 'ملاحظة للعميل (بالإنجليزية)'],
  deskNoteAr: ['Note to the customer (Arabic)', 'ملاحظة للعميل (بالعربية)'],
  deskSave: ['Save', 'حفظ'],
  deskCancel: ['Cancel', 'إلغاء'],
  deskNoteProblem: ['Write the note in both languages (500 characters each at most).', 'اكتب الملاحظة باللغتين (500 حرف لكل لغة على الأكثر).'],
  deskSaved: ['The request moved on and the customer got your note.', 'انتقل الطلب إلى الخطوة التالية ووصلت ملاحظتك إلى العميل.']
});
// TIKTOK-TEXTS-END

const STUDIO_TIKTOK_WANTS = Object.freeze(['auto_replies_help', 'advice']);
const STUDIO_TIKTOK_STATES = Object.freeze(['open', 'in_progress', 'done', 'declined', 'cancelled']);
const STUDIO_TIKTOK_STATE_LOOK = Object.freeze({  // [tone, icon]: a state never stands by its colour alone
  open: ['amber', 'clock'], in_progress: ['blue', 'wrench'], done: ['green', 'circle-check'], declined: ['rose', 'circle-x'], cancelled: ['slate', 'ban']
});
const STUDIO_TIKTOK_DESK_STEPS = Object.freeze({ open: ['in_progress', 'declined'], in_progress: ['done', 'declined'] });  // studio_support.TIKTOK_TRANSITIONS
const STUDIO_TIKTOK_HANDLE_RE = /^[A-Za-z0-9_.]{2,24}$/;
const STUDIO_TIKTOK_URL_RE = /^(?:https?:\/\/)?(?:[a-z]{1,3}\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,24})\/?(?:[?#].*)?$/i;
const STUDIO_TIKTOK_TICKET_RE = /^tkt_[0-9a-f]{40}$/;
const STUDIO_TIKTOK_NOTE_MAX = 1000;       // the customer's note (studio_support.TIKTOK_CUSTOMER_NOTE_MAX)
const STUDIO_TIKTOK_DESK_NOTE_MAX = 500;   // each language of the team's note (TIKTOK_NOTE_MAX)
const STUDIO_TIKTOK_FRESH_MS = 30 * 1000;
const STUDIO_TIKTOK_RETRY_MS = 30 * 1000;
const _studioTikTok = {
  forUser: '', generation: 0, service: null, items: [], nextCursor: null, openCount: 0, maxOpen: 3,
  loadedAt: 0, failedAt: 0, loading: null, again: false, error: null, draft: null, sentId: ''
};
const _studioTikTokDesk = { busy: new Map(), attempts: new Map(), editing: '', problem: '', onChange: '' };

function studioTikTokText(pair) {
  return adsStudioText(pair[0], pair[1]);
}

// The username of a typed handle ("name", "@name" or tiktok.com/@name), or '' (the server's rule).
function studioTikTokHandle(raw) {
  let value = String(raw || '').trim();
  const link = value.match(STUDIO_TIKTOK_URL_RE);
  if (link) value = link[1];
  else if (value.startsWith('@')) value = value.slice(1);
  return STUDIO_TIKTOK_HANDLE_RE.test(value) && !value.endsWith('.') ? value : '';
}

function studioTikTokOn() {
  const me = typeof studioMe === 'function' ? studioMe() : null;
  return !!(me && me.services && me.services.tiktok === true);
}

function studioTikTokInV2() {
  return typeof studioV2Frame === 'function' && studioV2Frame() === 'customer';
}

function studioTikTokScope() {
  const uid = studioExtrasUserId();
  if (_studioTikTok.forUser !== uid) {
    _studioTikTok.generation++;
    Object.assign(_studioTikTok, { forUser: uid, service: null, items: [], nextCursor: null, openCount: 0, maxOpen: 3, loadedAt: 0, failedAt: 0, loading: null, again: false, error: null, draft: null, sentId: '' });
  }
  return uid;
}

// A request as the server sends it (a ticket view with its `tiktok` part), read back through the
// rules the screens know; null for anything else. The profile link is derived, never trusted.
function studioTikTokCleanRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '');
  if (!STUDIO_TIKTOK_TICKET_RE.test(id)) return null;
  const service = raw.tiktok && typeof raw.tiktok === 'object' ? raw.tiktok : {};
  const handle = studioTikTokHandle(service.handle);
  const pair = value => (value && typeof value === 'object' ? { en: studioExtrasText(value.en, 500), ar: studioExtrasText(value.ar, 500) } : null);
  const status = ['open', 'answered', 'waiting_customer', 'resolved'].includes(raw.status) ? raw.status : 'open';
  return {
    id,
    number: /^T-\d{4,12}$/.test(String(raw.number || '')) ? String(raw.number) : '',
    status,
    handle,
    profileUrl: handle ? `https://www.tiktok.com/@${handle}` : '',
    wants: Array.isArray(service.wants) ? service.wants.filter(want => STUDIO_TIKTOK_WANTS.includes(want)) : [],
    state: STUDIO_TIKTOK_STATES.includes(service.state) ? service.state : 'open',
    stateLabels: pair(service.stateLabels),
    note: pair(service.note),
    stateAt: studioExtrasTime(service.stateAt),
    createdAt: studioExtrasTime(raw.createdAt),
    updatedAt: studioExtrasTime(raw.updatedAt),
    lastMessageAt: studioExtrasTime(raw.lastMessageAt),
    dueAt: status === 'open' ? studioExtrasTime(raw.dueAt) : '',
    overdue: raw.overdue === true,
    ownerId: typeof raw.ownerId === 'string' && Security.isValidRecordId(raw.ownerId) ? raw.ownerId : ''  // staff only, never drawn as a person
  };
}

function studioTikTokCleanService(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pair = value => (value && typeof value === 'object' ? { en: studioExtrasText(value.en, 400), ar: studioExtrasText(value.ar, 400) } : null);
  return {
    open: src.open === true,
    labels: pair(src.labels), notice: pair(src.notice), promise: pair(src.promise),
    wants: (Array.isArray(src.wants) ? src.wants : []).filter(item => item && STUDIO_TIKTOK_WANTS.includes(item.key)).map(item => ({ key: item.key, labels: pair(item.labels) })),
    maxOpen: studioExtrasWhole(src.maxOpen) || 3
  };
}

// The state in the reader's language: the server's words, else this file's copy of them.
function studioTikTokStateLabel(request) {
  const own = request.stateLabels ? studioPickText(request.stateLabels, 160) : '';
  return own || studioTikTokText(STUDIO_TIKTOK_TEXTS.states[request.state] || STUDIO_TIKTOK_TEXTS.states.open);
}

function studioTikTokWantLabel(key, service = null) {
  const fromServer = service && service.wants ? service.wants.find(item => item.key === key) : null;
  const own = fromServer && fromServer.labels ? studioPickText(fromServer.labels, 200) : '';
  return own || studioTikTokText(STUDIO_TIKTOK_TEXTS.wantLabels[key] || ['', '']);
}

// GET /api/studio/tiktok/requests (the caller's own, newest first): the first page (a reply younger
// than 30 s is reused; force asks now) or one more page. One read at a time; a failed read waits.
function studioTikTokWant(force = false, more = false) {
  if (!studioTikTokScope() || !studioExtrasServer()) return null;
  const slot = _studioTikTok;
  if (slot.loading) {
    if (force && !more) slot.again = true;
    return slot.loading;
  }
  const now = Date.now();
  if (!more && !force) {
    if (slot.failedAt && now - slot.failedAt < STUDIO_TIKTOK_RETRY_MS) return null;
    if (slot.loadedAt && now - slot.loadedAt < STUDIO_TIKTOK_FRESH_MS) return null;
  }
  if (more && !slot.nextCursor) return null;
  const generation = slot.generation;
  const signal = typeof studioReadSignal === 'function' ? studioReadSignal() : null;
  const url = more ? `/api/studio/tiktok/requests?cursor=${encodeURIComponent(slot.nextCursor)}` : '/api/studio/tiktok/requests';
  slot.again = false;
  const promise = studioApi(url, { method: 'GET' }).then(raw => {
    if (generation !== slot.generation) return;
    const items = raw && Array.isArray(raw.requests) ? raw.requests.map(studioTikTokCleanRequest).filter(Boolean) : [];
    if (more) {
      const seen = new Set(slot.items.map(item => item.id));
      slot.items = slot.items.concat(items.filter(item => !seen.has(item.id)));
    } else {
      slot.items = items;
      slot.loadedAt = now;
    }
    slot.nextCursor = raw && typeof raw.nextCursor === 'string' && /^[0-9:]+tkt_[0-9a-f]{40}$/.test(raw.nextCursor) ? raw.nextCursor : null;
    slot.openCount = studioExtrasWhole(raw && raw.openCount);
    slot.maxOpen = studioExtrasWhole(raw && raw.maxOpen) || 3;
    slot.service = studioTikTokCleanService(raw && raw.service);
    slot.failedAt = 0;
    slot.error = null;
  }, error => {
    if (generation !== slot.generation) return;
    if (typeof studioReadCancelled === 'function' && studioReadCancelled(error, signal)) return;  // the app moved on
    slot.failedAt = Date.now();
    slot.error = { code: studioExtrasErrorCode(error), text: studioExtrasErrorText(error, 'read') };
  }).finally(() => {
    if (generation !== slot.generation) return;
    slot.loading = null;
    if (slot.again) {
      slot.again = false;
      studioTikTokWant(true);
    }
    studioExtrasRedraw();
  });
  slot.loading = promise;
  return promise;
}

function studioTikTokRetry() {
  _studioTikTok.failedAt = 0;
  studioTikTokWant(true);
  studioExtrasRedraw();
}

function studioTikTokMore() {
  return studioTikTokWant(false, true);
}

// ---- the form

function studioTikTokDraft() {
  studioTikTokScope();
  if (!_studioTikTok.draft) {
    _studioTikTok.draft = { handle: '', wants: ['auto_replies_help'], note: '', operationId: studioExtrasOperationId('tiktok'), sending: false, error: '', problems: {} };
  }
  return _studioTikTok.draft;
}

// Typing stores the value (no redraw under the reader's hands); the inputs keep stable ids.
function studioTikTokSet(field, value) {
  const draft = studioTikTokDraft();
  if (field === 'handle') draft.handle = String(value || '').slice(0, 200);
  else if (field === 'note') draft.note = String(value || '').slice(0, STUDIO_TIKTOK_NOTE_MAX + 200);
  else return false;
  delete draft.problems[field];
  return true;
}

function studioTikTokToggleWant(key, checked) {
  const draft = studioTikTokDraft();
  const want = String(key || '');
  if (!STUDIO_TIKTOK_WANTS.includes(want)) return false;
  const on = checked === true || checked === 'true';
  draft.wants = STUDIO_TIKTOK_WANTS.filter(item => (item === want ? on : draft.wants.includes(item)));
  if (draft.wants.length) delete draft.problems.wants;
  return true;
}

function studioTikTokValidate(draft) {
  const problems = {};
  if (!studioTikTokHandle(draft.handle)) problems.handle = studioTikTokText(STUDIO_TIKTOK_TEXTS.problems.handle);
  if (!draft.wants.length) problems.wants = studioTikTokText(STUDIO_TIKTOK_TEXTS.problems.wants);
  if (draft.note.trim().length > STUDIO_TIKTOK_NOTE_MAX) problems.note = studioTikTokText(STUDIO_TIKTOK_TEXTS.problems.note);
  return problems;
}

// POST /api/studio/tiktok/requests, single flight, one operationId per draft (a retry replays; a
// draft the server already knows with other details gets a fresh id).
async function studioTikTokSend() {
  const draft = studioTikTokDraft();
  if (draft.sending || !studioExtrasServer()) return false;
  draft.problems = studioTikTokValidate(draft);
  draft.error = '';
  if (Object.keys(draft.problems).length) {
    studioExtrasRedraw();
    return false;
  }
  draft.sending = true;
  studioExtrasRedraw();
  const generation = _studioTikTok.generation;
  const body = { handle: studioTikTokHandle(draft.handle), wants: draft.wants.slice(), operationId: draft.operationId };
  const note = draft.note.trim();
  if (note) body.note = note;
  try {
    const raw = await studioApi('/api/studio/tiktok/requests', { method: 'POST', body });
    if (generation !== _studioTikTok.generation) return false;
    const request = studioTikTokCleanRequest(raw && raw.request);
    if (request) {
      _studioTikTok.items = [request].concat(_studioTikTok.items.filter(item => item.id !== request.id));
      _studioTikTok.openCount += 1;
      _studioTikTok.sentId = request.id;
    }
    _studioTikTok.draft = null;  // the next request gets its own operation id
    studioExtrasNotify(true, studioTikTokText(STUDIO_TIKTOK_TEXTS.title), studioTikTokText(STUDIO_TIKTOK_TEXTS.sent));
    studioTikTokWant(true);  // the server's own counts and the service state
    return true;
  } catch (error) {
    if (generation !== _studioTikTok.generation) return false;
    draft.error = studioExtrasErrorText(error, 'action');
    if (studioExtrasErrorCode(error) === 'IDEMPOTENCY_MISMATCH') draft.operationId = studioExtrasOperationId('tiktok');
    return false;
  } finally {
    if (generation === _studioTikTok.generation) {
      draft.sending = false;
      studioExtrasRedraw();
    }
  }
}

// ---- navigation

// The TikTok section lives in Help: ?tab=help&section=tiktok (15n draws it there through its hook).
function studioTikTokOpen() {
  if (!studioTikTokInV2() || typeof studioV2Go !== 'function') return false;
  return studioV2Go({ tab: 'help', section: 'tiktok' });
}

function studioTikTokOpenTicket(id) {
  const ticketId = String(id || '');
  return STUDIO_TIKTOK_TICKET_RE.test(ticketId) && typeof studioHelpOpen === 'function' ? studioHelpOpen(ticketId) : false;
}

// ---- drawing (customer)

function renderStudioTikTokState(request) {
  const look = STUDIO_TIKTOK_STATE_LOOK[request.state] || STUDIO_TIKTOK_STATE_LOOK.open;
  return `<span class="studio-help-status" data-tone="${look[0]}" data-state="${studioEsc(request.state)}" data-testid="studio-tiktok-state">${studioExtrasIcon(look[1], 'studio-help-status-icon')}<span>${studioEsc(studioTikTokStateLabel(request))}</span></span>`;
}

function renderStudioTikTokHandle(request) {
  if (!request.handle) return '';
  return `<a class="studio-tiktok-handle" href="${studioEsc(request.profileUrl)}" target="_blank" rel="noopener noreferrer" dir="ltr">@${studioEsc(request.handle)}</a>`;
}

function renderStudioTikTokWants(request, service = null) {
  if (!request.wants.length) return '';
  return `<ul class="studio-tiktok-wants-list">${request.wants.map(want => `<li>${studioEsc(studioTikTokWantLabel(want, service))}</li>`).join('')}</ul>`;
}

function renderStudioTikTokNote(request) {
  const note = request.note ? studioPickText(request.note, 500) : '';
  if (!note) return '';
  return `<p class="studio-tiktok-note" data-testid="studio-tiktok-note-${studioEsc(request.id)}"><span class="studio-tiktok-note-from">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.teamNote))}</span><span dir="auto">${studioEsc(note)}</span></p>`;
}

function renderStudioTikTokRequest(request, service) {
  const ago = studioExtrasAgo(request.stateAt || request.lastMessageAt || request.updatedAt || request.createdAt);
  const fresh = request.id === _studioTikTok.sentId;
  return `
              <li class="studio-help-row studio-tiktok-item${fresh ? ' is-fresh' : ''}" data-testid="studio-tiktok-item-${studioEsc(request.id)}" data-state="${studioEsc(request.state)}">
                <span class="studio-help-row-head"><span class="studio-help-number">${studioEsc(request.number)}</span>${renderStudioTikTokHandle(request)}${renderStudioTikTokState(request)}</span>
                ${renderStudioTikTokWants(request, service)}
                ${renderStudioTikTokNote(request)}
                <span class="studio-help-meta">${ago ? `<span>${studioEsc(ago)}</span>` : ''}</span>
                <button type="button" class="studio-help-link" data-testid="studio-tiktok-open-${studioEsc(request.id)}" onclick="studioTikTokOpenTicket('${request.id}')">${studioExtrasIcon('ticket', 'studio-help-ask-icon')}<span>${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.open))}</span></button>
              </li>`;
}

function renderStudioTikTokForm(service) {
  const draft = studioTikTokDraft();
  const problem = key => (draft.problems[key] ? `<p class="studio-help-error" data-testid="studio-tiktok-problem-${key}">${studioEsc(draft.problems[key])}</p>` : '');
  const wants = STUDIO_TIKTOK_WANTS.map(key => `
              <label class="studio-tiktok-want" for="studio-tiktok-want-${key}">
                <input type="checkbox" id="studio-tiktok-want-${key}" class="studio-tiktok-check"${draft.wants.includes(key) ? ' checked' : ''}${draft.sending ? ' disabled' : ''} onchange="studioTikTokToggleWant('${key}', this.checked)" />
                <span>${studioEsc(studioTikTokWantLabel(key, service))}</span>
              </label>`).join('');
  return `
          <form class="studio-help-form studio-tiktok-form" data-testid="studio-tiktok-form" onsubmit="studioTikTokSend(); return false;">
            <div class="studio-help-field${draft.problems.handle ? ' is-invalid' : ''}">
              <label class="studio-help-label" for="studio-tiktok-handle">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.handle))}</label>
              <input type="text" id="studio-tiktok-handle" class="studio-help-input" dir="ltr" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="200" placeholder="${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.handleHint))}" value="${studioEsc(draft.handle)}"${draft.sending ? ' disabled' : ''} oninput="studioTikTokSet('handle', this.value)" />
              ${problem('handle')}
            </div>
            <fieldset class="studio-help-field studio-tiktok-wants${draft.problems.wants ? ' is-invalid' : ''}">
              <legend class="studio-help-label">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.wants))}</legend>${wants}
              ${problem('wants')}
            </fieldset>
            <div class="studio-help-field${draft.problems.note ? ' is-invalid' : ''}">
              <label class="studio-help-label" for="studio-tiktok-note">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.note))}</label>
              <textarea id="studio-tiktok-note" class="studio-help-input" rows="3" maxlength="${STUDIO_TIKTOK_NOTE_MAX + 200}" dir="auto"${draft.sending ? ' disabled' : ''} oninput="studioTikTokSet('note', this.value)">${studioEsc(draft.note)}</textarea>
              ${problem('note')}
            </div>
            ${draft.error ? `<p class="studio-help-error" data-testid="studio-tiktok-error">${studioEsc(draft.error)}</p>` : ''}
            <div class="studio-help-actions">
              <button type="submit" class="studio-v2-action is-primary" data-testid="studio-tiktok-send"${draft.sending ? ' disabled aria-busy="true"' : ''}>${studioEsc(draft.sending ? studioTikTokText(STUDIO_TIKTOK_TEXTS.sending) : studioTikTokText(STUDIO_TIKTOK_TEXTS.send))}</button>
            </div>
          </form>`;
}

// The Help screen's section for ?section=tiktok (drawn by 15n through its hook): the service card
// (what it is, what you get today), the form while the service is open and the reader has room for
// another request, and the reader's own requests with the server's state words.
function renderStudioTikTokSection() {
  studioTikTokScope();
  studioTikTokWant();
  const slot = _studioTikTok;
  const service = slot.service;
  const open = service ? service.open : studioTikTokOn();
  const maxOpen = service ? service.maxOpen : slot.maxOpen;
  const full = slot.loadedAt > 0 && slot.openCount >= maxOpen;
  const labels = service && service.labels ? studioPickText(service.labels, 300) : '';
  const notice = service && service.notice ? studioPickText(service.notice, 400) : '';
  const promise = service && service.promise ? studioPickText(service.promise, 300) : '';
  let form = '';
  if (!open) form = `<p class="studio-help-note studio-tiktok-off" data-testid="studio-tiktok-off">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.off))}</p>`;
  else if (full) form = `<p class="studio-help-note" data-testid="studio-tiktok-full">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.full).replace('{n}', String(slot.openCount)))}</p>`;
  else form = renderStudioTikTokForm(service);
  let list = '';
  if (!slot.loadedAt && slot.error) list = typeof renderStudioHelpProblem === 'function' ? renderStudioHelpProblem(slot.error, 'studioTikTokRetry()', 'studio-tiktok-problem') : `<p class="studio-help-error" data-testid="studio-tiktok-problem">${studioEsc(slot.error.text)}</p>`;
  else if (!slot.loadedAt) list = `<p class="studio-help-empty" data-testid="studio-tiktok-loading">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.reading))}</p>`;
  else if (!slot.items.length) list = `<p class="studio-help-empty" data-testid="studio-tiktok-empty">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.none))}</p>`;
  else {
    list = `<ul class="studio-help-list" data-testid="studio-tiktok-list">${slot.items.map(request => renderStudioTikTokRequest(request, service)).join('')}</ul>
            <p class="studio-help-note">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.cancelHint))}</p>`;
    if (slot.nextCursor) list += `<button type="button" class="studio-v2-action studio-help-small" data-testid="studio-tiktok-more" onclick="studioTikTokMore()"${slot.loading ? ' disabled' : ''}>${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.older))}</button>`;
  }
  const sent = slot.sentId && slot.items.some(item => item.id === slot.sentId)
    ? `<p class="studio-tiktok-sent" role="status" data-testid="studio-tiktok-sent">${studioExtrasIcon('circle-check', 'studio-help-status-icon')}<span>${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.sent))}</span></p>` : '';
  return `
        <div class="studio-help studio-tiktok" data-testid="studio-tiktok" data-open="${open ? '1' : '0'}">
          <section class="studio-help-card" aria-labelledby="studio-tiktok-title">
            <div class="studio-help-head">
              <h2 id="studio-tiktok-title" class="studio-help-h2">${studioExtrasIcon('music-2', 'studio-help-status-icon')}<span>${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.title))}</span></h2>
            </div>
            <p class="studio-tiktok-service" data-testid="studio-tiktok-service">${studioEsc(labels || studioTikTokText(STUDIO_TIKTOK_TEXTS.service))}</p>
            <p class="studio-help-note" data-testid="studio-tiktok-notice">${studioEsc(notice || studioTikTokText(STUDIO_TIKTOK_TEXTS.notice))}</p>
            <h3 class="studio-help-h3">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.today))}</h3>
            <ul class="studio-help-guide" data-testid="studio-tiktok-today">${STUDIO_TIKTOK_TEXTS.todayItems.map(pair => `<li>${studioEsc(studioTikTokText(pair))}</li>`).join('')}</ul>
            <p class="studio-help-note">${studioEsc(promise || studioTikTokText(STUDIO_TIKTOK_TEXTS.promise))}</p>
            ${sent}
            ${form}
          </section>
          <section class="studio-help-card" aria-labelledby="studio-tiktok-yours">
            <div class="studio-help-head">
              <h2 id="studio-tiktok-yours" class="studio-help-h2">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.yours))}</h2>
              <button type="button" class="studio-help-link" data-testid="studio-tiktok-refresh" onclick="studioTikTokRetry()"${slot.loading ? ' disabled' : ''}>${studioExtrasIcon('refresh-cw', 'studio-help-ask-icon')}<span>${studioEsc(adsStudioText('Refresh', 'تحديث'))}</span></button>
            </div>
            ${list}
          </section>
        </div>`;
}

// The Help list's row to the TikTok section (15n draws it through its hook), only while the service
// is on for this account or the reader already has requests to look at.
function renderStudioTikTokEntry() {
  if (!studioTikTokInV2() || !studioTikTokOn()) return '';
  return `
          <button type="button" class="studio-help-row studio-tiktok-entry" data-testid="studio-tiktok-entry" onclick="studioTikTokOpen()">
            <span class="studio-help-row-head">${studioExtrasIcon('music-2', 'studio-help-status-icon')}<span class="studio-help-subject">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.title))}</span></span>
            <span class="studio-help-meta"><span>${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.entryHint))}</span></span>
          </button>`;
}

// ---- drawing and actions (the Team desk, studio-staff.js)

// The team's compact rows for a list from GET /api/studio/staff/tiktok ({requests}); `items` are the
// raw ticket views (or rows already cleaned here). options: {open: 'globalFn'} names a function to
// call with the ticket id when a row is tapped; {actions: false} hides the step buttons;
// {onChange: 'globalFn'} is called with the updated request after a step is saved.
function renderStudioTikTokDeskRows(items, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const name = value => (/^[A-Za-z_$][\w$]*$/.test(String(value || '')) ? String(value) : '');
  const open = name(opts.open);
  _studioTikTokDesk.onChange = name(opts.onChange);
  const rows = (Array.isArray(items) ? items : [])
    .map(item => (item && typeof item === 'object' && typeof item.handle === 'string' && STUDIO_TIKTOK_TICKET_RE.test(String(item.id || '')) ? item : studioTikTokCleanRequest(item)))
    .filter(Boolean);
  if (!rows.length) return `<p class="studio-help-empty" data-testid="studio-tiktok-desk-empty">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.deskEmpty))}</p>`;
  const wants = request => (request.wants.length ? `<span class="studio-help-meta"><span>${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.deskWants))}:</span>${request.wants.map(want => `<span>${studioEsc(studioTikTokWantLabel(want))}</span>`).join('')}</span>` : '');
  const due = request => {
    if (typeof studioHelpDueLine !== 'function') return '';
    const line = studioHelpDueLine(request, true);
    return line ? `<span class="studio-help-meta"><span>${studioEsc(line)}</span></span>` : '';
  };
  return `<ul class="studio-help-list studio-tiktok-desk" data-testid="studio-tiktok-desk">${rows.map(request => {
    const ago = studioExtrasAgo(request.stateAt || request.lastMessageAt || request.updatedAt || request.createdAt);
    const head = `<span class="studio-help-row-head"><span class="studio-help-number">${studioEsc(request.number)}</span>${renderStudioTikTokHandle(request)}${renderStudioTikTokState(request)}</span>`;
    const body = `${wants(request)}${renderStudioTikTokNote(request)}${due(request)}<span class="studio-help-meta">${ago ? `<span>${studioEsc(ago)}</span>` : ''}</span>`;
    const tap = open ? `<button type="button" class="studio-help-row${request.overdue ? ' is-overdue' : ''}" data-testid="studio-tiktok-desk-open-${studioEsc(request.id)}" onclick="${open}('${request.id}')">${head}${body}</button>`
      : `<div class="studio-help-row is-static${request.overdue ? ' is-overdue' : ''}">${head}${body}</div>`;
    return `
              <li data-testid="studio-tiktok-desk-${studioEsc(request.id)}" data-state="${studioEsc(request.state)}">${tap}${opts.actions === false ? '' : renderStudioTikTokDeskActions(request)}
              </li>`;
  }).join('')}</ul>`;
}

function renderStudioTikTokDeskActions(request) {
  const steps = STUDIO_TIKTOK_DESK_STEPS[request.state] || [];
  if (!steps.length) return '';
  const editing = _studioTikTokDesk.editing;
  const busy = Array.from(_studioTikTokDesk.busy.keys()).some(key => key.startsWith(`${request.id}|`));
  const label = step => studioTikTokText(step === 'in_progress' ? STUDIO_TIKTOK_TEXTS.deskStart : step === 'done' ? STUDIO_TIKTOK_TEXTS.deskDone : STUDIO_TIKTOK_TEXTS.deskDecline);
  const kind = step => (step === 'in_progress' ? 'start' : step === 'done' ? 'done' : 'decline');
  const buttons = steps.map(step => `<button type="button" class="studio-v2-action studio-help-small${step === 'declined' ? ' studio-ads-danger' : ''}" data-testid="studio-tiktok-desk-${kind(step)}-${studioEsc(request.id)}" onclick="studioTikTokDeskEdit('${request.id}', '${step}')"${busy ? ' disabled' : ''}>${studioEsc(label(step))}</button>`).join('');
  const current = editing.startsWith(`${request.id}|`) ? editing.slice(request.id.length + 1) : '';
  const form = current && steps.includes(current) ? `
                <form class="studio-help-form studio-tiktok-desk-form" data-testid="studio-tiktok-desk-form-${studioEsc(request.id)}" data-step="${studioEsc(current)}" onsubmit="studioTikTokDeskSend('${request.id}', '${current}'); return false;">
                  <p class="studio-help-label">${studioEsc(label(current))}</p>
                  <div class="studio-help-field">
                    <label class="studio-help-label" for="studio-tiktok-note-en-${studioEsc(request.id)}">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.deskNoteEn))}</label>
                    <textarea id="studio-tiktok-note-en-${studioEsc(request.id)}" class="studio-help-input" rows="2" maxlength="${STUDIO_TIKTOK_DESK_NOTE_MAX}" dir="ltr"${busy ? ' disabled' : ''}></textarea>
                  </div>
                  <div class="studio-help-field">
                    <label class="studio-help-label" for="studio-tiktok-note-ar-${studioEsc(request.id)}">${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.deskNoteAr))}</label>
                    <textarea id="studio-tiktok-note-ar-${studioEsc(request.id)}" class="studio-help-input" rows="2" maxlength="${STUDIO_TIKTOK_DESK_NOTE_MAX}" dir="rtl"${busy ? ' disabled' : ''}></textarea>
                  </div>
                  ${_studioTikTokDesk.problem ? `<p class="studio-help-error" data-testid="studio-tiktok-desk-problem">${studioEsc(_studioTikTokDesk.problem)}</p>` : ''}
                  <div class="studio-help-actions">
                    <button type="submit" class="studio-v2-action is-primary studio-help-small" data-testid="studio-tiktok-desk-save-${studioEsc(request.id)}"${busy ? ' disabled aria-busy="true"' : ''}>${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.deskSave))}</button>
                    <button type="button" class="studio-v2-action studio-help-small" onclick="studioTikTokDeskEdit('', '')"${busy ? ' disabled' : ''}>${studioEsc(studioTikTokText(STUDIO_TIKTOK_TEXTS.deskCancel))}</button>
                  </div>
                </form>` : '';
  return `<div class="studio-tiktok-desk-actions">${form ? '' : buttons}${form}</div>`;
}

// Opens (or closes, with '') the note form of one step; the note reaches the customer's thread.
function studioTikTokDeskEdit(id, step) {
  const ticketId = String(id || '');
  const wanted = String(step || '');
  _studioTikTokDesk.problem = '';
  _studioTikTokDesk.editing = STUDIO_TIKTOK_TICKET_RE.test(ticketId) && ['in_progress', 'done', 'declined'].includes(wanted) ? `${ticketId}|${wanted}` : '';
  studioExtrasRedraw();
  return !!_studioTikTokDesk.editing;
}

// POST /api/studio/staff/tiktok/{id}/status {status, note: {en, ar}, operationId}: single flight per
// request and step; one operation id per (request, step, the row's updatedAt), kept for retries.
async function studioTikTokDeskSend(id, step, note = null) {
  const ticketId = String(id || '');
  const status = String(step || '');
  if (!STUDIO_TIKTOK_TICKET_RE.test(ticketId) || !['in_progress', 'done', 'declined'].includes(status) || !studioExtrasServer()) return null;
  const key = `${ticketId}|${status}`;
  if (_studioTikTokDesk.busy.has(key)) return _studioTikTokDesk.busy.get(key);
  const read = suffix => {
    try { const el = document.getElementById(`studio-tiktok-note-${suffix}-${ticketId}`); return el ? String(el.value || '') : ''; } catch (_) { return ''; }
  };
  const text = note && typeof note === 'object' ? { en: String(note.en || ''), ar: String(note.ar || '') } : { en: read('en'), ar: read('ar') };
  text.en = text.en.trim();
  text.ar = text.ar.trim();
  if (!text.en || !text.ar || text.en.length > STUDIO_TIKTOK_DESK_NOTE_MAX || text.ar.length > STUDIO_TIKTOK_DESK_NOTE_MAX) {
    _studioTikTokDesk.problem = studioTikTokText(STUDIO_TIKTOK_TEXTS.deskNoteProblem);
    studioExtrasRedraw();
    return null;
  }
  const attemptKey = `${key}|${String((note && note.version) || '')}`;
  let operationId = _studioTikTokDesk.attempts.get(attemptKey);
  if (!operationId) {
    operationId = studioExtrasOperationId('tiktok-step');
    _studioTikTokDesk.attempts.set(attemptKey, operationId);
  }
  _studioTikTokDesk.problem = '';
  const uid = studioExtrasUserId();
  const promise = studioApi(`/api/studio/staff/tiktok/${encodeURIComponent(ticketId)}/status`, { method: 'POST', body: { status, note: text, operationId } }).then(raw => {
    if (uid !== studioExtrasUserId()) return null;
    const request = studioTikTokCleanRequest(raw && raw.request);
    _studioTikTokDesk.attempts.delete(attemptKey);
    _studioTikTokDesk.editing = '';
    studioExtrasNotify(true, studioTikTokText(STUDIO_TIKTOK_TEXTS.title), studioTikTokText(STUDIO_TIKTOK_TEXTS.deskSaved));
    const onChange = _studioTikTokDesk.onChange;
    try { if (onChange && typeof window !== 'undefined' && typeof window[onChange] === 'function') window[onChange](request); } catch (_) { /* the desk's own redraw follows */ }
    return request;
  }, error => {
    if (uid !== studioExtrasUserId()) return null;
    _studioTikTokDesk.problem = studioExtrasErrorText(error, 'action');
    if (['IDEMPOTENCY_MISMATCH', 'TICKET_CLOSED', 'INVALID_VALUE'].includes(studioExtrasErrorCode(error))) _studioTikTokDesk.attempts.delete(attemptKey);
    return null;
  }).finally(() => {
    _studioTikTokDesk.busy.delete(key);
    studioExtrasRedraw();
  });
  _studioTikTokDesk.busy.set(key, promise);
  studioExtrasRedraw();
  return promise;
}

// ------------------------------------------------------------------ the bell's unread count (P3-05)

const STUDIO_INBOX_PULSE_MS = 30 * 1000;
const STUDIO_INBOX_PULSE_KEY = 'inbox';

// While the customer layout is on, the pulse hook (15g) reads the feed's unreadCount every 30 s
// (only while the page is visible, one read at a time, its own back-off); when it moves, the Inbox
// (15n) reads again and redraws, so the bell's badge follows within a minute. Any other layout stops
// the watch. Called by the /me listener after every settled /me read (and once at load).
function studioInboxPulseStart(me) {
  if (typeof studioPulseWatch !== 'function' || typeof studioPulseStop !== 'function') return false;
  const layout = me && typeof me === 'object' ? me : null;
  const customer = !!layout && (typeof studioV2FrameOf === 'function' ? studioV2FrameOf(layout) === 'customer' : layout.ui === 'v2');
  if (!customer || !studioExtrasUserId() || typeof studioInboxWant !== 'function') {
    studioPulseStop(STUDIO_INBOX_PULSE_KEY);
    return false;
  }
  studioPulseWatch(STUDIO_INBOX_PULSE_KEY, { path: '/api/studio/activity', field: 'unreadCount', intervalMs: STUDIO_INBOX_PULSE_MS, onChange: studioInboxPulseChanged });
  return true;
}

function studioInboxPulseChanged() {
  try { studioInboxWant(true); } catch (_) { /* the next badge draw reads again */ }
}

// ------------------------------------------------------------------ results card (P3-04b)

// Meta's numbers for one request, through the classic reader (15c: one read per request at a time,
// kept two minutes, the last good values kept when a read fails). '' before a link (PLAN.md §5.4:
// no "Meta used" before the team linked the campaign) or for a request this screen does not know.
function renderStudioResultsCard(campaignId) {
  const id = String(campaignId || '');
  if (!id || !Security.isValidRecordId(id) || typeof adsStudioShowsResults !== 'function' || typeof adsStudioLoadResults !== 'function') return '';
  let request = typeof studioDataRequest === 'function' ? studioDataRequest(id) : null;
  if (!request && typeof getVisibleAdsStudioCampaigns === 'function') request = getVisibleAdsStudioCampaigns().find(row => row && String(row.id || '') === id) || null;
  if (!request || !adsStudioShowsResults(request)) return '';
  adsStudioLoadResults(id);
  const entry = typeof _adsStudioResults !== 'undefined' && _adsStudioResults.byId ? _adsStudioResults.byId.get(id) : null;
  const data = entry ? entry.data : null;
  const failed = !!(entry && entry.state === 'failed');
  const minor = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  let body;
  if (!data) {
    body = `<p class="studio-home-empty" data-testid="studio-results-note">${studioEsc(failed
      ? adsStudioText("Meta's numbers are late; we will check again automatically.", 'تأخرت أرقام ميتا؛ سنتحقق مرة أخرى تلقائياً.')
      : adsStudioText('Checking Meta…', 'نتحقق من ميتا…'))}</p>`;
  } else {
    const used = minor(data.metaUsedMinor);
    const paid = minor(data.paidMinor);
    const usedText = used === null ? '' : (paid
      ? adsStudioText(`Meta used ${studioUsd(used)} of ${studioUsd(paid)}`, `استخدمت ميتا ${studioUsd(used)} من ${studioUsd(paid)}`)
      : adsStudioText(`Meta used ${studioUsd(used)} so far`, `استخدمت ميتا ${studioUsd(used)} حتى الآن`));
    const count = value => (typeof adsStudioCount === 'function' ? adsStudioCount(value) : String(value));
    const stats = [
      ['impressions', adsStudioText('Impressions', 'مرات الظهور'), data.impressions],
      ['reach', adsStudioText('Reach', 'الوصول'), data.reach],
      ['results', typeof adsStudioResultTypeLabel === 'function' ? adsStudioResultTypeLabel(data.resultType) : adsStudioText('Results', 'النتائج'), data.resultCount]
    ].filter(([, , value]) => Number.isSafeInteger(value) && value >= 0);
    const ago = data.checkedAgo ? studioPickText(data.checkedAgo, 80) : '';
    const stage = data.stageLabels ? studioPickText(data.stageLabels, 160) : '';
    const note = failed
      ? adsStudioText("Meta's numbers are late; these are the last ones we read.", 'تأخرت أرقام ميتا؛ هذه آخر أرقام قرأناها.')
      : adsStudioText('Reported by Meta', 'بحسب ما تُبلغ به ميتا');
    body = `${stage ? `<p class="studio-ads-money-meaning">${studioEsc(stage)}</p>` : ''}
            ${usedText ? `<p class="studio-ads-results-used" data-testid="studio-results-used">${studioEsc(usedText)}</p>` : ''}
            ${stats.length ? `<dl class="studio-ads-stats studio-results-stats">${stats.map(([key, label, value]) => `<div data-testid="studio-results-stat-${key}"><dt>${studioEsc(label)}</dt><dd>${studioEsc(count(value))}</dd></div>`).join('')}</dl>` : ''}
            ${ago ? `<p class="studio-checked${data.stale ? ' is-stale' : ''}" data-testid="studio-results-checked">${studioEsc(ago)}</p>` : ''}
            <p class="studio-ads-money-note" data-testid="studio-results-note">${studioEsc(note)}</p>`;
  }
  return `
          <section class="studio-ads-box studio-results-card" data-testid="studio-results-card" data-campaign="${studioEsc(id)}" data-state="${data ? (failed ? 'stale' : 'ready') : (failed ? 'failed' : 'loading')}" aria-labelledby="studio-results-title-${studioEsc(id)}" aria-live="polite">
            <h3 id="studio-results-title-${studioEsc(id)}" class="studio-ads-h3">${studioExtrasIcon('chart-no-axes-combined', 'studio-help-status-icon')}<span>${studioEsc(adsStudioText('Meta results', 'نتائج ميتا'))}</span></h3>
            ${body}
          </section>`;
}

// ------------------------------------------------------------------ the login help line (P2-09, J0)

const STUDIO_PUBLIC_CONTACT_KEY = 'albayan.studio.public.contact';  // localStorage: the last answer, for the next visit
const STUDIO_PUBLIC_CONTACT_TTL_MS = 6 * 60 * 60 * 1000;
const STUDIO_PUBLIC_CONTACT_RETRY_MS = 60 * 1000;
const _studioPublicContact = { value: null, at: 0, promise: null, failedAt: 0 };

function studioPublicContactClean(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const email = typeof raw.email === 'string' && raw.email.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+$/.test(raw.email) ? raw.email : '';
  return { whatsapp: studioParsePhone(raw.whatsapp), phone: studioParsePhone(raw.phone), email };
}

function studioPublicContactCached() {
  if (_studioPublicContact.value) return _studioPublicContact.value;
  try {
    const stored = JSON.parse(window.localStorage.getItem(STUDIO_PUBLIC_CONTACT_KEY) || 'null');
    const value = stored && typeof stored === 'object' ? studioPublicContactClean(stored.value) : null;
    if (value) {
      _studioPublicContact.value = value;
      _studioPublicContact.at = Number.isSafeInteger(stored.at) ? stored.at : 0;
    }
  } catch (_) { /* no storage: the server's answer fills the line when it comes */ }
  return _studioPublicContact.value;
}

// GET /api/studio/public/contact (no login): at most once per 6 hours while the answer is known, one
// read at a time, a failed read tried again after a minute. The line on screen is filled in place.
function studioPublicContactLoad(force = false) {
  if (!studioExtrasServer() || typeof apiJson !== 'function') return Promise.resolve(studioPublicContactCached());
  if (_studioPublicContact.promise) return _studioPublicContact.promise;
  const now = Date.now();
  const known = studioPublicContactCached();
  if (!force && known && now - _studioPublicContact.at < STUDIO_PUBLIC_CONTACT_TTL_MS) return Promise.resolve(known);
  if (!force && _studioPublicContact.failedAt && now - _studioPublicContact.failedAt < STUDIO_PUBLIC_CONTACT_RETRY_MS) return Promise.resolve(known);
  _studioPublicContact.promise = apiJson('/api/studio/public/contact', { method: 'GET' }).then(raw => {
    const value = studioPublicContactClean(raw);
    if (value) {
      _studioPublicContact.value = value;
      _studioPublicContact.at = Date.now();
      _studioPublicContact.failedAt = 0;
      try { window.localStorage.setItem(STUDIO_PUBLIC_CONTACT_KEY, JSON.stringify({ value, at: _studioPublicContact.at })); } catch (_) { /* a private window */ }
    }
    return _studioPublicContact.value;
  }, () => {
    _studioPublicContact.failedAt = Date.now();
    return _studioPublicContact.value;
  }).finally(() => {
    _studioPublicContact.promise = null;
    studioLoginHelpMount();
  });
  return _studioPublicContact.promise;
}

// «عميل جديد أو نسيت كلمة المرور؟ راسلنا على واتساب …» for the studio front door (12-views.js draws
// it inside #studio-login-help; before this bundle arrives the div is empty and mounted below).
function renderStudioLoginHelp() {
  if (typeof IS_STUDIO_SHELL !== 'undefined' && !IS_STUDIO_SHELL) return '';
  const contact = studioPublicContactCached();
  studioPublicContactLoad();
  const isAr = typeof state !== 'undefined' && state && state.language === 'ar';
  const link = (href, text, testId, blank) => `<a href="${studioEsc(href)}" data-testid="${testId}" class="font-bold text-indigo-600 dark:text-indigo-300 hover:underline whitespace-nowrap" dir="ltr"${blank ? ' target="_blank" rel="noopener noreferrer"' : ''}>${studioEsc(text)}</a>`;
  const parts = [];
  if (contact && contact.whatsapp) {
    const wa = link(`https://wa.me/${contact.whatsapp.replace(/^\+/, '')}`, contact.whatsapp, 'studio-login-whatsapp', true);
    parts.push(isAr ? `راسلنا على واتساب ${wa}` : `message us on WhatsApp ${wa}`);
  }
  if (contact && contact.phone) {
    const tel = link(`tel:${contact.phone}`, contact.phone, 'studio-login-phone', false);
    parts.push(parts.length ? (isAr ? `أو اتصل بنا على ${tel}` : `or call ${tel}`) : (isAr ? `اتصل بنا على ${tel}` : `call us on ${tel}`));
  }
  const lead = isAr ? 'عميل جديد أو نسيت كلمة المرور؟' : 'New customer or forgot your password?';
  const tail = parts.length ? `${parts.join(' ')}.` : studioEsc(isAr ? 'تواصل مع فريق البيان.' : 'Contact the Albayan team.');
  return `<p class="mt-3 text-sm leading-relaxed text-slate-500 dark:text-slate-400" data-testid="studio-login-help" data-contact="${contact && (contact.whatsapp || contact.phone) ? '1' : '0'}">${studioEsc(lead)} ${tail}</p>`;
}

function studioLoginHelpMount() {
  try {
    const el = typeof document !== 'undefined' ? document.getElementById('studio-login-help') : null;
    if (el) el.innerHTML = renderStudioLoginHelp();
  } catch (_) { /* the next login draw asks again */ }
}

// ------------------------------------------------------------------ registrations

if (typeof studioMeSubscribe === 'function') studioMeSubscribe(studioInboxPulseStart);
try { studioInboxPulseStart(typeof studioMe === 'function' ? studioMe() : null); } catch (_) { /* the next /me read starts it */ }
studioLoginHelpMount();

// Hooks in the files before this one (each guarded with typeof at its call site; all in place since
// stage 15):
// - 15n Help: renderStudioHelpBody draws renderStudioTikTokSection() for ?section=tiktok and the list
//   draws renderStudioTikTokEntry() after the contact card (renderStudioHelpExtras); 15j Home: a
//   "TikTok help" goal, shown while /me says the service is on, opens studioTikTokOpen();
// - 15h shell: the bell's badge stays studioInboxBadge (15n); this file only keeps it current;
// - 15k My ads: renderStudioResultsCard(request.id) draws the results of the request detail;
// - 12-views.js (startup): <div id="studio-login-help"> in the studio login header; 01b-mobile-runtime.js
//   (startup): studioHandleBack() before the app's own Back (15h).
