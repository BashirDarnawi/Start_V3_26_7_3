const { test, expect } = require('@playwright/test');
const {
  ARABIC,
  PHONE,
  addToPilot,
  collectPageErrors,
  createStudioUser,
  expectCustomerTab,
  expectNoPageOverflow,
  openAdminApi,
  projectToken,
  setLanguage,
  signInStudio,
  tabParam
} = require('./helpers/studio-v2');

// Albayan Studio help desk (P3-08), the stop-request sheet (P3-10), the inbox (P3-05) and the staff
// tickets section (P3-09) with real server data, in both layouts: each test seeds its OWN customer
// (a USD top-up by the e2e admin and one approved request) and, where the team acts, its own
// reviewer with the classic Team desk. The services follow the customer allowlist ('pilot'); the
// classic test switches them on for everyone for its own run and puts 'pilot' back. The customer
// layout stays a pilot (never "on" for everyone).
//
// The full matrix runs on mobile-chromium at 390 px; desktop-chromium and mobile-webkit run one smoke.
//   npx playwright test tests/e2e/studio-help.spec.js --project=mobile-chromium

const FULL_MATRIX_PROJECT = 'mobile-chromium';
const BOOT_TIMEOUT = 20_000;
const WIDTHS = [320, 360, 390, 412, 820];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC';
const CONTACT = { whatsapp: '+218912345678', phone: '+218912345678', email: 'help@albayan.example.com' };
const TICKET_NUMBER = /^T-\d{6,}$/;

function fullMatrixOnly(testInfo) {
  test.skip(testInfo.project.name !== FULL_MATRIX_PROJECT, 'The full help-desk matrix runs on mobile-chromium (P2-13)');
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
    primaryText: "Message us for this week's offer.", headline: 'Weekly offer', description: 'A help-desk journey request.',
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

// An API session of one studio user (the browser's own Origin, like the site itself).
async function openUserApi(playwright, baseURL, user) {
  const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } });
  await jsonOrThrow(await api.post('/api/auth/login', { data: { email: user.email, password: user.password } }), `Login of ${user.email}`);
  return api;
}

