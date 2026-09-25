// ==========================================
// ALBAYAN STUDIO — HELP DESK, INBOX, STOP REQUEST AND THE STAFF TICKETS (plan tasks P3-05, P3-08,
// P3-09, P3-10; styles in assets/ads-workspace.css, "Albayan Studio help desk")
// ==========================================
// The service screens that exist in BOTH layouts (PLAN.md §5.1: switching the customer layout back
// to classic never hides a ticket, a stop request or the staff queue):
// - Help (v2 ?tab=help, registered with the shell; classic tab 'help', drawn by 15c through
//   renderStudioHelpClassic): my tickets (Open / Resolved, grouped "waiting for our team" and
//   "waiting for you"), New ticket (category chips, subject, message, an optional related item),
//   the thread with the team's answers (always "Albayan team", never a name or an id: the server
//   redacts, this file never asks), Resolve / Reopen, our working hours ("open now" in Tripoli time)
//   and the public contact from /me as a secondary way (D16). Every read is GET /api/studio/tickets*
//   and every change carries an operationId kept until the server answers (a lost answer replays the
//   same ticket or message, never a second one).
// - "Ask about this": studioHelpAskAbout(type, id) opens New ticket pre-filled with a request, a
//   payment (its PAY- code) or a linked page. The v2 request detail reaches it through its own
//   "Ask about this" action (the studioAdsSheet wrapper below); the classic request card and the
//   classic payment rows draw studioHelpAskButton (15c).
// - Ask to stop (P3-10): studioStopSheetOpen(id) is the in-page sheet on an Approved request in both
//   layouts (the v2 action through the wrapper below, the classic card through 15c). It explains what
//   happens, takes an optional note, sends POST /api/ad-studio/campaigns/{id}/stop-request (one
//   operationId per ad until the server answers; the server answers a repeat with the same ticket),
//   then shows the ticket number, the time the team pauses it by and, outside working hours, the
//   on-duty WhatsApp line the answer carries (a user navigation, never a fetch).
// - Inbox (v2 ?tab=inbox): GET /api/studio/activity, read again each time the screen is opened,
//   newest first, unread items marked, "Mark all seen" (POST /api/studio/activity/seen).
//   studioInboxBadge(tab) is the bell's unread badge in the shell's header (15h draws it on every
//   customer screen, so the count stays current while the studio is open).
// - The staff tickets section of the classic review tab (P3-09, renderStudioStaffTicketsClassic,
//   drawn by 15c): the queue by status with stop requests pinned on top (the server's order), the
//   thread, a reply (the ticket becomes "answered"), a status change, and the audited WhatsApp
//   contact link (P3-11) shown only when the customer consented. Admin-only tickets (payment,
//   account) never reach a reviewer: the server leaves them out, and this screen offers no way to
//   ask for them.
// No function of another file is wrapped: the shell (15h), My ads (15k) and the classic screens
// (15c) call this file's hooks behind typeof guards (see "hooks from the other screens" at the end).
// No native dialog anywhere; every server text is escaped; every id in a handler passed its rule
// first.

const STUDIO_HELP_TICKET_ID_RE = /^tkt_[0-9a-f]{40}$/;
const STUDIO_HELP_PAYMENT_REF_RE = /^PAY-[A-Z0-9]{4,16}$/;
const STUDIO_HELP_NEW = 'new';
const STUDIO_HELP_SUBJECT_MIN = 3;
const STUDIO_HELP_SUBJECT_MAX = 120;
const STUDIO_HELP_MESSAGE_MAX = 2000;
const STUDIO_HELP_NOTE_MAX = 1000;
const STUDIO_HELP_FRESH_MS = 30 * 1000;   // an open list or thread asks the server again after this long
const STUDIO_HELP_RETRY_MS = 30 * 1000;   // a failed read waits this long (Try again asks at once)
const STUDIO_INBOX_FRESH_MS = 60 * 1000;
// [code, icon, English, Arabic]: the server's categories (studio_support.CATEGORIES).
const STUDIO_HELP_CATEGORIES = Object.freeze([
  ['ad', 'megaphone', 'My ad', 'إعلاني'],
  ['payment', 'wallet', 'A payment', 'دفعة'],
  ['page', 'flag', 'My page', 'صفحتي'],
  ['account', 'circle-user-round', 'My account', 'حسابي'],
  ['tiktok', 'music', 'TikTok', 'تيك توك'],
  ['other', 'message-circle', 'Something else', 'شيء آخر']
]);
const STUDIO_HELP_STATUSES = Object.freeze(['open', 'answered', 'waiting_customer', 'resolved']);
const STUDIO_HELP_RELATED_TYPES = Object.freeze(['campaign', 'payment', 'page']);
// status -> [tone, icon, customer EN, customer AR, staff EN, staff AR]
const STUDIO_HELP_STATUS_LOOK = Object.freeze({
  open: ['amber', 'clock', 'Waiting for our team', 'بانتظار فريقنا', 'Waiting for the team', 'بانتظار الفريق'],
  answered: ['blue', 'message-circle-reply', 'Waiting for you', 'بانتظار ردك', 'Answered', 'تم الرد'],
  waiting_customer: ['blue', 'message-circle-reply', 'Waiting for you', 'بانتظار ردك', 'Waiting for the customer', 'بانتظار العميل'],
  resolved: ['green', 'check', 'Resolved', 'تم الحل', 'Resolved', 'تم الحل']
});
// [filter, English, Arabic]: the staff queue filters (the server's status values plus "active").
const STUDIO_STAFF_FILTERS = Object.freeze([
  ['active', 'Active', 'الجارية'],
  ['open', 'Waiting for the team', 'بانتظار الفريق'],
  ['answered', 'Answered', 'تم الرد'],
  ['waiting_customer', 'Waiting for the customer', 'بانتظار العميل'],
  ['resolved', 'Resolved', 'تم الحل']
]);
const STUDIO_HELP_DAYS = Object.freeze([
  ['sun', 'Sun', 'Sunday', 'الأحد'], ['mon', 'Mon', 'Monday', 'الاثنين'], ['tue', 'Tue', 'Tuesday', 'الثلاثاء'],
  ['wed', 'Wed', 'Wednesday', 'الأربعاء'], ['thu', 'Thu', 'Thursday', 'الخميس'], ['fri', 'Fri', 'Friday', 'الجمعة'],
  ['sat', 'Sat', 'Saturday', 'السبت']
]);
const STUDIO_HELP_MONTHS = Object.freeze([
  ['Jan', 'يناير'], ['Feb', 'فبراير'], ['Mar', 'مارس'], ['Apr', 'أبريل'], ['May', 'مايو'], ['Jun', 'يونيو'],
  ['Jul', 'يوليو'], ['Aug', 'أغسطس'], ['Sep', 'سبتمبر'], ['Oct', 'أكتوبر'], ['Nov', 'نوفمبر'], ['Dec', 'ديسمبر']
]);
// kind -> icon (studio_activity.KINDS)
const STUDIO_INBOX_KINDS = Object.freeze({
  request_sent_back: 'message-square-warning', request_approved: 'badge-check', request_live: 'rocket',
  request_rejected: 'x', ad_ended: 'hourglass', settled: 'scale', ticket_answered: 'message-circle-reply',
  payment_confirmed: 'wallet', stop_request_received: 'hand'
});

const _studioHelp = {
  forUser: '', generation: 0,
  lists: Object.create(null),   // 'active' | 'resolved' -> {items, nextCursor, loadedAt, failedAt, loading, again, error, more}
  threads: new Map(),           // ticket id -> {ticket, messages, loadedAt, failedAt, loading, error}
  draft: null,                  // the New ticket form (studioHelpNewDraft)
  replies: new Map(),           // ticket id -> {text, operationId, sending, error}
  busy: new Map(),              // 'resolve:<id>' | 'reopen:<id>' -> operationId in flight
  classic: { view: 'list', id: '', filter: 'active' },
  pages: { list: null, loadedAt: 0, failedAt: 0, loading: null }
};
const _studioStop = { forUser: '', id: '', note: '', sending: false, error: '', result: null, el: null, opener: null, attempts: new Map(), requested: new Map() };
const _studioInbox = { forUser: '', generation: 0, items: [], nextCursor: null, unread: 0, seenAt: '', loadedAt: 0, failedAt: 0, loading: null, again: false, error: null, more: null, marking: null, onScreen: false };
const _studioStaff = {
  forUser: '', generation: 0, filter: 'active',
  list: null,                   // {items, nextCursor, loadedAt, failedAt, loading, again, error, more}
  openId: '', threads: new Map(), replies: new Map(), busy: new Map(), contacts: new Map()
};

// ------------------------------------------------------------------ small helpers

function studioHelpUserId() {
  return typeof studioMeUserId === 'function' ? studioMeUserId() : '';
}

function studioHelpServer() {
  return typeof isServerModeEnabled === 'function' && isServerModeEnabled();
}

function studioHelpMe() {
  return typeof studioMe === 'function' ? studioMe() : null;
}

// The Help service is open for this user (/me services.help; the layout never matters, P3-20).
function studioHelpOn() {
  const me = studioHelpMe();
  return !!(me && me.services && me.services.help === true);
}

function studioStopSheetAvailable() {
  const me = studioHelpMe();
  return !!(me && me.services && me.services.stopRequest === true) && studioHelpServer();
}

// The classic layout shows its 'help' tab when the service is on (15c adsStudioTabsForUser).
function studioHelpClassicTab() {
  return studioHelpOn() && studioHelpServer();
}

function studioHelpInV2() {
  return typeof studioV2Frame === 'function' && studioV2Frame() === 'customer';
}

function studioHelpText(value, max = 300) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function studioHelpTime(value) {
  const text = studioHelpText(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? text : '';
}

function studioHelpIcon(name, className = 'studio-v2-icon') {
  return typeof studioV2Icon === 'function' ? studioV2Icon(name, className) : '';
}

function studioHelpOperationId(prefix) {
  return Security.generateSecureId(prefix);
}

function studioHelpErrorText(error, kind = 'action') {
  if (error && error.studio && error.studio.text) return error.studio.text;
  try { return studioErrorInfo(error, kind).text; } catch (_) {
    return kind === 'read'
      ? adsStudioText('This could not be loaded. Try again in a moment.', 'تعذّر التحميل. أعد المحاولة بعد لحظات.')
      : adsStudioText('The action could not be completed.', 'تعذّر إتمام العملية.');
  }
}

function studioHelpErrorCode(error) {
  return String((error && error.studio && error.studio.code) || '');
}

function studioHelpRedraw() {
  try {
    if (typeof state === 'undefined' || state.currentView !== 'ads-studio') return;
    if (typeof studioV2Rerender === 'function') studioV2Rerender();
    else if (typeof render === 'function') render();
  } catch (_) { /* the next draw shows the state */ }
}

function studioHelpNotify(ok, title, text) {
  if (typeof showNotification === 'function') showNotification(title, text, ok ? 'success' : 'error');
}

function studioHelpArCount(count, one, two, few, many) {
  if (count === 1) return one;
  if (count === 2) return two;
  return count >= 3 && count <= 10 ? `${count} ${few}` : `${count} ${many}`;
}

// "5 min ago" / «قبل 5 دقائق»; '' when the value is not a time.
function studioHelpAgo(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return adsStudioText('just now', 'الآن');
  if (minutes < 60) return adsStudioText(`${minutes} min ago`, `قبل ${studioHelpArCount(minutes, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة')}`);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return adsStudioText(`${hours} h ago`, `قبل ${studioHelpArCount(hours, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}`);
  const days = Math.round(hours / 24);
  return adsStudioText(`${days} days ago`, `قبل ${studioHelpArCount(days, 'يوم', 'يومين', 'أيام', 'يوماً')}`);
}

// The parts of a server time in Tripoli time (Latin digits, like every amount).
function studioHelpParts(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Tripoli', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const get = type => String((parts.find(part => part.type === type) || {}).value || '');
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    const hour = get('hour') === '24' ? '00' : get('hour');
    if (weekday >= 0 && /^\d{1,2}$/.test(get('day')) && /^\d{1,2}$/.test(get('month'))) {
      return { weekday, day: Number(get('day')), month: Number(get('month')), hour, minute: get('minute') };
    }
  } catch (_) { /* the phone's own zone below */ }
  return { weekday: date.getDay(), day: date.getDate(), month: date.getMonth() + 1, hour: String(date.getHours()).padStart(2, '0'), minute: String(date.getMinutes()).padStart(2, '0') };
}

// "Sun 25 Sep, 10:00" / «الأحد 25 سبتمبر، 10:00» (Tripoli time), '' when the value is not a time.
function studioHelpWhen(iso) {
  const parts = studioHelpParts(iso);
  if (!parts) return '';
  const day = STUDIO_HELP_DAYS[parts.weekday];
  const month = STUDIO_HELP_MONTHS[parts.month - 1];
  const dayName = day ? adsStudioText(day[1], day[3]) : '';
  const monthName = month ? adsStudioText(month[0], month[1]) : '';
  return adsStudioText(`${dayName} ${parts.day} ${monthName}, ${parts.hour}:${parts.minute}`, `${dayName} ${parts.day} ${monthName}، ${parts.hour}:${parts.minute}`).trim();
}

function studioHelpCategory(code) {
  return STUDIO_HELP_CATEGORIES.find(item => item[0] === String(code || '')) || null;
}

function studioHelpCategoryLabel(code) {
  const item = studioHelpCategory(code);
  return item ? adsStudioText(item[2], item[3]) : '';
}

