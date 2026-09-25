// ==========================================
// ALBAYAN STUDIO v2 — SHELL (plan tasks P2-02a-d; styles P2-08 in assets/ads-workspace.css)
// ==========================================
// The v2 frame, drawn only when GET /api/studio/me says so: ui 'v2' for the customer layout,
// staffDesk 'v2' for the Team desk (staff only). renderAdsStudioView (15c) asks renderStudioV2View()
// first and draws the classic screens, unchanged, whenever the answer is '' (classic, local mode,
// /me unknown or failed, or any error here).
//
// Addresses stay on ?tab= (one view, no new paths), with &section=, &id= and &step=:
//   customer: home (the pinned 'dashboard' too), campaigns, replies, wallet, help, inbox, account,
//             builder (&section=boost|full &step=N, also any tab with section=builder), posts and,
//             for staff only, review;
//   Team desk: tab=review&section=requests|launch|settle|tickets|health|more.
// Back (PLAN.md §5.1): builder step N -> N-1; a detail (&id=) -> its list; any other tab -> Home
// (the desk: its Requests); Home -> leaves the studio. The browser history mirrors that chain: every
// studio entry carries history.state.studioV2.chain (the keys from Home to itself). Leaving Home
// pushes, moving between tabs replaces, going up walks back through history, so the in-app Back
// button and the browser's Back always agree. A screen opened straight from a link gets its parents
// put under it. The builder hides the section bar (focus mode).
// Screens not built yet show "Coming soon in the new studio" inside their own root.

const STUDIO_V2_TABS = Object.freeze([
  // [tab, icon, English, Arabic, place] place: 'nav' = bottom bar / side rail, 'head' = header button
  ['home', 'house', 'Home', 'الرئيسية', 'nav'],
  ['campaigns', 'megaphone', 'My ads', 'إعلاناتي', 'nav'],
  ['replies', 'messages-square', 'Pages & replies', 'الصفحات والردود', 'nav'],
  ['wallet', 'wallet', 'Wallet', 'المحفظة', 'nav'],
  ['help', 'life-buoy', 'Help', 'المساعدة', 'nav'],
  ['inbox', 'bell', 'Inbox', 'الإشعارات', 'head'],
  ['account', 'circle-user-round', 'Account', 'حسابي', 'head'],
  ['builder', 'wand-sparkles', 'New request', 'طلب جديد', ''],
  ['posts', 'send', 'Scheduled posts', 'المنشورات المجدولة', ''],
  ['review', 'badge-check', 'Team desk', 'مكتب الفريق', '']
]);

const STUDIO_V2_STAFF_SECTIONS = Object.freeze([
  ['requests', 'clipboard-list', 'Requests', 'الطلبات'],
  ['launch', 'rocket', 'Launch', 'الإطلاق'],
  ['settle', 'scale', 'Settle', 'التسوية'],
  ['tickets', 'ticket', 'Tickets', 'التذاكر'],
  ['health', 'activity', 'Health', 'التنبيهات'],
  ['more', 'ellipsis', 'More', 'المزيد']
]);

const STUDIO_V2_BUILDER_STEPS = Object.freeze({
  full: [['Goal', 'الهدف'], ['Page', 'الصفحة'], ['Content', 'المحتوى'], ['Audience', 'الجمهور'], ['Budget & days', 'الميزانية والمدة'], ['Review', 'المراجعة']],
  boost: [['Post', 'المنشور'], ['Budget & days', 'الميزانية والمدة'], ['Review', 'المراجعة']]
});

const STUDIO_V2_CLASSIC_TABS = Object.freeze(['dashboard', 'campaigns', 'builder', 'posts', 'replies', 'review']);
const STUDIO_V2_ONLY_TABS = Object.freeze(['wallet', 'help', 'inbox', 'account']);
const STUDIO_V2_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const STUDIO_V2_SECTION_RE = /^[a-z][a-z0-9-]{0,31}$/;
const STUDIO_V2_WAIT_MS = 3000;  // at most this long a known v2 user sees "Opening the studio…" instead of classic
const STUDIO_V2_LAYOUT_KEY = 'albayan.studio.v2.layout.';  // + user id: the layout /me gave last time (this browser only)
const _studioV2 = { shown: '', waitFor: '', waitUntil: 0, waitTimer: null, docRendered: false, warned: false };

