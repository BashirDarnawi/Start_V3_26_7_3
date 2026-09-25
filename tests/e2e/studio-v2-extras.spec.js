const { test, expect } = require('@playwright/test');
const {
  PHONE,
  addToPilot,
  collectPageErrors,
  createStudioUser,
  expectCustomerTab,
  expectNoPageOverflow,
  openAdminApi,
  projectToken,
  setLanguage,
  signInStudio
} = require('./helpers/studio-v2');

// Albayan Studio extras (src/systems/ads_studio/15r-studio-extras.js) with real server data:
// - P5-02 the TikTok service request (a service done by hand, never a connection): the customer's form
//   and list with the server's state words, the team's step and note reaching the customer, the desk rows;
// - P3-05 (client) the bell's badge follows a decision within a minute through the pulse hook, and the
//   inbox item opens the ad;
// - P3-04b the results card shows Meta's numbers only once the campaign is linked;
// - P2-09 the login help line on the studio front door shows the public contact without a login.
// Each test seeds its OWN customer (pilot of the v2 layout) and, where the team acts, its own reviewer.
// The services follow the customer allowlist ('pilot') and are put back to 'off' afterwards; the
// customer layout stays a pilot (never "on" for everyone).
//
// The full matrix runs on mobile-chromium at 390 px; the other projects run one smoke journey.
//   npx playwright test tests/e2e/studio-v2-extras.spec.js --project=mobile-chromium

const FULL_MATRIX_PROJECT = 'mobile-chromium';
const BOOT_TIMEOUT = 20_000;
const PULSE_TIMEOUT = 75_000;  // the bell polls every 30 s (STUDIO_INBOX_PULSE_MS) plus the inbox read
const WIDTHS = [320, 390, 820];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC';
// PLAN.md §8.4 / server/test_studio_tiktok.py: a TikTok screen never says the account is connected, linked, managed or automated.
const FORBIDDEN_EN = /\b(connected|linked|managed|manages|automated)\b/i;
const FORBIDDEN_AR = /(متصل|مربوط|يدير|مؤتمت)/;
const TICKET_ID = /^tkt_[0-9a-f]{40}$/;

function fullMatrixOnly(testInfo) {
  test.skip(testInfo.project.name !== FULL_MATRIX_PROJECT, 'The full extras matrix runs on mobile-chromium (P2-13)');
}