// A stored ticket as the server shows it, every field read through its rule; null when it has no id.
function studioHelpCleanTicket(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '');
  if (!STUDIO_HELP_TICKET_ID_RE.test(id)) return null;
  const status = STUDIO_HELP_STATUSES.includes(raw.status) ? raw.status : 'open';
  const relatedType = STUDIO_HELP_RELATED_TYPES.includes(raw.relatedType) ? raw.relatedType : '';
  const relatedId = relatedType && typeof raw.relatedId === 'string' && Security.isValidRecordId(raw.relatedId) ? raw.relatedId : '';
  return {
    id,
    number: /^T-\d{4,12}$/.test(String(raw.number || '')) ? String(raw.number) : '',
    subject: studioHelpText(raw.subject, STUDIO_HELP_SUBJECT_MAX),
    category: studioHelpCategory(raw.category) ? String(raw.category) : 'other',
    status,
    audience: raw.audience === 'admin' ? 'admin' : 'staff',
    urgent: raw.priority === 'urgent' || raw.urgent === true,
    stopRequest: raw.kind === 'stop_request',
    relatedType: relatedType || (relatedId ? relatedType : ''),
    relatedId,
    createdAt: studioHelpTime(raw.createdAt),
    updatedAt: studioHelpTime(raw.updatedAt),
    dueAt: status === 'open' ? studioHelpTime(raw.dueAt) : '',
    lastMessageAt: studioHelpTime(raw.lastMessageAt),
    resolvedAt: studioHelpTime(raw.resolvedAt),
    reopenUntil: studioHelpTime(raw.reopenUntil),
    // staff only (never drawn as a person: the owner id is used for the audited contact link only)
    ownerId: typeof raw.ownerId === 'string' && Security.isValidRecordId(raw.ownerId) ? raw.ownerId : '',
    overdue: raw.overdue === true,
    messageCount: Number.isSafeInteger(raw.messageCount) ? raw.messageCount : 0
  };
}

function studioHelpCleanMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '');
  if (!Security.isValidRecordId(id)) return null;
  return { id, from: raw.from === 'team' ? 'team' : 'customer', text: studioHelpText(raw.text, STUDIO_HELP_MESSAGE_MAX), createdAt: studioHelpTime(raw.createdAt) };
}

function studioHelpCleanList(raw) {
  const items = raw && Array.isArray(raw.tickets) ? raw.tickets.map(studioHelpCleanTicket).filter(Boolean) : [];
  const cursor = raw && typeof raw.nextCursor === 'string' && /^[0-9:]+tkt_[0-9a-f]{40}$/.test(raw.nextCursor) ? raw.nextCursor : null;
  return { items, nextCursor: cursor };
}

function studioHelpEmptySlot() {
  return { items: [], nextCursor: null, loadedAt: 0, failedAt: 0, loading: null, again: false, error: null, more: null };
}

