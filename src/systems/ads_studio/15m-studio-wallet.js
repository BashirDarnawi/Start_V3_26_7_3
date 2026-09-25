// ==========================================
// ALBAYAN STUDIO v2 — WALLET AND ACCOUNT (plan tasks P2-06, P2-07; styles in assets/ads-workspace.css)
// ==========================================
// Two customer screens of the v2 frame (15h), drawn inside the frame's own screen roots
// (data-testid="studio-screen-wallet" / "studio-screen-account"):
//
// Wallet (?tab=wallet) — every amount is the server's own (GET /api/studio/wallet/summary, P1-07, read
// through Home's one copy of it, studioData in 15j: a money action anywhere in the studio renews it
// for this screen too); nothing here adds or converts money except the "≈ dinars" estimate before a
// payment request:
//   - the four numbers (Available, Reserved, In your ads, Spent) with one line each on what they
//     mean, "On its way back" only when it is not zero, and "Meta used $Y so far" only for ads
//     linked to Meta (the server sends null before a link, PLAN.md §5.4);
//   - payment requests waiting for our confirmation, with their PAY- code, the method's own
//     instructions (GET /api/wallet/payment-requests/methods), the receipt photo when the method
//     needs one, and Cancel (an in-page sheet, never a native dialog);
//   - the money of each ad, grouped by ad: every paid cycle with its steps (paid, returned) in
//     the server's words;
//   - the plan balance in dinars on its own card (never "$", never mixed with the dollars);
//   - Add money (?tab=wallet&id=add-money; Back returns to the wallet): purpose first (my ads in
//     dollars, or my plan in dinars), amount ($10/$25/$50/$100 or typed, Arabic digits too),
//     method, a confirm screen, then the PAY- code and how to pay. One idempotency key per
//     (user, currency, amount, method) until the server answers with the request (kept across
//     reopening Add money), so a retry after a lost answer replays the same request instead of
//     adding a second one. Other screens open it with studioWalletOpenAdd(purpose, amountMinor):
//     the request builder's "Add money" (15l) asks for the missing dollars.
// Account (?tab=account) — name (read only), language, theme, the optional WhatsApp number with
// consent (GET/PUT /api/studio/profile, P2-07, the same phone rule as the server), privacy and
// sign out (the app's own handleLogout).
//
// Both screens are registered with the shell (studioV2RegisterScreen, 15h): any error here falls back
// to the shell's own placeholder. Every server text is escaped; every action is single-flight.

const STUDIO_WALLET_USD_PRESETS = Object.freeze([1000, 2500, 5000, 10000]);  // $10 / $25 / $50 / $100
const STUDIO_WALLET_MIN_MINOR = 100;          // 1.00 of either currency (wallet_payments.WALLET_PAYMENT_CURRENCIES)
const STUDIO_WALLET_MAX_MINOR = 100000000;    // 1,000,000.00: a typing guard far below the server's own ceiling
const STUDIO_WALLET_MAX_OPEN = 5;             // wallet_payments.MAX_OPEN_PAYMENT_REQUESTS
const STUDIO_WALLET_FRESH_MS = 30000;         // an open wallet asks the server again after this long
const STUDIO_WALLET_ADD_ID = 'add-money';     // ?tab=wallet&id=add-money (the builder's "Add money" too)
const STUDIO_WALLET_STEPS = 4;                // purpose, amount, method, confirm (then the result)
const STUDIO_WALLET_HISTORY_MAX = 5;
const STUDIO_WALLET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const STUDIO_WALLET_REF_RE = /^PAY-[A-Z0-9]{4,16}$/;
const STUDIO_WALLET_METHOD_RE = /^[a-z0-9_]{2,40}$/;

// The payment routes answer with a plain English sentence; these are their stable starts
// (server/wallet_payments.py) in the reader's words. Anything else goes through the studio map.
const STUDIO_WALLET_REFUSALS = Object.freeze([
  ['Too many unpaid charge requests', 'You already have 5 payment requests waiting. Pay or cancel one of them first.', 'لديك 5 طلبات دفع تنتظر. ادفع أحدها أو ألغِه أولاً.'],
  ['Minimum wallet charge is', 'The smallest amount you can add is 1.00.', 'أقل مبلغ يمكنك إضافته هو 1.00.'],
  ['Unknown payment method', 'This payment method is no longer offered. Choose another one.', 'طريقة الدفع هذه لم تعد متاحة. اختر طريقة أخرى.'],
  ['The wallet is charged in USD or LYD', 'Money can be added in dollars or dinars only.', 'يمكن إضافة المال بالدولار أو الدينار فقط.'],
  ['Idempotency key was already used', 'This request changed while it was being sent. Check your payment requests before trying again.', 'تغيّر هذا الطلب أثناء إرساله. راجع طلبات الدفع قبل المحاولة مرة أخرى.'],
  ['Payment was already received', 'We already received this payment, so it cannot be cancelled.', 'استلمنا هذه الدفعة بالفعل، لذلك لا يمكن إلغاؤها.'],
  ['Payment request is confirmed', 'This payment is already confirmed.', 'هذه الدفعة مؤكدة بالفعل.'],
  ['Payment request is canceled', 'This payment request is already cancelled.', 'طلب الدفع هذا ملغى بالفعل.'],
  ['Only a pending request can take a receipt', 'A receipt can be added only while the payment waits for our confirmation.', 'يمكن إرفاق الإيصال فقط ما دامت الدفعة تنتظر تأكيدنا.'],
  ['The receipt photo is invalid or too large', 'Use a clear JPG or PNG photo under 4 MB.', 'استخدم صورة واضحة بصيغة JPG أو PNG أقل من 4 ميغابايت.'],
  ['Payment request not found', 'This payment request was not found. Refresh the wallet.', 'لم نجد طلب الدفع هذا. حدّث المحفظة.']
]);

const _studioWallet = {
  forUser: '', generation: 0,
  clean: { raw: null, value: null },       // the wallet summary (15j's copy) as these screens use it
  requests: null,                          // the owner's payment requests (ids, methods, dinar amounts, receipts)
  requestsAt: 0, listLoading: null, listAgain: false,
  methods: null, rate: 0, methodsFailed: false, methodsLoading: null,
  add: null,                               // the Add money flow (studioWalletNewFlow)
  idem: { fingerprint: '', key: '' },      // the create's idempotency key, until the server answers with the request
  busy: new Set(),                         // single-flight: 'create', 'cancel:<id>', 'receipt:<id>'
  plansAsked: false,
  whereOpen: false                         // "Where is every dollar?" stays open across redraws
};

const _studioAccount = {
  forUser: '', generation: 0,
  profile: null, error: '', loading: null,
  editing: false, draftNumber: '', draftConsent: false, formError: '', saving: false
};

// ------------------------------------------------------------------ small helpers

function studioWalletUserId() {
  return typeof state !== 'undefined' && state && state.currentUser ? String(state.currentUser.id || '') : '';
}

function studioWalletInt(value) {
  return Number.isSafeInteger(value) ? value : null;
}

function studioWalletText(value, max = 300) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function studioWalletIcon(name) {
  return typeof studioV2Icon === 'function' ? studioV2Icon(name) : '';
}

// Arabic counted words: 1 دقيقة, 2 دقيقتين, 3-10 دقائق, 11+ دقيقة.
function studioWalletArCount(count, one, two, few, many) {
  if (count === 1) return one;
  if (count === 2) return two;
  return count >= 3 && count <= 10 ? `${count} ${few}` : `${count} ${many}`;
}

// "5 min ago" / «قبل 5 دقائق» for a server time; '' when it is not a time.
function studioWalletAgo(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return adsStudioText('just now', 'الآن');
  if (minutes < 60) return adsStudioText(`${minutes} min ago`, `قبل ${studioWalletArCount(minutes, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة')}`);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return adsStudioText(`${hours} h ago`, `قبل ${studioWalletArCount(hours, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}`);
  const days = Math.round(hours / 24);
  return adsStudioText(`${days} days ago`, `قبل ${studioWalletArCount(days, 'يوم', 'يومين', 'أيام', 'يوماً')}`);
}

// A server time in Tripoli time, Latin digits (like every amount): "25 Sep" or "Thu 10:00".
function studioWalletWhen(iso, kind = 'date') {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return '';
  const options = kind === 'due'
    ? { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
    : { day: 'numeric', month: 'short', year: 'numeric' };
  try {
    return new Intl.DateTimeFormat(adsStudioIsAr() ? 'ar-LY-u-nu-latn' : 'en-GB', { timeZone: 'Africa/Tripoli', ...options }).format(new Date(at));
  } catch (_) {
    return new Date(at).toISOString().slice(0, kind === 'due' ? 16 : 10).replace('T', ' ');
  }
}

// An amount in its own currency: dollars with "$", dinars with LYD / د.ل (never "$").
function studioWalletMoney(minor, currency) {
  return currency === 'LYD' ? studioLyd(minor) : studioUsd(minor);
}

// The dinar estimate of a dollar amount: ceil(amount x rate), the server's own rule
// (wallet_payments.lyd_minor_for), shown only as "≈" until the server stamps the real one.
function studioWalletLydEstimate(amountMinor, rate) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !(rate > 0)) return null;
  const product = amountMinor * Math.floor(rate * 10000 + 0.5);
  return Number.isSafeInteger(product) ? Math.floor((product + 9999) / 10000) : null;
}

function studioWalletErrorText(error, kind = 'action') {
  const detail = error && error.payload && typeof error.payload.detail === 'string' ? error.payload.detail : '';
  const status = Number(error && error.status) || 0;
  if (detail && status >= 400 && status < 500 && status !== 429) {
    const hit = STUDIO_WALLET_REFUSALS.find(([start]) => detail.startsWith(start));
    if (hit) return adsStudioText(hit[1], hit[2]);
  }
  const info = error && error.studio && typeof error.studio.text === 'string' ? error.studio : studioErrorInfo(error, kind);
  return info.text;
}

function studioWalletRedraw() {
  try {
    if (typeof state === 'undefined' || state.currentView !== 'ads-studio') return;
    if (typeof studioV2Frame === 'function' && studioV2Frame() !== 'customer') return;
    const tab = new URLSearchParams(window.location.search || '').get('tab');
    if (tab !== 'wallet' && tab !== 'account') return;
    studioV2Rerender();
  } catch (_) { /* the next render shows the latest state */ }
}

function studioWalletNotify(ok, title, text) {
  try { if (typeof showNotification === 'function') showNotification(title, text, ok ? 'success' : 'error'); } catch (_) {}
}

// ------------------------------------------------------------------ wallet data

// Everything kept here belongs to one signed-in user: another user starts empty.
function studioWalletScope() {
  const uid = studioWalletUserId();
  if (_studioWallet.forUser !== uid) {
    _studioWallet.generation++;
    Object.assign(_studioWallet, {
      forUser: uid, clean: { raw: null, value: null }, requests: null, requestsAt: 0, listLoading: null, listAgain: false,
      add: null, idem: { fingerprint: '', key: '' }, whereOpen: false
    });
    _studioWallet.busy.clear();
  }
  return uid;
}

// The summary as the screens use it: whole cents or null (shown as "—"), lists as lists.
function studioWalletCleanSummary(raw) {
  if (!raw || typeof raw !== 'object' || !raw.usd || typeof raw.usd !== 'object') return null;
  const usd = raw.usd;
  const list = value => Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
  const used = studioWalletInt(usd.metaUsedInAdsMinor);
  return {
    usd: {
      availableMinor: studioWalletInt(usd.availableMinor),
      reservedMinor: studioWalletInt(usd.reservedMinor),
      inAdsMinor: studioWalletInt(usd.inAdsMinor),
      metaUsedInAdsMinor: used !== null && used >= 0 ? used : null,
      metaCheckedAt: studioWalletText(usd.metaCheckedAt, 40) || null,
      beingReturnedMinor: studioWalletInt(usd.beingReturnedMinor),
      spentMinor: studioWalletInt(usd.spentMinor),
      addedMinor: studioWalletInt(usd.addedMinor),
      adjustmentsMinor: studioWalletInt(usd.adjustmentsMinor)
    },
    reserved: list(raw.reserved).slice(0, 100),
    chains: list(raw.chains).slice(0, 300),
    lydMinor: raw.lyd && typeof raw.lyd === 'object' ? studioWalletInt(raw.lyd.balanceMinor) : null,
    pending: list(raw.pendingPayments).slice(0, 20)
  };
}

