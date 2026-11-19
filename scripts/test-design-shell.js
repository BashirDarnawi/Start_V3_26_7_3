/** Presentation-only regressions: actual shell functions and Meta renderers.
 * No network, DOM app initialization, payment writes or generated bundle needed.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/12d-manager-shell.js'), 'utf8');
let focused = null;
let toggled = null;
let photoAllowed = false;
let mediaCalls = 0;
let planned = 10000;
let remaining = 3450;
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const context = vm.createContext({
  state: { language: 'en', currentUser: { id: 'admin' } },
  Security: { escapeHtml },
  document: { getElementById: id => ({ getAttribute: () => toggled, focus: () => { focused = id; } }) },
  render() {},
  can: () => photoAllowed,
  isCurrentUserAdmin: () => context.state.currentUser?.role === 'Admin',
  getAdPhotoCount: ad => ad.photoCount || 0,
  metaAdThumbnailSrc: ad => ad.metaThumbnailUrl || '',
  isSafeReceiptPhotoSource: source => /^https:\/\//.test(source),
  renderAdPrimaryThumbnail() { mediaCalls++; return '<button class="existing-photo-action">photo</button>'; },
  renderMetaAdBudgetSummary: () => '<div data-role="meta-ad-budget">CANONICAL MONEY</div>',
  metaAdsPlannedTotalMinor: () => planned,
  metaAdsTotalRemainingMinor: () => remaining,
  getReceiptPaymentState: receipt => receipt.status === 'Paid' ? 'paid' : 'not_paid',
  appDateLocale: () => 'en-US',
  trStatus: value => value,
  platformLabel: value => String(value || ''),
});
vm.runInContext(source, context);
let passed = 0;
function check(label, run) { run(); passed++; console.log(`PASS ${label}`); }

check('stable DOM ids do not collide after punctuation or Unicode', () => {
  const ids = ['a-b', 'a_b', "a'b", 'a"b', 'a:b', 'صفحة', '🙂', '%25'];
  const dom = ids.map(id => context.shellRowDomId('ads', id, 'details'));
  assert.equal(new Set(dom).size, ids.length);
  assert(dom.every(id => /^[a-z0-9-]+$/.test(id)));
});
check('summary controls resolve their details without truncating text', () => {
  const html = context.shellListRow({ kind: 'receipts', id: "r'quoted", title: 'Long customer name', sub: 'Long receipt identifier', avatar: 'avatar', card: '<p>Existing actions</p>' });
  const detailsId = context.shellRowDomId('receipts', "r'quoted", 'details');
  assert(html.includes(`aria-controls="${detailsId}"`));
  assert(html.includes(`id="${detailsId}"`));
  assert(html.includes('>Details</span>'));
  assert(!html.includes('truncate'));
  assert(html.includes('shellToggleRow(this.dataset.shellKind, this.dataset.shellId)'));
  assert(html.includes('data-shell-row-id="r&#39;quoted"'));
  assert(html.includes('Existing actions'));
});
check('table details retain selectors and matching ids', () => {
  const attrs = context.shellTableDetailAttrs('ads', 'a1');
  assert(attrs.includes('data-shell-detail="ads"'));
  assert(attrs.includes('data-shell-detail-id="a1"'));
  assert(attrs.includes(context.shellRowDomId('ads', 'a1', 'details')));
  assert(!attrs.includes('aria-labelledby'));
});
check('filtered receipt can actually Hide and restores keyboard focus', () => {
  toggled = 'true';
  context.shellToggleRow('receipts', 'filtered');
  assert.equal(context.shellRowIsOpen('receipts', 'filtered', true), false);
  assert.equal(focused, context.shellRowDomId('receipts', 'filtered', 'toggle'));
  toggled = 'false';
  context.shellToggleRow('receipts', 'filtered');
  assert.equal(context.shellRowIsOpen('receipts', 'filtered', true), true);
});
check('Arabic disclosure labels work', () => {
  context.state.language = 'ar';
  const html = context.shellSummaryButton({ kind: 'ads', id: 'a', title: 'عميل', sub: '', avatar: '', open: true });
  assert(html.includes('>إخفاء</span>'));
  context.state.language = 'en';
});
check('outside record actions escape IDs and accept only fixed handlers', () => {
  const html = context.shellRecordAction('editReceipt', `r\"' onclick=bad`, '<Edit>', 'pencil');
  assert(html.includes('data-record-id="r&quot;&#39; onclick=bad"'));
  assert(html.includes('onclick="editReceipt(this.dataset.recordId)"'));
  assert(html.includes('&lt;Edit&gt;'));
  assert.equal(context.shellRecordAction('arbitraryCode()', 'r', 'Edit'), '');
});
check('directory overview actions do not duplicate visibly when full details open', () => {
  const props = { kind: 'customers', id: 'c', title: 'Customer', card: '<button>Full action</button>', facts: '<div>FACTS</div>', actions: '<button>QUICK</button>' };
  const closed = context.shellListRow(props);
  assert(closed.includes('<article'));
  assert(closed.includes('QUICK') && closed.includes('FACTS'));
  const open = context.shellListRow({ ...props, open: true });
  assert(!open.includes('QUICK') && !open.includes('FACTS'));
  assert(open.includes('Full action'));
});
check('receipt overview shows authoritative debt allocation, never a fabricated paid balance', () => {
  const html = context.shellReceiptRow({ id: 'r-overview', status: 'Not Paid', amountLocal: 999 }, { name: 'Customer' }, '', {
    hasCustomerDebt: true, collectionTarget: { amountLocal: 292.36 }, displayedUsedUSD: 30.14, displayedRemainingUSD: 0
  });
  assert(html.includes('Customer owes') && html.includes('292.36'));
  assert(html.includes('Debt linked to ads') && html.includes('$30.14'));
  assert(html.includes('Unassigned debt') && !html.includes('Available balance'));
  assert(!html.includes('999'));
});
check('outside receipt actions keep edit/photo/linked-record and admin coverage gates', () => {
  const receipt = { id: 'r-actions', status: 'Not Paid' };
  let html = context.shellReceiptRow(receipt, {}, '', { canCoverWithCompanyFunds: true });
  assert(!html.includes('data-record-action='));
  context.state.currentUser.role = 'Admin';
  html = context.shellReceiptRow(receipt, {}, '', { canCoverWithCompanyFunds: true, receiptPhotoCount: 2, canSeeReceiptAds: true, linkedAdCount: 3, canEditThisReceipt: true });
  for (const action of ['receiptCoverage', 'receiptPhotos', 'receiptAds', 'editReceipt']) assert(html.includes(`data-record-action="${action}"`));
  html = context.shellReceiptRow(receipt, {}, '', { destroyed: true, canCoverWithCompanyFunds: true, receiptPhotoCount: 2, canEditThisReceipt: true });
  assert(!html.includes('data-record-action='));
  delete context.state.currentUser.role;
});
check('customer overview hides contact and money without their specific permissions', () => {
  const html = context.shellCustomerRow({ id: 'private-c', name: 'Customer' }, { balanceLYD: -500, totalPaidLYD: 200, totalSpentLYD: 700 }, '', { phones: ['0912345678'], coverableDebtUSD: 100 });
  assert(!html.includes('0912345678') && !html.includes('500.00') && !html.includes('200.00') && !html.includes('700.00'));
  assert(!html.includes('customerCoverage'));
});
check('page overview does not reveal spend or ad counts without permission', () => {
  const html = context.shellPageRow({ id: 'private-page', name: 'Page' }, '', { linkedCustomers: [], pageStats: { totalAds: 345, totalSpendUSD: 567.89 } });
  assert(!html.includes('567.89') && !html.includes('345') && !html.includes('editPage'));
});
check('unsafe legacy thumbnail URL never reaches existing renderer', () => {
  mediaCalls = 0;
  assert.equal(context.shellAdMedia({ metaThumbnailUrl: 'javascript:bad' }, false), '');
  assert.equal(mediaCalls, 0);
});
check('uploaded photos delegate existing permission-aware renderer', () => {
  photoAllowed = true;
  assert(context.shellAdMedia({ photoCount: 1 }, false).includes('existing-photo-action'));
  photoAllowed = false;
});
check('Meta amounts use existing renderer and progress uses remaining helper', () => {
  const html = context.shellAdBudgetPreview({ id: 'meta1', metaAdId: '1', metaSpendMinor: 6550 }, false);
  assert(html.includes('CANONICAL MONEY'));
  assert(html.includes('aria-valuenow="65.5"'));
  assert(html.includes('width:65.5%'));
});
check('open-ended or invalid totals never pretend to have percentage progress', () => {
  planned = 0;
  assert(!context.shellAdBudgetPreview({ metaAdId: '1' }, false).includes('progressbar'));
  planned = Infinity;
  assert(!context.shellAdBudgetPreview({ metaAdId: '1' }, false).includes('progressbar'));
  planned = 10000;
});
check('manual ad preview does not invent remaining money', () => {
  assert.equal(context.shellAdBudgetPreview({ amountUSD: 50 }, false), '');
});
check('missing, null or invalid remaining figures never produce false complete progress', () => {
  for (const value of [null, undefined, '', true, 'bad', -1]) {
    const ad = { metaAdId: '1', metaSpendMinor: 50, metaTotalRemainingBudgetMinor: value };
    assert(!context.shellAdBudgetPreview(ad, false).includes('progressbar'));
  }
  assert(!context.shellAdBudgetPreview({ metaAdId: '1' }, false).includes('progressbar'));
  remaining = null;
  assert(!context.shellAdBudgetPreview({ metaAdId: '1', metaSpendMinor: 50 }, false).includes('progressbar'));
  remaining = 3450;
});
check('photo action is a sibling, never nested inside disclosure', () => {
  const html = context.shellTableSummaryRow('ads', 'ad1', { avatar: '', title: 'Campaign', sub: '', media: '<button class="photo">Photo</button>' }, 10);
  assert(html.includes('<div class="shell-summary-media"><button class="photo">Photo</button></div>'));
  assert.equal((html.match(/<button /g) || []).length, 2);
});
check('receipt summary keeps passed authoritative debt, not original amount', () => {
  const html = context.shellReceiptRow({ id: 'debt', amountLocal: 9999, status: 'Not Paid' }, { name: 'Customer' }, '<div>Existing receipt</div>', { hasCustomerDebt: true, collectionTarget: { amountLocal: 320 } });
  assert(html.includes('320 LYD'));
  assert(!html.includes('9,999'));
});
// Exercise the real existing media and budget renderer, not just spies.
context.isCurrentUserAdmin = () => false;
context.isServerModeEnabled = () => true;
context.getServerBaseUrl = () => 'https://app.example.invalid';
context.getAdPrimaryPhotoIndex = ad => ad.primaryAdPhotoIndex || 0;
context.getAdPhotoSources = ad => ad.adPhotos || [];
// Phone builds route <img> loads through the native layer; the browser path is the plain URL.
context.protectedImageUrl = pathname => pathname;
// The row renderers are the startup half of the Meta UI (the dialogs are the lazy meta-tools.js).
vm.runInContext(fs.readFileSync(path.join(root, 'src/15d0-meta-ads-core.js'), 'utf8'), context);
check('lean page avatar: the picture route only when an archived copy exists, else the signed URL', () => {
  const lean = { id: 'p1', _mediaOmitted: true, _lastModified: 7, metaPagePictureUrl: 'https://scontent.example/pic.jpg' };
  assert.equal(context.adPagePictureUrl(null, lean), 'https://scontent.example/pic.jpg');
  assert.equal(context.adPagePictureUrl(null, { ...lean, metaPagePictureArchivedFrom: 'https://scontent.example/pic.jpg' }), '/api/collections/pages/p1/picture?v=7');
});
check('real renderer never exposes uploaded private media without viewPhotos', () => {
  photoAllowed = false;
  const ad = { id: 'private', photoCount: 1, adPhotos: ['data:image/png;base64,PRIVATE'] };
  assert.equal(context.shellAdMedia(ad, false), '');
  ad.metaAdId = 'meta';
  ad.metaThumbnailUrl = 'https://cdn.example.invalid/creative.jpg';
  const html = context.shellAdMedia(ad, false);
  assert(html.includes('creative.jpg'));
  assert(!html.includes('primary-photo'));
  assert(!html.includes('PRIVATE'));
});
check('read-only photo permission reuses protected viewer without edit controls', () => {
  photoAllowed = true;
  const html = context.shellAdMedia({ id: 'private', photoCount: 3, primaryAdPhotoIndex: 2 }, false);
  assert(html.includes('/primary-photo?index=2'));
  assert(html.includes('crossorigin="use-credentials"'));
  assert(html.includes('openAdPhotoViewer'));
  assert(!html.includes('setAdPrimaryPhoto'));
  photoAllowed = false;
});
check('real Meta budget renderer preserves currency and suppresses unknown progress', () => {
  const ad = { id: 'a', metaAdId: 'm', metaCurrency: 'EUR', metaTotalBudgetMinor: 10000, metaSpendMinor: 3000 };
  const html = context.shellAdBudgetPreview(ad, false);
  assert(html.includes('€100.00'));
  assert(html.includes('€30.00'));
  assert(html.includes('€70.00'));
  assert(html.includes('aria-valuenow="30.0"'));
  const unknown = context.shellAdBudgetPreview({ ...ad, metaTotalRemainingBudgetMinor: null }, false);
  assert(!unknown.includes('progressbar'));
});
// Navigation must use the real canonical view gate: subscriptions determine
// creation inside Studio, not whether existing campaigns can be reached.
const auditSource = fs.readFileSync(path.join(root, 'src/08-data-audit.js'), 'utf8');
vm.runInContext(auditSource.slice(
  auditSource.indexOf('const VIEW_PERMISSION_MODULES ='),
  auditSource.indexOf('function getAlbayanManagerLandingViewForUser(')
), context);
context.isCurrentUserAdmin = () => context.state.currentUser?.role === 'Admin';
context.isAdminRole = role => String(role || '').toLowerCase() === 'admin';
context.isDeliveryRole = () => false;
context.currentUserHasPermission = (module, action) => (context.state.currentUser?.permissions?.[module] || []).includes(action);
context.hasSubscription = () => { throw new Error('The More launcher must not reimplement subscription gates'); };
for (const [label, user, expected] of [
  ['reviewer without subscription', { role: 'Employee', permissions: { adCampaignRequests: ['view', 'review'] } }, true],
  ['lapsed customer retaining owned campaigns', { role: 'Customer', permissions: { adCampaignRequests: ['viewOwn'] } }, true],
  ['subscription without view permission', { role: 'Customer', subscriptions: ['ad_maker'], permissions: {} }, false],
  ['administrator', { role: 'Admin', permissions: {} }, true],
]) {
  check(`More Ads Studio matches canonical access for ${label}`, () => {
    context.state.currentUser = user;
    const included = context.shellMoreTiles().some(tile => tile.id === 'ads-studio');
    assert.equal(included, expected);
    assert.equal(included, context.userCanAccessView(user, 'ads-studio'));
  });
}

// Readable text colours and the bundled Arabic font (docs/redesign/DESIGN.md, sections 5 and 6).
const styleCss = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const layoutCss = fs.readFileSync(path.join(root, 'assets/workspace-layout.css'), 'utf8');
const fontsCss = fs.readFileSync(path.join(root, 'assets/fonts.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const tokenBlock = selector => {
  const start = styleCss.indexOf(`\n${selector} {\n  --ui-canvas:`);
  assert(start >= 0, `${selector} token block`);
  return styleCss.slice(start, styleCss.indexOf('\n}', start));
};
const token = (block, name) => {
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`));
  assert(match, `--${name} is a six-digit colour`);
  return match[1];
};
const luminance = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
const TEXT_TOKENS = ['ui-muted', 'ui-success-text', 'ui-danger-text', 'ui-warning-text', 'ui-info-text', 'ui-link-text'];
check('light text colours reach 4.5:1 on the page, cards, soft panels and pale tags', () => {
  const light = tokenBlock(':root');
  const surfaces = [token(light, 'ui-canvas'), token(light, 'ui-surface'), token(light, 'ui-surface-soft'), '#f8fafc', '#f1f5f9'];
  for (const name of TEXT_TOKENS) for (const surface of surfaces) {
    assert(contrast(token(light, name), surface) >= 4.5, `--${name} on ${surface}`);
  }
  for (const [name, pale] of [['ui-success-text', '#ecfdf5'], ['ui-danger-text', '#fff1f2'], ['ui-warning-text', '#fffbeb'], ['ui-link-text', '#eff6ff']]) {
    assert(contrast(token(light, name), pale) >= 4.5, `--${name} on its pale tag ${pale}`);
  }
  assert(contrast('#ffffff', token(light, 'ui-success-solid')) >= 4.5, 'white text on a green button');
});
check('dark text colours reach 4.5:1 on the dark page, cards and soft panels', () => {
  const dark = tokenBlock('html.dark');
  const surfaces = [token(dark, 'ui-canvas'), token(dark, 'ui-surface'), token(dark, 'ui-surface-soft')];
  for (const name of [...TEXT_TOKENS, 'ui-dark-brand-text', 'ui-dark-violet-text', 'ui-dark-cyan-text', 'ui-dark-sky-text', 'ui-dark-orange-text', 'ui-dark-pink-text', 'ui-dark-slate-text']) {
    for (const surface of surfaces) assert(contrast(token(dark, name), surface) >= 4.5, `--${name} on ${surface}`);
  }
});
check('the colour classes use the tokens, after Tailwind and without !important', () => {
  assert(indexHtml.indexOf('assets/tailwind.css') < indexHtml.indexOf('assets/workspace-layout.css'));
  for (const rule of [
    '.text-slate-400, .text-slate-500 { color: var(--ui-muted); }',
    '.text-emerald-500, .text-emerald-600, .text-emerald-700 { color: var(--ui-success-text); }',
    '.text-rose-500, .text-rose-600, .text-rose-700 { color: var(--ui-danger-text); }',
    '.text-amber-600, .text-amber-700 { color: var(--ui-warning-text); }',
    '.bg-emerald-600, .bg-green-600 { background-color: var(--ui-success-solid); }',
  ]) assert(layoutCss.includes(rule), rule);
  // A pale box that stays pale in dark mode hands the light-mode colours to the text inside it.
  const pale = layoutCss.slice(layoutCss.indexOf('html.dark :is(.bg-white,'));
  assert(pale.includes(':not([class*="dark:bg-"])') && pale.includes('--ui-muted: #586780;') && pale.includes('--ui-success-text: #047857;'));
});
check('a label styled as a button keeps its white text inside dialogs', () => {
  assert.equal(styleCss.split('.app-dialog-panel label:not([class*="text-rose"]):not([class*="text-red"]):not([class*="text-white"])').length - 1, 2);
});
check('the Arabic font is bundled with its licence and used after Inter', () => {
  const { arabicFontCss, ARABIC_FONT_FILES } = require('./download-fonts.js');
  assert(fontsCss.endsWith(arabicFontCss()), 'assets/fonts.css ends with the rules scripts/download-fonts.js writes');
  assert.deepEqual(Object.keys(ARABIC_FONT_FILES), ['400', '500', '600', '700']);
  for (const file of fontsCss.match(/url\(fonts\/[^)]+\)/g).map(url => url.slice(10, -1))) {
    assert(fs.existsSync(path.join(root, 'assets/fonts', file)), `assets/fonts/${file}`);
  }
  assert(/SIL OPEN FONT LICENSE Version 1\.1/.test(fs.readFileSync(path.join(root, 'assets/fonts/IBM-Plex-Sans-Arabic-LICENSE.txt'), 'utf8')));
  assert(styleCss.includes("font-family: 'Inter', 'IBM Plex Sans Arabic', sans-serif;"));
  // Arabic script only: an English screen must not fetch an Arabic file for spaces, digits or punctuation.
  const ranges = [...arabicFontCss().matchAll(/unicode-range: ([^;]+);/g)].map(match => match[1]);
  assert.equal(ranges.length, 4);
  assert(ranges.every(range => range === 'U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFC'));
});
check('the shared frame: 264 px sidebar, a 72 px rail from 901 to 1279 px that opens for pointer and keyboard, mirrored without physical offsets', () => {
  const frame = layoutCss.slice(layoutCss.indexOf('The shared frame (redesign M4)'));
  assert(frame.length > 2000, 'the frame block is in assets/workspace-layout.css');
  assert(frame.includes('.app-shell > .app-sidebar { width: 264px; }'));
  assert(frame.includes('.app-shell > .app-sidebar ~ .app-main { margin-left: 0; margin-right: 0; margin-inline-start: 264px; }'));
  const rail = frame.slice(frame.indexOf('@media (min-width: 901px) and (max-width: 1279.98px)'));
  assert(rail.includes('.app-shell > .app-sidebar { width: 72px;') && rail.includes('.app-shell > .app-sidebar ~ .app-main { margin-inline-start: 72px; }'));
  assert(rail.includes('.app-shell > .app-sidebar:focus-within { width: 264px;'), 'the keyboard opens the rail');
  assert(rail.includes('@media (hover: hover)') && rail.includes('.app-shell > .app-sidebar:hover { width: 264px;'), 'so does a pointer that can hover');
  // A closed rail keeps every name for screen readers: clipped, never display:none.
  const closed = rail.slice(rail.indexOf('.app-sidebar:not(:hover):not(:focus-within) :is(.frame-link > span'));
  assert(closed.includes('clip-path: inset(50%)') && !/\.frame-link > span[^}]*display: none/.test(rail));
  // The frame's own rules place nothing with left/right: Arabic mirrors through logical properties.
  const own = frame.slice(0, frame.indexOf('/* Wide screens: theme, language and sign-out'));
  assert(!/[\s;{](left|right|margin-left|margin-right|padding-left|padding-right):\s*\d/.test(own.replace('margin-left: 0; margin-right: 0;', '')), 'a physical offset in the frame block');
  // Phones keep 44 px lines in the drawer and in both menus.
  assert(frame.includes('@media (max-width: 900px) {\n  .app-sidebar .frame-link { min-height: 44px; }\n  .frame-menu-list :is(button, a) { min-height: 44px; }'));
});
check('tablets get centred dialogs with their own width; the top position while a field is in use is kept', () => {
  const tablet = layoutCss.slice(layoutCss.indexOf('@media (min-width: 600px) and (max-width: 900px) and (min-height: 501px)'));
  assert(tablet.includes('.app-dialog-overlay > .app-dialog-panel { margin: auto !important; }'));
  assert(tablet.includes('.app-dialog-overlay > .app-dialog-panel.app-dialog-input-engaged { margin-top: 0 !important; }'));
  for (const [name, width] of [['sm', '24rem'], ['md', '28rem'], ['lg', '32rem'], ['xl', '36rem']]) {
    assert(tablet.includes(`.app-dialog-overlay > .app-dialog-panel.max-w-${name} { max-width: ${width} !important; }`), name);
  }
  // The phone sheet rule this sits on top of is still there, for widths under 600 px.
  assert(styleCss.includes('@media (max-width: 900px) and (min-height: 501px) {\n  .app-dialog-overlay > .app-dialog-panel {\n    margin-top: auto !important;\n    margin-bottom: 0 !important;'));
});
console.log(`${passed} shell presentation checks passed.`);