async function jsonOrThrow(response, label) {
  const body = await response.text();
  if (!response.ok()) throw new Error(`${label} failed with HTTP ${response.status()}: ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : null;
}

function libyaDay(offsetDays) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + offsetDays * 86400000));
}

function completeRequest(name) {
  return {
    name, objective: 'messages', platforms: ['facebook', 'instagram'], pageName: 'E2E Studio Page',
    primaryText: "Message us for this week's offer.", headline: 'Weekly offer', description: 'An extras journey request.',
    callToAction: 'Send Message', destination: 'https://wa.me/218910000000', locations: ['Tripoli, Libya'],
    ageMin: 18, ageMax: 55, genders: ['all'], languages: ['Arabic'], interests: ['Shopping'],
    startDate: libyaDay(30), endDate: libyaDay(36), durationDays: 7, budgetMinorUSD: 2500, budgetType: 'lifetime',
    notes: '', specialAdCategories: ['none'], creativeImages: [PNG], creativeAssetIds: []
  };
}

// Only the services entries change (the server merges them); the layout switches stay as they are.
async function setServices(api, services) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await jsonOrThrow(await api.get('/api/studio/admin/settings/rollout'), 'Reading the rollout setting');
    const response = await api.put('/api/studio/admin/settings/rollout', { data: { expectedVersion: current.version, value: { services } } });
    if (response.status() === 409) continue;
    const saved = await jsonOrThrow(response, 'Saving the services');
    expect(saved.value.ui, 'the v2 layout stays a pilot').not.toBe('on');
    return saved;
  }
  throw new Error('The rollout setting kept changing while this spec saved it (409 four times)');
}

// Read-modify-write of one setting (the contact here); a 409 reads again and retries.
async function putSetting(api, key, change) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await jsonOrThrow(await api.get(`/api/studio/admin/settings/${key}`), `Reading the ${key} setting`);
    const response = await api.put(`/api/studio/admin/settings/${key}`, { data: { expectedVersion: current.version, value: change(current.value || {}) } });
    if (response.status() === 409) continue;
    return jsonOrThrow(response, `Saving the ${key} setting`);
  }
  throw new Error(`The ${key} setting kept changing while this spec saved it (409 four times)`);
}

// An API session of one studio user (the browser's own Origin, like the site itself).
async function openUserApi(playwright, baseURL, user) {
  const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } });
  await jsonOrThrow(await api.post('/api/auth/login', { data: { email: user.email, password: user.password } }), `Login of ${user.email}`);
  return api;
}

// One customer in the v2 pilot with $100.00 (and, when asked, a submitted or approved request), plus a
// reviewer whose Team desk stays classic. services: what this journey needs on ('pilot' = the customer
// allowlist).
async function seed(playwright, baseURL, testInfo, label, { services = {}, request = '' } = {}) {
  const admin = await openAdminApi(playwright, baseURL);
  const customerApi = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } });
  try {
    const tag = `${label}-${projectToken(testInfo)}-${Date.now()}`;
    const user = await createStudioUser(admin.api, 'customer', tag);
    const reviewer = await createStudioUser(admin.api, 'reviewer', tag);
    await addToPilot(admin, { customers: [user.id] });
    if (Object.keys(services).length) await setServices(admin.api, services);
    await jsonOrThrow(await admin.api.post('/api/wallet/top-ups', {
      data: { userId: user.id, amountMinor: 10000, currency: 'USD', idempotencyKey: `e2e-extras-topup-${tag}`, memo: 'E2E extras journeys' }
    }), 'The USD top-up');
    let requestId = '';
    let submitted = null;
    if (request) {
      await jsonOrThrow(await customerApi.post('/api/auth/login', { data: { email: user.email, password: user.password } }), 'Customer login');
      requestId = `e2e_extras_${label}_${tag}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80);
      const created = await jsonOrThrow(await customerApi.post('/api/collections/adCampaignRequests', { data: { id: requestId, data: completeRequest(`E2E ${label} request`) } }), 'Creating the request');
      submitted = await jsonOrThrow(await customerApi.post(`/api/ad-studio/campaigns/${requestId}/submit`, {
        data: { expectedLastModified: created.lastModified, operationId: `e2e-extras-submit-${tag}` }
      }), 'Submitting the request');
      if (request === 'approved') {
        await jsonOrThrow(await admin.api.post(`/api/ad-studio/campaigns/${requestId}/review`, {
          data: { expectedLastModified: submitted.lastModified, decision: 'Approved', note: '', operationId: `e2e-extras-review-${tag}` }
        }), 'Approving the request');
      }
    }
    return { user, reviewer, requestId, submitted, tag };
  } finally {
    await customerApi.dispose();
    await admin.api.dispose();
  }
}

// The TikTok section lives in Help at ?tab=help&section=tiktok, drawn by 15n's own hook
// (renderStudioHelpBody -> renderStudioTikTokSection, stage 15). The Help list's row and Home's
// "TikTok help" goal (shown only while /me says the service is on) lead there; the goal is the way in.
async function openTikTok(page) {
  await expectCustomerTab(page, 'home');
  await expect(page.getByTestId('studio-goal-tiktok')).toBeVisible();
  await page.getByTestId('studio-goal-tiktok').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBe('tiktok');
  await expect(page.getByTestId('studio-tiktok')).toBeVisible();
  await expect(page.getByTestId('studio-help')).toHaveCount(0);  // the section stands alone, not inside the ticket list
}

async function expectNoForbiddenWords(page, label) {
  const text = await page.getByTestId('studio-tiktok').innerText();
  expect(text, `${label}: no connection words`).not.toMatch(FORBIDDEN_EN);
  expect(text, `${label}: no Arabic connection words`).not.toMatch(FORBIDDEN_AR);
}