// One payment request row (GET /api/wallet/payment-requests, or the create answer).
function studioWalletRequestRow(entity) {
  if (!entity || typeof entity !== 'object') return null;
  const data = entity.data && typeof entity.data === 'object' ? entity.data : {};
  const id = String(entity.id || '');
  const reference = String(data.reference || '');
  const rate = Number(data.lydRate);
  return {
    id: STUDIO_WALLET_ID_RE.test(id) ? id : '',
    reference: STUDIO_WALLET_REF_RE.test(reference) ? reference : '',
    status: ['pending', 'confirmed', 'canceled'].includes(data.status) ? data.status : 'other',
    currency: String(data.currency || 'USD').trim().toUpperCase() === 'LYD' ? 'LYD' : 'USD',
    amountMinor: studioWalletInt(data.amountMinor),
    amountMinorLYD: studioWalletInt(data.amountMinorLYD),
    lydRate: Number.isFinite(rate) && rate > 0 ? rate : null,
    method: STUDIO_WALLET_METHOD_RE.test(String(data.method || '')) ? String(data.method) : '',
    createdAt: studioWalletText(data.createdAt, 40),
    confirmedAt: studioWalletText(data.confirmedAt, 40),
    canceledAt: studioWalletText(data.canceledAt, 40),
    hasReceipt: Number(data._photoCount || 0) > 0 || !!data.receiptPhotoAt || !!data.receiptPhoto
  };
}

function studioWalletCleanMethods(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(method => method && typeof method === 'object' && STUDIO_WALLET_METHOD_RE.test(String(method.id || '')))
    .slice(0, 20)
    .map(method => ({
      id: String(method.id),
      name: method.name, desc: method.desc, instructions: method.instructions,
      requiresReceiptPhoto: method.requiresReceiptPhoto === true
    }));
}

function studioWalletMethod(id) {
  return (_studioWallet.methods || []).find(method => method.id === id) || null;
}

function studioWalletMethodName(id) {
  const method = studioWalletMethod(id);
  return (method && studioPickText(method.name, 80)) || String(id || '');
}

// The payment methods and today's dollar rate: read once. After a failure only a person asks
// again (Try again, Refresh), so a screen that redraws never loops on a failing read.
function studioWalletLoadMethods(retry = false) {
  if (_studioWallet.methods) return Promise.resolve(_studioWallet.methods);
  if (_studioWallet.methodsLoading) return _studioWallet.methodsLoading;
  if (_studioWallet.methodsFailed && retry !== true) return Promise.resolve(null);
  const generation = _studioWallet.generation;
  _studioWallet.methodsFailed = false;
  _studioWallet.methodsLoading = (async () => {
    try {
      const catalog = await studioApi('/api/wallet/payment-requests/methods', { method: 'GET' });
      _studioWallet.methods = studioWalletCleanMethods(catalog && catalog.methods);
      const rate = Number(catalog && catalog.rate && catalog.rate.usdToLyd);
      _studioWallet.rate = Number.isFinite(rate) && rate > 0 ? rate : 0;
    } catch (_) {
      _studioWallet.methodsFailed = true;
    } finally {
      _studioWallet.methodsLoading = null;
    }
    if (generation === _studioWallet.generation) studioWalletRedraw();
    return _studioWallet.methods;
  })();
  return _studioWallet.methodsLoading;
}

// The wallet summary, cleaned (null while unknown): Home's one copy (studioData, 15j).
function studioWalletSummary() {
  const raw = typeof studioDataValue === 'function' ? studioDataValue('wallet') : null;
  if (!raw) return null;
  if (_studioWallet.clean.raw !== raw) _studioWallet.clean = { raw, value: studioWalletCleanSummary(raw) };
  return _studioWallet.clean.value;
}

// {loading, error}: the last summary read's refusal in the reader's words ('' after a good answer).
function studioWalletSummaryState() {
  const known = typeof studioDataState === 'function' ? studioDataState('wallet') : { loading: false, failure: null };
  const failure = known.failure;
  return {
    loading: !!known.loading,
    error: failure ? (failure.text || adsStudioText('The wallet could not be read. Try again in a minute.', 'تعذّرت قراءة المحفظة. أعد المحاولة بعد دقيقة.')) : ''
  };
}

// The owner's payment requests, read with the summary (and at most every half minute by itself; a
// failed read keeps the last list). force: now (a read on its way is followed by one more). Returns
// the read's promise, or null when nothing new was asked.
function studioWalletLoadRequests(force = false) {
  if (_studioWallet.listLoading) {
    if (!force) return null;
    _studioWallet.listAgain = true;
    return _studioWallet.listLoading;
  }
  if (!force && Date.now() - _studioWallet.requestsAt < STUDIO_WALLET_FRESH_MS) return null;
  const generation = _studioWallet.generation;
  _studioWallet.requestsAt = Date.now();
  _studioWallet.listAgain = false;
  const promise = studioApi('/api/wallet/payment-requests', { method: 'GET' }).then(reply => {
    if (generation !== _studioWallet.generation) return;
    const rows = reply && Array.isArray(reply.requests) ? reply.requests : [];
    _studioWallet.requests = rows.map(studioWalletRequestRow).filter(row => row && row.reference);
  }, () => { /* the last list stays on screen */ }).then(() => {
    if (generation !== _studioWallet.generation) return null;
    _studioWallet.listLoading = null;
    if (!_studioWallet.listAgain) return null;
    _studioWallet.listAgain = false;
    const again = studioWalletLoadRequests(true);
    return again ? again.then(() => studioWalletRedraw()) : null;
  });
  _studioWallet.listLoading = promise;
  return promise;
}

// The summary (15j's copy) and the payment requests. A fresh answer is reused, a read on its way is
// joined (a forced one is followed by one more, so an answer never predates the action that asked),
// a failure keeps the last good numbers on screen. force: ask the server now.
function studioWalletLoad(force = false) {
  const uid = studioWalletScope();
  if (!uid || typeof isServerModeEnabled !== 'function' || !isServerModeEnabled()) return Promise.resolve(null);
  const joined = studioWalletSummaryState().loading;
  const summaryRead = typeof studioDataWant === 'function' ? studioDataWant('wallet', force, STUDIO_WALLET_FRESH_MS) : null;
  const started = !!summaryRead && (force || !joined);
  const listRead = studioWalletLoadRequests(force || started);
  if (!started && !listRead) return Promise.resolve(summaryRead).then(() => studioWalletSummary());
  if (!_studioWallet.methods) studioWalletLoadMethods(force);
  const generation = _studioWallet.generation;
  return Promise.allSettled([summaryRead, listRead]).then(() => {
    if (generation === _studioWallet.generation) studioWalletRedraw();
    return studioWalletSummary();
  });
}

function studioWalletRefresh() {
  studioWalletLoad(true);
}

function studioWalletWhereToggle(details) {
  _studioWallet.whereOpen = !!(details && details.open);
}

function studioWalletRetryMethods() {
  studioWalletLoadMethods(true);
  studioWalletRedraw();
}

function studioWalletRequestByReference(reference) {
  return (_studioWallet.requests || []).find(row => row.reference === reference) || null;
}

function studioWalletRequestById(id) {
  return (_studioWallet.requests || []).find(row => row.id === id) || null;
}

// ------------------------------------------------------------------ the two screens in the shell

studioV2RegisterScreen('wallet', route => renderStudioWalletScreen(route));
studioV2RegisterScreen('account', () => renderStudioAccountScreen());

// ------------------------------------------------------------------ the wallet screen

function renderStudioWalletScreen(route) {
  studioWalletScope();
  if (route && route.id === STUDIO_WALLET_ADD_ID) return renderStudioWalletAdd();
  studioWalletLoad();
  const summary = studioWalletSummary();
  const known = studioWalletSummaryState();
  if (!summary) {
    return known.error && !known.loading
      ? `
          <div class="studio-v2-wallet" data-testid="studio-wallet">
            ${renderStudioWalletProblem(known.error)}
          </div>`
      : `
          <div class="studio-v2-wallet" data-testid="studio-wallet" aria-busy="true">
            <p class="studio-v2-wallet-loading" role="status">${studioEsc(adsStudioText('Reading your wallet…', 'جارٍ قراءة محفظتك…'))}</p>
          </div>`;
  }
  return `
          <div class="studio-v2-wallet" data-testid="studio-wallet">
            ${known.error ? renderStudioWalletProblem(known.error, true) : ''}
            ${renderStudioWalletNumbers(summary.usd)}
            ${renderStudioWalletActions(summary)}
            ${renderStudioWalletPending(summary)}
            ${renderStudioWalletReserved(summary.reserved)}
            ${renderStudioWalletAds(summary.chains)}
            ${renderStudioWalletPlanCard(summary.lydMinor)}
            ${renderStudioWalletHistory()}
          </div>`;
}

function renderStudioWalletProblem(text, keptOld = false) {
  const note = keptOld ? adsStudioText('These are the last numbers we read.', 'هذه آخر أرقام قرأناها.') : '';
  return `
            <div class="studio-v2-wallet-banner is-bad" role="alert" data-testid="studio-wallet-problem">
              ${studioWalletIcon('circle-alert')}
              <div class="studio-v2-wallet-banner-body">
                <p class="studio-v2-wallet-banner-text">${studioEsc(text)} ${studioEsc(note)}</p>
                <button type="button" class="studio-v2-action" data-testid="studio-wallet-retry" onclick="studioWalletRefresh()">${studioWalletIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Try again', 'أعد المحاولة'))}</span></button>
              </div>
            </div>`;
}

