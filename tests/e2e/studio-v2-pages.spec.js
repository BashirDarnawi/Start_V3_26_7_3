const { test, expect } = require('@playwright/test');
const {
  ARABIC,
  PHONE,
  addToPilot,
  collectPageErrors,
  createStudioUser,
  expectCustomerTab,
  openAdminApi,
  projectToken,
  setLanguage,
  signInStudio,
  tabParam
} = require('./helpers/studio-v2');

// Albayan Studio v2 "Pages & replies" (P4-06), the page-link request (P4-07) and the help guides
// (P5-03) with real server data: each test seeds its OWN pilot customer and links two pages for it
// through the admin route (a Facebook page and an Instagram account; no Meta token runs here, so
// the pages are "Working" until a check says otherwise). The Help service ('pilot') is switched on
// for the link request and put back afterwards. The customer layout stays a pilot.
//
// The full journey runs on mobile-chromium at 390 px; the other projects run the smoke.
//   npx playwright test tests/e2e/studio-v2-pages.spec.js --project=mobile-chromium

const FULL_MATRIX_PROJECT = 'mobile-chromium';
const BOOT_TIMEOUT = 20_000;
const WIDTHS = [320, 360, 390, 412, 820];
const TICKET_NUMBER = /^T-\d{6,}$/;

function fullMatrixOnly(testInfo) {
  test.skip(testInfo.project.name !== FULL_MATRIX_PROJECT, 'The full Pages & replies journey runs on mobile-chromium (P2-13)');
}

