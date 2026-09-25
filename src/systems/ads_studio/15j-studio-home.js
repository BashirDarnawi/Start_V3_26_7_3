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