// The four numbers (PLAN.md §7.8), each with what it means. "Meta used" only when the server has
// a confirmed Meta figure for linked ads (null before any link).
function renderStudioWalletNumbers(usd) {
  const tiles = [
    ['available', 'Available', 'متاح', usd.availableMinor, 'Yours to use now.', 'لك وتستطيع استخدامه الآن.'],
    ['reserved', 'Reserved', 'محجوز', usd.reservedMinor, 'Held for requests waiting for our team. Still yours: withdraw a request to free it.', 'محجوز لطلبات تنتظر فريقنا، وما زال لك: اسحب الطلب لتحريره.'],
    ['in-ads', 'In your ads', 'في إعلاناتك', usd.inAdsMinor, 'Paid for ads being set up, running or just ended. What Meta does not use comes back after the ad ends.', 'مدفوع لإعلانات قيد التجهيز أو تعمل أو انتهت للتو. ما لا تصرفه ميتا يعود إليك بعد انتهاء الإعلان.'],
    ['spent', 'Spent', 'صُرف', usd.spentMinor, 'Final: what your finished ads used.', 'نهائي: ما صرفته إعلاناتك المنتهية.']
  ];
  const used = usd.metaUsedInAdsMinor;
  const tile = ([key, en, ar, minor, textEn, textAr]) => {
    let extra = '';
    if (key === 'in-ads' && used !== null) {
      const ago = studioWalletAgo(usd.metaCheckedAt);
      const line = adsStudioText(`Meta used ${studioUsd(used)} so far`, `استخدمت ميتا ${studioUsd(used)} حتى الآن`)
        + (ago ? adsStudioText(` · checked ${ago}`, ` · فُحص ${ago}`) : '');
      extra = `<p class="studio-v2-wallet-meta" data-testid="studio-wallet-meta-used">${studioEsc(line)}</p>`;
    }
    return `
              <div class="studio-v2-wallet-tile${key === 'available' ? ' is-main' : ''}" data-testid="studio-wallet-${key}">
                <p class="studio-v2-wallet-tile-label">${studioEsc(adsStudioText(en, ar))}</p>
                <p class="studio-v2-wallet-amount" data-testid="studio-wallet-${key}-amount">${studioLtr(studioUsd(minor))}</p>
                ${extra}
                <p class="studio-v2-wallet-tile-text">${studioEsc(adsStudioText(textEn, textAr))}</p>
              </div>`;
  };
  const back = usd.beingReturnedMinor;
  const returning = back !== null && back !== 0 ? `
            <div class="studio-v2-wallet-banner is-warn" data-testid="studio-wallet-being-returned">
              ${studioWalletIcon('undo-2')}
              <div class="studio-v2-wallet-banner-body">
                <p class="studio-v2-wallet-banner-title">${studioEsc(adsStudioText('On its way back to you', 'في طريقه إليك'))}: ${studioLtr(studioUsd(back))}</p>
                <p class="studio-v2-wallet-banner-text">${studioEsc(adsStudioText('An approval did not finish, so this money is coming back to your wallet, usually within minutes.', 'لم تكتمل موافقة، لذلك يعود هذا المال إلى محفظتك، عادةً خلال دقائق.'))}</p>
              </div>
            </div>` : '';
  const row = (en, ar, minor, testid) => `<div class="studio-v2-wallet-kv-row"><dt>${studioEsc(adsStudioText(en, ar))}</dt><dd data-testid="${testid}">${studioLtr(studioUsd(minor))}</dd></div>`;
  const adjusted = usd.adjustmentsMinor !== null && usd.adjustmentsMinor !== 0;
  return `
            <h2 class="studio-v2-wallet-visually-hidden">${studioEsc(adsStudioText('Your ad money in dollars', 'أموال إعلاناتك بالدولار'))}</h2>
            <div class="studio-v2-wallet-strip" data-testid="studio-wallet-numbers">${tiles.map(tile).join('')}
            </div>${returning}
            ${typeof studioGuideLinks === 'function' ? studioGuideLinks(['money', 'settle'], 'studio-wallet-guides') : ''}
            <details class="studio-v2-wallet-card studio-v2-wallet-where" data-testid="studio-wallet-where" ontoggle="studioWalletWhereToggle(this)"${_studioWallet.whereOpen ? ' open' : ''}>
              <summary>${studioWalletIcon('info')}<span>${studioEsc(adsStudioText('Where is every dollar?', 'أين كل دولار؟'))}</span></summary>
              <dl class="studio-v2-wallet-kv">
                ${row('Added to your wallet', 'أضفته إلى محفظتك', usd.addedMinor, 'studio-wallet-added')}
                ${adjusted ? row('Transfers and corrections', 'تحويلات وتصحيحات', usd.adjustmentsMinor, 'studio-wallet-adjustments') : ''}
              </dl>
              <p class="studio-v2-wallet-note">${studioEsc(adsStudioText(
    'All of it is always in one of these places: Available, Reserved, In your ads, On its way back or Spent. Your plan balance in dinars is separate and never mixed with these dollars.',
    'كل هذا المال موجود دائماً في أحد هذه الأماكن: متاح، محجوز، في إعلاناتك، في طريقه إليك، أو صُرف. أما رصيد الاشتراك بالدينار فمنفصل ولا يختلط بهذه الدولارات.'))}</p>
            </details>`;
}

function studioWalletPendingRows(summary) {
  return summary.pending.map(item => {
    const reference = STUDIO_WALLET_REF_RE.test(String(item.reference || '')) ? String(item.reference) : '';
    return {
      reference,
      amountMinor: studioWalletInt(item.amountMinor),
      currency: String(item.currency || 'USD').toUpperCase() === 'LYD' ? 'LYD' : 'USD',
      createdAt: studioWalletText(item.createdAt, 40),
      dueAt: studioWalletText(item.dueAt, 40),
      request: reference ? studioWalletRequestByReference(reference) : null
    };
  }).filter(item => item.reference);
}

function renderStudioWalletActions(summary) {
  const open = studioWalletPendingRows(summary).length;
  const full = open >= STUDIO_WALLET_MAX_OPEN;
  const loading = studioWalletSummaryState().loading || !!_studioWallet.listLoading;
  return `
            <div class="studio-v2-wallet-actions">
              <button type="button" class="studio-v2-action is-primary" data-testid="studio-wallet-add" onclick="studioWalletOpenAdd()"${full ? ' disabled aria-describedby="studio-wallet-full"' : ''}>${studioWalletIcon('plus')}<span>${studioEsc(adsStudioText('Add money', 'أضف مالاً'))}</span></button>
              <button type="button" class="studio-v2-action" data-testid="studio-wallet-refresh" onclick="studioWalletRefresh()"${loading ? ' aria-busy="true"' : ''}>${studioWalletIcon('refresh-cw')}<span>${studioEsc(loading ? adsStudioText('Reading…', 'جارٍ القراءة…') : adsStudioText('Refresh', 'تحديث'))}</span></button>
            </div>
            ${full ? `<p id="studio-wallet-full" class="studio-v2-wallet-note">${studioEsc(adsStudioText(`You have ${STUDIO_WALLET_MAX_OPEN} payment requests waiting. Pay or cancel one of them to add more money.`, `لديك ${STUDIO_WALLET_MAX_OPEN} طلبات دفع تنتظر. ادفع أحدها أو ألغِه لتضيف مالاً آخر.`))}</p>` : ''}`;
}

// How to pay: the method's own instruction with the request's code and dinar amount filled in.
function studioWalletInstruction(request, reference) {
  const method = request ? studioWalletMethod(request.method) : null;
  const template = method ? studioPickText(method.instructions, 400) : '';
  if (!template || !request) {
    return adsStudioText(`Pay with the code ${reference}. Your wallet is filled as soon as we confirm the payment.`,
      `ادفع مع ذكر الرمز ${reference}. تُضاف الأموال إلى محفظتك فور تأكيدنا للدفعة.`);
  }
  const lyd = request.currency === 'LYD' ? request.amountMinor : request.amountMinorLYD;
  return template
    .split('{reference}').join(reference)
    .split('{amountLYD}').join(lyd !== null ? studioMinorText(lyd) : '—')
    .split('{amountUSD}').join(request.currency === 'USD' && request.amountMinor !== null ? studioMinorText(request.amountMinor) : '—')
    .split('{rate}').join(request.lydRate ? String(request.lydRate) : '—');
}

// The same words as HTML: the code stays one left-to-right piece (never split at its dash in Arabic).
function renderStudioWalletInstruction(request, reference) {
  return studioWalletInstruction(request, reference).split(reference).map(part => studioEsc(part))
    .join(`<bdi dir="ltr" class="studio-v2-wallet-nowrap">${studioEsc(reference)}</bdi>`);
}

function renderStudioWalletCopy(reference) {
  if (!STUDIO_WALLET_REF_RE.test(reference)) return '';
  return `<button type="button" class="studio-v2-action studio-v2-wallet-small" data-testid="studio-wallet-copy" onclick="studioWalletCopy('${reference}')">${studioWalletIcon('copy')}<span>${studioEsc(adsStudioText('Copy code', 'انسخ الرمز'))}</span></button>`;
}