// A read of one list slot (the customer's or the staff's): the page, or one more page (cursor).
function studioHelpReadSlot(slot, path, generationOf, force, more = false) {
  if (slot.loading) {
    if (force && !more) slot.again = true;
    return slot.loading;
  }
  const now = Date.now();
  if (!more && !force) {
    if (slot.failedAt && now - slot.failedAt < STUDIO_HELP_RETRY_MS) return null;
    if (slot.loadedAt && now - slot.loadedAt < STUDIO_HELP_FRESH_MS) return null;
  }
  if (more && !slot.nextCursor) return null;
  const generation = generationOf();
  const signal = typeof studioReadSignal === 'function' ? studioReadSignal() : null;
  const url = more ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(slot.nextCursor)}` : path;
  slot.again = false;
  const promise = studioApi(url, { method: 'GET' }).then(raw => {
    if (generation !== generationOf()) return;
    const page = studioHelpCleanList(raw);
    if (more) {
      const seen = new Set(slot.items.map(item => item.id));
      slot.items = slot.items.concat(page.items.filter(item => !seen.has(item.id)));
    } else {
      slot.items = page.items;
      slot.loadedAt = now;
    }
    slot.nextCursor = page.nextCursor;
    slot.failedAt = 0;
    slot.error = null;
  }, error => {
    if (generation !== generationOf()) return;
    if (typeof studioReadCancelled === 'function' && studioReadCancelled(error, signal)) return;  // the app moved on
    slot.failedAt = Date.now();
    slot.error = { code: studioHelpErrorCode(error), text: studioHelpErrorText(error, 'read') };
  }).finally(() => {
    if (generation !== generationOf()) return;
    slot.loading = null;
    if (slot.again) {
      slot.again = false;
      studioHelpReadSlot(slot, path, generationOf, true);
    }
    studioHelpRedraw();
  });
  slot.loading = promise;
  return promise;
}

// ------------------------------------------------------------------ the customer's tickets (P3-08)

function studioHelpScope() {
  const uid = studioHelpUserId();
  if (_studioHelp.forUser !== uid) {
    _studioHelp.generation++;
    _studioHelp.forUser = uid;
    _studioHelp.lists = Object.create(null);
    _studioHelp.threads = new Map();
    _studioHelp.draft = null;
    _studioHelp.replies = new Map();
    _studioHelp.busy = new Map();
    _studioHelp.classic = { view: 'list', id: '', filter: 'active' };
    _studioHelp.pages = { list: null, loadedAt: 0, failedAt: 0, loading: null };
  }
  return uid;
}

function studioHelpGeneration() {
  return _studioHelp.generation;
}

function studioHelpListSlot(filter) {
  studioHelpScope();
  const key = filter === 'resolved' ? 'resolved' : 'active';
  if (!_studioHelp.lists[key]) _studioHelp.lists[key] = studioHelpEmptySlot();
  return _studioHelp.lists[key];
}

function studioHelpWantList(filter, force = false, more = false) {
  if (!studioHelpScope() || !studioHelpServer()) return null;
  const key = filter === 'resolved' ? 'resolved' : 'active';
  return studioHelpReadSlot(studioHelpListSlot(key), `/api/studio/tickets?status=${key}`, studioHelpGeneration, force, more);
}

function studioHelpMore(filter) {
  return studioHelpWantList(filter, false, true);
}

function studioHelpRetry(filter) {
  const slot = studioHelpListSlot(filter);
  slot.failedAt = 0;
  studioHelpWantList(filter, true);
  studioHelpRedraw();
}

// Every list the customer has read: the thread of a ticket the server listed starts from that row.
function studioHelpKnownTicket(id) {
  for (const slot of Object.values(_studioHelp.lists)) {
    const hit = slot.items.find(item => item.id === id);
    if (hit) return hit;
  }
  return null;
}

function studioHelpThreadSlot(id) {
  studioHelpScope();
  if (!_studioHelp.threads.has(id)) _studioHelp.threads.set(id, { ticket: null, messages: [], loadedAt: 0, failedAt: 0, loading: null, error: null });
  return _studioHelp.threads.get(id);
}

function studioHelpWantThread(id, force = false) {
  const ticketId = String(id || '');
  if (!STUDIO_HELP_TICKET_ID_RE.test(ticketId) || !studioHelpScope() || !studioHelpServer()) return null;
  const slot = studioHelpThreadSlot(ticketId);
  if (slot.loading) return slot.loading;
  const now = Date.now();
  if (!force) {
    if (slot.failedAt && now - slot.failedAt < STUDIO_HELP_RETRY_MS) return null;
    if (slot.loadedAt && now - slot.loadedAt < STUDIO_HELP_FRESH_MS) return null;
  }
  const generation = _studioHelp.generation;
  const signal = typeof studioReadSignal === 'function' ? studioReadSignal() : null;
  const promise = studioApi(`/api/studio/tickets/${encodeURIComponent(ticketId)}`, { method: 'GET' }).then(raw => {
    if (generation !== _studioHelp.generation) return;
    const ticket = studioHelpCleanTicket(raw && raw.ticket);
    if (!ticket) {
      slot.failedAt = Date.now();
      slot.error = { code: 'UNKNOWN', text: adsStudioText('This could not be loaded. Try again in a moment.', 'تعذّر التحميل. أعد المحاولة بعد لحظات.') };
      return;
    }
    slot.ticket = ticket;
    slot.messages = raw && Array.isArray(raw.messages) ? raw.messages.map(studioHelpCleanMessage).filter(Boolean).slice(0, 50) : [];
    slot.loadedAt = now;
    slot.failedAt = 0;
    slot.error = null;
    studioHelpUpdateListed(ticket);
  }, error => {
    if (generation !== _studioHelp.generation) return;
    if (typeof studioReadCancelled === 'function' && studioReadCancelled(error, signal)) return;
    slot.failedAt = Date.now();
    slot.error = { code: studioHelpErrorCode(error), text: studioHelpErrorText(error, 'read') };
  }).finally(() => {
    if (generation !== _studioHelp.generation) return;
    slot.loading = null;
    studioHelpRedraw();
  });
  slot.loading = promise;
  return promise;
}

// A ticket the server just answered with replaces its row in the lists it is in (a row that no
// longer fits its list's filter stays on screen with its new status until that list is read again,
// so the reader sees what their action did); a list it now belongs to is read again at its next draw.
function studioHelpUpdateListed(ticket) {
  for (const [key, slot] of Object.entries(_studioHelp.lists)) {
    const at = slot.items.findIndex(item => item.id === ticket.id);
    const fits = key === 'resolved' ? ticket.status === 'resolved' : ticket.status !== 'resolved';
    if (at >= 0) slot.items[at] = ticket;
    else if (fits) slot.loadedAt = 0;
  }
}

function studioHelpRetryThread(id) {
  const slot = studioHelpThreadSlot(String(id || ''));
  slot.failedAt = 0;
  studioHelpWantThread(id, true);
  studioHelpRedraw();
}

function studioHelpRefreshThread(id) {
  studioHelpWantThread(id, true);
  studioHelpRedraw();
}

// ------------------------------------------------------------------ navigation (both layouts)

// {view: 'list'|'new'|'thread', id, filter} from the v2 address, or from the classic tab's own state.
function studioHelpViewOf(route) {
  if (route && typeof route === 'object') {
    const id = String(route.id || '');
    if (id === STUDIO_HELP_NEW) return { view: 'new', id: '', filter: 'active' };
    if (STUDIO_HELP_TICKET_ID_RE.test(id)) return { view: 'thread', id, filter: 'active' };
    return { view: 'list', id: '', filter: String(route.section || '') === 'resolved' ? 'resolved' : 'active' };
  }
  studioHelpScope();
  const classic = _studioHelp.classic;
  return { view: classic.view, id: classic.id, filter: classic.filter === 'resolved' ? 'resolved' : 'active' };
}

// Opens the list (with a filter), the New ticket form or a thread: the v2 address in the v2 layout
// (Back returns to the list), the classic tab's own state otherwise.
function studioHelpGo(view, id = '', filter = '') {
  const want = view === 'new' || view === 'thread' ? String(view) : 'list';
  const ticket = STUDIO_HELP_TICKET_ID_RE.test(String(id || '')) ? String(id) : '';
  if (want === 'thread' && !ticket) return false;
  const resolved = filter === 'resolved';
  if (studioHelpInV2()) {
    return studioV2Go({ tab: 'help', section: want === 'list' && resolved ? 'resolved' : '', id: want === 'new' ? STUDIO_HELP_NEW : ticket });
  }
  studioHelpScope();
  _studioHelp.classic = { view: want, id: ticket, filter: want === 'list' ? (resolved ? 'resolved' : 'active') : _studioHelp.classic.filter };
  if (typeof _adsStudioActiveTab !== 'undefined' && _adsStudioActiveTab !== 'help' && typeof setAdsStudioTab === 'function') setAdsStudioTab('help');
  else studioHelpRedraw();
  return true;
}

function studioHelpOpen(id) {
  return studioHelpGo('thread', id);
}

function studioHelpFilter(filter) {
  return studioHelpGo('list', '', filter);
}

function studioHelpNew() {
  if (!studioHelpOn()) return false;
  studioHelpScope();
  if (!_studioHelp.draft) _studioHelp.draft = studioHelpNewDraft();
  return studioHelpGo('new');
}

// ------------------------------------------------------------------ New ticket and "Ask about this"

function studioHelpNewDraft(prefill = {}) {
  const category = studioHelpCategory(prefill.category) ? String(prefill.category) : '';
  return {
    category, subject: studioHelpText(prefill.subject, STUDIO_HELP_SUBJECT_MAX), message: '',
    relatedType: STUDIO_HELP_RELATED_TYPES.includes(prefill.relatedType) ? prefill.relatedType : '',
    relatedId: studioHelpText(prefill.relatedId, 80), relatedLabel: studioHelpText(prefill.relatedLabel, 160),
    operationId: studioHelpOperationId('ticket'), sending: false, error: '', problems: {}
  };
}

// What a ticket can be about, from what this device knows of the owner's items: their requests
// (Home's rows, 15j), the payments waiting in the wallet summary (their PAY- codes) and the linked
// pages (GET /api/studio/pages, read when the form is drawn). Each: {type, id, label, category}.
function studioHelpRelatedOptions() {
  const out = [];
  const requests = typeof studioDataRequests === 'function' ? studioDataRequests() : [];
  for (const request of requests) {
    const name = typeof studioDataName === 'function' ? studioDataName(request) : studioHelpText(request.name, 160);
    const ref = /^ALB-S-[A-Za-z0-9]{1,20}$/.test(String(request.studioRef || '')) ? ` (${request.studioRef})` : '';
    out.push({ type: 'campaign', id: request.id, label: `${name}${ref}`, category: 'ad' });
  }
  const wallet = typeof studioDataValue === 'function' ? studioDataValue('wallet') : null;
  const pending = wallet && Array.isArray(wallet.pendingPayments) ? wallet.pendingPayments : [];
  for (const item of pending) {
    const reference = item && typeof item.reference === 'string' ? item.reference : '';
    if (STUDIO_HELP_PAYMENT_REF_RE.test(reference)) out.push({ type: 'payment', id: reference, label: reference, category: 'payment' });
  }
  const pages = Array.isArray(_studioHelp.pages.list) ? _studioHelp.pages.list : [];
  for (const page of pages) out.push({ type: 'page', id: page.id, label: page.name || adsStudioText('Linked page', 'صفحة مربوطة'), category: 'page' });
  return out;
}

function studioHelpWantPages(force = false) {
  if (!studioHelpScope() || !studioHelpServer() || typeof adsStudioNormalizePostPages !== 'function') return null;
  const slot = _studioHelp.pages;
  if (slot.loading) return slot.loading;
  const now = Date.now();
  if (!force && ((slot.failedAt && now - slot.failedAt < STUDIO_HELP_RETRY_MS) || (slot.loadedAt && now - slot.loadedAt < 5 * 60 * 1000))) return null;
  const generation = _studioHelp.generation;
  const promise = studioApi('/api/studio/pages', { method: 'GET' }).then(raw => {
    if (generation !== _studioHelp.generation) return;
    slot.list = adsStudioNormalizePostPages(raw);
    slot.loadedAt = now;
    slot.failedAt = 0;
  }, () => {
    if (generation !== _studioHelp.generation) return;
    slot.failedAt = Date.now();  // the picker simply lists no pages
  }).finally(() => {
    if (generation !== _studioHelp.generation) return;
    slot.loading = null;
    studioHelpRedraw();
  });
  slot.loading = promise;
  return promise;
}

// The item a ticket is opened about: a request (its name and studio code), a payment (its PAY-
// code or request id) or a linked page; null when it is not this owner's.
function studioHelpRelated(type, id) {
  const kind = String(type || '');
  const wanted = String(id || '');
  if (!STUDIO_HELP_RELATED_TYPES.includes(kind) || !Security.isValidRecordId(wanted)) return null;
  if (kind === 'campaign') {
    const request = typeof studioDataRequest === 'function' ? studioDataRequest(wanted) : null;
    if (!request) return null;
    const option = studioHelpRelatedOptions().find(item => item.type === 'campaign' && item.id === wanted);
    const name = typeof studioDataName === 'function' ? studioDataName(request) : studioHelpText(request.name, 160);
    return { type: kind, id: wanted, label: option ? option.label : name, category: 'ad', subject: adsStudioText(`About my ad: ${name}`, `بخصوص إعلاني: ${name}`).slice(0, STUDIO_HELP_SUBJECT_MAX) };
  }
  if (kind === 'payment') {
    const label = STUDIO_HELP_PAYMENT_REF_RE.test(wanted) ? wanted : adsStudioText('Payment request', 'طلب دفع');
    return { type: kind, id: wanted, label, category: 'payment', subject: adsStudioText(`About my payment ${label}`, `بخصوص دفعتي ${label}`).slice(0, STUDIO_HELP_SUBJECT_MAX) };
  }
  const page = studioHelpRelatedOptions().find(item => item.type === 'page' && item.id === wanted);
  const label = page ? page.label : adsStudioText('My page', 'صفحتي');
  return { type: kind, id: wanted, label, category: 'page', subject: adsStudioText(`About my page: ${label}`, `بخصوص صفحتي: ${label}`).slice(0, STUDIO_HELP_SUBJECT_MAX) };
}

// "Ask about this" from a request, a payment row or a page card: New ticket, pre-filled.
function studioHelpAskAbout(type, id) {
  if (!studioHelpOn()) return false;
  const related = studioHelpRelated(type, id);
  if (!related) return false;
  studioHelpScope();
  _studioHelp.draft = studioHelpNewDraft({ category: related.category, subject: related.subject, relatedType: related.type, relatedId: related.id, relatedLabel: related.label });
  return studioHelpGo('new');
}

// The button other screens draw (15c: the classic request card and payment rows); '' while the
// service is off. compact: the small variant for a row.
function studioHelpAskButton(type, id, compact = false) {
  if (!studioHelpOn() || !STUDIO_HELP_RELATED_TYPES.includes(String(type || '')) || !Security.isValidRecordId(String(id || ''))) return '';
  const label = type === 'payment' ? adsStudioText('Ask about this payment', 'اسأل عن هذه الدفعة') : adsStudioText('Ask about this', 'اسأل عن هذا');
  return `<button type="button" class="studio-help-ask${compact ? ' is-compact' : ''}" data-testid="studio-ask-${studioEsc(type)}-${studioEsc(id)}" onclick="studioHelpAskAbout('${studioEsc(type)}', '${studioEsc(id)}')">${studioHelpIcon('message-circle', 'studio-help-ask-icon')}<span>${studioEsc(label)}</span></button>`;
}

function studioHelpDraft() {
  studioHelpScope();
  if (!_studioHelp.draft) _studioHelp.draft = studioHelpNewDraft();
  return _studioHelp.draft;
}

function studioHelpDraftSet(field, value) {
  const draft = studioHelpDraft();
  if (draft.sending) return;
  if (field === 'subject') draft.subject = String(value || '').slice(0, STUDIO_HELP_SUBJECT_MAX);
  else if (field === 'message') draft.message = String(value || '').slice(0, STUDIO_HELP_MESSAGE_MAX);
  else return;
  if (draft.problems[field]) { delete draft.problems[field]; studioHelpRedraw(); }
}

function studioHelpDraftCategory(code) {
  const draft = studioHelpDraft();
  if (draft.sending || !studioHelpCategory(code)) return;
  draft.category = String(code);
  delete draft.problems.category;
  studioHelpRedraw();
}

// The related-item picker: 'campaign:<id>' / 'payment:<ref>' / 'page:<id>' or '' (none).
function studioHelpDraftRelated(value) {
  const draft = studioHelpDraft();
  if (draft.sending) return;
  const text = String(value || '');
  const at = text.indexOf(':');
  const type = at > 0 ? text.slice(0, at) : '';
  const id = at > 0 ? text.slice(at + 1) : '';
  const option = studioHelpRelatedOptions().find(item => item.type === type && item.id === id);
  if (!option) {
    draft.relatedType = '';
    draft.relatedId = '';
    draft.relatedLabel = '';
  } else {
    draft.relatedType = option.type;
    draft.relatedId = option.id;
    draft.relatedLabel = option.label;
    if (!draft.category) draft.category = option.category;
  }
  studioHelpRedraw();
}

function studioHelpValidate(draft) {
  const problems = {};
  if (!studioHelpCategory(draft.category)) problems.category = adsStudioText('Choose what the ticket is about.', 'اختر موضوع التذكرة.');
  const subject = draft.subject.trim();
  if (subject.length < STUDIO_HELP_SUBJECT_MIN || subject.length > STUDIO_HELP_SUBJECT_MAX) {
    problems.subject = adsStudioText(`A subject of ${STUDIO_HELP_SUBJECT_MIN} to ${STUDIO_HELP_SUBJECT_MAX} characters.`, `عنوان من ${STUDIO_HELP_SUBJECT_MIN} إلى ${STUDIO_HELP_SUBJECT_MAX} حرفاً.`);
  }
  const message = draft.message.trim();
  if (!message || message.length > STUDIO_HELP_MESSAGE_MAX) {
    problems.message = adsStudioText(`Write your message (up to ${STUDIO_HELP_MESSAGE_MAX} characters).`, `اكتب رسالتك (حتى ${STUDIO_HELP_MESSAGE_MAX} حرف).`);
  }
  return problems;
}

// Sends the New ticket (single flight; the operationId stays until the server answers, so a lost
// answer replays the same ticket). Resolves to the ticket, or null.
function studioHelpSend() {
  const draft = studioHelpDraft();
  if (draft.sending) return null;
  const problems = studioHelpValidate(draft);
  if (Object.keys(problems).length) {
    draft.problems = problems;
    draft.error = '';
    studioHelpRedraw();
    return null;
  }
  if (!studioHelpServer()) {
    draft.error = adsStudioText('Sending a ticket needs the connection to Albayan.', 'إرسال التذكرة يحتاج الاتصال بالبيان.');
    studioHelpRedraw();
    return null;
  }
  draft.sending = true;
  draft.error = '';
  draft.problems = {};
  studioHelpRedraw();
  const generation = _studioHelp.generation;
  const body = { subject: draft.subject.trim(), category: draft.category, message: draft.message.trim(), operationId: draft.operationId };
  if (draft.relatedType && draft.relatedId) {
    body.relatedType = draft.relatedType;
    body.relatedId = draft.relatedId;
  }
  return studioApi('/api/studio/tickets', { method: 'POST', body }).then(raw => {
    if (generation !== _studioHelp.generation) return null;
    const ticket = studioHelpCleanTicket(raw && raw.ticket);
    const first = studioHelpCleanMessage(raw && raw.message);
    _studioHelp.draft = null;
    if (ticket) {
      const slot = studioHelpThreadSlot(ticket.id);
      slot.ticket = ticket;
      slot.messages = first ? [first] : [];
      slot.loadedAt = Date.now();
      slot.error = null;
      studioHelpUpdateListed(ticket);
      const due = ticket.dueAt ? studioHelpWhen(ticket.dueAt) : '';
      studioHelpNotify(true, adsStudioText('Ticket sent', 'أُرسلت التذكرة'), due
        ? adsStudioText(`${ticket.number}: we reply by ${due} (Tripoli time).`, `${ticket.number}: نرد قبل ${due} (بتوقيت طرابلس).`)
        : adsStudioText(`${ticket.number}: we reply during our working hours.`, `${ticket.number}: نرد خلال ساعات عملنا.`));
      studioHelpGo('thread', ticket.id);
    } else {
      studioHelpListSlot('active').loadedAt = 0;
      studioHelpGo('list');
    }
    return ticket;
  }, error => {
    if (generation !== _studioHelp.generation) return null;
    draft.sending = false;
    draft.error = studioHelpErrorText(error, 'action');
    const code = studioHelpErrorCode(error);
    if (code === 'IDEMPOTENCY_MISMATCH') {
      draft.operationId = studioHelpOperationId('ticket');  // the first send made a ticket with other words: see the list
      studioHelpListSlot('active').loadedAt = 0;
    } else if (code === 'SERVICE_OFF' && typeof studioLoadMe === 'function') {
      studioLoadMe(0);
    }
    studioHelpRedraw();
    return null;
  });
}

function studioHelpCancelNew() {
  studioHelpScope();
  if (_studioHelp.draft && !_studioHelp.draft.sending) _studioHelp.draft = null;
  return studioHelpGo('list');
}

// ------------------------------------------------------------------ replies, resolve and reopen

function studioHelpReply(id) {
  studioHelpScope();
  const key = String(id || '');
  if (!_studioHelp.replies.has(key)) _studioHelp.replies.set(key, { text: '', operationId: studioHelpOperationId('reply'), sending: false, error: '' });
  return _studioHelp.replies.get(key);
}

function studioHelpReplySet(id, value) {
  const reply = studioHelpReply(id);
  if (!reply.sending) reply.text = String(value || '').slice(0, STUDIO_HELP_MESSAGE_MAX);
}

// The message a ticket thread gets from its owner (customer) or the team (staff routes).
function studioHelpPostMessage(id, reply, path, author) {
  const ticketId = String(id || '');
  if (!STUDIO_HELP_TICKET_ID_RE.test(ticketId) || reply.sending) return null;
  const text = reply.text.trim();
  if (!text) {
    reply.error = adsStudioText('Write your message first.', 'اكتب رسالتك أولاً.');
    studioHelpRedraw();
    return null;
  }
  if (!studioHelpServer()) {
    reply.error = adsStudioText('Sending needs the connection to Albayan.', 'الإرسال يحتاج الاتصال بالبيان.');
    studioHelpRedraw();
    return null;
  }
  reply.sending = true;
  reply.error = '';
  studioHelpRedraw();
  const staff = author === 'team';
  const store = staff ? _studioStaff : _studioHelp;
  const generation = store.generation;
  return studioApi(path, { method: 'POST', body: { text, operationId: reply.operationId } }).then(raw => {
    if (generation !== store.generation) return null;
    const ticket = studioHelpCleanTicket(raw && raw.ticket);
    const message = studioHelpCleanMessage(raw && raw.message);
    reply.text = '';
    reply.operationId = studioHelpOperationId('reply');
    reply.sending = false;
    const slot = staff ? studioStaffThreadSlot(ticketId) : studioHelpThreadSlot(ticketId);
    if (ticket) slot.ticket = ticket;
    if (message && !slot.messages.some(item => item.id === message.id)) slot.messages = slot.messages.concat([message]);
    if (staff && ticket) studioStaffUpdateListed(ticket);
    else if (ticket) studioHelpUpdateListed(ticket);
    studioHelpRedraw();
    return message;
  }, error => {
    if (generation !== store.generation) return null;
    reply.sending = false;
    reply.error = studioHelpErrorText(error, 'action');
    if (studioHelpErrorCode(error) === 'IDEMPOTENCY_MISMATCH') reply.operationId = studioHelpOperationId('reply');
    if (staff) studioStaffWantThread(ticketId, true); else studioHelpWantThread(ticketId, true);
    studioHelpRedraw();
    return null;
  });
}

function studioHelpReplySend(id) {
  return studioHelpPostMessage(id, studioHelpReply(id), `/api/studio/tickets/${encodeURIComponent(String(id || ''))}/messages`, 'customer');
}

// Resolve or reopen the owner's own ticket (single flight per ticket and action).
function studioHelpStatus(id, action) {
  const ticketId = String(id || '');
  const kind = action === 'reopen' ? 'reopen' : 'resolve';
  if (!STUDIO_HELP_TICKET_ID_RE.test(ticketId) || !studioHelpServer()) return null;
  studioHelpScope();
  const key = `${kind}:${ticketId}`;
  if (_studioHelp.busy.has(key)) return null;
  const operationId = studioHelpOperationId(kind);
  _studioHelp.busy.set(key, operationId);
  studioHelpRedraw();
  const generation = _studioHelp.generation;
  return studioApi(`/api/studio/tickets/${encodeURIComponent(ticketId)}/${kind}`, { method: 'POST', body: { operationId } }).then(raw => {
    if (generation !== _studioHelp.generation) return null;
    const ticket = studioHelpCleanTicket(raw && raw.ticket);
    if (ticket) {
      studioHelpThreadSlot(ticketId).ticket = ticket;
      studioHelpUpdateListed(ticket);
    }
    studioHelpNotify(true, kind === 'resolve' ? adsStudioText('Ticket resolved', 'تم حل التذكرة') : adsStudioText('Ticket reopened', 'أُعيد فتح التذكرة'),
      kind === 'resolve' ? adsStudioText('You can reopen it within 7 days if needed.', 'يمكنك إعادة فتحها خلال 7 أيام عند الحاجة.') : adsStudioText('The team will look at it again.', 'سينظر فيها الفريق مرة أخرى.'));
    return ticket;
  }, error => {
    if (generation !== _studioHelp.generation) return null;
    studioHelpNotify(false, adsStudioText('Not done', 'لم يتم'), studioHelpErrorText(error, 'action'));
    studioHelpWantThread(ticketId, true);
    return null;
  }).finally(() => {
    if (generation !== _studioHelp.generation) return;
    _studioHelp.busy.delete(key);
    studioHelpRedraw();
  });
}

// ------------------------------------------------------------------ drawing: pieces

function renderStudioHelpStatus(ticket, staffView = false) {
  const look = STUDIO_HELP_STATUS_LOOK[ticket.status] || STUDIO_HELP_STATUS_LOOK.open;
  const label = staffView ? adsStudioText(look[4], look[5]) : adsStudioText(look[2], look[3]);
  return `<span class="studio-help-status" data-tone="${look[0]}" data-status="${studioEsc(ticket.status)}">${studioHelpIcon(look[1], 'studio-help-status-icon')}<span>${studioEsc(label)}</span></span>`;
}

function renderStudioHelpUrgent(ticket) {
  if (!ticket.urgent && !ticket.stopRequest) return '';
  const label = ticket.stopRequest ? adsStudioText('Urgent: stop request', 'عاجل: طلب إيقاف') : adsStudioText('Urgent', 'عاجل');
  return `<span class="studio-help-status is-urgent" data-tone="rose">${studioHelpIcon('hand', 'studio-help-status-icon')}<span>${studioEsc(label)}</span></span>`;
}

function renderStudioHelpProblem(error, retry, testId) {
  return `
            <div class="studio-help-problem" data-testid="${testId}">
              <span>${studioEsc(error && error.text ? error.text : '')}</span>
              <button type="button" class="studio-v2-action studio-help-small" onclick="${retry}">${studioEsc(adsStudioText('Try again', 'حاول مرة أخرى'))}</button>
            </div>`;
}

function studioHelpDueLine(ticket, staffView = false) {
  if (!ticket.dueAt) return '';
  const when = studioHelpWhen(ticket.dueAt);
  if (!when) return '';
  if (staffView) return ticket.overdue ? adsStudioText(`Overdue since ${when}`, `متأخرة منذ ${when}`) : adsStudioText(`Due by ${when}`, `الموعد قبل ${when}`);
  return adsStudioText(`We reply by ${when} (Tripoli time)`, `نرد قبل ${when} (بتوقيت طرابلس)`);
}

function renderStudioHelpRow(ticket, open, staffView = false) {
  const meta = [studioHelpCategoryLabel(ticket.category)];
  const ago = studioHelpAgo(ticket.lastMessageAt || ticket.updatedAt || ticket.createdAt);
  if (ago) meta.push(adsStudioText(`updated ${ago}`, `آخر تحديث ${ago}`));
  const due = studioHelpDueLine(ticket, staffView);
  if (due) meta.push(due);
  return `
              <li>
                <button type="button" class="studio-help-row${ticket.overdue ? ' is-overdue' : ''}" data-testid="studio-ticket-${studioEsc(ticket.id)}" data-status="${studioEsc(ticket.status)}" onclick="${open}">
                  <span class="studio-help-row-head"><span class="studio-help-number">${studioEsc(ticket.number)}</span>${renderStudioHelpUrgent(ticket)}${renderStudioHelpStatus(ticket, staffView)}</span>
                  <span class="studio-help-subject" dir="auto">${studioEsc(ticket.subject || adsStudioText('(no subject)', '(بدون عنوان)'))}</span>
                  <span class="studio-help-meta">${meta.filter(Boolean).map(text => `<span>${studioEsc(text)}</span>`).join('')}</span>
                </button>
              </li>`;
}

function renderStudioHelpMessages(messages, staffView = false) {
  if (!messages.length) return `<p class="studio-help-empty">${studioEsc(adsStudioText('No messages yet.', 'لا توجد رسائل بعد.'))}</p>`;
  const team = adsStudioText('Albayan team', 'فريق البيان');
  const customer = staffView ? adsStudioText('Customer', 'العميل') : adsStudioText('You', 'أنت');
  return `
            <ol class="studio-help-msgs" data-testid="studio-ticket-messages">${messages.map(message => `
              <li class="studio-help-msg is-${message.from}" data-from="${message.from}">
                <span class="studio-help-msg-from">${studioEsc(message.from === 'team' ? team : customer)}</span>
                <p class="studio-help-msg-text" dir="auto">${studioEsc(message.text)}</p>
                ${message.createdAt ? `<span class="studio-help-msg-time">${studioEsc(studioHelpWhen(message.createdAt))}</span>` : ''}
              </li>`).join('')}
            </ol>`;
}

function renderStudioHelpReplyForm(id, reply, send, testId) {
  return `
            <form class="studio-help-reply" data-testid="${testId}" onsubmit="event.preventDefault(); ${send}">
              <label class="studio-help-label" for="studio-help-reply-${studioEsc(id)}">${studioEsc(adsStudioText('Your reply', 'ردك'))}</label>
              <textarea id="studio-help-reply-${studioEsc(id)}" class="studio-help-input" rows="3" maxlength="${STUDIO_HELP_MESSAGE_MAX}" oninput="studioHelpReplyInput('${studioEsc(id)}', this)"${reply.sending ? ' disabled' : ''}>${studioEsc(reply.text)}</textarea>
              ${reply.error ? `<p class="studio-help-error" role="alert">${studioEsc(reply.error)}</p>` : ''}
              <div class="studio-help-actions">
                <button type="submit" class="studio-v2-action is-primary" data-testid="${testId}-send"${reply.sending ? ' disabled aria-busy="true"' : ''}>${studioHelpIcon('send')}<span>${studioEsc(reply.sending ? adsStudioText('Sending…', 'جارٍ الإرسال…') : adsStudioText('Send', 'إرسال'))}</span></button>
              </div>
            </form>`;
}

// The reply textarea keeps its words in state across the app's redraws (customer and staff threads).
function studioHelpReplyInput(id, input) {
  const key = String(id || '');
  const value = input && typeof input.value === 'string' ? input.value : '';
  if (_studioStaff.openId === key && studioStaffCan()) studioStaffReplySet(key, value);
  else studioHelpReplySet(key, value);
}

// ------------------------------------------------------------------ drawing: the customer screens

function renderStudioHelpList(view) {
  const filter = view.filter;
  const slot = studioHelpListSlot(filter);
  studioHelpWantList(filter);
  const on = studioHelpOn();
  const chips = [['active', adsStudioText('Open', 'مفتوحة')], ['resolved', adsStudioText('Resolved', 'محلولة')]].map(([key, label]) =>
    `<button type="button" class="studio-help-chip" data-testid="studio-help-filter-${key}" aria-pressed="${key === filter ? 'true' : 'false'}" onclick="studioHelpFilter('${key}')">${studioEsc(label)}</button>`).join('');
  let body = '';
  if (!slot.loadedAt && slot.error) body = renderStudioHelpProblem(slot.error, `studioHelpRetry('${filter}')`, 'studio-help-problem');
  else if (!slot.loadedAt) body = `<p class="studio-help-empty" data-testid="studio-help-loading">${studioEsc(adsStudioText('Reading your tickets…', 'نقرأ تذاكرك…'))}</p>`;
  else if (!slot.items.length) {
    body = `<p class="studio-help-empty" data-testid="studio-help-empty">${studioEsc(filter === 'resolved'
      ? adsStudioText('No resolved tickets yet.', 'لا توجد تذاكر محلولة بعد.')
      : adsStudioText('No open tickets. Open one whenever you need us.', 'لا توجد تذاكر مفتوحة. افتح تذكرة متى احتجت إلينا.'))}</p>`;
  } else {
    const open = ticket => `studioHelpOpen('${ticket.id}')`;
    if (filter === 'resolved') {
      body = `<ul class="studio-help-list" data-testid="studio-help-list">${slot.items.map(ticket => renderStudioHelpRow(ticket, open(ticket))).join('')}</ul>`;
    } else {
      const forYou = slot.items.filter(ticket => ticket.status === 'answered' || ticket.status === 'waiting_customer');
      const forTeam = slot.items.filter(ticket => ticket.status === 'open');
      const group = (items, title, testId) => (items.length ? `
            <h3 class="studio-help-h3">${studioEsc(title)}</h3>
            <ul class="studio-help-list" data-testid="${testId}">${items.map(ticket => renderStudioHelpRow(ticket, open(ticket))).join('')}</ul>` : '');
      body = group(forYou, adsStudioText('Waiting for you', 'بانتظار ردك'), 'studio-help-list-you')
        + group(forTeam, adsStudioText('Waiting for our team', 'بانتظار فريقنا'), 'studio-help-list-team');
    }
    if (slot.nextCursor) body += `<button type="button" class="studio-v2-action studio-help-small" data-testid="studio-help-more" onclick="studioHelpMore('${filter}')"${slot.loading ? ' disabled' : ''}>${studioEsc(adsStudioText('Show older tickets', 'اعرض التذاكر الأقدم'))}</button>`;
  }
  const offNote = on ? '' : `<p class="studio-help-note" data-testid="studio-help-off">${studioEsc(adsStudioText('Opening new tickets is not available for your account yet. The other ways to reach us are below.', 'فتح تذاكر جديدة غير متاح لحسابك بعد. طرق التواصل الأخرى معنا في الأسفل.'))}</p>`;
  return `
          <section class="studio-help-card" data-testid="studio-help-tickets" aria-labelledby="studio-help-title">
            <div class="studio-help-head">
              <h2 id="studio-help-title" class="studio-help-h2">${studioEsc(adsStudioText('My tickets', 'تذاكري'))}</h2>
              ${on ? `<button type="button" class="studio-v2-action is-primary studio-help-small" data-testid="studio-help-new" onclick="studioHelpNew()">${studioHelpIcon('plus')}<span>${studioEsc(adsStudioText('New ticket', 'تذكرة جديدة'))}</span></button>` : ''}
            </div>
            ${offNote}
            <div class="studio-help-chips" role="group" aria-label="${studioEsc(adsStudioText('Show', 'اعرض'))}">${chips}</div>
            ${slot.loadedAt && slot.error ? `<p class="studio-help-note">${studioEsc(adsStudioText('The list could not be refreshed; it shows what we know.', 'تعذّر تحديث القائمة؛ تعرض ما نعرفه.'))}</p>` : ''}
            ${body}
          </section>
          ${renderStudioHelpContact()}`;
}

function renderStudioHelpForm() {
  const draft = studioHelpDraft();
  studioHelpWantPages();
  if (typeof studioDataWant === 'function') studioDataWant('wallet');
  const chips = STUDIO_HELP_CATEGORIES.map(([code, icon, en, ar]) =>
    `<button type="button" class="studio-help-chip" data-testid="studio-help-category-${code}" aria-pressed="${draft.category === code ? 'true' : 'false'}" onclick="studioHelpDraftCategory('${code}')"${draft.sending ? ' disabled' : ''}>${studioHelpIcon(icon, 'studio-help-chip-icon')}<span>${studioEsc(adsStudioText(en, ar))}</span></button>`).join('');
  const options = studioHelpRelatedOptions();
  const current = draft.relatedType && draft.relatedId ? `${draft.relatedType}:${draft.relatedId}` : '';
  const known = options.some(item => `${item.type}:${item.id}` === current);
  const optionHtml = [`<option value=""${current ? '' : ' selected'}>${studioEsc(adsStudioText('Nothing in particular', 'لا شيء بعينه'))}</option>`]
    .concat(!known && current ? [`<option value="${studioEsc(current)}" selected>${studioEsc(draft.relatedLabel || current)}</option>`] : [])
    .concat(options.map(item => `<option value="${studioEsc(`${item.type}:${item.id}`)}"${`${item.type}:${item.id}` === current ? ' selected' : ''}>${studioEsc(`${studioHelpCategoryLabel(item.category)}: ${item.label}`)}</option>`)).join('');
  const field = (key, label, control) => `
            <div class="studio-help-field${draft.problems[key] ? ' is-invalid' : ''}">
              <label class="studio-help-label" for="studio-help-${key}">${studioEsc(label)}</label>
              ${control}
              ${draft.problems[key] ? `<p class="studio-help-error" data-testid="studio-help-problem-${key}">${studioEsc(draft.problems[key])}</p>` : ''}
            </div>`;
  return `
          <form class="studio-help-card studio-help-form" data-testid="studio-help-form" onsubmit="event.preventDefault(); studioHelpSend();">
            <h2 class="studio-help-h2">${studioEsc(adsStudioText('New ticket', 'تذكرة جديدة'))}</h2>
            <div class="studio-help-field${draft.problems.category ? ' is-invalid' : ''}">
              <p class="studio-help-label">${studioEsc(adsStudioText('What is it about?', 'ما موضوعها؟'))}</p>
              <div class="studio-help-chips" role="group" aria-label="${studioEsc(adsStudioText('Category', 'التصنيف'))}">${chips}</div>
              ${draft.problems.category ? `<p class="studio-help-error" data-testid="studio-help-problem-category">${studioEsc(draft.problems.category)}</p>` : ''}
            </div>
            ${field('related', adsStudioText('About which item?', 'عن أي عنصر؟'), `<select id="studio-help-related" class="studio-help-input" data-testid="studio-help-related" onchange="studioHelpDraftRelated(this.value)"${draft.sending ? ' disabled' : ''}>${optionHtml}</select>`)}
            ${field('subject', adsStudioText('Subject', 'العنوان'), `<input id="studio-help-subject" class="studio-help-input" type="text" maxlength="${STUDIO_HELP_SUBJECT_MAX}" value="${studioEsc(draft.subject)}" oninput="studioHelpDraftSet('subject', this.value)"${draft.sending ? ' disabled' : ''} />`)}
            ${field('message', adsStudioText('Your message', 'رسالتك'), `<textarea id="studio-help-message" class="studio-help-input" rows="5" maxlength="${STUDIO_HELP_MESSAGE_MAX}" oninput="studioHelpDraftSet('message', this.value)"${draft.sending ? ' disabled' : ''}>${studioEsc(draft.message)}</textarea>`)}
            ${draft.error ? `<p class="studio-help-error" role="alert" data-testid="studio-help-error">${studioEsc(draft.error)}</p>` : ''}
            <div class="studio-help-actions">
              <button type="button" class="studio-v2-action" data-testid="studio-help-cancel" onclick="studioHelpCancelNew()"${draft.sending ? ' disabled' : ''}>${studioEsc(adsStudioText('Cancel', 'إلغاء'))}</button>
              <button type="submit" class="studio-v2-action is-primary" data-testid="studio-help-send"${draft.sending ? ' disabled aria-busy="true"' : ''}>${studioHelpIcon('send')}<span>${studioEsc(draft.sending ? adsStudioText('Sending…', 'جارٍ الإرسال…') : adsStudioText('Send ticket', 'أرسل التذكرة'))}</span></button>
            </div>
          </form>`;
}

// The related item of a ticket as a link back to it (a request in My ads, the wallet, the pages).
function studioHelpRelatedLink(ticket) {
  if (!ticket.relatedType || !ticket.relatedId) return '';
  const label = studioHelpRelated(ticket.relatedType, ticket.relatedId);
  const text = label ? label.label : (ticket.relatedType === 'payment' ? ticket.relatedId : adsStudioText('the item', 'العنصر'));
  const inV2 = studioHelpInV2();
  let go = '';
  if (ticket.relatedType === 'campaign') go = inV2 ? `studioV2Go({ tab: 'campaigns', id: '${ticket.relatedId}' })` : `setAdsStudioTab('campaigns')`;
  else if (ticket.relatedType === 'payment') go = inV2 ? `studioV2Open('wallet')` : `setAdsStudioTab('dashboard')`;
  else go = inV2 ? `studioV2Open('replies')` : `setAdsStudioTab('replies')`;
  return `<button type="button" class="studio-help-link" data-testid="studio-ticket-related" onclick="${go}">${studioHelpIcon('link-2', 'studio-help-ask-icon')}<span dir="auto">${studioEsc(adsStudioText(`About: ${text}`, `بخصوص: ${text}`))}</span></button>`;
}

function renderStudioHelpThread(view) {
  const id = view.id;
  const slot = studioHelpThreadSlot(id);
  studioHelpWantThread(id);
  const ticket = slot.ticket || studioHelpKnownTicket(id);
  const back = `<button type="button" class="studio-help-link" data-testid="studio-help-back" onclick="studioHelpGo('list')">${studioHelpIcon(adsStudioIsAr() ? 'arrow-right' : 'arrow-left', 'studio-help-ask-icon')}<span>${studioEsc(adsStudioText('All tickets', 'كل التذاكر'))}</span></button>`;
  if (!ticket) {
    const inner = slot.error
      ? renderStudioHelpProblem(slot.error, `studioHelpRetryThread('${id}')`, 'studio-help-problem')
      : `<p class="studio-help-empty" data-testid="studio-help-loading">${studioEsc(adsStudioText('Reading the ticket…', 'نقرأ التذكرة…'))}</p>`;
    return `<section class="studio-help-card" data-testid="studio-ticket-thread" data-ticket="${studioEsc(id)}">${back}${inner}</section>`;
  }
  const reply = studioHelpReply(id);
  const resolved = ticket.status === 'resolved';
  const reopenOpen = resolved && ticket.reopenUntil && Date.parse(ticket.reopenUntil) > Date.now();
  const closed = resolved && !reopenOpen;
  const due = studioHelpDueLine(ticket);
  const busyResolve = _studioHelp.busy.has(`resolve:${id}`);
  const busyReopen = _studioHelp.busy.has(`reopen:${id}`);
  let actions = '';
  if (!resolved) actions = `<button type="button" class="studio-v2-action" data-testid="studio-ticket-resolve" onclick="studioHelpStatus('${id}', 'resolve')"${busyResolve ? ' disabled aria-busy="true"' : ''}>${studioHelpIcon('check')}<span>${studioEsc(adsStudioText('Mark as solved', 'تم الحل'))}</span></button>`;
  else if (reopenOpen) actions = `<button type="button" class="studio-v2-action" data-testid="studio-ticket-reopen" onclick="studioHelpStatus('${id}', 'reopen')"${busyReopen ? ' disabled aria-busy="true"' : ''}>${studioHelpIcon('rotate-ccw')}<span>${studioEsc(adsStudioText('Reopen', 'أعد الفتح'))}</span></button>`;
  const stateLine = closed
    ? adsStudioText('This ticket is closed for good (resolved more than 7 days ago). Open a new ticket if you need us again.', 'أُغلقت هذه التذكرة نهائياً (حُلّت قبل أكثر من 7 أيام). افتح تذكرة جديدة إن احتجت إلينا مرة أخرى.')
    : reopenOpen ? adsStudioText(`Resolved. You can reopen it until ${studioHelpWhen(ticket.reopenUntil)}.`, `تم الحل. يمكنك إعادة فتحها حتى ${studioHelpWhen(ticket.reopenUntil)}.`)
      : due || (ticket.status === 'open' ? adsStudioText('We reply during our working hours.', 'نرد خلال ساعات عملنا.') : adsStudioText('The team answered. Reply if you need more.', 'ردّ الفريق. أجب إن احتجت المزيد.'));
  return `
          <section class="studio-help-card studio-help-thread" data-testid="studio-ticket-thread" data-ticket="${studioEsc(id)}" data-status="${studioEsc(ticket.status)}">
            <div class="studio-help-head">${back}<button type="button" class="studio-help-link" data-testid="studio-ticket-refresh" onclick="studioHelpRefreshThread('${id}')"${slot.loading ? ' disabled' : ''}>${studioHelpIcon('refresh-cw', 'studio-help-ask-icon')}<span>${studioEsc(adsStudioText('Refresh', 'تحديث'))}</span></button></div>
            <div class="studio-help-row-head"><span class="studio-help-number" data-testid="studio-ticket-number">${studioEsc(ticket.number)}</span>${renderStudioHelpUrgent(ticket)}${renderStudioHelpStatus(ticket)}</div>
            <h2 class="studio-help-h2" dir="auto" data-testid="studio-ticket-subject">${studioEsc(ticket.subject)}</h2>
            <p class="studio-help-meta"><span>${studioEsc(studioHelpCategoryLabel(ticket.category))}</span>${ticket.createdAt ? `<span>${studioEsc(adsStudioText(`opened ${studioHelpWhen(ticket.createdAt)}`, `فُتحت ${studioHelpWhen(ticket.createdAt)}`))}</span>` : ''}</p>
            ${studioHelpRelatedLink(ticket)}
            <p class="studio-help-note" data-testid="studio-ticket-state">${studioEsc(stateLine)}</p>
            ${slot.error && slot.loadedAt ? `<p class="studio-help-note">${studioEsc(adsStudioText('The thread could not be refreshed; it shows what we know.', 'تعذّر تحديث المحادثة؛ تعرض ما نعرفه.'))}</p>` : ''}
            ${renderStudioHelpMessages(slot.messages)}
            ${closed ? '' : renderStudioHelpReplyForm(id, reply, `studioHelpReplySend('${id}');`, 'studio-ticket-reply')}
            ${actions ? `<div class="studio-help-actions">${actions}</div>` : ''}
          </section>`;
}

// Our working hours (from /me serviceHours, Tripoli time) and the public contact as a second way
// (D16: WhatsApp is a recommendation, tickets stay the sure way).
function renderStudioHelpContact() {
  const me = studioHelpMe();
  const hours = me && me.serviceHours && typeof me.serviceHours === 'object' ? me.serviceHours : {};
  const contact = me && me.contact ? me.contact : {};
  const week = hours.week && typeof hours.week === 'object' ? hours.week : null;
  const open = typeof hours.openNow === 'boolean' ? hours.openNow : null;
  const clock = value => (typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : '');
  const rows = week ? STUDIO_HELP_DAYS.map(([key, , en, ar]) => {
    const day = week[key];
    const range = day && clock(day.open) && clock(day.close) ? `${day.open}–${day.close}` : '';
    return `<div class="studio-help-hours-row${range ? '' : ' is-closed'}"><dt>${studioEsc(adsStudioText(en, ar))}</dt><dd>${range ? studioLtr(range) : studioEsc(adsStudioText('Closed', 'مغلق'))}</dd></div>`;
  }).join('') : '';
  const ramadan = hours.ramadan && typeof hours.ramadan === 'object' && clock(hours.ramadan.open) && clock(hours.ramadan.close) && /^\d{4}-\d{2}-\d{2}$/.test(String(hours.ramadan.from || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(hours.ramadan.to || ''))
    ? `<p class="studio-help-note" data-testid="studio-help-ramadan">${studioEsc(adsStudioText(`Ramadan (${hours.ramadan.from} to ${hours.ramadan.to}): ${hours.ramadan.open}–${hours.ramadan.close} on working days.`, `رمضان (من ${hours.ramadan.from} إلى ${hours.ramadan.to}): ${hours.ramadan.open}–${hours.ramadan.close} في أيام العمل.`))}</p>` : '';
  const holidays = (Array.isArray(hours.holidays) ? hours.holidays : []).filter(item => item && /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || ''))).slice(0, 6);
  const holidayHtml = holidays.length ? `<p class="studio-help-note" data-testid="studio-help-holidays">${studioEsc(adsStudioText('Closed on: ', 'مغلق في: '))}${holidays.map(item => {
    const label = adsStudioText(studioHelpText(item.labelEn, 80), studioHelpText(item.labelAr, 80));
    return studioEsc(label ? `${item.date} (${label})` : String(item.date));
  }).join('، ')}</p>` : '';
  const openChip = open === null ? '' : `<span class="studio-help-status" data-tone="${open ? 'green' : 'slate'}" data-testid="studio-help-open-now">${studioHelpIcon(open ? 'circle-check' : 'clock', 'studio-help-status-icon')}<span>${studioEsc(open ? adsStudioText('Open now', 'نعمل الآن') : adsStudioText('Closed now', 'مغلق الآن'))}</span></span>`;
  const links = [];
  if (contact.whatsapp) links.push(['whatsapp', `https://wa.me/${String(contact.whatsapp).replace(/^\+/, '')}`, 'message-circle', adsStudioText('WhatsApp', 'واتساب'), true]);
  if (contact.phone) links.push(['phone', `tel:${contact.phone}`, 'phone', adsStudioText('Call us', 'اتصل بنا'), false]);
  if (contact.email) links.push(['email', `mailto:${contact.email}`, 'mail', adsStudioText('Email', 'البريد'), false]);
  const linkHtml = links.map(([key, href, icon, label, newTab]) =>
    `<a class="studio-v2-action studio-help-small" data-testid="studio-help-contact-${key}" href="${studioEsc(href)}"${newTab ? ' target="_blank" rel="noopener noreferrer"' : ''}>${studioHelpIcon(icon)}<span>${studioEsc(label)}</span></a>`).join('');
  return `
          <section class="studio-help-card" data-testid="studio-help-contact" aria-labelledby="studio-help-hours-title">
            <div class="studio-help-head">
              <h2 id="studio-help-hours-title" class="studio-help-h2">${studioEsc(adsStudioText('Our working hours', 'ساعات عملنا'))}</h2>
              ${openChip}
            </div>
            ${rows ? `<dl class="studio-help-hours" data-testid="studio-help-hours">${rows}</dl>` : `<p class="studio-help-note">${studioEsc(adsStudioText('Our hours will appear here soon.', 'ستظهر ساعات عملنا هنا قريباً.'))}</p>`}
            <p class="studio-help-note">${studioEsc(adsStudioText('Tripoli time. We answer tickets and stop requests within these hours.', 'بتوقيت طرابلس. نرد على التذاكر وطلبات الإيقاف خلال هذه الساعات.'))}</p>
            ${ramadan}${holidayHtml}
            <h3 class="studio-help-h3">${studioEsc(adsStudioText('How help works', 'كيف تعمل المساعدة'))}</h3>
            <ul class="studio-help-guide">
              <li>${studioEsc(adsStudioText('Every ticket gets a number (T-…) and a time we reply by.', 'كل تذكرة تحصل على رقم (T-…) وموعد نرد قبله.'))}</li>
              <li>${studioEsc(adsStudioText('Money questions go to an admin; ad questions to the review team.', 'أسئلة المال تذهب إلى المدير، وأسئلة الإعلانات إلى فريق المراجعة.'))}</li>
              <li>${studioEsc(adsStudioText('To stop a running ad, use "Ask to stop" on the ad itself: it opens an urgent ticket.', 'لإيقاف إعلان يعمل استخدم «اطلب الإيقاف» على الإعلان نفسه: يفتح تذكرة عاجلة.'))}</li>
            </ul>
            ${linkHtml ? `<h3 class="studio-help-h3">${studioEsc(adsStudioText('Other ways to reach us', 'طرق أخرى للتواصل معنا'))}</h3>
            <p class="studio-help-note">${studioEsc(adsStudioText('A ticket is the surest way: it is tracked and answered by its due time. You can also reach us here:', 'التذكرة هي الطريقة الأضمن: تُتابَع ويُرد عليها في موعدها. ويمكنك أيضاً التواصل معنا هنا:'))}</p>
            <div class="studio-help-contact">${linkHtml}</div>` : ''}
          </section>`;
}

