// Shared helpers of the Albayan Studio v2 browser journeys (tests/e2e/studio-v2.spec.js; plan task
// P2-13). The e2e server (scripts/start-e2e-server.js) runs with ALBAYAN_STUDIO_V2=pilot: only the
// users a spec adds to the rollout allowlist see the v2 layout. Every spec creates its OWN users
// here (never the shared e2e admin as a pilot) and adds them through the real admin settings API.
// The customer layout is never switched on for everyone, so design-system.spec.js and
// critical-flows.spec.js keep testing the classic studio with the e2e admin.
const zlib = require('zlib');
const { expect } = require('@playwright/test');

const ADMIN_EMAIL = 'e2e.admin@albayan.example.com';
const ADMIN_PASSWORD = 'E2eAdminPassword123!';
const STUDIO_USER_PASSWORD = 'E2eStudioPilotPassword123!';

// The access presets of src/04-permissions.js (PERMISSION_TEMPLATES.adsStudioCustomer / adsStudioReviewer).
const CUSTOMER_PERMISSIONS = { adCampaignRequests: ['viewOwn', 'add', 'editOwn', 'deleteOwn', 'submitOwn', 'stopOwn'] };
const REVIEWER_PERMISSIONS = { adCampaignRequests: ['view', 'review'] };

// The shared contract of the v2 layout (data-testid values).
const CUSTOMER_TABS = ['home', 'campaigns', 'replies', 'wallet', 'help'];
const HEADER_TABS = ['inbox', 'account'];
const STAFF_SECTIONS = ['requests', 'launch', 'settle', 'tickets', 'health', 'more'];
// What ?tab= may say on Home: nothing, or the pinned "dashboard" id (PLAN.md §5.1), or "home".
const HOME_TAB_PARAMS = [null, 'dashboard', 'home'];
const PHONE = { width: 390, height: 844 };
const ARABIC = new RegExp('[\\u0600-\\u06FF]');
const LATIN = /[A-Za-z]/;