function renderStudioWalletReceipt(request) {
  const method = request ? studioWalletMethod(request.method) : null;
  if (!request || !request.id || request.status !== 'pending' || !method || !method.requiresReceiptPhoto) return '';
  const busy = _studioWallet.busy.has(`receipt:${request.id}`);
  const inputId = `studio-wallet-receipt-${request.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const label = busy ? adsStudioText('Sending the photo…', 'جارٍ إرسال الصورة…')
    : request.hasReceipt ? adsStudioText('Replace the receipt photo', 'استبدل صورة الإيصال') : adsStudioText('Attach the receipt photo', 'أرفق صورة الإيصال');
  return `
                <input type="file" accept="image/*" id="${inputId}" class="studio-v2-wallet-visually-hidden" onchange="studioWalletAttachReceipt('${request.id}', this)"${busy ? ' disabled' : ''} />
                <label for="${inputId}" class="studio-v2-action studio-v2-wallet-small" data-testid="studio-wallet-receipt"${busy ? ' aria-busy="true"' : ''}>${studioWalletIcon('paperclip')}<span>${studioEsc(label)}</span></label>
                ${request.hasReceipt ? `<p class="studio-v2-wallet-note" data-testid="studio-wallet-receipt-attached">${studioWalletIcon('circle-check')} ${studioEsc(adsStudioText('Receipt attached', 'أرفقت الإيصال'))}</p>` : ''}`;
}

function renderStudioWalletPending(summary) {
  const rows = studioWalletPendingRows(summary);
  if (!rows.length) return '';
  const card = item => {
    const request = item.request;
    const purpose = item.currency === 'LYD' ? adsStudioText('For your plan', 'لاشتراكك') : adsStudioText('For your ads', 'لإعلاناتك');
    const dinars = item.currency === 'USD' && request && request.amountMinorLYD !== null
      ? `<div class="studio-v2-wallet-kv-row"><dt>${studioEsc(adsStudioText('You pay in dinars', 'تدفع بالدينار'))}</dt><dd>${studioLtr(studioLyd(request.amountMinorLYD))}</dd></div>` : '';
    const method = request && request.method
      ? `<div class="studio-v2-wallet-kv-row"><dt>${studioEsc(adsStudioText('Method', 'طريقة الدفع'))}</dt><dd>${studioEsc(studioWalletMethodName(request.method))}</dd></div>` : '';
    const due = item.dueAt && studioWalletWhen(item.dueAt, 'due')
      ? adsStudioText(`We confirm it by ${studioWalletWhen(item.dueAt, 'due')} (Tripoli time).`, `نؤكد دفعتك قبل ${studioWalletWhen(item.dueAt, 'due')} (بتوقيت طرابلس).`)
      : adsStudioText('We confirm payments during our working hours. The money appears here as soon as we do.', 'نؤكد الدفعات خلال ساعات عملنا، ويظهر المال هنا فور التأكيد.');
    const cancelBusy = request && _studioWallet.busy.has(`cancel:${request.id}`);
    const cancel = request && request.id ? `<button type="button" class="studio-v2-action studio-v2-wallet-small studio-v2-wallet-danger" data-testid="studio-wallet-cancel" onclick="studioWalletAskCancel('${request.id}')"${cancelBusy ? ' disabled aria-busy="true"' : ''}>${studioWalletIcon('circle-x')}<span>${studioEsc(cancelBusy ? adsStudioText('Cancelling…', 'جارٍ الإلغاء…') : adsStudioText('Cancel request', 'ألغِ الطلب'))}</span></button>` : '';
    return `
              <article class="studio-v2-wallet-card studio-v2-wallet-pay" data-testid="studio-wallet-pending-item" data-reference="${studioEsc(item.reference)}" data-currency="${item.currency}">
                <div class="studio-v2-wallet-row-head">
                  <span class="studio-v2-wallet-chip is-warn">${studioWalletIcon('clock')}<span>${studioEsc(adsStudioText('Waiting for our confirmation', 'بانتظار تأكيدنا'))}</span></span>
                  <span class="studio-v2-wallet-chip">${studioEsc(purpose)}</span>
                </div>
                <p class="studio-v2-wallet-code" data-testid="studio-wallet-reference">${studioLtr(item.reference)}</p>
                <dl class="studio-v2-wallet-kv">
                  <div class="studio-v2-wallet-kv-row"><dt>${studioEsc(adsStudioText('Amount', 'المبلغ'))}</dt><dd data-testid="studio-wallet-pending-amount">${studioLtr(studioWalletMoney(item.amountMinor, item.currency))}</dd></div>
                  ${dinars}${method}
                </dl>
                <p class="studio-v2-wallet-how" data-testid="studio-wallet-instruction">${renderStudioWalletInstruction(request, item.reference)}</p>
                <p class="studio-v2-wallet-note">${studioWalletIcon('calendar-clock')} ${studioEsc(due)}</p>
                <div class="studio-v2-wallet-actions is-compact">
                  ${renderStudioWalletCopy(item.reference)}${renderStudioWalletReceipt(request)}${cancel}
                </div>
              </article>`;
  };
  return `
            <section class="studio-v2-wallet-section" data-testid="studio-wallet-pending" aria-labelledby="studio-wallet-pending-title">
              <h2 id="studio-wallet-pending-title" class="studio-v2-wallet-h2">${studioEsc(adsStudioText('Payment requests', 'طلبات الدفع'))}</h2>
              ${rows.map(card).join('')}
            </section>`;
}

function renderStudioWalletReserved(reserved) {
  if (!reserved.length) return '';
  const item = entry => {
    const name = studioWalletText(entry.name, 200) || adsStudioText('Your ad', 'إعلانك');
    const daily = studioWalletInt(entry.dailyMinor);
    const days = studioWalletInt(entry.days);
    const split = daily !== null && days !== null
      ? `<p class="studio-v2-wallet-note">${studioEsc(adsStudioText(`${studioUsd(daily)} a day for ${days} days`, `${studioUsd(daily)} يومياً لمدة ${adsStudioDaysText(days)}`))}</p>` : '';
    return `
                <li class="studio-v2-wallet-line" data-testid="studio-wallet-reserved-item">
                  <span class="studio-v2-wallet-line-name">${studioEsc(name)}</span>
                  <span class="studio-v2-wallet-line-amount">${studioLtr(studioUsd(studioWalletInt(entry.budgetMinor)))}</span>
                  ${split}
                </li>`;
  };
  return `
            <section class="studio-v2-wallet-card" data-testid="studio-wallet-reserved-list" aria-labelledby="studio-wallet-reserved-title">
              <h2 id="studio-wallet-reserved-title" class="studio-v2-wallet-h2">${studioEsc(adsStudioText('Held for requests waiting for review', 'محجوز لطلبات تنتظر المراجعة'))}</h2>
              <ul class="studio-v2-wallet-lines">${reserved.map(item).join('')}
              </ul>
            </section>`;
}

const STUDIO_WALLET_CYCLE_LOOK = Object.freeze({
  in_ads: ['megaphone', 'is-accent', 'In your ads', 'في إعلاناتك'],
  approving: ['hourglass', 'is-warn', 'Being approved', 'قيد الموافقة'],
  being_returned: ['undo-2', 'is-warn', 'On its way back to you', 'في طريقه إليك'],
  spent: ['receipt', '', 'Spent', 'صُرف'],
  returned: ['circle-check', 'is-ok', 'Returned in full', 'أُعيد كاملاً']
});

// Each paid cycle (one budget payment and what came back from it) as the server lists it.
function renderStudioWalletCycle(chain) {
  const cycleState = String(chain.state || '');
  const look = STUDIO_WALLET_CYCLE_LOOK[cycleState] ||['circle-alert', '', 'Status not available', 'الحالة غير متاحة'];
  const paid = studioWalletInt(chain.paidMinor);
  const returned = studioWalletInt(chain.returnedMinor);
  const net = studioWalletInt(chain.netMinor);
  const used = studioWalletInt(chain.metaUsedMinor);
  const bucketWords = {
    inAds: ['Now in your ads', 'الآن في إعلاناتك'], beingReturned: ['Coming back to you', 'يعود إليك'], spent: ['Spent', 'صُرف']
  }[String(chain.bucket || '')];
  const ago = studioWalletAgo(chain.checkedAt);
  const meta = used !== null && used >= 0
    ? `<p class="studio-v2-wallet-meta" data-testid="studio-wallet-ad-meta-used">${studioEsc(adsStudioText(`Meta used ${studioUsd(used)} so far`, `استخدمت ميتا ${studioUsd(used)} حتى الآن`) + (ago ? adsStudioText(` · checked ${ago}`, ` · فُحص ${ago}`) : ''))}</p>` : '';
  const steps = (Array.isArray(chain.steps) ? chain.steps : []).filter(step => step && typeof step === 'object').slice(0, 20).map(step => {
    const kind = step.kind === 'return' ? 'return' : 'payment';
    const words = studioPickText(step.labels, 240) || (kind === 'return' ? adsStudioText('Returned', 'أُعيد') : adsStudioText('Paid', 'دُفع'));
    return `
                    <li class="studio-v2-wallet-step is-${kind}">
                      ${studioWalletIcon(kind === 'return' ? 'arrow-down-left' : 'arrow-up-right')}
                      <span class="studio-v2-wallet-step-name">${studioEsc(words)}</span>
                      <span class="studio-v2-wallet-step-amount">${studioLtr(studioUsd(studioWalletInt(step.amountMinor)))}</span>
                      ${studioWalletWhen(step.at) ? `<span class="studio-v2-wallet-step-date">${studioEsc(studioWalletWhen(step.at))}</span>` : ''}
                    </li>`;
  }).join('');
  return `
                <div class="studio-v2-wallet-cycle" data-testid="studio-wallet-cycle" data-state="${studioEsc(cycleState)}">
                  <span class="studio-v2-wallet-chip ${look[1]}">${studioWalletIcon(look[0])}<span>${studioEsc(adsStudioText(look[2], look[3]))}</span></span>
                  <dl class="studio-v2-wallet-kv">
                    <div class="studio-v2-wallet-kv-row"><dt>${studioEsc(adsStudioText('Paid from your wallet', 'دُفع من محفظتك'))}</dt><dd>${studioLtr(studioUsd(paid))}</dd></div>
                    ${returned ? `<div class="studio-v2-wallet-kv-row"><dt>${studioEsc(adsStudioText('Returned to your wallet', 'أُعيد إلى محفظتك'))}</dt><dd>${studioLtr(studioUsd(returned))}</dd></div>` : ''}
                    ${bucketWords && net ? `<div class="studio-v2-wallet-kv-row"><dt>${studioEsc(adsStudioText(bucketWords[0], bucketWords[1]))}</dt><dd>${studioLtr(studioUsd(net))}</dd></div>` : ''}
                  </dl>
                  ${meta}
                  <ol class="studio-v2-wallet-steps">${steps}
                  </ol>
                </div>`;
}

// The server lists paid cycles newest first; one card per ad keeps its cycles together.
function studioWalletAdGroups(chains) {
  const groups = [];
  const byId = new Map();
  chains.forEach((chain, index) => {
    const id = STUDIO_WALLET_ID_RE.test(String(chain.campaignId || '')) ? String(chain.campaignId) : `missing-${index}`;
    let group = byId.get(id);
    if (!group) {
      group = { id, name: '', archived: false, missing: false, chains: [] };
      byId.set(id, group);
      groups.push(group);
    }
    group.name = group.name || studioWalletText(chain.name, 200);
    group.archived = group.archived || chain.archived === true;
    group.missing = group.missing || chain.requestMissing === true;
    group.chains.push(chain);
  });
  return groups;
}

function renderStudioWalletAds(chains) {
  const groups = studioWalletAdGroups(chains);
  const card = group => `
              <article class="studio-v2-wallet-card studio-v2-wallet-ad" data-testid="studio-wallet-ad" data-campaign="${studioEsc(group.id)}">
                <div class="studio-v2-wallet-row-head">
                  <h3 class="studio-v2-wallet-h3">${studioEsc(group.name || adsStudioText('Your ad', 'إعلانك'))}</h3>
                  ${group.archived ? `<span class="studio-v2-wallet-chip">${studioEsc(adsStudioText('Archived', 'مؤرشف'))}</span>` : ''}
                  ${group.missing ? `<span class="studio-v2-wallet-chip">${studioEsc(adsStudioText('Request removed', 'الطلب محذوف'))}</span>` : ''}
                </div>${group.chains.map(renderStudioWalletCycle).join('')}
              </article>`;
  return `
            <section class="studio-v2-wallet-section" data-testid="studio-wallet-ads" aria-labelledby="studio-wallet-ads-title">
              <h2 id="studio-wallet-ads-title" class="studio-v2-wallet-h2">${studioEsc(adsStudioText('Money of each ad', 'أموال كل إعلان'))}</h2>
              ${groups.length ? groups.map(card).join('') : `<p class="studio-v2-wallet-note studio-v2-wallet-empty" data-testid="studio-wallet-ads-empty">${studioEsc(adsStudioText(
    'No ad has been paid for yet. When our team approves a request, its budget moves here and you can follow every dollar of it.',
    'لم يُدفع لأي إعلان بعد. عندما يوافق فريقنا على طلب تنتقل ميزانيته إلى هنا وتتابع كل دولار منها.'))}</p>`}
            </section>`;
}

function renderStudioWalletPlanCard(lydMinor) {
  return `
            <section class="studio-v2-wallet-card studio-v2-wallet-plan" data-testid="studio-wallet-lyd" aria-labelledby="studio-wallet-lyd-title">
              <h2 id="studio-wallet-lyd-title" class="studio-v2-wallet-h2">${studioWalletIcon('badge-dollar-sign')} ${studioEsc(adsStudioText('Plan balance (dinars)', 'رصيد الاشتراك (بالدينار)'))}</h2>
              <p class="studio-v2-wallet-amount" data-testid="studio-wallet-lyd-amount">${studioLtr(studioLyd(lydMinor))}</p>
              <p class="studio-v2-wallet-note">${studioEsc(adsStudioText(
    'Dinars pay for your Albayan plan only. They never pay for ads, and your ad dollars never pay for the plan.',
    'الدينار لاشتراكك في البيان فقط؛ لا يدفع ثمن الإعلانات، ولا تدفع دولارات إعلاناتك ثمن الاشتراك.'))}</p>
              <div class="studio-v2-wallet-actions">
                <button type="button" class="studio-v2-action" data-testid="studio-wallet-renew" onclick="showSubscriptionModal('ad_maker', 'ad_maker')">${studioWalletIcon('crown')}<span>${studioEsc(adsStudioText('Renew or activate the plan', 'جدّد الاشتراك أو فعّله'))}</span></button>
                <button type="button" class="studio-v2-action" data-testid="studio-wallet-add-lyd" onclick="studioWalletOpenAdd('plan')">${studioWalletIcon('plus')}<span>${studioEsc(adsStudioText('Add dinars for the plan', 'أضف ديناراً للاشتراك'))}</span></button>
              </div>
            </section>`;
}

function renderStudioWalletHistory() {
  const done = (_studioWallet.requests || []).filter(row => row.status === 'confirmed' || row.status === 'canceled').slice(0, STUDIO_WALLET_HISTORY_MAX);
  if (!done.length) return '';
  const item = row => {
    const confirmed = row.status === 'confirmed';
    const when = studioWalletWhen(confirmed ? row.confirmedAt : row.canceledAt) || studioWalletWhen(row.createdAt);
    return `
                <li class="studio-v2-wallet-line" data-testid="studio-wallet-history-item" data-status="${row.status}">
                  <span class="studio-v2-wallet-line-name">${studioLtr(row.reference)}${when ? ` · ${studioEsc(when)}` : ''}</span>
                  <span class="studio-v2-wallet-line-amount">${studioLtr(studioWalletMoney(row.amountMinor, row.currency))}</span>
                  <span class="studio-v2-wallet-chip ${confirmed ? 'is-ok' : ''}">${studioWalletIcon(confirmed ? 'circle-check' : 'circle-x')}<span>${studioEsc(confirmed ? adsStudioText('Added to your wallet', 'أُضيف إلى محفظتك') : adsStudioText('Cancelled', 'ملغى'))}</span></span>
                </li>`;
  };
  return `
            <section class="studio-v2-wallet-card" data-testid="studio-wallet-history" aria-labelledby="studio-wallet-history-title">
              <h2 id="studio-wallet-history-title" class="studio-v2-wallet-h2">${studioEsc(adsStudioText('Recent payments', 'آخر الدفعات'))}</h2>
              <ul class="studio-v2-wallet-lines">${done.map(item).join('')}
              </ul>
            </section>`;
}

// ------------------------------------------------------------------ wallet actions

async function studioWalletCopy(reference) {
  const code = String(reference || '');
  if (!STUDIO_WALLET_REF_RE.test(code)) return;
  let copied = false;
  try { copied = typeof copyTextToClipboard === 'function' ? await copyTextToClipboard(code) : false; } catch (_) { copied = false; }
  try {
    if (typeof showNotification === 'function') {
      showNotification(copied ? adsStudioText('Code copied', 'نُسخ الرمز') : adsStudioText('Could not copy', 'تعذّر النسخ'),
        copied ? code : adsStudioText('Select the code and copy it yourself.', 'حدّد الرمز وانسخه بنفسك.'), copied ? 'success' : 'warning');
    }
  } catch (_) {}
}

function studioWalletAskCancel(requestId) {
  const request = studioWalletRequestById(String(requestId || ''));
  if (!request || request.status !== 'pending') return;
  studioWalletSheet({
    testid: 'studio-wallet-cancel-sheet',
    title: adsStudioText('Cancel this payment request?', 'إلغاء طلب الدفع هذا؟'),
    text: adsStudioText(
      `Cancel ${request.reference} only if you have not paid it. If you already paid, keep it: our team confirms it and fills your wallet.`,
      `ألغِ ${request.reference} فقط إن لم تدفعه بعد. إن كنت دفعت فأبقِه؛ سيؤكده فريقنا ويضيف المال إلى محفظتك.`),
    confirm: adsStudioText('Cancel the request', 'ألغِ الطلب'),
    cancel: adsStudioText('Keep it', 'أبقِه'),
    danger: true,
    onConfirm: () => studioWalletCancel(request.id)
  });
}

async function studioWalletCancel(requestId) {
  const id = String(requestId || '');
  const key = `cancel:${id}`;
  if (!STUDIO_WALLET_ID_RE.test(id) || _studioWallet.busy.has(key)) return;
  const generation = _studioWallet.generation;
  _studioWallet.busy.add(key);
  studioWalletRedraw();
  try {
    await apiWalletPaymentRequestDecide(id, 'cancel');
    if (generation === _studioWallet.generation) {
      studioWalletNotify(true, adsStudioText('Payment request cancelled', 'أُلغي طلب الدفع'), adsStudioText('Nothing was added to your wallet.', 'لم يُضف شيء إلى محفظتك.'));
    }
  } catch (error) {
    if (generation === _studioWallet.generation) {
      studioWalletNotify(false, adsStudioText('Could not cancel', 'تعذّر الإلغاء'), studioWalletErrorText(error));
    }
  } finally {
    if (generation === _studioWallet.generation) {
      _studioWallet.busy.delete(key);
      studioWalletLoad(true);
    }
  }
}

async function studioWalletAttachReceipt(requestId, input) {
  const id = String(requestId || '');
  const file = input && input.files && input.files[0];
  const key = `receipt:${id}`;
  if (!file || !STUDIO_WALLET_ID_RE.test(id) || _studioWallet.busy.has(key)) return;
  const generation = _studioWallet.generation;
  _studioWallet.busy.add(key);
  studioWalletRedraw();
  try {
    const photo = await compressImageToDataUrl(file);
    await apiWalletPaymentRequestAttachReceipt(id, photo);
    if (generation === _studioWallet.generation) {
      studioWalletNotify(true, adsStudioText('Receipt attached', 'أُرفق الإيصال'), adsStudioText('We will check it and confirm your payment.', 'سنراجعه ونؤكد دفعتك.'));
    }
  } catch (error) {
    if (generation === _studioWallet.generation) {
      studioWalletNotify(false, adsStudioText('Could not attach the receipt', 'تعذّر إرفاق الإيصال'), studioWalletErrorText(error));
    }
  } finally {
    try { if (input) input.value = ''; } catch (_) {}
    if (generation === _studioWallet.generation) {
      _studioWallet.busy.delete(key);
      studioWalletLoad(true);
    }
  }
}

// ------------------------------------------------------------------ Add money (J2)

function studioWalletNewFlow(purpose = '', amountMinor = 0) {
  const known = purpose === 'ads' || purpose === 'plan' ? purpose : '';
  const wanted = known && Number.isSafeInteger(amountMinor) && amountMinor > 0 ? Math.max(amountMinor, STUDIO_WALLET_MIN_MINOR) : 0;
  const amount = wanted && wanted <= STUDIO_WALLET_MAX_MINOR ? studioMinorText(wanted).replace(/,/g, '') : '';
  return { step: known ? 2 : 1, purpose: known, amountText: amount, method: '', error: '', created: null };
}

// Opens Add money. purpose 'ads' (dollars) or 'plan' (dinars) skips the first question; amountMinor
// fills the amount (other screens use it: "short by $S -> Add money", "Add the missing N LYD").
function studioWalletOpenAdd(purpose = '', amountMinor = 0) {
  studioWalletScope();
  if (!_studioWallet.busy.has('create')) _studioWallet.add = studioWalletNewFlow(purpose, Number(amountMinor) || 0);
  if (typeof studioV2Go === 'function' && studioV2Go({ tab: 'wallet', id: STUDIO_WALLET_ADD_ID })) return true;
  return false;
}

function studioWalletFlow() {
  if (!_studioWallet.add) _studioWallet.add = studioWalletNewFlow();
  return _studioWallet.add;
}

function studioWalletFlowCurrency(flow) {
  return flow.purpose === 'plan' ? 'LYD' : 'USD';
}

// The typed amount: minor units, or an error in the reader's words.
function studioWalletFlowAmount(flow) {
  const currency = studioWalletFlowCurrency(flow);
  const minor = studioParseAmount(flow.amountText);
  if (!String(flow.amountText || '').trim()) return { minor: NaN, error: adsStudioText('Choose or type an amount.', 'اختر مبلغاً أو اكتبه.') };
  if (!Number.isSafeInteger(minor)) return { minor: NaN, error: adsStudioText('Type the amount in numbers, such as 25 or 25.50.', 'اكتب المبلغ بالأرقام، مثل 25 أو 25.50.') };
  if (minor < STUDIO_WALLET_MIN_MINOR) {
    const least = studioWalletMoney(STUDIO_WALLET_MIN_MINOR, currency);
    return { minor: NaN, error: adsStudioText(`The smallest amount is ${least}.`, `أقل مبلغ هو ${least}.`) };
  }
  if (minor > STUDIO_WALLET_MAX_MINOR) return { minor: NaN, error: adsStudioText('That amount is too large. Type a smaller one, or contact us.', 'هذا المبلغ كبير جداً. اكتب مبلغاً أصغر أو تواصل معنا.') };
  return { minor, error: '' };
}

// The line under the amount box: the amount as it will be sent, and the dinar estimate for dollars.
function studioWalletAmountHelp(flow) {
  const currency = studioWalletFlowCurrency(flow);
  const parsed = studioWalletFlowAmount(flow);
  if (!Number.isSafeInteger(parsed.minor)) {
    return currency === 'LYD'
      ? adsStudioText('In dinars. Arabic digits work too.', 'بالدينار. يمكنك الكتابة بالأرقام العربية أيضاً.')
      : adsStudioText('In dollars. Arabic digits work too.', 'بالدولار. يمكنك الكتابة بالأرقام العربية أيضاً.');
  }
  const exact = studioWalletMoney(parsed.minor, currency);
  const lyd = currency === 'USD' ? studioWalletLydEstimate(parsed.minor, _studioWallet.rate) : null;
  return lyd !== null
    ? adsStudioText(`= ${exact} · about ${studioLyd(lyd)} at today's rate (estimate)`, `= ${exact} · نحو ${studioLyd(lyd)} بسعر اليوم (تقديري)`)
    : `= ${exact}`;
}