// ------------------------------------------------------------------ which layout

// 'staff' (the Team desk), 'customer' (the v2 customer layout) or '' (classic, or /me not known).
function studioV2Frame() {
  const me = studioMe();
  if (!me) return '';
  if (me.staffDesk === 'v2' && me.isStaff) return 'staff';
  return me.ui === 'v2' ? 'customer' : '';
}

function studioV2IsStaff() {
  const me = studioMe();
  return !!(me && me.isStaff);
}

function studioV2Remembered(uid) {
  try { return String(window.localStorage.getItem(STUDIO_V2_LAYOUT_KEY + uid) || ''); } catch (_) { return ''; }
}

function studioV2Remember(uid, frame) {
  try {
    if (frame === 'customer' || frame === 'staff') window.localStorage.setItem(STUDIO_V2_LAYOUT_KEY + uid, frame);
    else window.localStorage.removeItem(STUDIO_V2_LAYOUT_KEY + uid);
  } catch (_) { /* a private window: the classic screens show until /me answers */ }
}

// While the first /me read is on its way: a user whose last answer was v2 sees a short neutral
// "Opening the studio…" (never the v2 frame before /me says so); everyone else gets classic at once.
function studioV2ShouldWait() {
  const uid = studioMeUserId();
  if (!uid || !studioMeLoading()) return false;
  const remembered = studioV2Remembered(uid);
  if (remembered !== 'customer' && remembered !== 'staff') return false;
  if (_studioV2.waitFor !== uid) {
    _studioV2.waitFor = uid;
    _studioV2.waitUntil = Date.now() + STUDIO_V2_WAIT_MS;
    if (_studioV2.waitTimer) clearTimeout(_studioV2.waitTimer);
    _studioV2.waitTimer = setTimeout(() => {
      _studioV2.waitTimer = null;
      if (_studioV2.shown === 'wait') studioV2Rerender();
    }, STUDIO_V2_WAIT_MS + 50);
  }
  return Date.now() < _studioV2.waitUntil;
}

function studioV2Rerender() {
  try {
    if (typeof state !== 'undefined' && state.currentView === 'ads-studio' && typeof render === 'function') render();
  } catch (_) { /* the next render shows the right layout */ }
}

// A /me answer arrived (or failed): draw again only when the layout on screen is no longer right.
function studioV2OnMe(me) {
  const uid = studioMeUserId();
  if (!uid) return;
  const frame = studioV2Frame();
  if (me) studioV2Remember(uid, frame);
  if (!_studioV2.shown) return;
  const want = frame || 'classic';
  if (want !== _studioV2.shown) studioV2Rerender();
  else if (want === 'classic' && me && !STUDIO_V2_CLASSIC_TABS.includes(String(_adsStudioActiveTab || ''))) studioV2Rerender();
}

studioMeSubscribe(studioV2OnMe);

// Called first by renderAdsStudioView (15c). '' = draw the classic screens.
function renderStudioV2View() {
  try {
    studioLoadMe();  // reuses a fresh answer, joins a read on its way, re-reads an old one
    const frame = studioV2Frame();
    if (frame === 'staff') { _studioV2.shown = 'staff'; return renderStudioV2StaffFrame(); }
    if (frame === 'customer') { _studioV2.shown = 'customer'; return renderStudioV2CustomerFrame(); }
    if (!studioMe() && studioV2ShouldWait()) { _studioV2.shown = 'wait'; return renderStudioV2Waiting(); }
    _studioV2.shown = 'classic';
    if (studioMe()) studioV2ClassicTabFix();
    return '';
  } catch (error) {
    if (!_studioV2.warned) {
      _studioV2.warned = true;
      try { console.warn('[studio v2] showing the classic screens instead:', error); } catch (_) {}
    }
    _studioV2.shown = 'classic';
    return '';
  }
}