function projectToken(testInfo) {
  return testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

async function jsonOrThrow(response, label) {
  const body = await response.text();
  if (!response.ok()) throw new Error(`${label} failed with HTTP ${response.status()}: ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : null;
}

// An API session of the e2e admin ({api, adminId}). Requests carry the site's own Origin, like
// the browser's. Dispose the api when done.
async function openAdminApi(playwright, baseURL) {
  const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } });
  const login = await jsonOrThrow(
    await api.post('/api/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }), 'Admin login');
  const adminId = String((login && login.user && login.user.id) || '');
  expect(adminId, 'the admin login names the admin').toBeTruthy();
  return { api, adminId };
}

// An API session of one studio user (the site's own Origin, like the browser). Dispose it when done.
async function openUserApi(playwright, baseURL, user) {
  const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } });
  try {
    await jsonOrThrow(await api.post('/api/auth/login', { data: { email: user.email, password: user.password } }), `Login of ${user.email}`);
  } catch (error) {
    await api.dispose();
    throw error;
  }
  return api;
}

// A small solid PNG for the builder's photo input (the photo path compresses whatever it gets; the
// server checks the result).
function makePng(width = 48, height = 48, rgb = [37, 99, 235]) {
  const table = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = buffer => {
    let c = -1;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.from([0, ...Array.from({ length: width }, () => rgb).flat()]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// A dedicated studio user (Employee + the studio preset). Customers also get the free ad_maker
// plan (bought by the admin for them), so the classic studio shows its tabs, not the paywall.
async function createStudioUser(api, kind, tag) {
  const customer = kind === 'customer';
  const email = `e2e.studio.${kind}.${tag}@albayan.example.com`;
  const created = await jsonOrThrow(await api.post('/api/users', {
    data: {
      name: `E2E Studio ${kind} ${tag}`.slice(0, 100),
      email,
      password: STUDIO_USER_PASSWORD,
      role: 'Employee',
      permissions: customer ? CUSTOMER_PERMISSIONS : REVIEWER_PERMISSIONS
    }
  }), `Creating the ${kind} ${email}`);
  expect(created.id, `the new ${kind} needs an id`).toBeTruthy();
  if (customer) {
    await jsonOrThrow(await api.post('/api/subscriptions/purchase', {
      data: { serviceId: 'ad_maker', idempotencyKey: `e2e-studio-plan-${tag}`, userId: created.id }
    }), `The ad_maker plan of ${email}`);
  }
  return { id: String(created.id), email, password: STUDIO_USER_PASSWORD, kind };
}

// Read-modify-write of the rollout record through PUT /api/studio/admin/settings/rollout with the
// version that was read (expectedVersion); a 409 (someone saved first) reads again and retries.
async function saveRollout(api, change) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await jsonOrThrow(await api.get('/api/studio/admin/settings/rollout'), 'Reading the rollout setting');
    const value = change(current.value || {});
    if (value.ui === 'on') throw new Error('The e2e suite never switches the v2 layout on for everyone');
    const response = await api.put('/api/studio/admin/settings/rollout', { data: { expectedVersion: current.version, value } });
    if (response.status() === 409) continue;
    return jsonOrThrow(response, 'Saving the rollout setting');
  }
  throw new Error('The rollout setting kept changing while this spec saved it (409 four times)');
}

function withIds(list, ids) {
  return Array.from(new Set([...(Array.isArray(list) ? list : []), ...ids]));
}

// Customers join the v2 layout pilot (ui 'pilot' + uiAllowlist); staff join the Team desk pilot
// (staffDesk 'pilot' + staffAllowlist). Nobody else changes: the e2e admin stays classic.
async function addToPilot({ api, adminId }, { customers = [], staff = [] }) {
  const saved = await saveRollout(api, current => {
    const value = {};
    if (customers.length) Object.assign(value, { ui: 'pilot', uiAllowlist: withIds(current.uiAllowlist, customers) });
    if (staff.length) Object.assign(value, { staffDesk: 'pilot', staffAllowlist: withIds(current.staffAllowlist, staff) });
    return value;
  });
  expect(saved.value.ui, 'the v2 layout stays a pilot').toBe('pilot');
  expect(saved.envSwitch, 'start-e2e-server.js runs with ALBAYAN_STUDIO_V2=pilot').toBe('pilot');
  for (const id of customers) expect(saved.value.uiAllowlist).toContain(id);
  for (const id of staff) expect(saved.value.staffAllowlist).toContain(id);
  expect(saved.value.uiAllowlist, 'the shared e2e admin never joins the pilot').not.toContain(adminId);
  expect(saved.value.staffAllowlist, 'the shared e2e admin never joins the pilot').not.toContain(adminId);
  return saved;
}

// Sign in on the studio front door (/studio) with the login form.
async function signInStudio(page, user, path = '/studio') {
  await page.goto(path);
  const chooser = page.getByRole('button', { name: 'Use another account', exact: true });
  if (await chooser.isVisible().catch(() => false)) await chooser.click();
  await expect(page.locator('#login-form')).toBeVisible();
  await page.locator('#login-email').fill(user.email);
  await page.locator('#login-password').fill(user.password);
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/auth/login') && r.request().method() === 'POST'),
    page.locator('#login-form button[type="submit"]').click()
  ]);
  expect(response.ok(), `Studio login for ${user.email} failed with HTTP ${response.status()}`).toBe(true);
  await page.waitForFunction(id => typeof state !== 'undefined' && String(state.currentUser?.id || '') === id, user.id);
}

// What the server says this user gets (GET /api/studio/me through the app's own apiJson).
function studioMe(page) {
  return page.evaluate(() => apiJson('/api/studio/me', { method: 'GET' }));
}

async function setLanguage(page, language) {
  await page.evaluate(lang => { if (state.language !== lang) toggleLanguage(); }, language);
  await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
}

function tabParam(page) {
  return new URL(page.url()).searchParams.get('tab');
}

// A customer tab is open: its screen root is shown, and a bottom-nav tab is the only current one.
// Right after a page load the frame waits for the app's boot and /api/studio/me: pass a longer
// frameTimeout there.
async function expectCustomerTab(page, tab, { frameTimeout } = {}) {
  await expect(page.getByTestId('studio-v2-frame')).toBeVisible(frameTimeout ? { timeout: frameTimeout } : undefined);
  await expect(page.getByTestId(`studio-screen-${tab}`)).toBeVisible();
  if (tab === 'home') {
    await expect.poll(() => HOME_TAB_PARAMS.includes(tabParam(page)),
      { message: 'Home keeps ?tab= empty, dashboard or home' }).toBe(true);
  } else {
    await expect.poll(() => tabParam(page)).toBe(tab);
  }
  for (const other of CUSTOMER_TABS) {
    const button = page.getByTestId(`studio-nav-${other}`);
    if (other === tab) await expect(button).toHaveAttribute('aria-current', 'page');
    else await expect(button).not.toHaveAttribute('aria-current', 'page');
  }
}

async function expectNoPageOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow, `${label} overflows the page sideways`).toBeLessThanOrEqual(1);
}

// Browser messages every page of the app gets today, outside the studio's control:
// * index.html's <meta> security headers (the server sends the real ones as HTTP headers);
// * the sign-in data load asks for every collection and the user list; the server answers 401/403
//   for the ones this user may not read (a studio customer reads almost none of them), and the
//   browser logs each refused request as a console error.
const PLATFORM_NOISE = [
  { text: /X-Frame-Option.*\bmeta\b/i },
  { text: /frame-ancestors'? is ignored when delivered via an? (HTML )?<?meta>? element/i },
  { text: /Failed to load resource: the server responded with a status of 40[13]\b/i,
    url: /\/api\/(collections\/[A-Za-z]+|users|auth\/me)(\?|$)/ }
];

// Page errors and console errors of one page, minus PLATFORM_NOISE. A failed studio request, a
// server error or any error the app logs itself still counts.
function collectPageErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const url = (message.location() && message.location().url) || '';
    if (PLATFORM_NOISE.some(noise => noise.text.test(text) && (!noise.url || noise.url.test(url)))) return;
    errors.push(`console: ${text}${url ? ` (${url})` : ''}`);
  });
  return errors;
}

module.exports = {
  ARABIC,
  CUSTOMER_TABS,
  HEADER_TABS,
  LATIN,
  PHONE,
  STAFF_SECTIONS,
  addToPilot,
  collectPageErrors,
  createStudioUser,
  expectCustomerTab,
  expectNoPageOverflow,
  makePng,
  openAdminApi,
  openUserApi,
  projectToken,
  setLanguage,
  signInStudio,
  studioMe,
  tabParam
};