function studioWalletAmountInput(input) {
  const flow = studioWalletFlow();
  flow.amountText = String((input && input.value) || '').slice(0, 24);
  flow.error = '';
  try {
    const help = document.getElementById('studio-wallet-amount-help');
    if (help) help.textContent = studioWalletAmountHelp(flow);
    const problem = document.getElementById('studio-wallet-add-error');
    if (problem) problem.textContent = '';
    document.querySelectorAll('[data-wallet-preset]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.getAttribute('data-wallet-preset')) === studioParseAmount(flow.amountText)));
    });
  } catch (_) {}
}

function studioWalletPickPurpose(purpose) {
  if (purpose !== 'ads' && purpose !== 'plan') return;
  const flow = studioWalletFlow();
  if (flow.purpose !== purpose) Object.assign(flow, { purpose, amountText: '', method: '' });
  flow.step = 2;
  flow.error = '';
  studioWalletRedraw();
}

function studioWalletPickAmount(minor) {
  const flow = studioWalletFlow();
  if (!Number.isSafeInteger(minor) || minor < STUDIO_WALLET_MIN_MINOR) return;
  flow.amountText = studioMinorText(minor).replace(/,/g, '');
  flow.error = '';
  studioWalletRedraw();
}

function studioWalletPickMethod(id) {
  const flow = studioWalletFlow();
  if (!studioWalletMethod(String(id || ''))) return;
  flow.method = String(id);
  flow.error = '';
  flow.step = 4;
  studioWalletRedraw();
}

function studioWalletFlowStep(delta) {
  const flow = studioWalletFlow();
  if (flow.created) return;
  const step = flow.step + (Number(delta) || 0);
  if (delta > 0) {
    if (flow.step === 1 && !flow.purpose) return;
    if (flow.step === 2) {
      const parsed = studioWalletFlowAmount(flow);
      if (parsed.error) { flow.error = parsed.error; studioWalletRedraw(); return; }
    }
    if (flow.step === 3 && !studioWalletMethod(flow.method)) {
      flow.error = adsStudioText('Choose how you will pay.', 'اختر طريقة الدفع.');
      studioWalletRedraw();
      return;
    }
  }
  flow.step = Math.min(Math.max(step, 1), STUDIO_WALLET_STEPS);
  flow.error = '';
  studioWalletRedraw();
}

async function studioWalletCreate() {
  const flow = studioWalletFlow();
  const uid = studioWalletScope();
  if (!uid || flow.created || _studioWallet.busy.has('create')) return;
  const parsed = studioWalletFlowAmount(flow);
  const method = studioWalletMethod(flow.method);
  const currency = studioWalletFlowCurrency(flow);
  if (!flow.purpose || parsed.error || !method) {
    flow.error = parsed.error || adsStudioText('Choose how you will pay.', 'اختر طريقة الدفع.');
    flow.step = !flow.purpose ? 1 : (parsed.error ? 2 : 3);
    studioWalletRedraw();
    return;
  }
  if (currency === 'USD' && !(_studioWallet.rate > 0)) return;  // the confirm screen explains why
  // One key per (user, currency, amount, method) until the server answers with the request: a retry
  // after a lost answer, even from a reopened Add money, replays the same request on the server
  // instead of making a second one (the classic charge screen keeps its key the same way, 12c).
  const fingerprint = `${uid}|${currency}|${parsed.minor}|${method.id}`;
  if (_studioWallet.idem.fingerprint !== fingerprint || !_studioWallet.idem.key) {
    _studioWallet.idem = { fingerprint, key: Security.generateSecureId('studiopay') };
  }
  const key = _studioWallet.idem.key;
  const generation = _studioWallet.generation;
  _studioWallet.busy.add('create');
  flow.error = '';
  studioWalletRedraw();
  try {
    const created = studioWalletRequestRow(await apiWalletPaymentRequestCreate(parsed.minor, method.id, key, currency));
    if (generation !== _studioWallet.generation) return;
    if (!created || !created.reference) throw new Error('The payment request answer had no reference');
    flow.created = created;
    if (_studioWallet.idem.key === key) _studioWallet.idem = { fingerprint: '', key: '' };
    _studioWallet.requests = [created].concat((_studioWallet.requests || []).filter(row => row.id !== created.id));
    studioWalletLoad(true);
  } catch (error) {
    if (generation === _studioWallet.generation) flow.error = studioWalletErrorText(error);
  } finally {
    if (generation === _studioWallet.generation) {
      _studioWallet.busy.delete('create');
      studioWalletRedraw();
    }
  }
}

function studioWalletFinishAdd() {
  _studioWallet.add = null;
  if (typeof studioV2Go === 'function') studioV2Go({ tab: 'wallet' });
}