async function jsonOrThrow(response, label) {
  const body = await response.text();
  if (!response.ok()) throw new Error(`${label} failed with HTTP ${response.status()}: ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : null;
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

async function openUserApi(playwright, baseURL, user) {
  const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } });
  await jsonOrThrow(await api.post('/api/auth/login', { data: { email: user.email, password: user.password } }), `Login of ${user.email}`);
  return api;
}

// One pilot customer with a linked Facebook page and a linked Instagram account (admin link route,
// numeric Meta ids unique to this run), the Help service on as a pilot.
async function seed(playwright, baseURL, testInfo, label) {
  const admin = await openAdminApi(playwright, baseURL);
  try {
    const tag = `${label}-${projectToken(testInfo)}-${Date.now()}`;
    const user = await createStudioUser(admin.api, 'customer', tag);
    await addToPilot(admin, { customers: [user.id] });
    await setServices(admin.api, { help: 'pilot', stopRequest: 'pilot' });
    const stamp = String(Date.now()).slice(-9);
    const fb = await jsonOrThrow(await admin.api.post('/api/social-studio/pages/link', {
      data: { ownerId: user.id, metaPageId: `1${stamp}`, platform: 'fb', name: `E2E Shop ${tag}`.slice(0, 120) }
    }), 'Linking the Facebook page');
    const ig = await jsonOrThrow(await admin.api.post('/api/social-studio/pages/link', {
      data: { ownerId: user.id, metaPageId: `2${stamp}`, platform: 'ig', igUserId: `3${stamp}`, name: `e2e.shop.${stamp}` }
    }), 'Linking the Instagram account');
    return { user, tag, fbPageId: String(fb.id), igPageId: String(ig.id), fbName: fb.name, adminId: admin.adminId };
  } finally {
    await admin.api.dispose();
  }
}

// No sideways scroll, nothing outside the screen, 44 px touch targets, at every phone and tablet width.
async function expectFits(page, label) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.evaluate(() => {
      const root = '[data-testid="studio-v2-frame"]';
      const inside = element => { const box = element.getBoundingClientRect(); return box.width === 0 || (box.left >= -1 && box.right <= innerWidth + 1); };
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        outside: [...document.querySelectorAll(`${root} button, ${root} h1, ${root} h2, ${root} p, ${root} dd, ${root} li`)]
          .filter(element => !inside(element)).map(element => element.textContent.trim().slice(0, 40)),
        small: [...document.querySelectorAll(`${root} .studio-pg button`)].filter(element => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && (box.width < 43.5 || box.height < 43.5);
        }).map(element => element.getAttribute('data-testid') || element.textContent.trim().slice(0, 30))
      };
    });
    expect(layout.overflow, `${label} overflows at ${width}px`).toBeLessThanOrEqual(1);
    expect(layout.outside, `${label} at ${width}px`).toEqual([]);
    expect(layout.small, `${label} touch targets at ${width}px`).toEqual([]);
  }
  await page.setViewportSize(PHONE);
}

test.describe('Albayan Studio v2 Pages & replies', () => {
  test.beforeEach(() => {
    test.setTimeout(180_000);
  });

  // The other studio specs expect the services off: every test here leaves them as it found them.
  test.afterEach(async ({ playwright, baseURL }) => {
    const admin = await openAdminApi(playwright, baseURL);
    try {
      await setServices(admin.api, { help: 'off', stopRequest: 'off' });
    } finally {
      await admin.api.dispose();
    }
  });

  test('v2: linked pages with their health, the page-link request with the Instagram answers reaches the desk, a rule with keywords on the linked page, the log and posts, a guide; Arabic; fits 320-820 px', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const seeded = await seed(playwright, baseURL, testInfo, 'pages');
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await signInStudio(page, seeded.user);
    await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });

    // Pages: both linked pages, "Working" from the server, checked X ago, no Check now for a customer, the guides.
    await page.getByTestId('studio-nav-replies').click();
    await expectCustomerTab(page, 'replies');
    const pages = page.getByTestId('studio-pg-pages');
    await expect(pages).toBeVisible();
    const fbCard = page.getByTestId(`studio-pg-page-${seeded.fbPageId}`);
    const igCard = page.getByTestId(`studio-pg-page-${seeded.igPageId}`);
    await expect(fbCard).toHaveAttribute('data-state', 'ok');
    await expect(igCard).toHaveAttribute('data-state', 'ok');
    await expect(fbCard.getByTestId('studio-pg-health')).toHaveText(/Working/);
    await expect(fbCard).toContainText(seeded.fbName);
    await expect(fbCard.getByTestId('studio-pg-checked')).toBeVisible();
    await expect(page.locator('[data-testid^="studio-pg-check-"]')).toHaveCount(0);
    await expect(page.getByTestId('studio-guide-link-share-page')).toBeVisible();
    await expect(page.getByTestId(`studio-ask-page-${seeded.fbPageId}`)).toBeVisible();
    await expectFits(page, 'Pages');

    // A guide opens in a sheet with the Meta menu names and closes (Escape, then the button).
    await page.getByTestId('studio-guide-link-share-page').click();
    const guide = page.getByTestId('studio-guide-sheet');
    await expect(guide).toHaveAttribute('data-guide', 'share-page');
    await expect(guide).toContainText('Assign partners');
    await page.keyboard.press('Escape');
    await expect(guide).toHaveCount(0);
    await page.getByTestId('studio-guide-link-instagram').click();
    await expect(page.getByTestId('studio-guide-sheet')).toContainText('Switch to professional account');
    await page.getByTestId('studio-guide-close').click();
    await expect(page.getByTestId('studio-guide-sheet')).toHaveCount(0);

    // Ask us to link a page: Instagram, the three answers, the guide before Send; one ticket with every answer.
    await page.getByTestId('studio-pg-link-request').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe('link');
    const form = page.getByTestId('studio-pg-link-form');
    await expect(form).toBeVisible();
    await page.getByTestId('studio-pg-link-send').click();  // nothing filled: the form explains, nothing is sent
    await expect(page.getByTestId('studio-pg-link-problem-platform')).toBeVisible();
    await page.getByTestId('studio-pg-link-platform-ig').click();
    await expect(page.getByTestId('studio-pg-link-professional-yes')).toBeVisible();
    await expect(page.getByTestId('studio-guide-inline-share-page')).toContainText('Business settings');
    await page.locator('#studio-pg-link-name').fill('E2E new shop');
    await page.locator('#studio-pg-link-url').fill('https://instagram.com/e2e.new.shop');
    await page.getByTestId('studio-pg-link-professional-yes').click();
    await page.getByTestId('studio-pg-link-linked-unsure').click();
    await page.getByTestId('studio-pg-link-isPublic-no').click();
    await expect(form).toContainText('Comments reach Albayan only from a public account');
    await page.locator('#studio-pg-link-shared').check();
    await expectFits(page, 'Link request');
    await page.getByTestId('studio-pg-link-send').click();
    const done = page.getByTestId('studio-pg-link-done');
    await expect(done).toBeVisible();
    const number = (await page.getByTestId('studio-pg-link-number').innerText()).trim();
    expect(number).toMatch(TICKET_NUMBER);
    const customerApi = await openUserApi(playwright, baseURL, seeded.user);
    try {
      const list = await jsonOrThrow(await customerApi.get('/api/studio/tickets?status=active'), 'The customer tickets');
      const ticket = (list.tickets || []).find(item => item.number === number);
      expect(ticket, 'the link request is a page ticket').toBeTruthy();
      expect(ticket.category).toBe('page');
      expect(ticket.subject).toBe('Link my page: E2E new shop');
      const thread = await jsonOrThrow(await customerApi.get(`/api/studio/tickets/${ticket.id}`), 'The ticket thread');
      const text = String((thread.messages || [])[0] && (thread.messages || [])[0].text || '');
      for (const line of ['Platform / المنصة: Instagram', 'Page name / اسم الصفحة: E2E new shop', 'Professional account (business or creator) / حساب احترافي (أعمال أو صانع محتوى): Yes / نعم', 'Linked to a Facebook page / مربوط بصفحة فيسبوك: Not sure / لست متأكداً', 'Public account / حساب عام: No / لا', 'Meta Business Suite / أُضيف البيان كشريك في Meta Business Suite: Yes / نعم']) {
        expect(text, 'the desk reads every answer from the message').toContain(line);
      }
    } finally {
      await customerApi.dispose();
    }
    // The thread opens from the result; Back returns to Pages.
    await page.getByTestId('studio-pg-link-open').click();
    await expect.poll(() => tabParam(page)).toBe('help');
    await expect(page.getByTestId('studio-ticket-number')).toHaveText(number);

    // Rules: a keyword rule on the linked Facebook page, saved and listed with its page; on/off.
    await page.goto('/studio?tab=replies&section=rules');
    await expect(page.getByTestId('studio-pg-rules-card')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-pg-rules-empty')).toBeVisible();
    await expect(page.getByTestId('studio-pg-master')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('studio-pg-rule-new').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe('new');
    await page.getByTestId('studio-pg-rule-save').click();  // nothing filled: explained inline, nothing saved
    await expect(page.getByTestId('studio-pg-rule-problem-name')).toBeVisible();
    await page.locator('#studio-rule-name').fill('E2E price questions');
    await page.getByTestId(`studio-pg-rule-page-${seeded.fbPageId}`).click();
    await page.locator('#studio-rule-keyword').fill('price, بكم');
    await page.getByTestId('studio-pg-rule-keyword-add').click();
    await expect(page.getByTestId('studio-pg-rule-keyword-remove-1')).toBeVisible();
    await page.locator('#studio-rule-public').fill('Thanks! We sent you the price list.');
    await expectFits(page, 'Rule editor');
    await page.getByTestId('studio-pg-rule-save').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBeNull();
    const rule = page.locator('[data-testid^="studio-pg-rule-"][data-enabled]').first();
    await expect(rule).toBeVisible();
    await expect(rule).toContainText('E2E price questions');
    await expect(rule).toContainText(seeded.fbName);
    await expect(rule).toContainText('Keywords: price, بكم');
    const ruleId = (await rule.getAttribute('data-testid')).replace('studio-pg-rule-', '');
    await page.getByTestId(`studio-pg-rule-toggle-${ruleId}`).click();
    await expect(rule).toHaveAttribute('data-enabled', '0');
    const customerApi2 = await openUserApi(playwright, baseURL, seeded.user);
    try {
      const rules = await jsonOrThrow(await customerApi2.get('/api/social-studio/rules'), 'The rules');
      const saved = (rules.rules || []).find(item => item.id === ruleId);
      expect(saved, 'the rule is saved on the server').toBeTruthy();
      expect(saved.enabled).toBe(false);
      expect(saved.pageRefs).toEqual([seeded.fbPageId]);
      expect(saved.keywords).toEqual(['price', 'بكم']);
    } finally {
      await customerApi2.dispose();
    }
    await expectFits(page, 'Rules');

    // Log and posts: empty and honest; the posts tab shows the same list.
    await page.getByTestId('studio-pg-section-log').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBe('log');
    await expect(page.getByTestId('studio-pg-log-empty')).toBeVisible();
    await expect(page.getByTestId('studio-pg-log-counters')).toContainText('comments handled');
    await page.getByTestId('studio-pg-section-posts').click();
    await expect(page.getByTestId('studio-pg-posts-empty')).toBeVisible();
    await page.goto('/studio?tab=posts');
    await expect(page.getByTestId('studio-screen-posts')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-pg-posts-card')).toBeVisible();

    // Arabic: right to left, Arabic words on the pages and the sections.
    await page.goto('/studio?tab=replies');
    await expect(page.getByTestId('studio-pg-pages')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await setLanguage(page, 'ar');
    await expect(page.getByTestId('studio-pg-pages')).toContainText('الصفحات المربوطة');
    await expect(fbCard.getByTestId('studio-pg-health')).toHaveText(/يعمل/);
    expect(await page.getByTestId('studio-pg').innerText()).toMatch(ARABIC);
    await expectFits(page, 'Pages (AR)');
    await setLanguage(page, 'en');
    expect(errors).toEqual([]);
  });

  test('admin: Check now is admin-only on the server, and the health of a linked page answers with the neutral state while Meta is not connected', async ({ playwright, baseURL }, testInfo) => {
    const seeded = await seed(playwright, baseURL, testInfo, 'check');
    const customerApi = await openUserApi(playwright, baseURL, seeded.user);
    const admin = await openAdminApi(playwright, baseURL);
    try {
      const refused = await customerApi.post(`/api/social-studio/pages/${seeded.fbPageId}/check`, { data: {} });
      expect(refused.status(), 'a customer never runs the check').toBe(403);
      const checked = await jsonOrThrow(await admin.api.post(`/api/social-studio/pages/${seeded.fbPageId}/check`, { data: {} }), 'The admin check');
      expect(checked.pageId).toBe(seeded.fbPageId);
      expect(checked.errorCode, 'no Meta token in the e2e server').toBe('not_configured');
      expect(checked.health.state).toBe('ok');
      expect(checked.health.label.ar).toBe('يعمل');
      const pages = await jsonOrThrow(await customerApi.get('/api/social-studio/pages'), 'The customer pages');
      const fb = (pages.pages || []).find(item => item.id === seeded.fbPageId);
      expect(fb.health.checkedAt, 'the check stamped the page').toBeTruthy();
      expect(String(fb.linkedBy), 'a customer never sees the admin id').not.toBe(seeded.adminId);
    } finally {
      await customerApi.dispose();
      await admin.api.dispose();
    }
  });
});