test.describe('Albayan Studio extras: TikTok service, inbox badge, results card, login help', () => {
  test.beforeEach(() => {
    test.setTimeout(240_000);
  });

  // The other studio specs expect the services off: every test here leaves them as it found them.
  test.afterEach(async ({ playwright, baseURL }) => {
    const admin = await openAdminApi(playwright, baseURL);
    try {
      await setServices(admin.api, { help: 'off', stopRequest: 'off', tiktok: 'off' });
    } finally {
      await admin.api.dispose();
    }
  });

  test('P5-02 TikTok: the customer sends a service request, sees the server\'s state words, the team\'s step and note reach them; the desk rows draw the same request; never a connection word; Arabic; fits 320-820 px', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const seeded = await seed(playwright, baseURL, testInfo, 'tiktok', { services: { help: 'pilot', tiktok: 'pilot' } });
    const errors = collectPageErrors(page);
    let nativeDialogs = 0;
    page.on('dialog', dialog => { nativeDialogs += 1; dialog.dismiss().catch(() => {}); });
    await page.setViewportSize(PHONE);
    await signInStudio(page, seeded.user);
    await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });

    // The section: the service words, "what you get today", the form, no requests yet.
    await openTikTok(page);
    await expect(page.getByTestId('studio-tiktok')).toHaveAttribute('data-open', '1');
    await expect(page.getByTestId('studio-tiktok-service')).toContainText('hands-on help from the Albayan team');
    await expect(page.getByTestId('studio-tiktok-notice')).toContainText('by hand');
    await expect(page.getByTestId('studio-tiktok-today')).toContainText('TikTok runs them, not Albayan');
    await expect(page.getByTestId('studio-tiktok-empty')).toBeVisible();
    await expectNoForbiddenWords(page, 'empty section');
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await expectNoPageOverflow(page, `TikTok section at ${width}px`);
    }
    await page.setViewportSize(PHONE);

    // An empty form explains and sends nothing; a bad handle is refused on the screen.
    await page.locator('#studio-tiktok-handle').fill('bad handle!');
    await page.getByTestId('studio-tiktok-send').click();
    await expect(page.getByTestId('studio-tiktok-problem-handle')).toBeVisible();

    // The request: handle as a profile link, both kinds of help, a note.
    await page.locator('#studio-tiktok-handle').fill(`https://www.tiktok.com/@e2e_shop_${seeded.tag.slice(-6).replace(/[^a-z0-9]/gi, '')}`);
    const handle = `e2e_shop_${seeded.tag.slice(-6).replace(/[^a-z0-9]/gi, '')}`;
    await page.locator('#studio-tiktok-want-advice').check();
    await page.locator('#studio-tiktok-note').fill('Please call after 5 pm.');
    const [posted] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/studio/tiktok/requests') && r.request().method() === 'POST'),
      page.getByTestId('studio-tiktok-send').click()
    ]);
    expect(posted.ok(), `POST /tiktok/requests answered ${posted.status()}`).toBe(true);
    const created = await posted.json();
    const ticketId = String(created.request.id);
    expect(ticketId).toMatch(TICKET_ID);
    expect(created.request.tiktok.handle).toBe(handle);
    expect(created.request.tiktok.wants).toEqual(['auto_replies_help', 'advice']);
    await expect(page.getByTestId('studio-tiktok-sent')).toBeVisible();
    const item = page.getByTestId(`studio-tiktok-item-${ticketId}`);
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-state', 'open');
    await expect(item.getByTestId('studio-tiktok-state')).toContainText('Received: the team contacts you within one business day');
    await expect(item.locator('.studio-tiktok-handle')).toHaveAttribute('href', `https://www.tiktok.com/@${handle}`);
    await expect(item).toContainText('Advice on answering comments by hand');
    await expectNoForbiddenWords(page, 'after sending');

    // Arabic: the same section, right to left, the server's Arabic state words.
    await setLanguage(page, 'ar');
    await expect(page.getByTestId('studio-v2-frame')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('studio-tiktok-service')).toContainText('مساعدة يدوية من فريق البيان');
    await expect(item.getByTestId('studio-tiktok-state')).toContainText('وصل الطلب');
    await expectNoForbiddenWords(page, 'Arabic');
    await expectNoPageOverflow(page, 'TikTok section (AR)');
    await setLanguage(page, 'en');

    // The Help list (15n hooks, stage 15): the guides card (studio-pages.js, fetched for it) and the TikTok row after the contact card.
    await page.getByTestId('studio-nav-help').click();
    await expectCustomerTab(page, 'help');
    await expect(page.getByTestId('studio-guides')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-tiktok-entry')).toBeVisible();
    expect(await page.evaluate(() => {
      const contact = document.querySelector('[data-testid="studio-help-contact"]');
      const guides = document.querySelector('[data-testid="studio-guides"]');
      const entry = document.querySelector('[data-testid="studio-tiktok-entry"]');
      return !!contact && !!guides && !!entry && !!(contact.compareDocumentPosition(guides) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(guides.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), 'contact card, then the guides, then the TikTok row').toBe(true);
    await page.getByTestId('studio-tiktok-entry').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBe('tiktok');
    await expect(page.getByTestId('studio-tiktok')).toBeVisible();

    // The team: the request is in the staff list; the desk rows draw it (the same function studio-staff.js
    // calls) with the server's words; a step with a bilingual note moves it on.
    const reviewerApi = await openUserApi(playwright, baseURL, seeded.reviewer);
    try {
      const staffList = await jsonOrThrow(await reviewerApi.get('/api/studio/staff/tiktok?state=active'), 'The staff TikTok list');
      const mine = staffList.requests.find(row => row.id === ticketId);
      expect(mine, 'the reviewer sees the request').toBeTruthy();
      expect(mine.tiktok.handle).toBe(handle);
      const deskRows = await page.evaluate(items => renderStudioTikTokDeskRows(items, { open: 'studioStaffOpen' }), staffList.requests);
      expect(deskRows).toContain(`data-testid="studio-tiktok-desk-${ticketId}"`);
      expect(deskRows).toContain(`data-testid="studio-tiktok-desk-start-${ticketId}"`);
      expect(deskRows).toContain(`onclick="studioStaffOpen('${ticketId}')"`);
      expect(deskRows).toContain('Received: the team contacts you within one business day');
      expect(deskRows.replace(/<[^>]+>/g, ' ')).not.toMatch(FORBIDDEN_EN);
      const stepped = await jsonOrThrow(await reviewerApi.post(`/api/studio/staff/tiktok/${ticketId}/status`, {
        data: { status: 'in_progress', note: { en: 'We called you and set it up together.', ar: 'اتصلنا بك وأعددناها معاً.' }, operationId: `e2e-extras-tiktok-step-${seeded.tag}` }
      }), 'The team step');
      expect(stepped.request.tiktok.state).toBe('in_progress');
    } finally {
      await reviewerApi.dispose();
    }

    // The customer: Refresh shows the new state and the team's note; "Open the ticket" shows the thread.
    await page.getByTestId('studio-tiktok-refresh').click();
    await expect(item).toHaveAttribute('data-state', 'in_progress');
    await expect(item.getByTestId('studio-tiktok-state')).toContainText('In progress with the Albayan team');
    await expect(item.getByTestId(`studio-tiktok-note-${ticketId}`)).toContainText('We called you and set it up together.');
    await expectNoForbiddenWords(page, 'in progress');
    await page.getByTestId(`studio-tiktok-open-${ticketId}`).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(ticketId);
    await expect(page.getByTestId('studio-ticket-thread')).toBeVisible();
    await expect(page.getByTestId('studio-ticket-thread')).toContainText('We called you and set it up together.');
    expect(nativeDialogs).toBe(0);
    expect(errors).toEqual([]);
  });

  test('P3-05 inbox badge: an approval reaches the bell within a minute through the pulse, the item opens the ad, "Mark all seen" clears it', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const seeded = await seed(playwright, baseURL, testInfo, 'inbox', { request: 'submitted' });
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await signInStudio(page, seeded.user);
    await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-inbox-badge')).toHaveCount(0);

    // The team approves while the studio stays open: no tap, no reload.
    const admin = await openAdminApi(playwright, baseURL);
    try {
      await jsonOrThrow(await admin.api.post(`/api/ad-studio/campaigns/${seeded.requestId}/review`, {
        data: { expectedLastModified: seeded.submitted.lastModified, decision: 'Approved', note: '', operationId: `e2e-extras-inbox-review-${seeded.tag}` }
      }), 'Approving the request');
    } finally {
      await admin.api.dispose();
    }
    await expect(page.getByTestId('studio-inbox-badge')).toBeVisible({ timeout: PULSE_TIMEOUT });
    await expect(page.getByTestId('studio-inbox-badge')).toHaveText('1');

    // The bell: the item in the reader's language; tapping it opens the ad; Mark all seen clears the badge.
    await page.getByTestId('studio-nav-inbox').click();
    await expectCustomerTab(page, 'inbox');
    const item = page.locator(`[data-testid^="studio-inbox-item-"][data-kind="request_approved"]`).first();
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-unread', '1');
    await expect(item).toContainText('Your ad was approved');
    await page.getByTestId('studio-inbox-seen').click();
    await expect(page.getByTestId('studio-inbox-unread')).toHaveAttribute('data-count', '0');
    await expect(page.getByTestId('studio-inbox-badge')).toHaveCount(0);
    await item.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(seeded.requestId);
    await expect(page.getByTestId('studio-ad-detail')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('P3-04b results card and P2-09 login help: nothing before a link, Meta\'s numbers after one; the front door shows the public contact without a login', async ({ page, playwright, baseURL }, testInfo) => {
    const smoke = testInfo.project.name !== FULL_MATRIX_PROJECT;
    const seeded = await seed(playwright, baseURL, testInfo, 'results', { request: 'approved' });
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);

    // The login help line: the admin's public contact, read by the front door before any login.
    const admin = await openAdminApi(playwright, baseURL);
    let previousContact = null;
    try {
      previousContact = (await jsonOrThrow(await admin.api.get('/api/studio/admin/settings/contact'), 'Reading the contact')).value;
      await putSetting(admin.api, 'contact', () => ({ whatsapp: '+218912345678', phone: '+218213333333', email: 'help@albayan.example.com', urgentWhatsapp: '+218911111111' }));
      const publicContact = await jsonOrThrow(await page.request.get('/api/studio/public/contact'), 'The public contact');
      expect(publicContact).toEqual({ whatsapp: '+218912345678', phone: '+218213333333', email: 'help@albayan.example.com' });
      await page.evaluate(() => { try { localStorage.removeItem('albayan.studio.public.contact'); } catch (_) {} }).catch(() => {});
      await page.goto('/studio');
      const chooser = page.getByRole('button', { name: 'Use another account', exact: true });
      if (await chooser.isVisible().catch(() => false)) await chooser.click();
      await expect(page.locator('#login-form')).toBeVisible();
      const help = page.getByTestId('studio-login-help');
      await expect(help).toBeVisible({ timeout: BOOT_TIMEOUT });
      await expect(help).toHaveAttribute('data-contact', '1', { timeout: BOOT_TIMEOUT });
      await expect(help).toContainText('New customer or forgot your password?');
      await expect(page.getByTestId('studio-login-whatsapp')).toHaveAttribute('href', 'https://wa.me/218912345678');
      await expect(page.getByTestId('studio-login-phone')).toHaveAttribute('href', 'tel:+218213333333');
      expect(await help.innerText()).not.toContain('+218911111111');
      await expect(page.getByTestId('studio-login-terms')).toHaveAttribute('href', '/privacy#terms');  // P5-07: the customer terms on the login help line
      await expect(page.getByTestId('studio-login-terms')).toHaveText('Customer terms');
      await expectNoPageOverflow(page, 'login with the help line');
    } finally {
      try {
        if (previousContact) await putSetting(admin.api, 'contact', () => previousContact);
      } finally {
        await admin.api.dispose();
      }
    }
    if (smoke) { expect(errors).toEqual([]); return; }

    // The results card: an approved request without a link shows no card at all.
    await signInStudio(page, seeded.user);
    await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });
    // The sign-in data load brings the requests a moment after the frame: the detail needs its row.
    await expect.poll(() => page.evaluate(id => typeof studioDataRequest === 'function' && !!studioDataRequest(id), seeded.requestId), { timeout: BOOT_TIMEOUT }).toBe(true);
    await page.evaluate(id => studioV2Go({ tab: 'campaigns', id }), seeded.requestId);
    await expect(page.getByTestId('studio-ad-detail')).toBeVisible();
    // The detail draws the results through renderStudioResultsCard (15k hook, stage 15): no card before a link.
    await expect(page.getByTestId('studio-results-card')).toHaveCount(0);
    await expect(page.getByTestId('studio-ad-results')).toHaveCount(0);
    expect(await page.evaluate(id => renderStudioResultsCard(id), seeded.requestId)).toBe('');

    // Linked and checked (the seed door writes what the results sync would): Meta used $Y of $X, the counts.
    const now = new Date().toISOString();
    const admin2 = await openAdminApi(playwright, baseURL);
    try {
      await jsonOrThrow(await admin2.api.post('/api/studio/test/seed-results', { data: {
        campaignId: seeded.requestId,
        link: { metaAdAccountId: '9876543210', metaCampaignId: `13${String(Date.now()).slice(-10)}` },
        results: { lastSyncedAt: now, spendMinorUSD: 340, spendConfirmedAt: now, currency: 'USD', insightsState: 'ok', syncState: 'ok',
          lifetimeImpressions: 1234, reach: 800, clicks: 20, resultType: 'link_click', resultCount: 20,
          campaignEffectiveStatus: 'ACTIVE', adStatusCounts: { ACTIVE: 1 }, anyAdDelivering: true }
      } }), 'Seeding Meta results');
    } finally {
      await admin2.api.dispose();
    }
    await page.reload();
    await expect(page.getByTestId('studio-ad-detail')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-results-card')).toHaveAttribute('data-state', 'ready', { timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-results-used')).toHaveText('Meta used $3.40 of $25.00', { timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-ad-guides')).toBeVisible();  // the guide links under the tracker (15k hook)
    await page.getByTestId('studio-guide-link-stages').click();
    await expect(page.getByTestId('studio-guide-sheet')).toHaveAttribute('data-guide', 'stages');
    await page.getByTestId('studio-guide-close').click();
    await expect(page.getByTestId('studio-guide-sheet')).toHaveCount(0);
    await expect.poll(async () => page.evaluate(id => renderStudioResultsCard(id), seeded.requestId), { timeout: BOOT_TIMEOUT }).toContain('data-state="ready"');
    const card = await page.evaluate(id => renderStudioResultsCard(id), seeded.requestId);
    expect(card).toContain('data-testid="studio-results-used">Meta used $3.40 of $25.00<');
    expect(card).toContain('data-testid="studio-results-stat-impressions"');
    expect(card).toContain('<dd>1,234</dd>');
    expect(card).toContain('<dd>800</dd>');
    expect(card).toMatch(/data-testid="studio-results-checked">checked (just now|\d+ min ago)</);
    await setLanguage(page, 'ar');
    const cardAr = await page.evaluate(id => renderStudioResultsCard(id), seeded.requestId);
    expect(cardAr).toContain('استخدمت ميتا $3.40 من $25.00');
    expect(cardAr).toContain('نتائج ميتا');
    expect(errors).toEqual([]);
  });
});