function renderStudioWalletStepBar(flow) {
  const names = [['Purpose', 'الغرض'], ['Amount', 'المبلغ'], ['Method', 'طريقة الدفع'], ['Confirm', 'التأكيد']];
  const items = names.map((name, index) => {
    const number = index + 1;
    const mark = number === flow.step ? ' is-current' : (number < flow.step ? ' is-done' : '');
    return `<li class="studio-v2-step${mark}"${number === flow.step ? ' aria-current="step"' : ''}><span class="studio-v2-step-dot" aria-hidden="true">${number}</span><span class="studio-v2-step-name">${studioEsc(adsStudioText(name[0], name[1]))}</span></li>`;
  }).join('');
  const current = names[flow.step - 1];
  return `
            <p class="studio-v2-step-text" data-testid="studio-wallet-add-step">${studioEsc(adsStudioText(`Step ${flow.step} of ${STUDIO_WALLET_STEPS}: ${current[0]}`, `الخطوة ${flow.step} من ${STUDIO_WALLET_STEPS}: ${current[1]}`))}</p>
            <ol class="studio-v2-steps">${items}</ol>`;
}

function renderStudioWalletFlowNav(flow, next) {
  const back = flow.step > 1
    ? `<button type="button" class="studio-v2-action" data-testid="studio-wallet-add-back" onclick="studioWalletFlowStep(-1)">${studioWalletIcon(adsStudioIsAr() ? 'arrow-right' : 'arrow-left')}<span>${studioEsc(adsStudioText('Previous', 'السابق'))}</span></button>`
    : '';
  return `
            <div class="studio-v2-wallet-actions is-nav">${back}${next || ''}</div>`;
}

function renderStudioWalletAdd() {
  const flow = studioWalletFlow();
  if (!_studioWallet.methods) studioWalletLoadMethods();
  if (flow.created) return renderStudioWalletCreated(flow);
  let body = '';
  if (flow.step === 1) body = renderStudioWalletPurposeStep(flow);
  else if (flow.step === 2) body = renderStudioWalletAmountStep(flow);
  else if (flow.step === 3) body = renderStudioWalletMethodStep(flow);
  else body = renderStudioWalletConfirmStep(flow);
  return `
          <div class="studio-v2-wallet is-flow" data-testid="studio-wallet-add-flow" data-step="${flow.step}">
            ${renderStudioWalletStepBar(flow)}
            ${body}
          </div>`;
}

function renderStudioWalletPurposeStep(flow) {
  const choice = (purpose, icon, en, ar, textEn, textAr) => `
              <button type="button" class="studio-v2-wallet-choice" data-testid="studio-wallet-purpose-${purpose}" aria-pressed="${flow.purpose === purpose}" onclick="studioWalletPickPurpose('${purpose}')">
                <span class="studio-v2-wallet-choice-icon" aria-hidden="true">${studioWalletIcon(icon)}</span>
                <span class="studio-v2-wallet-choice-body">
                  <span class="studio-v2-wallet-choice-title">${studioEsc(adsStudioText(en, ar))}</span>
                  <span class="studio-v2-wallet-choice-text">${studioEsc(adsStudioText(textEn, textAr))}</span>
                </span>
              </button>`;
  return `
            <h2 class="studio-v2-wallet-h2">${studioEsc(adsStudioText('What is this money for?', 'لماذا هذا المال؟'))}</h2>
            <div class="studio-v2-wallet-choices" role="group" aria-label="${studioEsc(adsStudioText('What is this money for?', 'لماذا هذا المال؟'))}">
              ${choice('ads', 'megaphone', 'My ads', 'إعلاناتي', 'For ad budgets only, in dollars.', 'لميزانيات الإعلانات فقط، بالدولار.')}
              ${choice('plan', 'crown', 'My plan', 'اشتراكي', 'To renew or activate your plan, in dinars.', 'لتجديد اشتراكك أو تفعيله، بالدينار.')}
            </div>
            <p class="studio-v2-wallet-note">${studioEsc(adsStudioText('You pay in dinars either way; we work out the amount for you.', 'ستدفع بالدينار في الحالتين؛ ونحن نحسب لك المبلغ.'))}</p>
            ${renderStudioWalletFlowNav(flow, '')}`;
}

// The plan's price, when the catalog knows it (dinars only), as the one ready-made dinar amount.
function studioWalletPlanPriceMinor() {
  try {
    const plan = typeof hubPlanForService === 'function' ? hubPlanForService('ad_maker') : null;
    if (!plan && !_studioWallet.plansAsked && typeof refreshSubscriptionPlans === 'function') {
      _studioWallet.plansAsked = true;
      Promise.resolve(refreshSubscriptionPlans()).then(() => studioWalletRedraw()).catch(() => {});
    }
    const price = plan ? Number(plan.priceMinor) : NaN;
    return plan && Number.isSafeInteger(price) && price >= STUDIO_WALLET_MIN_MINOR && String(plan.currency || 'LYD').toUpperCase() === 'LYD' ? price : 0;
  } catch (_) { return 0; }
}

function renderStudioWalletAmountStep(flow) {
  const currency = studioWalletFlowCurrency(flow);
  const typed = studioParseAmount(flow.amountText);
  const preset = (minor, words) => `<button type="button" class="studio-v2-wallet-preset" data-testid="studio-wallet-preset-${minor}" data-wallet-preset="${minor}" aria-pressed="${typed === minor}" onclick="studioWalletPickAmount(${minor})">${words ? `<span class="studio-v2-wallet-preset-words">${studioEsc(words)}</span>` : ''}${studioLtr(studioWalletMoney(minor, currency))}</button>`;
  let presets = '';
  if (currency === 'USD') presets = STUDIO_WALLET_USD_PRESETS.map(minor => preset(minor, '')).join('');
  else {
    const price = studioWalletPlanPriceMinor();
    if (price) presets = preset(price, adsStudioText('Plan price', 'سعر الاشتراك'));
  }
  const title = currency === 'LYD' ? adsStudioText('How many dinars?', 'كم ديناراً؟') : adsStudioText('How many dollars for your ads?', 'كم دولاراً لإعلاناتك؟');
  return `
            <h2 class="studio-v2-wallet-h2">${studioEsc(title)}</h2>
            ${presets ? `<div class="studio-v2-wallet-presets" role="group" aria-label="${studioEsc(adsStudioText('Ready amounts', 'مبالغ جاهزة'))}">${presets}</div>` : ''}
            <label class="studio-v2-wallet-label" for="studio-wallet-amount">${studioEsc(currency === 'LYD' ? adsStudioText('Or type an amount in dinars', 'أو اكتب مبلغاً بالدينار') : adsStudioText('Or type an amount in dollars', 'أو اكتب مبلغاً بالدولار'))}</label>
            <input id="studio-wallet-amount" class="studio-v2-wallet-input" type="text" inputmode="decimal" autocomplete="off" dir="ltr" maxlength="24" value="${studioEsc(flow.amountText)}" oninput="studioWalletAmountInput(this)" aria-describedby="studio-wallet-amount-help studio-wallet-add-error" />
            <p id="studio-wallet-amount-help" class="studio-v2-wallet-note" aria-live="polite">${studioEsc(studioWalletAmountHelp(flow))}</p>
            <p id="studio-wallet-add-error" class="studio-v2-wallet-error" role="alert">${studioEsc(flow.error)}</p>
            ${renderStudioWalletFlowNav(flow, `<button type="button" class="studio-v2-action is-primary" data-testid="studio-wallet-add-next" onclick="studioWalletFlowStep(1)"><span>${studioEsc(adsStudioText('Next', 'التالي'))}</span>${studioWalletIcon(adsStudioIsAr() ? 'arrow-left' : 'arrow-right')}</button>`)}`;
}

function renderStudioWalletMethodStep(flow) {
  let list;
  if (_studioWallet.methods && _studioWallet.methods.length) {
    list = _studioWallet.methods.map(method => {
      const name = studioPickText(method.name, 80) || method.id;
      const desc = studioPickText(method.desc, 160);
      return `
              <button type="button" class="studio-v2-wallet-choice" data-testid="studio-wallet-method-${method.id}" aria-pressed="${flow.method === method.id}" onclick="studioWalletPickMethod('${method.id}')">
                <span class="studio-v2-wallet-choice-icon" aria-hidden="true">${studioWalletIcon(method.requiresReceiptPhoto ? 'landmark' : 'smartphone')}</span>
                <span class="studio-v2-wallet-choice-body">
                  <span class="studio-v2-wallet-choice-title">${studioEsc(name)}</span>
                  ${desc ? `<span class="studio-v2-wallet-choice-text">${studioEsc(desc)}</span>` : ''}
                  ${method.requiresReceiptPhoto ? `<span class="studio-v2-wallet-choice-text">${studioEsc(adsStudioText('You attach a photo of the transfer receipt.', 'ترفق صورة إيصال الحوالة.'))}</span>` : ''}
                </span>
              </button>`;
    }).join('');
    list = `<div class="studio-v2-wallet-choices" role="group" aria-label="${studioEsc(adsStudioText('Payment methods', 'طرق الدفع'))}">${list}</div>`;
  } else if (_studioWallet.methods) {
    list = `<p class="studio-v2-wallet-note" role="status">${studioEsc(adsStudioText('No payment method is offered right now.', 'لا توجد طريقة دفع متاحة الآن.'))} ${studioEsc(studioWalletContactLine())}</p>`;
  } else if (_studioWallet.methodsLoading || !_studioWallet.methodsFailed) {
    list = `<p class="studio-v2-wallet-loading" role="status">${studioEsc(adsStudioText('Reading the payment methods…', 'جارٍ قراءة طرق الدفع…'))}</p>`;
  } else {
    list = `<div class="studio-v2-wallet-banner is-bad" role="alert">${studioWalletIcon('circle-alert')}<div class="studio-v2-wallet-banner-body"><p class="studio-v2-wallet-banner-text">${studioEsc(adsStudioText('The payment methods could not be read.', 'تعذّرت قراءة طرق الدفع.'))}</p><button type="button" class="studio-v2-action" data-testid="studio-wallet-methods-retry" onclick="studioWalletRetryMethods()">${studioWalletIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Try again', 'أعد المحاولة'))}</span></button></div></div>`;
  }
  return `
            <h2 class="studio-v2-wallet-h2">${studioEsc(adsStudioText('How will you pay?', 'كيف ستدفع؟'))}</h2>
            ${list}
            <p id="studio-wallet-add-error" class="studio-v2-wallet-error" role="alert">${studioEsc(flow.error)}</p>
            ${renderStudioWalletFlowNav(flow, '')}`;
}

function studioWalletContactLine() {
  const me = typeof studioMe === 'function' ? studioMe() : null;
  const whatsapp = me && me.contact ? me.contact.whatsapp : '';
  return whatsapp
    ? adsStudioText(`You can reach us on WhatsApp: ${whatsapp}`, `يمكنك مراسلتنا على واتساب: ${whatsapp}`)
    : adsStudioText('Try again later, or ask the Albayan team.', 'أعد المحاولة لاحقاً، أو اسأل فريق البيان.');
}