// One customer with $100.00 and an approved request that has not started, plus a reviewer whose Team
// desk is classic (never in the staff pilot). pilot: the customer joins the v2 layout pilot (the
// services 'pilot' mode follows that allowlist).
async function seed(playwright, baseURL, testInfo, label, { pilot = true, services = { help: 'pilot', stopRequest: 'pilot' } } = {}) {
  const admin = await openAdminApi(playwright, baseURL);
  const origin = new URL(baseURL).origin;
  const customerApi = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: origin } });
  try {
    const tag = `${label}-${projectToken(testInfo)}-${Date.now()}`;
    const user = await createStudioUser(admin.api, 'customer', tag);
    const reviewer = await createStudioUser(admin.api, 'reviewer', tag);
    if (pilot) await addToPilot(admin, { customers: [user.id] });
    await setServices(admin.api, services);
    await jsonOrThrow(await admin.api.post('/api/wallet/top-ups', {
      data: { userId: user.id, amountMinor: 10000, currency: 'USD', idempotencyKey: `e2e-help-topup-${tag}`, memo: 'E2E help desk journeys' }
    }), 'The USD top-up');
    await jsonOrThrow(await customerApi.post('/api/auth/login', { data: { email: user.email, password: user.password } }), 'Customer login');
    const id = `e2e_help_approved_${tag}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80);
    const created = await jsonOrThrow(await customerApi.post('/api/collections/adCampaignRequests', { data: { id, data: completeRequest('E2E approved, not started') } }), 'Creating the request');
    const submitted = await jsonOrThrow(await customerApi.post(`/api/ad-studio/campaigns/${id}/submit`, {
      data: { expectedLastModified: created.lastModified, operationId: `e2e-help-submit-${tag}` }
    }), 'Submitting the request');
    await jsonOrThrow(await admin.api.post(`/api/ad-studio/campaigns/${id}/review`, {
      data: { expectedLastModified: submitted.lastModified, decision: 'Approved', note: '', operationId: `e2e-help-review-${tag}` }
    }), 'Approving the request');
    return { user, reviewer, requestId: id, tag };
  } finally {
    await customerApi.dispose();
    await admin.api.dispose();
  }
}

async function answerMeWith(page, change) {
  await page.route('**/api/studio/me', async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: change(body) });
  });
}

// No sideways scroll, nothing outside the screen, 44 px touch targets, at every phone and tablet width.
async function expectFits(page, label, frame = '[data-testid="studio-v2-frame"]') {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.evaluate(root => {
      const inside = element => { const box = element.getBoundingClientRect(); return box.width === 0 || (box.left >= -1 && box.right <= innerWidth + 1); };
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        outside: [...document.querySelectorAll(`${root} button, ${root} h1, ${root} h2, ${root} p, ${root} dd`)]
          .filter(element => !inside(element)).map(element => element.textContent.trim().slice(0, 40)),
        small: [...document.querySelectorAll(`${root} .studio-help button`)].filter(element => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && (box.width < 43.5 || box.height < 43.5);
        }).map(element => element.getAttribute('data-testid') || element.textContent.trim().slice(0, 30))
      };
    }, frame);
    expect(layout.overflow, `${label} overflows at ${width}px`).toBeLessThanOrEqual(1);
    expect(layout.outside, `${label} at ${width}px`).toEqual([]);
    expect(layout.small, `${label} touch targets at ${width}px`).toEqual([]);
  }
  await page.setViewportSize(PHONE);
}

const actionIds = page => page.locator('[data-testid^="studio-ad-action-"]').evaluateAll(buttons =>
  buttons.map(button => button.getAttribute('data-testid').replace('studio-ad-action-', '')));

test.describe('Albayan Studio help desk, inbox and stop requests', () => {
  test.beforeEach(() => {
    test.setTimeout(180_000);
  });

  // The other studio specs expect the services off (their "coming soon" sheets): every test here
  // leaves them as it found them.
  test.afterEach(async ({ playwright, baseURL }) => {
    const admin = await openAdminApi(playwright, baseURL);
    try {
      await setServices(admin.api, { help: 'off', stopRequest: 'off' });
    } finally {
      await admin.api.dispose();
    }
  });

  test('v2: a ticket from Help and from "Ask about this", the thread with the team\'s answer, resolve and reopen; hours and contact; Arabic; fits 320-820 px', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const seeded = await seed(playwright, baseURL, testInfo, 'help');
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await answerMeWith(page, body => ({ ...body, contact: CONTACT }));
    await signInStudio(page, seeded.user);
    await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });

    // Help: no tickets yet, the hours from the server (Sun-Thu 09:00-17:00 by default) and the contact links.
    await page.getByTestId('studio-nav-help').click();
    await expectCustomerTab(page, 'help');
    await expect(page.getByTestId('studio-help-empty')).toBeVisible();
    await expect(page.getByTestId('studio-help-hours')).toContainText('Sunday');
    await expect(page.getByTestId('studio-help-open-now')).toBeVisible();
    expect(await page.getByTestId('studio-help-contact-whatsapp').getAttribute('href')).toBe('https://wa.me/218912345678');
    await expect(page.getByTestId('studio-help-contact-phone')).toHaveAttribute('href', 'tel:+218912345678');
    await expectFits(page, 'Help (empty)');

    // New ticket: category, subject, message; the thread opens with its number and the due time.
    await page.getByTestId('studio-help-new').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe('new');
    await page.getByTestId('studio-help-send').click();  // nothing filled: the form explains, nothing is sent
    await expect(page.getByTestId('studio-help-problem-category')).toBeVisible();
    await page.getByTestId('studio-help-category-other').click();
    await page.locator('#studio-help-subject').fill('How do I change my page?');
    await page.locator('#studio-help-message').fill('I linked the wrong page to my account.');
    await page.getByTestId('studio-help-send').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toMatch(/^tkt_[0-9a-f]{40}$/);
    const ticketId = new URL(page.url()).searchParams.get('id');
    const thread = page.getByTestId('studio-ticket-thread');
    await expect(thread).toBeVisible();
    const number = (await page.getByTestId('studio-ticket-number').innerText()).trim();
    expect(number).toMatch(TICKET_NUMBER);
    await expect(page.getByTestId('studio-ticket-state')).toContainText('We reply');
    await expect(thread.locator('.studio-help-msg[data-from="customer"]')).toHaveCount(1);
    await expectFits(page, 'Ticket thread');

    // The list groups it under "waiting for our team".
    await page.getByTestId('studio-back').click();
    await expectCustomerTab(page, 'help');
    await expect(page.getByTestId('studio-help-list-team').getByTestId(`studio-ticket-${ticketId}`)).toContainText(number);

    // The team answers (a reviewer through the staff route): the thread shows "Albayan team", never a person.
    const reviewerApi = await openUserApi(playwright, baseURL, seeded.reviewer);
    try {
      await jsonOrThrow(await reviewerApi.post(`/api/studio/staff/tickets/${ticketId}/messages`, {
        data: { text: 'Send us the link of the right page and we relink it today.', operationId: `e2e-help-answer-${seeded.tag}` }
      }), 'The team answer');
    } finally {
      await reviewerApi.dispose();
    }
    await page.getByTestId(`studio-ticket-${ticketId}`).click();
    await page.getByTestId('studio-ticket-refresh').click();
    await expect(thread.locator('.studio-help-msg[data-from="team"]')).toContainText('Send us the link of the right page');
    await expect(thread.locator('.studio-help-msg[data-from="team"] .studio-help-msg-from')).toHaveText('Albayan team');
    await expect(thread).toHaveAttribute('data-status', 'answered');
    const threadText = await thread.innerText();
    expect(threadText, 'no reviewer name or email reaches the customer').not.toMatch(/E2E Studio reviewer|e2e\.studio\.reviewer/);
    expect(threadText).not.toContain(seeded.reviewer.id);

    // A reply reopens it for the team; resolve; reopen within 7 days.
    await page.locator(`#studio-help-reply-${ticketId}`).fill('Thanks, here it is: https://facebook.com/e2e-right-page');
    await page.getByTestId('studio-ticket-reply-send').click();
    await expect(thread.locator('.studio-help-msg[data-from="customer"]')).toHaveCount(2);
    await expect(thread).toHaveAttribute('data-status', 'open');
    await page.getByTestId('studio-ticket-resolve').click();
    await expect(thread).toHaveAttribute('data-status', 'resolved');
    await expect(page.getByTestId('studio-ticket-reopen')).toBeVisible();
    await page.getByTestId('studio-ticket-reopen').click();
    await expect(thread).toHaveAttribute('data-status', 'open');

    // "Ask about this" on the approved request pre-fills New ticket with that request.
    await page.goto(`/studio?tab=campaigns&id=${seeded.requestId}`);
    await expect(page.getByTestId('studio-ad-detail')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect.poll(() => actionIds(page)).toContain('ask');
    await page.getByTestId('studio-ad-action-ask').click();
    await expect.poll(() => tabParam(page)).toBe('help');
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe('new');
    await expect(page.getByTestId('studio-help-related')).toHaveValue(`campaign:${seeded.requestId}`);
    await expect(page.locator('#studio-help-subject')).toHaveValue('About my ad: E2E approved, not started');
    await expect(page.getByTestId('studio-help-category-ad')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#studio-help-message').fill('When does it start?');
    await page.getByTestId('studio-help-send').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toMatch(/^tkt_[0-9a-f]{40}$/);
    await expect(page.getByTestId('studio-ticket-related')).toContainText('E2E approved, not started');

    // Arabic: right to left, Arabic words, the same ticket number.
    await setLanguage(page, 'ar');
    await expect(page.getByTestId('studio-ticket-subject')).toContainText('About my ad');
    expect(await thread.innerText()).toMatch(ARABIC);
    await page.getByTestId('studio-back').click();
    await expect(page.getByTestId('studio-help-tickets')).toContainText('تذاكري');
    await expectFits(page, 'Help (AR)');
    await setLanguage(page, 'en');
    expect(errors).toEqual([]);
  });

  test('v2: Ask to stop opens one urgent ticket (a repeat gets the same one), the inbox shows it, the classic Team desk answers it first', async ({ page, browser, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const seeded = await seed(playwright, baseURL, testInfo, 'stop');
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await signInStudio(page, seeded.user);
    await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });

    await page.goto(`/studio?tab=campaigns&id=${seeded.requestId}`);
    await expect(page.getByTestId('studio-ad-detail')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect.poll(() => actionIds(page)).toEqual(['stop', 'ask_stop', 'ask']);
    await page.getByTestId('studio-ad-action-ask_stop').click();
    const sheet = page.getByTestId('studio-sheet-ask-stop');
    await expect(sheet).toHaveAttribute('data-state', 'ask');
    await expect(sheet).toContainText('This opens an urgent ticket');
    await expect(sheet).not.toContainText('Coming soon');
    await page.getByTestId('studio-stop-note').fill('The offer ended early.');
    await page.getByTestId('studio-sheet-confirm').click();
    await expect(sheet).toHaveAttribute('data-state', 'sent');
    const number = (await page.getByTestId('studio-stop-number').innerText()).replace(/^Ticket\s+/, '').trim();
    expect(number).toMatch(TICKET_NUMBER);
    await expect(page.getByTestId('studio-stop-due')).toContainText('pause it');

    // A repeat from anywhere (another tap, another device) answers with the same ticket.
    const again = await page.evaluate(id => apiJson(`/api/ad-studio/campaigns/${id}/stop-request`, { method: 'POST', body: { operationId: `e2e-stop-again-${Date.now()}` } }), seeded.requestId);
    expect(again.ticket.number).toBe(number);

    // The ticket opens from the sheet as an urgent one; the request now wears "Stop requested".
    await page.getByTestId('studio-stop-open-ticket').click();
    await expect.poll(() => tabParam(page)).toBe('help');
    const thread = page.getByTestId('studio-ticket-thread');
    await expect(page.getByTestId('studio-ticket-number')).toHaveText(number);
    await expect(thread).toContainText('Urgent: stop request');
    await expect(thread.locator('.studio-help-msg[data-from="customer"]')).toContainText('The offer ended early.');
    const ticketId = new URL(page.url()).searchParams.get('id');
    await page.goto(`/studio?tab=campaigns&id=${seeded.requestId}`);
    await expect(page.getByTestId('studio-ad-detail')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-ad-detail').locator('.studio-flag')).toContainText('Stop requested', { timeout: BOOT_TIMEOUT });
    await expect.poll(() => actionIds(page)).not.toContain('ask_stop');

    // The bell wears the unread count on every screen (the approval and the stop request are unread).
    const bell = page.getByTestId('studio-nav-inbox');
    const badge = bell.getByTestId('studio-inbox-badge');
    await expect(badge).toBeVisible({ timeout: BOOT_TIMEOUT });
    expect(Number((await badge.innerText()).trim())).toBeGreaterThanOrEqual(1);

    // The inbox: "We received your stop request" is unread until Mark all seen; the badge then goes.
    await bell.click();
    await expectCustomerTab(page, 'inbox');
    const item = page.locator('[data-testid^="studio-inbox-item-"][data-kind="stop_request_received"]');
    await expect(item).toHaveAttribute('data-unread', '1');
    await expect(item).toContainText(number);
    await expect(page.getByTestId('studio-inbox-unread')).not.toHaveAttribute('data-count', '0');
    await page.getByTestId('studio-inbox-seen').click();
    await expect(page.getByTestId('studio-inbox-unread')).toHaveAttribute('data-count', '0');
    await expect(item).toHaveAttribute('data-unread', '0');
    await expect(page.getByTestId('studio-inbox-badge')).toHaveCount(0);
    await expectFits(page, 'Inbox');

    // The reviewer's classic Team desk: the stop request is pinned first; a reply marks it answered.
    const deskContext = await browser.newContext({ viewport: PHONE });
    const desk = await deskContext.newPage();
    try {
      await signInStudio(desk, seeded.reviewer);
      await expect(desk.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible({ timeout: BOOT_TIMEOUT });
      await desk.getByRole('tab', { name: /Review Queue/ }).click();
      await expect.poll(() => tabParam(desk)).toBe('review');
      const section = desk.getByTestId('studio-staff-tickets');
      await expect(section).toBeVisible();
      const rows = section.locator('[data-testid="studio-staff-list"] > li');
      await expect(rows.first()).toContainText(number, { timeout: BOOT_TIMEOUT });
      await expect(rows.first()).toContainText('Urgent: stop request');
      await desk.getByTestId(`studio-ticket-${ticketId}`).click();
      const staffThread = desk.getByTestId('studio-staff-thread');
      await expect(staffThread).toBeVisible();
      await expect(staffThread.locator('.studio-help-msg[data-from="customer"]')).toContainText('The offer ended early.');
      await desk.locator(`#studio-help-reply-${ticketId}`).fill('Paused in Meta a minute ago.');
      await desk.getByTestId('studio-staff-reply-send').click();
      await expect(staffThread).toHaveAttribute('data-status', 'answered');
      await expect(desk.getByTestId(`studio-ticket-${ticketId}`).locator('.studio-help-status[data-status]')).toHaveAttribute('data-status', 'answered');
    } finally {
      await deskContext.close();
    }

    // The customer sees the answer, as "Albayan team".
    await page.goto(`/studio?tab=help&id=${ticketId}`);
    await expect(thread).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(thread.locator('.studio-help-msg[data-from="team"]')).toContainText('Paused in Meta a minute ago.');
    await expect(thread.locator('.studio-help-msg[data-from="team"] .studio-help-msg-from')).toHaveText('Albayan team');
    expect(errors).toEqual([]);
  });

  test('classic: the Help tab, "Ask about this" on the card and the payment row, the stop-request sheet on the card, and the staff section (a reviewer never sees a payment ticket)', async ({ page, browser, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const seeded = await seed(playwright, baseURL, testInfo, 'classic', { pilot: false, services: { help: 'on', stopRequest: 'on' } });
    const admin = await openAdminApi(playwright, baseURL);
    try {
      const errors = collectPageErrors(page);
      await page.setViewportSize(PHONE);
      await signInStudio(page, seeded.user);
      await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible({ timeout: BOOT_TIMEOUT });
      await expect(page.getByTestId('studio-v2-frame')).toHaveCount(0);
      const helpTab = page.getByRole('tab', { name: 'Help', exact: true });
      await expect(helpTab).toBeVisible({ timeout: BOOT_TIMEOUT });

      // A payment ticket (admin-only) from the wallet row of a pending payment.
      const customerApi = await openUserApi(playwright, baseURL, seeded.user);
      let paymentRef = '';
      try {
        const payment = await jsonOrThrow(await customerApi.post('/api/wallet/payment-requests', {
          data: { amountMinor: 5000, currency: 'LYD', method: 'adfali', idempotencyKey: `e2e-help-pay-${seeded.tag}` }
        }), 'The pending LYD payment');
        paymentRef = String((payment.data && payment.data.reference) || '');
      } finally {
        await customerApi.dispose();
      }
      expect(paymentRef).toMatch(/^PAY-/);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible({ timeout: BOOT_TIMEOUT });
      await expect(page.getByTestId(`studio-ask-payment-${paymentRef}`)).toBeVisible({ timeout: BOOT_TIMEOUT });
      await page.getByTestId(`studio-ask-payment-${paymentRef}`).click();
      await expect.poll(() => tabParam(page)).toBe('help');
      const form = page.getByTestId('studio-help-form');
      await expect(form).toBeVisible();
      await expect(page.getByTestId('studio-help-category-payment')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('studio-help-related')).toHaveValue(`payment:${paymentRef}`);
      await page.locator('#studio-help-message').fill('I paid this morning, please confirm it.');
      await page.getByTestId('studio-help-send').click();
      const thread = page.getByTestId('studio-ticket-thread');
      await expect(thread).toBeVisible();
      const paymentNumber = (await page.getByTestId('studio-ticket-number').innerText()).trim();
      expect(paymentNumber).toMatch(TICKET_NUMBER);
      const paymentTicketId = await thread.getAttribute('data-ticket');
      await expectFits(page, 'Classic ticket thread', '.studio-help');

      // The campaign card: "Ask about this" pre-fills the request; "Ask to stop" opens the sheet and the card shows the marker.
      await page.getByRole('tab', { name: /My Campaigns/ }).click();
      const card = page.locator(`[data-ads-studio-campaign="${seeded.requestId}"]`);
      await expect(card).toBeVisible();
      await card.getByTestId(`studio-ask-campaign-${seeded.requestId}`).click();
      await expect(page.getByTestId('studio-help-related')).toHaveValue(`campaign:${seeded.requestId}`);
      await page.getByTestId('studio-help-cancel').click();
      await expect(page.getByTestId('studio-help-tickets')).toBeVisible();
      await page.getByRole('tab', { name: /My Campaigns/ }).click();
      await card.locator('[data-ads-studio-ask-stop]').click();
      const sheet = page.getByTestId('studio-sheet-ask-stop');
      await expect(sheet).toHaveAttribute('data-state', 'ask');
      await page.getByTestId('studio-sheet-confirm').click();
      await expect(sheet).toHaveAttribute('data-state', 'sent');
      const stopNumber = (await page.getByTestId('studio-stop-number').innerText()).replace(/^Ticket\s+/, '').trim();
      expect(stopNumber).toMatch(TICKET_NUMBER);
      await page.getByTestId('studio-stop-done').click();
      await expect(sheet).toHaveCount(0);
      await expect(card.locator('[data-ads-studio-stop-requested]')).toBeVisible();
      await expect(card.locator('[data-ads-studio-ask-stop]')).toHaveCount(0);
      await expectNoPageOverflow(page, 'Classic campaigns with the stop marker');

      // The reviewer's classic desk: the stop request first, the payment ticket absent (admin-only); the admin sees it.
      const deskContext = await browser.newContext({ viewport: PHONE });
      const desk = await deskContext.newPage();
      try {
        await signInStudio(desk, seeded.reviewer);
        await desk.getByRole('tab', { name: /Review Queue/ }).click();
        const section = desk.getByTestId('studio-staff-tickets');
        await expect(section.locator('[data-testid="studio-staff-list"] > li').first()).toContainText(stopNumber, { timeout: BOOT_TIMEOUT });
        await expect(section).not.toContainText(paymentNumber);
        await expect(desk.getByTestId(`studio-ticket-${paymentTicketId}`)).toHaveCount(0);
      } finally {
        await deskContext.close();
      }
      const reviewerApi = await openUserApi(playwright, baseURL, seeded.reviewer);
      try {
        expect((await reviewerApi.get(`/api/studio/staff/tickets/${paymentTicketId}`)).status(), 'a reviewer gets 404 on a payment ticket').toBe(404);
      } finally {
        await reviewerApi.dispose();
      }
      const adminQueue = await jsonOrThrow(await admin.api.get('/api/studio/staff/tickets?status=active&limit=50'), 'The admin queue');
      expect(adminQueue.tickets.map(item => item.number)).toContain(paymentNumber);
      expect(errors).toEqual([]);
    } finally {
      await admin.api.dispose();  // afterEach switches the services off again
    }
  });

  test('smoke: Help lists the tickets and fits on this browser', async ({ page, playwright, baseURL }, testInfo) => {
    test.skip(testInfo.project.name === FULL_MATRIX_PROJECT, 'mobile-chromium runs the full matrix above');
    const seeded = await seed(playwright, baseURL, testInfo, 'smoke');
    const errors = collectPageErrors(page);
    await signInStudio(page, seeded.user);
    await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });
    await page.getByTestId('studio-nav-help').click();
    await expectCustomerTab(page, 'help');
    await expect(page.getByTestId('studio-help-empty')).toBeVisible();
    await expect(page.getByTestId('studio-help-hours')).toBeVisible();
    await expectNoPageOverflow(page, `Help on ${testInfo.project.name}`);
    expect(errors).toEqual([]);
  });
});