function studioHelpRenderView(view) {
  if (view.view === 'new') return studioHelpOn() ? renderStudioHelpForm() : renderStudioHelpList({ view: 'list', id: '', filter: 'active' });
  if (view.view === 'thread') return renderStudioHelpThread(view);
  return renderStudioHelpList(view);
}

// The v2 Help screen (registered with the shell) and the classic help tab (drawn by 15c).
function renderStudioHelpBody(route) {
  studioHelpScope();
  const view = studioHelpViewOf(route);
  return `
        <div class="studio-help" data-testid="studio-help" data-view="${studioEsc(view.view)}">${studioHelpRenderView(view)}
        </div>`;
}

function renderStudioHelpClassic() {
  studioHelpScope();
  const view = studioHelpViewOf(null);
  return `
    <div class="studio-help studio-help-classic" data-testid="studio-help" data-view="${studioEsc(view.view)}" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}">${studioHelpRenderView(view)}
    </div>`;
}

if (typeof studioV2RegisterScreen === 'function') studioV2RegisterScreen('help', renderStudioHelpBody);

// ------------------------------------------------------------------ Inbox (P3-05)

function studioInboxScope() {
  const uid = studioHelpUserId();
  if (_studioInbox.forUser !== uid) {
    _studioInbox.generation++;
    Object.assign(_studioInbox, { forUser: uid, items: [], nextCursor: null, unread: 0, seenAt: '', loadedAt: 0, failedAt: 0, loading: null, again: false, error: null, more: null, marking: null, onScreen: false });
  }
  return uid;
}

function studioInboxCleanItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '');
  const kind = String(raw.kind || '');
  if (!Security.isValidRecordId(id) || !Object.prototype.hasOwnProperty.call(STUDIO_INBOX_KINDS, kind)) return null;
  const relatedType = STUDIO_HELP_RELATED_TYPES.includes(raw.relatedType) || raw.relatedType === 'ticket' ? raw.relatedType : '';
  return {
    id, kind,
    title: raw.title && typeof raw.title === 'object' ? { en: studioHelpText(raw.title.en, 200), ar: studioHelpText(raw.title.ar, 200) } : { en: '', ar: '' },
    body: raw.body && typeof raw.body === 'object' ? { en: studioHelpText(raw.body.en, 400), ar: studioHelpText(raw.body.ar, 400) } : { en: '', ar: '' },
    relatedType,
    relatedId: relatedType && typeof raw.relatedId === 'string' && Security.isValidRecordId(raw.relatedId) ? raw.relatedId : '',
    createdAt: studioHelpTime(raw.createdAt),
    unread: raw.unread === true
  };
}

// Reads the first page (a reply younger than a minute is reused; force asks now), or one more page.
function studioInboxWant(force = false, more = false) {
  if (!studioInboxScope() || !studioHelpServer()) return null;
  if (_studioInbox.loading) {
    if (force && !more) _studioInbox.again = true;
    return _studioInbox.loading;
  }
  const now = Date.now();
  if (!more && !force) {
    if (_studioInbox.failedAt && now - _studioInbox.failedAt < STUDIO_HELP_RETRY_MS) return null;
    if (_studioInbox.loadedAt && now - _studioInbox.loadedAt < STUDIO_INBOX_FRESH_MS) return null;
  }
  if (more && !_studioInbox.nextCursor) return null;
  const generation = _studioInbox.generation;
  const signal = typeof studioReadSignal === 'function' ? studioReadSignal() : null;
  const url = more ? `/api/studio/activity?cursor=${encodeURIComponent(_studioInbox.nextCursor)}` : '/api/studio/activity';
  _studioInbox.again = false;
  const promise = studioApi(url, { method: 'GET' }).then(raw => {
    if (generation !== _studioInbox.generation) return;
    const items = raw && Array.isArray(raw.items) ? raw.items.map(studioInboxCleanItem).filter(Boolean) : [];
    if (more) {
      const seen = new Set(_studioInbox.items.map(item => item.id));
      _studioInbox.items = _studioInbox.items.concat(items.filter(item => !seen.has(item.id)));
    } else {
      _studioInbox.items = items;
      _studioInbox.loadedAt = now;
    }
    _studioInbox.nextCursor = raw && typeof raw.nextCursor === 'string' && /^\d{1,15}:[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(raw.nextCursor) ? raw.nextCursor : null;
    _studioInbox.unread = raw && Number.isSafeInteger(raw.unreadCount) && raw.unreadCount >= 0 ? raw.unreadCount : _studioInbox.items.filter(item => item.unread).length;
    _studioInbox.seenAt = studioHelpTime(raw && raw.seenAt);
    _studioInbox.failedAt = 0;
    _studioInbox.error = null;
  }, error => {
    if (generation !== _studioInbox.generation) return;
    if (typeof studioReadCancelled === 'function' && studioReadCancelled(error, signal)) return;
    _studioInbox.failedAt = Date.now();
    _studioInbox.error = { code: studioHelpErrorCode(error), text: studioHelpErrorText(error, 'read') };
  }).finally(() => {
    if (generation !== _studioInbox.generation) return;
    _studioInbox.loading = null;
    if (_studioInbox.again) {
      _studioInbox.again = false;
      studioInboxWant(true);
    }
    studioHelpRedraw();
  });
  _studioInbox.loading = promise;
  return promise;
}

function studioInboxMore() {
  return studioInboxWant(false, true);
}

function studioInboxRetry() {
  _studioInbox.failedAt = 0;
  studioInboxWant(true);
  studioHelpRedraw();
}

function studioInboxUnreadCount() {
  studioInboxScope();
  return _studioInbox.unread;
}

// The bell's badge for the shell's header (15h passes the tab on screen): '' while nothing is
// unread. Drawing it asks for the feed (at most once a minute), so the count stays current while
// the studio is open; a screen other than the Inbox also notes that the Inbox is not on screen, so
// its next opening reads the feed afresh.
function studioInboxBadge(tab = '') {
  if (String(tab || '') !== 'inbox') _studioInbox.onScreen = false;
  studioInboxWant();
  const count = studioInboxUnreadCount();
  if (!count) return '';
  return `<span class="studio-inbox-badge" data-testid="studio-inbox-badge" aria-label="${studioEsc(adsStudioText(`${count} unread`, `${count} غير مقروءة`))}">${count > 99 ? '99+' : count}</span>`;
}

// POST /api/studio/activity/seen with the newest item's time (the marker only moves forward).
function studioInboxMarkSeen() {
  if (!studioInboxScope() || !studioHelpServer() || _studioInbox.marking) return _studioInbox.marking;
  const newest = _studioInbox.items.reduce((best, item) => (item.createdAt && (!best || Date.parse(item.createdAt) > Date.parse(best)) ? item.createdAt : best), '');
  const upTo = newest || new Date().toISOString();
  const generation = _studioInbox.generation;
  const promise = studioApi('/api/studio/activity/seen', { method: 'POST', body: { upTo } }).then(raw => {
    if (generation !== _studioInbox.generation) return null;
    const seenAt = studioHelpTime(raw && raw.activitySeenAt) || upTo;
    _studioInbox.seenAt = seenAt;
    _studioInbox.unread = raw && Number.isSafeInteger(raw.unreadCount) && raw.unreadCount >= 0 ? raw.unreadCount : 0;
    const limit = Date.parse(seenAt);
    _studioInbox.items = _studioInbox.items.map(item => (item.unread && item.createdAt && Date.parse(item.createdAt) <= limit ? { ...item, unread: false } : item));
    return seenAt;
  }, error => {
    if (generation !== _studioInbox.generation) return null;
    studioHelpNotify(false, adsStudioText('Not done', 'لم يتم'), studioHelpErrorText(error, 'action'));
    return null;
  }).finally(() => {
    if (generation !== _studioInbox.generation) return;
    _studioInbox.marking = null;
    studioHelpRedraw();
  });
  _studioInbox.marking = promise;
  studioHelpRedraw();
  return promise;
}

// Tapping an item opens what it is about: the request, the ticket or the wallet.
function studioInboxOpen(id) {
  const item = _studioInbox.items.find(entry => entry.id === String(id || ''));
  if (!item) return false;
  if (item.relatedType === 'campaign' && item.relatedId) return studioV2Go({ tab: 'campaigns', id: item.relatedId });
  if (item.relatedType === 'ticket' && item.relatedId) return studioHelpGo('thread', item.relatedId);
  if (item.relatedType === 'payment') return studioV2Open('wallet');
  return false;
}

function renderStudioInboxBody() {
  studioInboxScope();
  // Opening the Inbox reads the feed afresh (the bell's own read may be up to a minute old); the
  // redraws while it stays open reuse that answer.
  const opening = !_studioInbox.onScreen;
  _studioInbox.onScreen = true;
  studioInboxWant(opening);
  const count = _studioInbox.unread;
  const marking = !!_studioInbox.marking;
  let body = '';
  if (!_studioInbox.loadedAt && _studioInbox.error) body = renderStudioHelpProblem(_studioInbox.error, 'studioInboxRetry()', 'studio-inbox-problem');
  else if (!_studioInbox.loadedAt) body = `<p class="studio-help-empty" data-testid="studio-inbox-loading">${studioEsc(adsStudioText('Reading your inbox…', 'نقرأ إشعاراتك…'))}</p>`;
  else if (!_studioInbox.items.length) body = `<p class="studio-help-empty" data-testid="studio-inbox-empty">${studioEsc(adsStudioText('Nothing here yet. Decisions on your ads, payments and ticket answers appear here.', 'لا شيء هنا بعد. تظهر هنا قرارات إعلاناتك ودفعاتك وردود التذاكر.'))}</p>`;
  else {
    body = `<ul class="studio-help-list" data-testid="studio-inbox-list">${_studioInbox.items.map(item => {
      const openable = (item.relatedType === 'campaign' || item.relatedType === 'ticket' || item.relatedType === 'payment') && (item.relatedType === 'payment' || item.relatedId);
      return `
              <li>
                <button type="button" class="studio-help-row studio-inbox-item${item.unread ? ' is-unread' : ''}" data-testid="studio-inbox-item-${studioEsc(item.id)}" data-kind="${studioEsc(item.kind)}" data-unread="${item.unread ? '1' : '0'}" onclick="studioInboxOpen('${item.id}')"${openable ? '' : ' disabled'}>
                  <span class="studio-inbox-icon" aria-hidden="true">${studioHelpIcon(STUDIO_INBOX_KINDS[item.kind])}</span>
                  <span class="studio-inbox-text">
                    <span class="studio-help-subject">${item.unread ? `<span class="studio-inbox-dot" aria-hidden="true"></span>` : ''}${studioEsc(studioPickText(item.title, 200))}</span>
                    <span class="studio-help-note">${studioEsc(studioPickText(item.body, 400))}</span>
                    ${item.createdAt ? `<span class="studio-help-msg-time">${studioEsc(studioHelpAgo(item.createdAt))}</span>` : ''}
                  </span>
                </button>
              </li>`;
    }).join('')}</ul>`;
    if (_studioInbox.nextCursor) body += `<button type="button" class="studio-v2-action studio-help-small" data-testid="studio-inbox-more" onclick="studioInboxMore()"${_studioInbox.loading ? ' disabled' : ''}>${studioEsc(adsStudioText('Show older', 'اعرض الأقدم'))}</button>`;
  }
  return `
        <div class="studio-help studio-inbox" data-testid="studio-inbox">
          <section class="studio-help-card" aria-labelledby="studio-inbox-title">
            <div class="studio-help-head">
              <h2 id="studio-inbox-title" class="studio-help-h2">${studioEsc(adsStudioText('Inbox', 'الإشعارات'))}</h2>
              <button type="button" class="studio-v2-action studio-help-small" data-testid="studio-inbox-seen" onclick="studioInboxMarkSeen()"${count && !marking ? '' : ' disabled'}${marking ? ' aria-busy="true"' : ''}>${studioHelpIcon('check-check')}<span>${studioEsc(adsStudioText('Mark all seen', 'تعليم الكل كمقروء'))}</span></button>
            </div>
            <p class="studio-help-note" data-testid="studio-inbox-unread" data-count="${count}">${studioEsc(count ? adsStudioText(`${count} new`, `${count} جديدة`) : adsStudioText('Nothing new', 'لا جديد'))}</p>
            ${body}
          </section>
        </div>`;
}

if (typeof studioV2RegisterScreen === 'function') studioV2RegisterScreen('inbox', renderStudioInboxBody);

// ------------------------------------------------------------------ Ask to stop (P3-10)

function studioStopScope() {
  const uid = studioHelpUserId();
  if (_studioStop.forUser !== uid) {
    Object.assign(_studioStop, { forUser: uid, id: '', note: '', sending: false, error: '', result: null, attempts: new Map(), requested: new Map() });
    studioStopSheetClose();
  }
  return uid;
}

// The owner's own Approved request this device knows (Home's rows, 15j; the classic list otherwise).
function studioStopRequest(id) {
  const wanted = String(id || '');
  if (!Security.isValidRecordId(wanted)) return null;
  let request = typeof studioDataRequest === 'function' ? studioDataRequest(wanted) : null;
  if (!request && typeof findVisibleAdsStudioCampaign === 'function') {
    const row = findVisibleAdsStudioCampaign(wanted);
    if (row && String(row.createdBy || '') === studioHelpUserId()) request = row;
  }
  return request && String(request.status || '') === 'Approved' ? request : null;
}

// When this ad's stop was asked for, from the request row (the server's marker) or the answer this
// device got; '' when never.
function studioStopRequestedAt(id) {
  studioStopScope();
  const wanted = String(id || '');
  const known = _studioStop.requested.get(wanted);
  if (known && known.stopRequestedAt) return known.stopRequestedAt;
  const request = typeof studioDataRequest === 'function' ? studioDataRequest(wanted) : (typeof findVisibleAdsStudioCampaign === 'function' ? findVisibleAdsStudioCampaign(wanted) : null);
  return request ? studioHelpTime(request.stopRequestedAt) : '';
}

function studioStopCleanResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ticket = studioHelpCleanTicket(raw.ticket);
  const contact = raw.urgentContact && typeof raw.urgentContact === 'object' ? raw.urgentContact : {};
  return {
    ticket,
    stopRequestedAt: studioHelpTime(raw.stopRequestedAt),
    afterHours: raw.afterHours === true,
    urgentContact: raw.afterHours === true ? { whatsapp: studioParsePhone(contact.whatsapp), phone: studioParsePhone(contact.phone) } : { whatsapp: '', phone: '' }
  };
}