function renderStudioWalletConfirmStep(flow) {
  const currency = studioWalletFlowCurrency(flow);
  const parsed = studioWalletFlowAmount(flow);
  const method = studioWalletMethod(flow.method);
  const busy = _studioWallet.busy.has('create');
  const noRate = currency === 'USD' && !(_studioWallet.rate > 0);
  const lyd = currency === 'USD' ? studioWalletLydEstimate(parsed.minor, _studioWallet.rate) : null;
  const row = (en, ar, value, testid) => `<div class="studio-v2-wallet-kv-row"><dt>${studioEsc(adsStudioText(en, ar))}</dt><dd data-testid="${testid}">${value}</dd></div>`;
  const create = `<button type="button" class="studio-v2-action is-primary" data-testid="studio-wallet-create" onclick="studioWalletCreate()"${busy || noRate || !method || parsed.error ? ' disabled' : ''}${busy ? ' aria-busy="true"' : ''}>${studioWalletIcon('check')}<span>${studioEsc(busy ? adsStudioText('Creating…', 'جارٍ الإنشاء…') : adsStudioText('Create the payment request', 'أنشئ طلب الدفع'))}</span></button>`;
  return `
            <h2 class="studio-v2-wallet-h2">${studioEsc(adsStudioText('Check and confirm', 'راجع وأكّد'))}</h2>
            <dl class="studio-v2-wallet-card studio-v2-wallet-kv" data-testid="studio-wallet-confirm">
              ${row('For', 'لأجل', studioEsc(currency === 'LYD' ? adsStudioText('My plan (dinars)', 'اشتراكي (بالدينار)') : adsStudioText('My ads (dollars)', 'إعلاناتي (بالدولار)')), 'studio-wallet-confirm-purpose')}
              ${row('Amount', 'المبلغ', studioLtr(Number.isSafeInteger(parsed.minor) ? studioWalletMoney(parsed.minor, currency) : '—'), 'studio-wallet-confirm-amount')}
              ${lyd !== null ? row('About, in dinars', 'نحو، بالدينار', `${studioLtr(studioLyd(lyd))} <span class="studio-v2-wallet-note">${studioEsc(adsStudioText('(estimate; the exact amount is on the next screen)', '(تقديري؛ المبلغ الدقيق في الشاشة التالية)'))}</span>`, 'studio-wallet-confirm-lyd') : ''}
              ${row('Method', 'طريقة الدفع', studioEsc(method ? studioWalletMethodName(method.id) : '—'), 'studio-wallet-confirm-method')}
            </dl>
            ${noRate ? `<div class="studio-v2-wallet-banner is-warn" role="alert" data-testid="studio-wallet-no-rate">${studioWalletIcon('triangle-alert')}<div class="studio-v2-wallet-banner-body"><p class="studio-v2-wallet-banner-text">${studioEsc(adsStudioText("Today's dollar rate is not available yet, so we cannot tell you the amount in dinars.", 'سعر الدولار لليوم غير متاح بعد، لذلك لا نستطيع أن نحسب لك المبلغ بالدينار.'))} ${studioEsc(studioWalletContactLine())}</p></div></div>` : ''}
            <div class="studio-v2-wallet-card">
              <h3 class="studio-v2-wallet-h3">${studioEsc(adsStudioText('What happens next', 'ماذا يحدث بعد ذلك'))}</h3>
              <ol class="studio-v2-wallet-next">
                <li>${studioEsc(adsStudioText('You get a payment code (PAY-…) and how to pay with it.', 'تحصل على رمز دفع (PAY-…) وطريقة الدفع به.'))}</li>
                <li>${studioEsc(adsStudioText('You pay in dinars and mention that code.', 'تدفع بالدينار وتذكر ذلك الرمز.'))}</li>
                <li>${studioEsc(currency === 'LYD'
    ? adsStudioText('Our team confirms the payment during working hours; the dinars then appear on your plan balance.', 'يؤكد فريقنا الدفعة خلال ساعات العمل، ثم تظهر الدنانير في رصيد اشتراكك.')
    : adsStudioText('Our team confirms the payment during working hours; the dollars then appear as Available.', 'يؤكد فريقنا الدفعة خلال ساعات العمل، ثم تظهر الدولارات في «متاح».'))}</li>
              </ol>
            </div>
            <p id="studio-wallet-add-error" class="studio-v2-wallet-error" role="alert" data-testid="studio-wallet-add-error">${studioEsc(flow.error)}</p>
            ${renderStudioWalletFlowNav(flow, create)}`;
}

function renderStudioWalletCreated(flow) {
  const made = flow.created;
  const request = studioWalletRequestById(made.id) || made;
  const receipt = renderStudioWalletReceipt(request);
  return `
          <div class="studio-v2-wallet is-flow" data-testid="studio-wallet-add-flow" data-step="done">
            <div class="studio-v2-wallet-card studio-v2-wallet-created" data-testid="studio-wallet-created" data-currency="${made.currency}">
              <p class="studio-v2-wallet-chip is-ok">${studioWalletIcon('circle-check')}<span>${studioEsc(adsStudioText('Payment request created', 'أُنشئ طلب الدفع'))}</span></p>
              <h2 class="studio-v2-wallet-h2">${studioEsc(adsStudioText('Your payment code', 'رمز الدفع الخاص بك'))}</h2>
              <p class="studio-v2-wallet-code is-big" data-testid="studio-wallet-created-reference">${studioLtr(made.reference)}</p>
              <dl class="studio-v2-wallet-kv">
                <div class="studio-v2-wallet-kv-row"><dt>${studioEsc(adsStudioText('Amount', 'المبلغ'))}</dt><dd data-testid="studio-wallet-created-amount">${studioLtr(studioWalletMoney(made.amountMinor, made.currency))}</dd></div>
                ${made.currency === 'USD' && made.amountMinorLYD !== null ? `<div class="studio-v2-wallet-kv-row"><dt>${studioEsc(adsStudioText('You pay in dinars', 'تدفع بالدينار'))}</dt><dd data-testid="studio-wallet-created-lyd">${studioLtr(studioLyd(made.amountMinorLYD))}</dd></div>` : ''}
              </dl>
              <p class="studio-v2-wallet-how" data-testid="studio-wallet-created-instruction">${renderStudioWalletInstruction(request, made.reference)}</p>
              <p class="studio-v2-wallet-note">${studioEsc(adsStudioText('We confirm payments during our working hours. The money appears in your wallet as soon as we do.', 'نؤكد الدفعات خلال ساعات عملنا، ويظهر المال في محفظتك فور التأكيد.'))}</p>
              <div class="studio-v2-wallet-actions">
                ${renderStudioWalletCopy(made.reference)}${receipt}
                <button type="button" class="studio-v2-action is-primary" data-testid="studio-wallet-done" onclick="studioWalletFinishAdd()">${studioWalletIcon('wallet')}<span>${studioEsc(adsStudioText('Back to the wallet', 'العودة إلى المحفظة'))}</span></button>
              </div>
            </div>
          </div>`;
}

// ------------------------------------------------------------------ the in-page sheet

let _studioWalletSheetOpener = null;

// A small confirm sheet (never a native dialog). It is a .mobile-dialog-overlay on <body>, so the
// phone's Back closes it like every other overlay of the app (01b-mobile-runtime.js).
function studioWalletSheet(options) {
  studioWalletCloseSheet();
  const opts = options || {};
  const overlay = document.createElement('div');
  overlay.id = 'studio-v2-wallet-sheet';
  overlay.className = 'mobile-dialog-overlay studio-v2-wsheet-overlay';
  overlay.setAttribute('dir', adsStudioIsAr() ? 'rtl' : 'ltr');
  // A column: on phones the platform keeps every dialog at the top of its scroll box (align-items and
  // margins are fixed there), so the sheet reaches the bottom through justify-content instead.
  overlay.innerHTML = `
    <div class="studio-v2-wsheet" role="alertdialog" aria-modal="true" aria-labelledby="studio-v2-wsheet-title" aria-describedby="studio-v2-wsheet-text" data-testid="${studioEsc(opts.testid || 'studio-wallet-sheet')}">
      <h2 id="studio-v2-wsheet-title" class="studio-v2-wsheet-title">${studioEsc(opts.title || '')}</h2>
      <p id="studio-v2-wsheet-text" class="studio-v2-wsheet-text">${studioEsc(opts.text || '')}</p>
      <div class="studio-v2-wsheet-actions">
        <button type="button" class="studio-v2-action${opts.danger ? ' studio-v2-wallet-danger' : ' is-primary'}" data-sheet="confirm" data-testid="studio-sheet-confirm">${studioEsc(opts.confirm || adsStudioText('Yes', 'نعم'))}</button>
        <button type="button" class="studio-v2-action" data-sheet="cancel" data-testid="studio-sheet-cancel">${studioEsc(opts.cancel || adsStudioText('Cancel', 'إلغاء'))}</button>
      </div>
    </div>`;
  const confirm = overlay.querySelector('[data-sheet="confirm"]');
  const cancel = overlay.querySelector('[data-sheet="cancel"]');
  let done = false;
  confirm.addEventListener('click', () => {
    if (done) return;
    done = true;
    studioWalletCloseSheet();
    try { if (typeof opts.onConfirm === 'function') opts.onConfirm(); } catch (_) {}
  });
  cancel.addEventListener('click', () => studioWalletCloseSheet());
  overlay.addEventListener('click', event => { if (event.target === overlay) studioWalletCloseSheet(); });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); studioWalletCloseSheet(); return; }
    if (event.key !== 'Tab') return;
    const order = [confirm, cancel];
    const at = order.indexOf(document.activeElement);
    event.preventDefault();
    order[(at + (event.shiftKey ? order.length - 1 : 1) + order.length) % order.length].focus();
  });
  _studioWalletSheetOpener = document.activeElement;
  document.body.appendChild(overlay);
  if (typeof IconQueue !== 'undefined' && IconQueue && typeof IconQueue.schedule === 'function') IconQueue.schedule(overlay);
  try { cancel.focus(); } catch (_) {}
}

function studioWalletCloseSheet() {
  const sheet = document.getElementById('studio-v2-wallet-sheet');
  if (sheet) sheet.remove();
  const opener = _studioWalletSheetOpener;
  _studioWalletSheetOpener = null;
  try { if (sheet && opener && opener.isConnected && typeof opener.focus === 'function') opener.focus(); } catch (_) {}
}

// ------------------------------------------------------------------ the account screen (P2-07)

function studioAccountScope() {
  const uid = studioWalletUserId();
  if (_studioAccount.forUser !== uid) {
    _studioAccount.generation++;
    Object.assign(_studioAccount, { forUser: uid, profile: null, error: '', loading: null, editing: false, draftNumber: '', draftConsent: false, formError: '', saving: false });
  }
  return uid;
}

function studioAccountCleanProfile(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const number = typeof value.whatsappNumber === 'string' && studioParsePhone(value.whatsappNumber) === value.whatsappNumber ? value.whatsappNumber : '';
  return { whatsappNumber: number, whatsappConsentAt: number ? studioWalletText(value.whatsappConsentAt, 40) : '' };
}

function studioAccountLoad(force = false) {
  const uid = studioAccountScope();
  if (!uid || typeof isServerModeEnabled !== 'function' || !isServerModeEnabled()) return Promise.resolve(null);
  if (_studioAccount.loading) return _studioAccount.loading;
  if (!force && (_studioAccount.profile || _studioAccount.error)) return Promise.resolve(_studioAccount.profile);
  const generation = _studioAccount.generation;
  const signal = studioReadSignal();
  const promise = (async () => {
    try {
      const profile = studioAccountCleanProfile(await studioApi('/api/studio/profile', { method: 'GET' }));
      if (generation !== _studioAccount.generation) return null;
      Object.assign(_studioAccount, { profile, error: '' });
    } catch (error) {
      if (generation !== _studioAccount.generation) return null;
      // Leaving the page cancels the read (asked again on the next draw); a timeout is a failure.
      if (!studioReadCancelled(error, signal)) _studioAccount.error = studioWalletErrorText(error, 'read');
    }
    _studioAccount.loading = null;
    studioWalletRedraw();
    return _studioAccount.profile;
  })();
  _studioAccount.loading = promise;
  return promise;
}

function studioAccountRetry() {
  _studioAccount.error = '';
  studioAccountLoad(true);
}