// The classic layout knows only its own tabs: a v2 address (?tab=wallet …) opens its Overview.
function studioV2ClassicTabFix() {
  try {
    if (STUDIO_V2_CLASSIC_TABS.includes(String(_adsStudioActiveTab || ''))) return;
    _adsStudioActiveTab = 'dashboard';
    const tab = new URLSearchParams(window.location.search || '').get('tab');
    if (tab && !STUDIO_V2_CLASSIC_TABS.includes(tab) && typeof updateUrlParams === 'function') {
      updateUrlParams({ tab: 'dashboard', section: null, id: null, step: null }, true);
    }
  } catch (_) { /* the Overview shows anyway */ }
}

// ------------------------------------------------------------------ the address and the Back model

function studioV2ReadAddress() {
  let params;
  try { params = new URLSearchParams(window.location.search || ''); } catch (_) { params = new URLSearchParams(''); }
  return { tab: params.get('tab') || '', section: params.get('section') || '', id: params.get('id') || '', step: params.get('step') || '' };
}

function studioV2BuilderSteps(section) {
  return STUDIO_V2_BUILDER_STEPS[section === 'boost' ? 'boost' : 'full'];
}

function studioV2Home(frame) {
  return frame === 'staff'
    ? { tab: 'review', section: 'requests', id: '', step: 0 }
    : { tab: 'home', section: '', id: '', step: 0 };
}

// Any address -> a route this frame can draw ({tab, section, id, step}); anything unknown is Home.
function studioV2Route(raw, frame) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const section = STUDIO_V2_SECTION_RE.test(String(src.section || '')) ? String(src.section) : '';
  const id = STUDIO_V2_ID_RE.test(String(src.id || '')) ? String(src.id) : '';
  if (frame === 'staff') {
    const known = STUDIO_V2_STAFF_SECTIONS.some(item => item[0] === section);
    return { tab: 'review', section: known ? section : 'requests', id, step: 0 };
  }
  let tab = String(src.tab || '');
  if (!tab || tab === 'dashboard') tab = 'home';
  if (section === 'builder') tab = 'builder';
  if (!STUDIO_V2_TABS.some(item => item[0] === tab) || (tab === 'review' && !studioV2IsStaff())) tab = 'home';
  if (tab === 'home') return studioV2Home(frame);
  if (tab === 'builder') {
    const kind = section === 'boost' || section === 'full' ? section : '';
    const count = studioV2BuilderSteps(kind).length;
    const rawStep = String(src.step === undefined || src.step === null ? '' : src.step);
    const step = /^\d{1,2}$/.test(rawStep) ? Number(rawStep) : 1;
    return { tab, section: kind, id: '', step: Math.min(Math.max(step, 1), count) };
  }
  return { tab, section, id, step: 0 };
}

function studioV2Key(route) {
  return [route.tab, route.section, route.id, route.step || ''].join('|');
}

// One level up (PLAN.md §5.1), or null on Home.
function studioV2Parent(route, frame) {
  if (frame === 'staff') {
    if (route.id) return { ...route, id: '' };
    return route.section === 'requests' ? null : studioV2Home('staff');
  }
  if (route.tab === 'home') return null;
  if (route.tab === 'builder' && route.step > 1) return { ...route, step: route.step - 1 };
  if (route.id) return { ...route, id: '' };
  return studioV2Home('customer');
}

// Home first, the route last.
function studioV2Path(route, frame) {
  const path = [route];
  let up = studioV2Parent(route, frame);
  for (let guard = 0; up && guard < 20; guard++) {
    path.unshift(up);
    up = studioV2Parent(up, frame);
  }
  return path;
}

function studioV2Url(route) {
  const params = new URLSearchParams();
  params.set('tab', route.tab);
  if (route.section) params.set('section', route.section);
  if (route.id) params.set('id', route.id);
  if (route.step) params.set('step', String(route.step));
  return `${window.location.pathname || '/'}?${params.toString()}`;
}

function studioV2HistoryChain() {
  try {
    const mark = window.history.state && window.history.state.studioV2;
    const chain = mark && mark.chain;
    return Array.isArray(chain) && chain.length > 0 && chain.length <= 24
      && chain.every(key => typeof key === 'string' && key.length <= 200) ? chain.slice() : null;
  } catch (_) { return null; }
}