// POST the stop request once per ad: the operationId stays until the server answers, and a repeat
// (this device or another) gets the same ticket from the server anyway.
async function studioStopSendOnce(id, note) {
  studioStopScope();
  const key = String(id || '');
  let operationId = _studioStop.attempts.get(key);
  if (!operationId) {
    operationId = studioHelpOperationId('stopask');
    _studioStop.attempts.set(key, operationId);
  }
  const body = { operationId };
  const words = studioHelpText(note, STUDIO_HELP_NOTE_MAX);
  if (words) body.note = words;
  const timeout = typeof TIME_CONSTANTS !== 'undefined' && TIME_CONSTANTS && TIME_CONSTANTS.API_TIMEOUT_LONG_MS ? { timeoutMs: TIME_CONSTANTS.API_TIMEOUT_LONG_MS } : {};
  const reply = await studioApi(`/api/ad-studio/campaigns/${encodeURIComponent(key)}/stop-request`, { method: 'POST', body }, timeout);
  const result = studioStopCleanResult(reply);
  if (!result || !result.ticket) throw new Error('The stop request answered without a ticket');
  _studioStop.attempts.delete(key);
  _studioStop.requested.set(key, result);
  if (typeof studioDataRefresh === 'function') studioDataRefresh();  // the stage's "Stop requested" chip
  return result;
}

function studioStopSheetClose() {
  const el = _studioStop.el;
  const opener = _studioStop.opener;
  _studioStop.el = null;
  _studioStop.opener = null;
  _studioStop.id = '';
  if (el && el.isConnected) el.remove();
  try { if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus(); } catch (_) {}
}

function studioStopSheetDone() {
  studioStopSheetClose();
  studioHelpRedraw();
}

function studioStopNoteInput(input) {
  if (!_studioStop.sending) _studioStop.note = String((input && input.value) || '').slice(0, STUDIO_HELP_NOTE_MAX);
}