function renderStudioAccountScreen() {
  studioAccountScope();
  studioAccountLoad();
  const user = (typeof state !== 'undefined' && state && state.currentUser) || {};
  const name = studioWalletText(user.name, 120) || adsStudioText('Your account', 'حسابك');
  const email = studioWalletText(user.email, 254);
  const dark = typeof state !== 'undefined' && state.theme === 'dark';
  const row = (onclick, icon, label, value, testid, extra = '') => `
              <button type="button" class="studio-v2-row${extra}" data-testid="${testid}" onclick="${onclick}">
                ${studioWalletIcon(icon)}
                <span class="studio-v2-row-label">${studioEsc(label)}</span>
                ${value ? `<span class="studio-v2-row-value">${studioEsc(value)}</span>` : ''}
              </button>`;
  return `
          <div class="studio-v2-account" data-testid="studio-account">
            <div class="studio-v2-wallet-card studio-v2-account-person" data-testid="studio-account-person">
              <span class="studio-v2-account-avatar" aria-hidden="true">${studioEsc(Array.from(name)[0] || '?')}</span>
              <div class="studio-v2-account-person-body">
                <p class="studio-v2-account-name" data-testid="studio-account-name">${studioEsc(name)}</p>
                ${email ? `<p class="studio-v2-wallet-note">${studioLtr(email)}</p>` : ''}
                <p class="studio-v2-wallet-note">${studioEsc(adsStudioText('The Albayan team sets the name on your account. Ask us if it needs a change.', 'يضبط فريق البيان الاسم في حسابك. اطلب منا تغييره إن لزم.'))}</p>
              </div>
            </div>
            <div class="studio-v2-list" data-testid="studio-account-settings">
              ${row('toggleLanguage()', 'languages', adsStudioText('Language', 'اللغة'), adsStudioIsAr() ? 'العربية' : 'English', 'studio-account-language')}
              ${row('toggleTheme()', dark ? 'moon' : 'sun', adsStudioText('Theme', 'المظهر'), dark ? adsStudioText('Dark', 'داكن') : adsStudioText('Light', 'فاتح'), 'studio-account-theme')}
            </div>
            ${renderStudioAccountWhatsapp()}
            <div class="studio-v2-list">
              <a class="studio-v2-row" data-testid="studio-account-privacy" href="/privacy" target="_blank" rel="noopener">
                ${studioWalletIcon('shield-check')}
                <span class="studio-v2-row-label">${studioEsc(adsStudioText('Privacy', 'الخصوصية'))}</span>
              </a>
              <a class="studio-v2-row" data-testid="studio-account-terms" href="/privacy#terms" target="_blank" rel="noopener">
                ${studioWalletIcon('scroll-text')}
                <span class="studio-v2-row-label">${studioEsc(adsStudioText('Customer terms', 'شروط العملاء'))}</span>
              </a>
              ${row('handleLogout()', 'log-out', adsStudioText('Sign out', 'تسجيل الخروج'), '', 'studio-account-logout', ' is-danger')}
            </div>
          </div>`;
}

function studioAccountHelp() {
  const number = studioParsePhone(_studioAccount.draftNumber);
  return number
    ? adsStudioText(`We will save it as ${number}.`, `سنحفظه بهذا الشكل: ${number}.`)
    : adsStudioText('Libyan numbers can be typed as 091 234 5678. Other countries need their + code.', 'يمكن كتابة الأرقام الليبية هكذا: 091 234 5678. أرقام الدول الأخرى تحتاج رمز الدولة مع +.');
}

function renderStudioAccountWhatsapp() {
  const account = _studioAccount;
  let body;
  if (!account.profile && account.error) {
    body = `
              <div class="studio-v2-wallet-banner is-bad" role="alert">${studioWalletIcon('circle-alert')}<div class="studio-v2-wallet-banner-body"><p class="studio-v2-wallet-banner-text">${studioEsc(account.error)}</p><button type="button" class="studio-v2-action" data-testid="studio-account-retry" onclick="studioAccountRetry()">${studioWalletIcon('refresh-cw')}<span>${studioEsc(adsStudioText('Try again', 'أعد المحاولة'))}</span></button></div></div>`;
  } else if (!account.profile) {
    body = `<p class="studio-v2-wallet-loading" role="status">${studioEsc(adsStudioText('Reading your profile…', 'جارٍ قراءة ملفك…'))}</p>`;
  } else if (account.editing) {
    const saving = account.saving;
    body = `
              <label class="studio-v2-wallet-label" for="studio-account-whatsapp">${studioEsc(adsStudioText('WhatsApp number', 'رقم واتساب'))}</label>
              <input id="studio-account-whatsapp" class="studio-v2-wallet-input" type="tel" inputmode="tel" autocomplete="tel" dir="ltr" maxlength="32" value="${studioEsc(account.draftNumber)}" oninput="studioAccountDraftNumber(this)" aria-describedby="studio-account-whatsapp-help studio-account-whatsapp-error" />
              <p id="studio-account-whatsapp-help" class="studio-v2-wallet-note" aria-live="polite">${studioEsc(studioAccountHelp())}</p>
              <label class="studio-v2-account-check" for="studio-account-whatsapp-consent">
                <input id="studio-account-whatsapp-consent" type="checkbox" onchange="studioAccountDraftConsent(this)"${account.draftConsent ? ' checked' : ''} />
                <span>${studioEsc(adsStudioText(
    'I agree that the Albayan team may contact me on this WhatsApp number about my requests and payments.',
    'أوافق على أن يتواصل معي فريق البيان على رقم واتساب هذا بشأن طلباتي ودفعاتي.'))}</span>
              </label>
              <p id="studio-account-whatsapp-error" class="studio-v2-wallet-error" role="alert" data-testid="studio-account-whatsapp-error">${studioEsc(account.formError)}</p>
              <div class="studio-v2-wallet-actions">
                <button type="button" class="studio-v2-action is-primary" data-testid="studio-account-whatsapp-save" onclick="studioAccountSave()"${saving ? ' disabled aria-busy="true"' : ''}>${studioWalletIcon('check')}<span>${studioEsc(saving ? adsStudioText('Saving…', 'جارٍ الحفظ…') : adsStudioText('Save the number', 'احفظ الرقم'))}</span></button>
                <button type="button" class="studio-v2-action" data-testid="studio-account-whatsapp-cancel" onclick="studioAccountEdit(false)"${saving ? ' disabled' : ''}><span>${studioEsc(adsStudioText('Cancel', 'إلغاء'))}</span></button>
              </div>`;
  } else if (account.profile.whatsappNumber) {
    const since = studioWalletWhen(account.profile.whatsappConsentAt);
    body = `
              <p class="studio-v2-wallet-code" data-testid="studio-account-whatsapp-number">${studioLtr(account.profile.whatsappNumber)}</p>
              ${since ? `<p class="studio-v2-wallet-note">${studioEsc(adsStudioText(`You allowed us to contact you here on ${since}.`, `سمحت لنا بالتواصل معك هنا بتاريخ ${since}.`))}</p>` : ''}
              <div class="studio-v2-wallet-actions">
                <button type="button" class="studio-v2-action" data-testid="studio-account-whatsapp-change" onclick="studioAccountEdit(true)"${account.saving ? ' disabled' : ''}>${studioWalletIcon('pencil')}<span>${studioEsc(adsStudioText('Change', 'غيّره'))}</span></button>
                <button type="button" class="studio-v2-action studio-v2-wallet-danger" data-testid="studio-account-whatsapp-remove" onclick="studioAccountAskRemove()"${account.saving ? ' disabled aria-busy="true"' : ''}>${studioWalletIcon('trash-2')}<span>${studioEsc(adsStudioText('Remove', 'احذفه'))}</span></button>
              </div>`;
  } else {
    body = `
              <p class="studio-v2-wallet-note" data-testid="studio-account-whatsapp-none">${studioEsc(adsStudioText('No number saved.', 'لا يوجد رقم محفوظ.'))}</p>
              <div class="studio-v2-wallet-actions">
                <button type="button" class="studio-v2-action" data-testid="studio-account-whatsapp-add" onclick="studioAccountEdit(true)">${studioWalletIcon('message-circle')}<span>${studioEsc(adsStudioText('Add a WhatsApp number', 'أضف رقم واتساب'))}</span></button>
              </div>`;
  }
  return `
            <section class="studio-v2-wallet-card studio-v2-account-whatsapp" data-testid="studio-account-whatsapp" aria-labelledby="studio-account-whatsapp-title">
              <h2 id="studio-account-whatsapp-title" class="studio-v2-wallet-h2">${studioWalletIcon('message-circle')} ${studioEsc(adsStudioText('WhatsApp (optional)', 'واتساب (اختياري)'))}</h2>
              <p class="studio-v2-wallet-note">${studioEsc(adsStudioText(
    'Add a number if you want our team to reach you about your requests and payments while the app is closed. We use it only for that, never for adverts, and you can remove it at any time.',
    'أضف رقماً إن أردت أن يصلك فريقنا بشأن طلباتك ودفعاتك والتطبيق مغلق. نستخدمه لذلك فقط، لا للإعلانات، ويمكنك حذفه في أي وقت.'))}</p>
              ${body}
            </section>`;
}

function studioAccountEdit(open) {
  const account = _studioAccount;
  if (account.saving || !account.profile) return;
  account.editing = !!open;
  account.draftNumber = open ? account.profile.whatsappNumber : '';
  account.draftConsent = false;  // a number (new or the same) is saved only with a fresh tick
  account.formError = '';
  studioWalletRedraw();
  if (open) setTimeout(() => { try { document.getElementById('studio-account-whatsapp')?.focus(); } catch (_) {} }, 0);
}

function studioAccountDraftNumber(input) {
  _studioAccount.draftNumber = String((input && input.value) || '').slice(0, 32);
  _studioAccount.formError = '';
  try {
    const help = document.getElementById('studio-account-whatsapp-help');
    if (help) help.textContent = studioAccountHelp();
    const problem = document.getElementById('studio-account-whatsapp-error');
    if (problem) problem.textContent = '';
  } catch (_) {}
}

function studioAccountDraftConsent(input) {
  _studioAccount.draftConsent = !!(input && input.checked);
  _studioAccount.formError = '';
  try { const problem = document.getElementById('studio-account-whatsapp-error'); if (problem) problem.textContent = ''; } catch (_) {}
}

async function studioAccountPut(number) {
  const account = _studioAccount;
  if (account.saving) return false;
  const generation = account.generation;
  account.saving = true;
  account.formError = '';
  studioWalletRedraw();
  let ok = false;
  try {
    const body = number ? { whatsappNumber: number, whatsappConsent: true } : { whatsappNumber: null, whatsappConsent: false };
    const saved = studioAccountCleanProfile(await studioApi('/api/studio/profile', { method: 'PUT', body }));
    if (generation !== account.generation) return false;
    account.profile = saved;
    account.editing = false;
    account.draftNumber = '';
    account.draftConsent = false;
    ok = true;
    studioWalletNotify(true, number ? adsStudioText('WhatsApp number saved', 'حُفظ رقم واتساب') : adsStudioText('WhatsApp number removed', 'حُذف رقم واتساب'),
      number ? saved.whatsappNumber : adsStudioText('The team can no longer message you there.', 'لن يراسلك الفريق عليه بعد الآن.'));
  } catch (error) {
    if (generation !== account.generation) return false;
    account.formError = studioWalletErrorText(error);  // PHONE_INVALID / CONSENT_REQUIRED: the studio error map (15g)
    if (!account.editing) studioWalletNotify(false, adsStudioText('Could not save', 'تعذّر الحفظ'), account.formError);
  } finally {
    if (generation === account.generation) {
      account.saving = false;
      studioWalletRedraw();
    }
  }
  return ok;
}

function studioAccountSave() {
  const account = _studioAccount;
  if (account.saving) return;
  const number = studioParsePhone(account.draftNumber);
  if (!number) account.formError = adsStudioText('Type a WhatsApp number such as 091 234 5678 or +218 91 234 5678.', 'اكتب رقم واتساب مثل 091 234 5678، أو الرقم الدولي كاملاً مع رمز الدولة.');
  else if (!account.draftConsent) account.formError = adsStudioText(STUDIO_ERROR_TEXTS.CONSENT_REQUIRED[0], STUDIO_ERROR_TEXTS.CONSENT_REQUIRED[1]);
  if (account.formError) { studioWalletRedraw(); return; }
  studioAccountPut(number);
}

function studioAccountAskRemove() {
  const account = _studioAccount;
  if (account.saving || !account.profile || !account.profile.whatsappNumber) return;
  studioWalletSheet({
    testid: 'studio-account-remove-sheet',
    title: adsStudioText('Remove your WhatsApp number?', 'حذف رقم واتساب؟'),
    text: adsStudioText('The Albayan team will no longer be able to message you there. You can add it again at any time.', 'لن يتمكن فريق البيان من مراسلتك عليه بعد الآن. يمكنك إضافته مجدداً في أي وقت.'),
    confirm: adsStudioText('Remove the number', 'احذف الرقم'),
    cancel: adsStudioText('Keep it', 'أبقِه'),
    danger: true,
    onConfirm: () => studioAccountPut(null)
  });
}