// The classic tab variable follows the v2 address, so a whole-view re-navigation (which keeps only
// ?tab=) and the loader's restore land on the same screen.
function studioV2SyncClassicTab(route) {
  try { _adsStudioActiveTab = route.tab === 'home' ? 'dashboard' : route.tab; } catch (_) {}
}

function studioV2WriteEntry(route, chain, replace) {
  const entry = { view: 'ads-studio', params: { tab: route.tab }, studioV2: { chain: chain.slice() } };
  const url = studioV2Url(route);
  if (replace) window.history.replaceState(entry, '', url);
  else window.history.pushState(entry, '', url);
  studioV2SyncClassicTab(route);
}

function studioV2NavigationType() {
  try {
    const entry = performance.getEntriesByType('navigation')[0];
    return entry && entry.type ? String(entry.type) : 'navigate';
  } catch (_) { return 'navigate'; }
}

// On every v2 draw: the entry on screen carries its chain. A screen opened straight from a link (or
// from another page of the app) gets Home and its other parents put under it; after a reload or a
// return through history the entries under it are the studio's own and only the mark is renewed.
function studioV2EnsureHistory(route, frame) {
  try {
    const current = window.history.state;
    if (current && current.overlaySentinel) return;  // an open sheet owns the top entry
    const path = studioV2Path(route, frame);
    const keys = path.map(studioV2Key);
    const chain = studioV2HistoryChain();
    const firstDraw = !_studioV2.docRendered;
    _studioV2.docRendered = true;
    if (chain && chain[chain.length - 1] === keys[keys.length - 1]) return;
    if (path.length === 1 || (firstDraw && studioV2NavigationType() !== 'navigate')) {
      window.history.replaceState(Object.assign({}, current || {}, { view: 'ads-studio', studioV2: { chain: keys } }), '', window.location.href);
      return;
    }
    path.forEach((step, index) => studioV2WriteEntry(step, keys.slice(0, index + 1), index === 0));
  } catch (_) { /* the address stays as it is */ }
}