// The sheet's words before and after the send (both layouts; the classes are My ads' sheet ones).
function renderStudioStopSheet(request, view) {
  const me = studioHelpMe();
  const hours = me && me.serviceHours ? me.serviceHours : {};
  const open = typeof hours.openNow === 'boolean' ? hours.openNow : null;
  const onDuty = typeof hours.onDutyUntil === 'string' && /^\d{2}:\d{2}$/.test(hours.onDutyUntil) ? hours.onDutyUntil : '';
  const name = typeof studioDataName === 'function' ? studioDataName(request) : studioHelpText(request.name, 160);
  const ref = /^ALB-S-[A-Za-z0-9]{1,20}$/.test(String(request.studioRef || '')) ? String(request.studioRef) : '';
  const result = view.result;
  let inner;
  if (result && result.ticket) {
    const due = result.ticket.dueAt ? studioHelpWhen(result.ticket.dueAt) : '';
    const reference = `${result.ticket.number}${ref ? ` · ${ref}` : ''}`;
    let urgent = '';
    if (result.afterHours) {
      const contact = result.urgentContact || {};
      const links = [];
      if (contact.whatsapp) {
        const text = adsStudioText(`Urgent stop request ${reference}: please stop my ad "${name}".`, `طلب إيقاف عاجل ${reference}: أرجو إيقاف إعلاني «${name}».`);
        links.push(`<a class="studio-v2-action is-primary" data-testid="studio-stop-urgent-whatsapp" href="https://wa.me/${studioEsc(contact.whatsapp.replace(/^\+/, ''))}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener noreferrer">${studioHelpIcon('message-circle')}<span>${studioEsc(adsStudioText('WhatsApp the on-duty team', 'راسل فريق المناوبة على واتساب'))}</span></a>`);
      }
      if (contact.phone) links.push(`<a class="studio-v2-action" data-testid="studio-stop-urgent-phone" href="tel:${studioEsc(contact.phone)}">${studioHelpIcon('phone')}<span>${studioEsc(adsStudioText('Call us', 'اتصل بنا'))}</span></a>`);
      const line = links.length
        ? adsStudioText('We are outside working hours now. For an urgent stop right now, message the on-duty team:', 'نحن خارج ساعات العمل الآن. لإيقاف عاجل الآن راسل فريق المناوبة:')
        : adsStudioText('We are outside working hours now; we handle it at the next opening.', 'نحن خارج ساعات العمل الآن؛ نعالجه عند بدء الدوام القادم.');
      urgent = `
          <div class="studio-stop-urgent" data-testid="studio-stop-after-hours">
            <p class="studio-ads-sheet-text">${studioEsc(line)}</p>
            ${links.length ? `<div class="studio-ads-contact">${links.join('')}</div>` : ''}
            ${links.length && onDuty ? `<p class="studio-ads-sheet-note">${studioEsc(adsStudioText(`The on-duty line answers until ${onDuty} (Tripoli time).`, `يرد خط المناوبة حتى ${onDuty} (بتوقيت طرابلس).`))}</p>` : ''}
          </div>`;
    }
    inner = `
        <h2 id="studio-stop-title" class="studio-ads-sheet-title">${studioEsc(adsStudioText('Stop request sent', 'أُرسل طلب الإيقاف'))}</h2>
        <p class="studio-ads-sheet-name" dir="auto">${studioEsc(name)}</p>
        <p class="studio-stop-number" data-testid="studio-stop-number">${studioEsc(adsStudioText(`Ticket ${result.ticket.number}`, `التذكرة ${result.ticket.number}`))}</p>
        <p class="studio-ads-sheet-text" data-testid="studio-stop-due">${studioEsc(due
    ? adsStudioText(`We pause it in Meta by ${due} (Tripoli time) and tell you when it is done.`, `نوقفه في ميتا قبل ${due} (بتوقيت طرابلس) ونخبرك عند إتمامه.`)
    : adsStudioText('We pause it in Meta as soon as possible during our working hours and tell you when it is done.', 'نوقفه في ميتا في أقرب وقت خلال ساعات عملنا ونخبرك عند إتمامه.'))}</p>
        <p class="studio-ads-sheet-note">${studioEsc(adsStudioText('Meta may keep spending until we pause it. What Meta did not spend comes back after its numbers settle, usually within 2–3 days after the stop.', 'قد تواصل ميتا الصرف حتى نوقفه. يعود إليك ما لم تصرفه ميتا بعد أن تثبت أرقامها، عادةً خلال يومين إلى ثلاثة بعد الإيقاف.'))}</p>
        ${urgent}
        <div class="studio-ads-sheet-actions">
          ${studioHelpOn() || studioHelpInV2() ? `<button type="button" class="studio-v2-action" data-testid="studio-stop-open-ticket" onclick="studioStopOpenTicket('${result.ticket.id}')">${studioEsc(adsStudioText('Open the ticket', 'افتح التذكرة'))}</button>` : ''}
          <button type="button" class="studio-v2-action is-primary" data-testid="studio-stop-done" data-sheet-focus="1" onclick="studioStopSheetDone()">${studioEsc(adsStudioText('Done', 'تم'))}</button>
        </div>`;
  } else {
    const hoursLine = open === null ? ''
      : open ? adsStudioText('We are in working hours now: the team sees it right away.', 'نحن في ساعات العمل الآن: يراه الفريق فوراً.')
        : adsStudioText('We are outside working hours now. After you send, we show you the on-duty line for an urgent stop.', 'نحن خارج ساعات العمل الآن. بعد الإرسال نعرض لك خط المناوبة للإيقاف العاجل.');
    inner = `
        <h2 id="studio-stop-title" class="studio-ads-sheet-title">${studioEsc(adsStudioText('Ask us to stop this ad', 'اطلب منا إيقاف هذا الإعلان'))}</h2>
        <p class="studio-ads-sheet-name" dir="auto">${studioEsc(name)}${ref ? ` · ${studioEsc(ref)}` : ''}</p>
        <p class="studio-ads-sheet-text">${studioEsc(adsStudioText('This opens an urgent ticket. The team pauses the ad in Meta within our working hours and tells you when it is done. Meta may keep spending until then; what Meta did not spend comes back after its numbers settle, usually within 2–3 days after the stop.', 'يفتح هذا تذكرة عاجلة. يوقف الفريق الإعلان في ميتا خلال ساعات عملنا ويخبرك عند إتمامه. قد تواصل ميتا الصرف حتى ذلك الحين، ويعود إليك ما لم تصرفه ميتا بعد أن تثبت أرقامها، عادةً خلال يومين إلى ثلاثة بعد الإيقاف.'))}</p>
        ${hoursLine ? `<p class="studio-ads-sheet-note" data-testid="studio-stop-hours">${studioEsc(hoursLine)}</p>` : ''}
        <label class="studio-help-label" for="studio-stop-note">${studioEsc(adsStudioText('A note for the team (optional)', 'ملاحظة للفريق (اختياري)'))}</label>
        <textarea id="studio-stop-note" class="studio-help-input" rows="2" maxlength="${STUDIO_HELP_NOTE_MAX}" data-testid="studio-stop-note" oninput="studioStopNoteInput(this)"${view.sending ? ' disabled' : ''}>${studioEsc(view.note)}</textarea>
        <p class="studio-ads-sheet-error" role="alert" data-testid="studio-sheet-error"${view.error ? '' : ' hidden'}>${studioEsc(view.error)}</p>
        <div class="studio-ads-sheet-actions">
          <button type="button" class="studio-v2-action" data-testid="studio-sheet-cancel" data-sheet-focus="1" onclick="studioStopSheetClose()"${view.sending ? ' disabled' : ''}>${studioEsc(adsStudioText('Keep it running', 'أبقِه يعمل'))}</button>
          <button type="button" class="studio-v2-action is-primary" data-testid="studio-sheet-confirm" onclick="studioStopSend()"${view.sending ? ' disabled aria-busy="true"' : ''}>${studioHelpIcon('hand')}<span>${studioEsc(view.sending ? adsStudioText('Sending…', 'جارٍ الإرسال…') : adsStudioText('Send the stop request', 'أرسل طلب الإيقاف'))}</span></button>
        </div>`;
  }
  return `
    <div class="mobile-dialog-overlay studio-ads-sheet studio-stop-sheet" data-testid="studio-sheet-ask-stop" data-state="${result ? 'sent' : 'ask'}" onclick="if (event.target === this && !_studioStop.sending) studioStopSheetClose()">
      <div class="studio-ads-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="studio-stop-title" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}">${inner}
      </div>
    </div>`;
}

function studioStopSheetRedraw() {
  const el = _studioStop.el;
  const request = studioStopRequest(_studioStop.id);
  if (!el || !el.isConnected || !request) return;
  const holder = document.createElement('div');
  holder.innerHTML = renderStudioStopSheet(request, _studioStop).trim();
  const next = holder.firstElementChild;
  if (!next) return;
  el.replaceWith(next);
  _studioStop.el = next;
  studioStopSheetWire(next);
}

function studioStopSheetWire(el) {
  el.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !_studioStop.sending) {
      event.preventDefault();
      if (_studioStop.el === el) studioStopSheetClose();
    }
  });
  if (typeof IconQueue !== 'undefined' && IconQueue && typeof IconQueue.schedule === 'function') IconQueue.schedule(el);
  const focus = el.querySelector('[data-sheet-focus]');
  try { if (focus) focus.focus(); } catch (_) {}
}

// Opens the sheet for the owner's Approved request (an already asked stop shows its ticket again:
// the server answers the same ticket). false when it cannot open (the classic toast stays then).
function studioStopSheetOpen(id, opener = null) {
  if (typeof document === 'undefined' || !document.body || !studioStopSheetAvailable()) return false;
  const request = studioStopRequest(id);
  if (!request) return false;
  studioStopScope();
  studioStopSheetClose();
  Object.assign(_studioStop, { id: request.id, note: '', sending: false, error: '', result: null, opener: opener || null });
  const holder = document.createElement('div');
  holder.innerHTML = renderStudioStopSheet(request, _studioStop).trim();
  const el = holder.firstElementChild;
  if (!el) return false;
  _studioStop.el = el;
  document.body.appendChild(el);
  studioStopSheetWire(el);
  return true;
}

function studioStopSend() {
  if (_studioStop.sending || !_studioStop.id) return null;
  if (!studioHelpServer()) {
    _studioStop.error = adsStudioText('A stop request needs the connection to Albayan.', 'طلب الإيقاف يحتاج الاتصال بالبيان.');
    studioStopSheetRedraw();
    return null;
  }
  const id = _studioStop.id;
  _studioStop.sending = true;
  _studioStop.error = '';
  studioStopSheetRedraw();
  return studioStopSendOnce(id, _studioStop.note).then(result => {
    if (_studioStop.id !== id) return result;
    _studioStop.sending = false;
    _studioStop.result = result;
    studioStopSheetRedraw();
    studioHelpNotify(true, adsStudioText('Stop requested', 'طُلب الإيقاف'), adsStudioText(`Ticket ${result.ticket.number}. We pause the ad as soon as we can.`, `التذكرة ${result.ticket.number}. نوقف الإعلان في أقرب وقت.`));
    studioHelpRedraw();  // the card's "Stop requested" chip (classic) or the stage flag (v2)
    return result;
  }, error => {
    if (_studioStop.id !== id) return null;
    _studioStop.sending = false;
    _studioStop.error = studioHelpErrorText(error, 'action');
    studioStopSheetRedraw();
    return null;
  });
}

// On a phone the open sheet owns one history entry that closing it gives back (01b overlay model): the
// move to the ticket waits for that step, so the two never cross (as My ads' studioAdsAfterSheet).
function studioStopOpenTicket(id) {
  const ticketId = String(id || '');
  studioStopSheetClose();
  let pending = false;
  try { pending = !!(window.history.state && window.history.state.overlaySentinel); } catch (_) {}
  const open = () => studioHelpGo('thread', ticketId);
  if (pending && typeof studioV2AfterPop === 'function') studioV2AfterPop(open);
  else open();
}

// ------------------------------------------------------------------ the staff tickets (P3-09, P3-11)

function studioStaffCan() {
  return typeof adsStudioCanReview === 'function' && adsStudioCanReview();
}

function studioStaffScope() {
  const uid = studioHelpUserId();
  if (_studioStaff.forUser !== uid) {
    _studioStaff.generation++;
    Object.assign(_studioStaff, { forUser: uid, filter: 'active', list: null, openId: '', threads: new Map(), replies: new Map(), busy: new Map(), contacts: new Map() });
  }
  return uid;
}

function studioStaffGeneration() {
  return _studioStaff.generation;
}

function studioStaffListSlot() {
  studioStaffScope();
  if (!_studioStaff.list) _studioStaff.list = studioHelpEmptySlot();
  return _studioStaff.list;
}

function studioStaffWant(force = false, more = false) {
  if (!studioStaffScope() || !studioStaffCan() || !studioHelpServer()) return null;
  return studioHelpReadSlot(studioStaffListSlot(), `/api/studio/staff/tickets?status=${_studioStaff.filter}`, studioStaffGeneration, force, more);
}

function studioStaffFilter(filter) {
  if (!STUDIO_STAFF_FILTERS.some(item => item[0] === String(filter || ''))) return;
  studioStaffScope();
  _studioStaff.filter = String(filter);
  _studioStaff.list = studioHelpEmptySlot();
  _studioStaff.openId = '';
  studioStaffWant(true);
  studioHelpRedraw();
}

function studioStaffMore() {
  return studioStaffWant(false, true);
}

function studioStaffRetry() {
  studioStaffListSlot().failedAt = 0;
  studioStaffWant(true);
  studioHelpRedraw();
}

function studioStaffThreadSlot(id) {
  studioStaffScope();
  if (!_studioStaff.threads.has(id)) _studioStaff.threads.set(id, { ticket: null, messages: [], loadedAt: 0, failedAt: 0, loading: null, error: null });
  return _studioStaff.threads.get(id);
}

function studioStaffWantThread(id, force = false) {
  const ticketId = String(id || '');
  if (!STUDIO_HELP_TICKET_ID_RE.test(ticketId) || !studioStaffScope() || !studioStaffCan() || !studioHelpServer()) return null;
  const slot = studioStaffThreadSlot(ticketId);
  if (slot.loading) return slot.loading;
  const now = Date.now();
  if (!force && ((slot.failedAt && now - slot.failedAt < STUDIO_HELP_RETRY_MS) || (slot.loadedAt && now - slot.loadedAt < STUDIO_HELP_FRESH_MS))) return null;
  const generation = _studioStaff.generation;
  const signal = typeof studioReadSignal === 'function' ? studioReadSignal() : null;
  const promise = studioApi(`/api/studio/staff/tickets/${encodeURIComponent(ticketId)}`, { method: 'GET' }).then(raw => {
    if (generation !== _studioStaff.generation) return;
    const ticket = studioHelpCleanTicket(raw && raw.ticket);
    if (!ticket) {
      slot.failedAt = Date.now();
      slot.error = { code: 'UNKNOWN', text: adsStudioText('This could not be loaded. Try again in a moment.', 'تعذّر التحميل. أعد المحاولة بعد لحظات.') };
      return;
    }
    slot.ticket = ticket;
    slot.messages = raw && Array.isArray(raw.messages) ? raw.messages.map(studioHelpCleanMessage).filter(Boolean).slice(0, 50) : [];
    slot.loadedAt = now;
    slot.failedAt = 0;
    slot.error = null;
    studioStaffUpdateListed(ticket);
  }, error => {
    if (generation !== _studioStaff.generation) return;
    if (typeof studioReadCancelled === 'function' && studioReadCancelled(error, signal)) return;
    slot.failedAt = Date.now();
    slot.error = { code: studioHelpErrorCode(error), text: studioHelpErrorText(error, 'read') };
  }).finally(() => {
    if (generation !== _studioStaff.generation) return;
    slot.loading = null;
    studioHelpRedraw();
  });
  slot.loading = promise;
  return promise;
}

// As studioHelpUpdateListed: the row stays with its new status (the staff sees what their action did).
function studioStaffUpdateListed(ticket) {
  const slot = studioStaffListSlot();
  const at = slot.items.findIndex(item => item.id === ticket.id);
  const filter = _studioStaff.filter;
  const fits = filter === 'active' ? ticket.status !== 'resolved' : ticket.status === filter;
  if (at >= 0) slot.items[at] = ticket;
  else if (fits) slot.loadedAt = 0;
}

function studioStaffOpen(id) {
  const ticketId = String(id || '');
  if (!STUDIO_HELP_TICKET_ID_RE.test(ticketId)) return false;
  studioStaffScope();
  _studioStaff.openId = _studioStaff.openId === ticketId ? '' : ticketId;
  if (_studioStaff.openId) studioStaffWantThread(ticketId);
  studioHelpRedraw();
  return true;
}

function studioStaffRetryThread(id) {
  studioStaffThreadSlot(String(id || '')).failedAt = 0;
  studioStaffWantThread(id, true);
  studioHelpRedraw();
}

function studioStaffReply(id) {
  studioStaffScope();
  const key = String(id || '');
  if (!_studioStaff.replies.has(key)) _studioStaff.replies.set(key, { text: '', operationId: studioHelpOperationId('answer'), sending: false, error: '' });
  return _studioStaff.replies.get(key);
}

function studioStaffReplySet(id, value) {
  const reply = studioStaffReply(id);
  if (!reply.sending) reply.text = String(value || '').slice(0, STUDIO_HELP_MESSAGE_MAX);
}

function studioStaffReplySend(id) {
  if (!studioStaffCan()) return null;
  return studioHelpPostMessage(id, studioStaffReply(id), `/api/studio/staff/tickets/${encodeURIComponent(String(id || ''))}/messages`, 'team');
}

// POST /staff/tickets/{id}/status: answered, waiting_customer, resolved or open (single flight).
function studioStaffStatus(id, status) {
  const ticketId = String(id || '');
  if (!STUDIO_HELP_TICKET_ID_RE.test(ticketId) || !STUDIO_HELP_STATUSES.includes(status) || !studioStaffCan() || !studioHelpServer()) return null;
  studioStaffScope();
  const key = `status:${ticketId}`;
  if (_studioStaff.busy.has(key)) return null;
  const operationId = studioHelpOperationId('status');
  _studioStaff.busy.set(key, operationId);
  studioHelpRedraw();
  const generation = _studioStaff.generation;
  return studioApi(`/api/studio/staff/tickets/${encodeURIComponent(ticketId)}/status`, { method: 'POST', body: { status, operationId } }).then(raw => {
    if (generation !== _studioStaff.generation) return null;
    const ticket = studioHelpCleanTicket(raw && raw.ticket);
    if (ticket) {
      studioStaffThreadSlot(ticketId).ticket = ticket;
      studioStaffUpdateListed(ticket);
    }
    return ticket;
  }, error => {
    if (generation !== _studioStaff.generation) return null;
    studioHelpNotify(false, adsStudioText('Not done', 'لم يتم'), studioHelpErrorText(error, 'action'));
    studioStaffWantThread(ticketId, true);
    return null;
  }).finally(() => {
    if (generation !== _studioStaff.generation) return;
    _studioStaff.busy.delete(key);
    studioHelpRedraw();
  });
}

// The audited WhatsApp link (P3-11): shown only when the customer saved a number with consent.
function studioStaffContact(id) {
  const ticketId = String(id || '');
  const slot = studioStaffThreadSlot(ticketId);
  const ticket = slot.ticket;
  if (!ticket || !ticket.ownerId || !studioStaffCan() || !studioHelpServer()) return null;
  const entry = _studioStaff.contacts.get(ticketId) || { url: '', error: '', loading: null };
  if (entry.loading) return entry.loading;
  const generation = _studioStaff.generation;
  const promise = studioApi(`/api/studio/staff/customers/${encodeURIComponent(ticket.ownerId)}/contact?relatedType=ticket&relatedId=${encodeURIComponent(ticketId)}`, { method: 'GET' }).then(raw => {
    if (generation !== _studioStaff.generation) return null;
    const url = raw && typeof raw.whatsappUrl === 'string' && /^https:\/\/wa\.me\/\d{6,20}(\?text=[^\s"'<>]*)?$/.test(raw.whatsappUrl) ? raw.whatsappUrl : '';
    entry.url = url;
    entry.error = url ? '' : adsStudioText('No WhatsApp link came back.', 'لم يصل رابط واتساب.');
    return url;
  }, error => {
    if (generation !== _studioStaff.generation) return null;
    entry.error = studioHelpErrorText(error, 'read');
    return null;
  }).finally(() => {
    if (generation !== _studioStaff.generation) return;
    entry.loading = null;
    studioHelpRedraw();
  });
  entry.loading = promise;
  _studioStaff.contacts.set(ticketId, entry);
  studioHelpRedraw();
  return promise;
}

function renderStudioStaffThread(id) {
  const slot = studioStaffThreadSlot(id);
  const ticket = slot.ticket;
  if (!ticket) {
    return slot.error
      ? renderStudioHelpProblem(slot.error, `studioStaffRetryThread('${id}')`, 'studio-staff-problem')
      : `<p class="studio-help-empty">${studioEsc(adsStudioText('Reading the ticket…', 'نقرأ التذكرة…'))}</p>`;
  }
  const reply = studioStaffReply(id);
  const busy = _studioStaff.busy.has(`status:${id}`);
  const contact = _studioStaff.contacts.get(id) || { url: '', error: '', loading: null };
  const statusButton = (status, label, testId) => (ticket.status === status ? '' : `<button type="button" class="studio-v2-action studio-help-small" data-testid="${testId}" onclick="studioStaffStatus('${id}', '${status}')"${busy ? ' disabled aria-busy="true"' : ''}>${studioEsc(label)}</button>`);
  const contactHtml = contact.url
    ? `<a class="studio-v2-action studio-help-small" data-testid="studio-staff-whatsapp-link" href="${studioEsc(contact.url)}" target="_blank" rel="noopener noreferrer">${studioHelpIcon('message-circle')}<span>${studioEsc(adsStudioText('Open WhatsApp', 'افتح واتساب'))}</span></a>`
    : `<button type="button" class="studio-v2-action studio-help-small" data-testid="studio-staff-whatsapp" onclick="studioStaffContact('${id}')"${contact.loading ? ' disabled aria-busy="true"' : ''}>${studioHelpIcon('message-circle')}<span>${studioEsc(adsStudioText('Message on WhatsApp', 'راسل على واتساب'))}</span></button>`;
  return `
            <div class="studio-help-thread" data-testid="studio-staff-thread" data-ticket="${studioEsc(id)}" data-status="${studioEsc(ticket.status)}">
              ${studioHelpRelatedLinkStaff(ticket)}
              ${renderStudioHelpMessages(slot.messages, true)}
              ${renderStudioHelpReplyForm(id, reply, `studioStaffReplySend('${id}');`, 'studio-staff-reply')}
              <div class="studio-help-actions" data-testid="studio-staff-status-actions">
                ${statusButton('waiting_customer', adsStudioText('Waiting for the customer', 'بانتظار العميل'), 'studio-staff-status-waiting')}
                ${statusButton('resolved', adsStudioText('Resolve', 'حلّ التذكرة'), 'studio-staff-status-resolved')}
                ${ticket.status === 'resolved' ? statusButton('open', adsStudioText('Reopen', 'أعد الفتح'), 'studio-staff-status-open') : ''}
                ${contactHtml}
              </div>
              ${contact.error ? `<p class="studio-help-note" data-testid="studio-staff-whatsapp-note">${studioEsc(contact.error)}</p>` : ''}
            </div>`;
}

function studioHelpRelatedLinkStaff(ticket) {
  if (!ticket.relatedType || !ticket.relatedId) return '';
  const what = ticket.relatedType === 'campaign' ? adsStudioText('Request', 'الطلب') : ticket.relatedType === 'payment' ? adsStudioText('Payment', 'الدفعة') : adsStudioText('Page', 'الصفحة');
  return `<p class="studio-help-note" data-testid="studio-staff-related">${studioEsc(`${what}: `)}${studioLtr(ticket.relatedId)}</p>`;
}

// The tickets section of the classic review tab (15c draws it under the review and launch queues).
function renderStudioStaffTicketsClassic() {
  if (!studioStaffCan() || !studioHelpServer()) return '';
  studioStaffScope();
  const slot = studioStaffListSlot();
  studioStaffWant();
  const chips = STUDIO_STAFF_FILTERS.map(([key, en, ar]) =>
    `<button type="button" class="studio-help-chip" data-testid="studio-staff-filter-${key}" aria-pressed="${key === _studioStaff.filter ? 'true' : 'false'}" onclick="studioStaffFilter('${key}')">${studioEsc(adsStudioText(en, ar))}</button>`).join('');
  let body = '';
  if (!slot.loadedAt && slot.error) body = renderStudioHelpProblem(slot.error, 'studioStaffRetry()', 'studio-staff-problem');
  else if (!slot.loadedAt) body = `<p class="studio-help-empty" data-testid="studio-staff-loading">${studioEsc(adsStudioText('Reading the tickets…', 'نقرأ التذاكر…'))}</p>`;
  else if (!slot.items.length) body = `<p class="studio-help-empty" data-testid="studio-staff-empty">${studioEsc(adsStudioText('No tickets in this list.', 'لا توجد تذاكر في هذه القائمة.'))}</p>`;
  else {
    body = `<ul class="studio-help-list" data-testid="studio-staff-list">${slot.items.map(ticket => {
      const open = _studioStaff.openId === ticket.id;
      return renderStudioHelpRow(ticket, `studioStaffOpen('${ticket.id}')`, true).replace('</li>', `${open ? renderStudioStaffThread(ticket.id) : ''}</li>`);
    }).join('')}</ul>`;
    if (slot.nextCursor) body += `<button type="button" class="studio-v2-action studio-help-small" data-testid="studio-staff-more" onclick="studioStaffMore()"${slot.loading ? ' disabled' : ''}>${studioEsc(adsStudioText('Show more', 'اعرض المزيد'))}</button>`;
  }
  const urgent = slot.items.filter(ticket => (ticket.urgent || ticket.stopRequest) && ticket.status !== 'resolved').length;
  return `
    <section class="studio-help studio-staff-tickets" data-testid="studio-staff-tickets" aria-labelledby="studio-staff-tickets-title">
      <div class="studio-help-card">
        <div class="studio-help-head">
          <h2 id="studio-staff-tickets-title" class="studio-help-h2">${studioEsc(adsStudioText('Tickets', 'التذاكر'))}${urgent ? ` <span class="studio-help-status is-urgent" data-tone="rose" data-testid="studio-staff-urgent-count">${studioHelpIcon('hand', 'studio-help-status-icon')}<span>${studioEsc(adsStudioText(`${urgent} stop request${urgent === 1 ? '' : 's'}`, `${studioHelpArCount(urgent, 'طلب إيقاف واحد', 'طلبا إيقاف', 'طلبات إيقاف', 'طلب إيقاف')}`))}</span></span>` : ''}</h2>
          <button type="button" class="studio-help-link" data-testid="studio-staff-refresh" onclick="studioStaffRetry()"${slot.loading ? ' disabled' : ''}>${studioHelpIcon('refresh-cw', 'studio-help-ask-icon')}<span>${studioEsc(adsStudioText('Refresh', 'تحديث'))}</span></button>
        </div>
        <p class="studio-help-note">${studioEsc(adsStudioText('Stop requests come first. A reply marks the ticket answered; payment and account tickets are handled by admins.', 'طلبات الإيقاف أولاً. الرد يعلّم التذكرة كمردود عليها؛ تذاكر الدفع والحساب يعالجها المديرون.'))}</p>
        <div class="studio-help-chips" role="group" aria-label="${studioEsc(adsStudioText('Show', 'اعرض'))}">${chips}</div>
        ${body}
      </div>
    </section>`;
}

// ------------------------------------------------------------------ hooks from the other screens

// Nothing here wraps another file's function. The shell (15h) asks studioHelpClassicTab() through
// studioV2ClassicTabKnown (so its tab fix keeps ?tab=help) and draws studioInboxBadge() on the bell;
// My ads (15k) routes its "Ask about this" and "Ask to stop" actions to studioHelpAskAbout and
// studioStopSheetOpen; the classic screens (15c) draw renderStudioHelpClassic, studioHelpAskButton,
// the stop sheet and renderStudioStaffTicketsClassic. Every call site guards with typeof.

// A page opened at ?tab=help before /me said the service is on: the classic tab follows once it does.
if (typeof studioMeSubscribe === 'function') {
  studioMeSubscribe(() => {
    try {
      if (typeof state === 'undefined' || state.currentView !== 'ads-studio' || studioHelpInV2()) return;
      if (typeof studioV2Frame === 'function' && studioV2Frame()) return;
      const tab = new URLSearchParams(window.location.search || '').get('tab');
      if (tab === 'help' && studioHelpClassicTab() && String(_adsStudioActiveTab || '') !== 'help') {
        _adsStudioActiveTab = 'help';
        studioHelpRedraw();
      }
    } catch (_) { /* the Overview stays */ }
  });
}