// The start-up address rewrite keeps only ?tab= (and loses even that when this bundle arrives after
// it). On the first v2 draw of a page opened moments ago, the address it was opened with comes back
// (only tab, section, id and step), unless the reader has already moved somewhere else.
function studioV2RestoreOpeningAddress() {
  if (_studioV2.docRendered) return;
  try {
    if (typeof performance === 'undefined' || !(performance.now() < 15000)) return;
    const entry = performance.getEntriesByType('navigation')[0];
    if (!entry || !entry.name) return;
    const opened = new URL(String(entry.name));
    if (opened.pathname !== window.location.pathname) return;
    const now = new URLSearchParams(window.location.search || '');
    if (['section', 'id', 'step'].some(key => now.get(key))) return;
    const tab = now.get('tab') || '';
    const openedTab = opened.searchParams.get('tab') || '';
    if (!openedTab || !(tab === openedTab || tab === '' || tab === 'dashboard')) return;
    const params = new URLSearchParams();
    for (const key of ['tab', 'section', 'id', 'step']) {
      const value = opened.searchParams.get(key);
      if (value) params.set(key, value);
    }
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params.toString()}`);
  } catch (_) { /* the address stays as it is */ }
}

function studioV2HistoryGo(delta) {
  try { window.history.go(delta); } catch (_) {}
}

// After history.go(): runs once the browser has moved (the router has drawn that entry by then).
function studioV2AfterPop(fn) {
  let done = false;
  let timer = null;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener('popstate', finish);
    if (timer) clearTimeout(timer);
    try { fn(); } catch (_) {}
  };
  window.addEventListener('popstate', finish);
  timer = setTimeout(finish, 1500);
}

function studioV2Show(navigated) {
  if (navigated && typeof requestViewScrollReset === 'function') requestViewScrollReset();
  studioV2Rerender();
}

// Opens a route and keeps the history equal to its chain: the common part stays, what is above it is
// walked back (going up = the browser's own Back), the rest is added (the first addition replaces the
// entry being left, so moving between tabs never stacks up).
function studioV2Go(target) {
  const frame = studioV2Frame();
  if (!frame || typeof window === 'undefined' || !window.history) return false;
  const current = studioV2Route(studioV2ReadAddress(), frame);
  const path = studioV2Path(studioV2Route(target, frame), frame);
  const keys = path.map(studioV2Key);
  let chain = studioV2HistoryChain();
  if (!chain || chain[chain.length - 1] !== studioV2Key(current)) chain = [studioV2Key(current)];
  if (chain[chain.length - 1] === keys[keys.length - 1]) { studioV2Show(false); return true; }
  let same = 0;
  while (same < keys.length && same < chain.length && keys[same] === chain[same]) same++;
  const pops = chain.length - same;
  try {
    if (same === keys.length) { studioV2HistoryGo(-pops); return true; }
    if (same === 0) {
      path.forEach((step, index) => studioV2WriteEntry(step, keys.slice(0, index + 1), index === 0));
      studioV2Show(true);
      return true;
    }
    const writeRest = replaceFirst => {
      path.slice(same).forEach((step, index) => studioV2WriteEntry(step, keys.slice(0, same + index + 1), index === 0 && replaceFirst));
      studioV2Show(true);
    };
    if (pops <= 1) writeRest(pops === 1);
    else {
      studioV2AfterPop(() => writeRest(true));
      studioV2HistoryGo(-(pops - 1));
    }
    return true;
  } catch (_) { return false; }
}

function studioV2Open(tab) {
  return studioV2Go({ tab: String(tab || '') });
}

function studioV2OpenSection(section) {
  return studioV2Go({ tab: 'review', section: String(section || '') });
}

function studioV2BuilderStep(delta) {
  if (studioV2Frame() !== 'customer') return false;
  const route = studioV2Route(studioV2ReadAddress(), 'customer');
  if (route.tab !== 'builder') return false;
  return studioV2Go({ tab: 'builder', section: route.section, step: route.step + (Number(delta) || 0) });
}

function studioV2CloseBuilder() {
  return studioV2Go(studioV2Home('customer'));
}

function studioV2CanLeave() {
  try { if (window.history.length > 1) return true; } catch (_) {}
  return !IS_STUDIO_SHELL && !!adsStudioBackTarget();
}

function studioV2Leave() {
  try {
    if (window.history.length > 1) { window.history.back(); return true; }
  } catch (_) {}
  const target = IS_STUDIO_SHELL ? '' : adsStudioBackTarget();
  if (target && typeof navigateTo === 'function') { navigateTo(target); return true; }
  return false;
}

// The in-app Back button.
function studioV2Back() {
  const frame = studioV2Frame();
  if (!frame) return false;
  const parent = studioV2Parent(studioV2Route(studioV2ReadAddress(), frame), frame);
  return parent ? studioV2Go(parent) : studioV2Leave();
}

// For the app's hardware Back key (P2-09 hook): true when the studio moved up a level itself; false on
// Home or outside the v2 layout, so the app's own Back runs.
function studioHandleBack() {
  if (typeof state === 'undefined' || state.currentView !== 'ads-studio') return false;
  const frame = studioV2Frame();
  if (!frame) return false;
  return studioV2Parent(studioV2Route(studioV2ReadAddress(), frame), frame) ? studioV2Back() : false;
}

// The pinned tab setter and the address restore keep working in both layouts: in v2 the setter
// drives the v2 address (same ?tab=, the Back model's history); the restore also keeps the v2-only
// tabs, so a reload or a link to ?tab=wallet survives the start-up address rewrite (which keeps ?tab=).
const _studioV2ClassicSetTab = typeof setAdsStudioTab === 'function' ? setAdsStudioTab : null;
const _studioV2ClassicRestoreTab = typeof restoreAdsStudioTabFromUrl === 'function' ? restoreAdsStudioTabFromUrl : null;

setAdsStudioTab = function setAdsStudioTabForLayout(tabId) {
  if (studioV2Frame() && typeof state !== 'undefined' && state.currentView === 'ads-studio') {
    const tab = String(tabId || '');
    if (tab === 'dashboard' || STUDIO_V2_TABS.some(item => item[0] === tab)) studioV2Go({ tab });
    return;
  }
  if (_studioV2ClassicSetTab) _studioV2ClassicSetTab(tabId);
};

restoreAdsStudioTabFromUrl = function restoreAdsStudioTabFromUrlForLayout() {
  if (_studioV2ClassicRestoreTab) _studioV2ClassicRestoreTab();
  try {
    const tab = String(new URLSearchParams(window.location.search || '').get('tab') || '');
    if (tab === 'home') _adsStudioActiveTab = 'dashboard';
    else if (STUDIO_V2_ONLY_TABS.includes(tab)) _adsStudioActiveTab = tab;
  } catch (_) {}
};

// ------------------------------------------------------------------ drawing

function studioV2TabInfo(tab) {
  return STUDIO_V2_TABS.find(item => item[0] === tab) || STUDIO_V2_TABS[0];
}

function studioV2StaffSection(section) {
  return STUDIO_V2_STAFF_SECTIONS.find(item => item[0] === section) || STUDIO_V2_STAFF_SECTIONS[0];
}

function studioV2Icon(name, className = 'studio-v2-icon') {
  return `<i data-lucide="${studioEsc(name)}" class="${className}" aria-hidden="true"></i>`;
}

function studioV2BuilderStepText(route) {
  const steps = studioV2BuilderSteps(route.section);
  const step = Math.min(Math.max(1, route.step || 1), steps.length);
  const name = steps[step - 1];
  return adsStudioText(`Step ${step} of ${steps.length}: ${name[0]}`, `الخطوة ${step} من ${steps.length}: ${name[1]}`);
}

function renderStudioV2Header(route, frame) {
  const staff = frame === 'staff';
  const focus = !staff && route.tab === 'builder';
  const parent = studioV2Parent(route, frame);
  const brand = adsStudioText('Albayan Ads Studio', 'استوديو إعلانات البيان');
  let title = brand;
  let kicker = '';
  if (staff) {
    const section = studioV2StaffSection(route.section);
    title = adsStudioText(section[2], section[3]);
    kicker = adsStudioText('Team desk', 'مكتب الفريق');
  } else if (route.tab !== 'home') {
    const info = studioV2TabInfo(route.tab);
    title = adsStudioText(info[2], info[3]);
    kicker = brand;
  }
  const backLabel = parent ? adsStudioText('Back', 'رجوع') : adsStudioText('Leave the studio', 'الخروج من الاستوديو');
  const back = parent || studioV2CanLeave()
    ? `<button type="button" data-testid="studio-back" class="studio-v2-icon-btn" onclick="studioV2Back()" aria-label="${studioEsc(backLabel)}" title="${studioEsc(backLabel)}">${studioV2Icon(adsStudioIsAr() ? 'arrow-right' : 'arrow-left')}</button>`
    : '';
  const headButton = tab => {
    const info = studioV2TabInfo(tab);
    const label = adsStudioText(info[2], info[3]);
    return `<button type="button" data-testid="studio-nav-${tab}" class="studio-v2-icon-btn" onclick="studioV2Open('${tab}')" aria-label="${studioEsc(label)}" title="${studioEsc(label)}"${route.tab === tab ? ' aria-current="page"' : ''}>${studioV2Icon(info[1])}</button>`;
  };
  let actions = '';
  if (focus) {
    const close = adsStudioText('Close', 'إغلاق');
    actions = `<button type="button" data-testid="studio-close" class="studio-v2-icon-btn" onclick="studioV2CloseBuilder()" aria-label="${studioEsc(close)}" title="${studioEsc(close)}">${studioV2Icon('x')}</button>`;
  } else if (!staff) {
    actions = headButton('inbox') + headButton('account');
  }
  return `
      <header class="studio-v2-header">
        ${back}
        <div class="studio-v2-heading">
          ${kicker ? `<p class="studio-v2-kicker">${studioEsc(kicker)}</p>` : ''}
          <h1 id="studio-v2-title" class="studio-v2-title">${studioEsc(title)}</h1>
        </div>
        ${actions ? `<div class="studio-v2-header-actions">${actions}</div>` : ''}
      </header>`;
}

function renderStudioV2Soon(title, icon, forStaff = false) {
  const note = forStaff
    ? adsStudioText('This part of the Team desk is still being built.', 'ما زلنا نبني هذا القسم من مكتب الفريق.')
    : adsStudioText('This part is still being built. Your requests, money and pages are safe and unchanged.',
      'ما زلنا نبني هذا القسم. طلباتك وأموالك وصفحاتك محفوظة ولم يتغير فيها شيء.');
  return `
          <div class="studio-v2-soon" data-testid="studio-soon">
            <span class="studio-v2-soon-icon" aria-hidden="true">${studioV2Icon(icon)}</span>
            <h2 class="studio-v2-soon-title">${studioEsc(title)}</h2>
            <p class="studio-v2-soon-text">${studioEsc(adsStudioText('Coming soon in the new studio', 'قريباً في الاستوديو الجديد'))}</p>
            <p class="studio-v2-soon-note">${studioEsc(note)}</p>
          </div>`;
}

// Language, theme and sign-out: reachable in every layout while Account / More are being built.
function renderStudioV2Basics() {
  const dark = typeof state !== 'undefined' && state.theme === 'dark';
  const row = (onclick, icon, label, value, extra = '') => `
            <button type="button" class="studio-v2-row${extra}" onclick="${onclick}">
              ${studioV2Icon(icon)}
              <span class="studio-v2-row-label">${studioEsc(label)}</span>
              ${value ? `<span class="studio-v2-row-value">${studioEsc(value)}</span>` : ''}
            </button>`;
  return `
          <div class="studio-v2-list" data-testid="studio-basics">
            ${row('toggleLanguage()', 'languages', adsStudioText('Language', 'اللغة'), adsStudioIsAr() ? 'العربية' : 'English')}
            ${row('toggleTheme()', dark ? 'moon' : 'sun', adsStudioText('Theme', 'المظهر'), dark ? adsStudioText('Dark', 'داكن') : adsStudioText('Light', 'فاتح'))}
            ${row('handleLogout()', 'log-out', adsStudioText('Log out', 'تسجيل الخروج'), '', ' is-danger')}
          </div>`;
}

function renderStudioV2Builder(route) {
  const steps = studioV2BuilderSteps(route.section);
  const items = steps.map((name, index) => {
    const number = index + 1;
    const mark = number === route.step ? ' is-current' : (number < route.step ? ' is-done' : '');
    return `<li class="studio-v2-step${mark}"${number === route.step ? ' aria-current="step"' : ''}><span class="studio-v2-step-dot" aria-hidden="true">${number}</span><span class="studio-v2-step-name">${studioEsc(adsStudioText(name[0], name[1]))}</span></li>`;
  }).join('');
  const next = route.step < steps.length
    ? `<button type="button" data-testid="studio-builder-next" class="studio-v2-action is-primary" onclick="studioV2BuilderStep(1)">${studioEsc(adsStudioText('Next', 'التالي'))}</button>`
    : '';
  return `
          <div class="studio-v2-builder" data-step="${route.step}" data-steps="${steps.length}">
            <p class="studio-v2-step-text" data-testid="studio-builder-step">${studioEsc(studioV2BuilderStepText(route))}</p>
            <ol class="studio-v2-steps">${items}</ol>
            ${renderStudioV2Soon(adsStudioText('New request', 'طلب جديد'), 'wand-sparkles')}
            ${next ? `<div class="studio-v2-builder-actions">${next}</div>` : ''}
          </div>`;
}

function renderStudioV2CustomerScreen(route) {
  const info = studioV2TabInfo(route.tab);
  let body;
  if (route.tab === 'builder') {
    body = renderStudioV2Builder(route);
  } else {
    body = renderStudioV2Soon(adsStudioText(info[2], info[3]), info[1]);
    // A customer without an active plan still needs the way to activate it (the classic card).
    if (route.tab === 'home' && !adsStudioCanUse()) body += `<div class="studio-v2-gate">${renderAdsStudioSubscriptionGate()}</div>`;
    if (route.tab === 'account') body += renderStudioV2Basics();
  }
  const attrs = (route.section ? ` data-section="${studioEsc(route.section)}"` : '') + (route.id ? ` data-id="${studioEsc(route.id)}"` : '');
  return `
        <section data-testid="studio-screen-${studioEsc(route.tab)}" class="studio-v2-screen" aria-labelledby="studio-v2-title"${attrs}>${body}
        </section>`;
}

function renderStudioV2CustomerFrame() {
  studioV2RestoreOpeningAddress();
  const route = studioV2Route(studioV2ReadAddress(), 'customer');
  studioV2EnsureHistory(route, 'customer');
  studioV2SyncClassicTab(route);
  const focus = route.tab === 'builder';
  const items = STUDIO_V2_TABS.filter(item => item[4] === 'nav').map(([tab, icon, en, ar]) => `
          <button type="button" data-testid="studio-nav-${tab}" class="studio-v2-nav-item" onclick="studioV2Open('${tab}')"${route.tab === tab ? ' aria-current="page"' : ''}>${studioV2Icon(icon, 'studio-v2-nav-icon')}<span>${studioEsc(adsStudioText(en, ar))}</span></button>`).join('');
  return `
    <div data-testid="studio-v2-frame" class="studio-v2-frame" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}" data-tab="${studioEsc(route.tab)}" data-focus="${focus ? '1' : '0'}">
      ${renderStudioV2Header(route, 'customer')}
      <div class="studio-v2-body">
        <nav data-testid="studio-nav" class="studio-v2-nav" aria-label="${studioEsc(adsStudioText('Studio sections', 'أقسام الاستوديو'))}"${focus ? ' hidden' : ''}>${items}
        </nav>
        <div class="studio-v2-main">${renderStudioV2CustomerScreen(route)}
        </div>
      </div>
    </div>`;
}

// The Team desk frame (P2-02d): its own sections, no wallet or payment items (admin-only items live
// under More once they are built). Sections are filled in Phase 3.
function renderStudioV2StaffFrame() {
  studioV2RestoreOpeningAddress();
  const route = studioV2Route(studioV2ReadAddress(), 'staff');
  studioV2EnsureHistory(route, 'staff');
  studioV2SyncClassicTab(route);
  const section = studioV2StaffSection(route.section);
  const items = STUDIO_V2_STAFF_SECTIONS.map(([id, icon, en, ar]) => `
          <button type="button" data-testid="studio-staffnav-${id}" class="studio-v2-nav-item" onclick="studioV2OpenSection('${id}')"${section[0] === id ? ' aria-current="page"' : ''}>${studioV2Icon(icon, 'studio-v2-nav-icon')}<span>${studioEsc(adsStudioText(en, ar))}</span></button>`).join('');
  const attrs = route.id ? ` data-id="${studioEsc(route.id)}"` : '';
  return `
    <div data-testid="studio-staff-frame" class="studio-v2-frame is-staff" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}" data-tab="review" data-section="${section[0]}" data-focus="0">
      ${renderStudioV2Header(route, 'staff')}
      <div class="studio-v2-body">
        <nav data-testid="studio-staffnav" class="studio-v2-nav is-staff" aria-label="${studioEsc(adsStudioText('Team desk sections', 'أقسام مكتب الفريق'))}">${items}
        </nav>
        <div class="studio-v2-main">
          <section data-testid="studio-screen-review" data-section="${section[0]}" class="studio-v2-screen" aria-labelledby="studio-v2-title"${attrs}>
            <div data-testid="studio-staff-screen-${section[0]}">${renderStudioV2Soon(adsStudioText(section[2], section[3]), section[1], true)}${section[0] === 'more' ? renderStudioV2Basics() : ''}
            </div>
          </section>
        </div>
      </div>
    </div>`;
}

function renderStudioV2Waiting() {
  return `
    <div data-testid="studio-v2-loading" class="studio-v2-loading" dir="${adsStudioIsAr() ? 'rtl' : 'ltr'}" role="status">
      <span class="studio-v2-spinner" aria-hidden="true"></span>
      <p>${studioEsc(adsStudioText('Opening the studio…', 'جارٍ فتح الاستوديو…'))}</p>
    </div>`;
}
