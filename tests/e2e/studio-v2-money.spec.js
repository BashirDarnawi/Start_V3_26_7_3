const { test, expect } = require('@playwright/test');
const {
  ARABIC,
  PHONE,
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
  tabParam
} = require('./helpers/studio-v2');

// The Albayan Studio v2 money journey (plan task P2-10), end to end with REAL money routes and no
// mocked numbers: a pilot customer whose wallet top-up was confirmed through the payment-request
// routes builds a quick boost in the wizard (a new ad without a post: own text, a photo, a daily
// budget of 7 x $10.00), sends it, watches Home reserve the $70.00, withdraws it from My ads and
// sees the money come back; then (a second test) sends again, a reviewer approves on the Team desk,
// the customer sees "In your ads $70.00", and a staff stop of the never-linked ad (the real route)
// returns the whole payment; then (a third test) the customer stops the approved ad before its start
// date from the app (Stop -> the sheet -> confirm) and gets the whole $70.00 back. At every step the
// Home strip is compared with GET /api/studio/wallet/summary.
//
// Each test seeds its OWN pilot customer and reviewer (helpers/studio-v2.js); the customer layout
// stays a pilot (never "on" for everyone). The full journeys run on mobile-chromium at 390 px, in
// Arabic (RTL) and English; desktop-chromium and mobile-webkit run one smoke pass. Run with:
//   npx playwright test tests/e2e/studio-v2-money.spec.js --project=mobile-chromium

const FULL_MATRIX_PROJECT = 'mobile-chromium';
const BOOT_TIMEOUT = 20_000;
const TOP_UP_MINOR = 10000;                 // $100.00, confirmed through the real payment-request routes
const DAILY_MINOR = 1000;                   // $10.00 a day
const DAYS = 7;
const TOTAL_MINOR = DAILY_MINOR * DAYS;     // $70.00 reserved, then paid, then returned
const MONEY_CELLS = [['available', 'availableMinor'], ['reserved', 'reservedMinor'], ['in-ads', 'inAdsMinor'], ['spent', 'spentMinor']];

// The words the customer reads, per language (the server's stage labels and the screens' own).
const WORDS = {
  en: {
    home: 'Home', available: 'Available', reserved: 'Reserved', inAds: 'In your ads',
    waiting: 'Waiting for Albayan review', draft: 'Draft — not sent', approved: 'Approved — being set up in Meta', stopped: 'Stopped',
    reservedRow: 'Reserved — still yours', returnedInFull: 'Came back to you in full', withdrawTitle: 'Withdraw this request?',
    stopTitle: 'Stop this ad before it starts?', stopConfirm: 'Stop and refund',
    perDay: '10', page: 'E2E Bakery', text: 'Fresh bread every morning — order before 9.'
  },
  ar: {
    home: 'الرئيسية', available: 'متاح', reserved: 'محجوز', inAds: 'في إعلاناتك',
    waiting: 'بانتظار مراجعة فريق البيان', draft: 'مسودة — لم تُرسل', approved: 'مقبول — نجهّزه في ميتا', stopped: 'أُوقف',
    reservedRow: 'محجوز — ما زال لك', returnedInFull: 'عاد إليك كاملاً', withdrawTitle: 'سحب هذا الطلب؟',
    stopTitle: 'إيقاف هذا الإعلان قبل أن يبدأ؟', stopConfirm: 'أوقفه واسترد المبلغ',
    perDay: '١٠', page: 'مخبز البيان التجريبي', text: 'خبز طازج كل صباح — اطلب قبل التاسعة.'
  }
};

function fullMatrixOnly(testInfo) {
  test.skip(testInfo.project.name !== FULL_MATRIX_PROJECT, 'The full money journey runs on mobile-chromium (P2-13)');
}

async function jsonOrThrow(response, label) {
  const body = await response.text();
  if (!response.ok()) throw new Error(`${label} failed with HTTP ${response.status()}: ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : null;
}

// "$1,234.56" for cents (the studio's own format, written independently here).
function usd(minor) {
  const whole = (Math.abs(minor) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minor < 0 ? '-' : ''}$${whole}`;
}

const fourNumbers = summary => MONEY_CELLS.map(([, field]) => summary.usd[field]);

// One pilot customer with a CONFIRMED top-up through the real routes (the customer asks to add
// $100.00 and gets a PAY- code; the e2e admin confirms it), plus a reviewer in the Team desk pilot.
// The customer's own API session is returned for server-side reads (dispose it at the end).
async function seedMoneyCustomer(playwright, baseURL, testInfo, label) {
  const admin = await openAdminApi(playwright, baseURL);
  let customerApi = null;
  try {
    // Short: an e-mail's local part must stay within 64 characters on every project.
    const tag = `${label}-${projectToken(testInfo).replace('chromium', 'cr').replace('webkit', 'wk')}-${Date.now().toString(36)}`;
    const customer = await createStudioUser(admin.api, 'customer', `m-${tag}`);
    const reviewer = await createStudioUser(admin.api, 'reviewer', `m-${tag}`);
    await addToPilot(admin, { customers: [customer.id], staff: [reviewer.id] });
    customerApi = await openUserApi(playwright, baseURL, customer);
    const payment = await jsonOrThrow(await customerApi.post('/api/wallet/payment-requests', {
      data: { amountMinor: TOP_UP_MINOR, currency: 'USD', method: 'adfali', idempotencyKey: `e2e-money-pay-${tag}` }
    }), 'Asking to add money');
    expect(String(payment.data && payment.data.reference), 'the top-up gets a PAY- code').toMatch(/^PAY-[A-Z0-9]{8}$/);
    const confirmed = await jsonOrThrow(await admin.api.post(`/api/wallet/payment-requests/${encodeURIComponent(payment.id)}/confirm`, { data: {} }), 'Confirming the top-up');
    expect(confirmed.data && confirmed.data.status, 'the admin confirmed the payment').toBe('confirmed');
    const summary = await jsonOrThrow(await customerApi.get('/api/studio/wallet/summary'), 'The wallet summary after the top-up');
    expect(fourNumbers(summary), 'the confirmed top-up is available, nothing reserved, paid or spent').toEqual([TOP_UP_MINOR, 0, 0, 0]);
    return { customer, reviewer, tag, customerApi };
  } catch (error) {
    if (customerApi) await customerApi.dispose();
    throw error;
  } finally {
    await admin.api.dispose();
  }
}

// The request as the server has it (no photos).
async function readRequest(api, id) {
  const entity = await jsonOrThrow(await api.get(`/api/collections/adCampaignRequests/${encodeURIComponent(id)}?include_media=false`), `Reading ${id}`);
  return { data: entity.data || {}, lastModified: Number(entity.lastModified || (entity.data && entity.data._lastModified) || 0) };
}

// The app cancels its in-flight reads on a navigation (AbortError): this read is only a comparison
// value, so it is asked again rather than failing the journey on that timing.
async function walletSummary(page) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.evaluate(() => apiJson('/api/studio/wallet/summary', { method: 'GET' }));
    } catch (error) {
      if (attempt >= 6 || !/abort/i.test(String(error && error.message))) throw error;
      await page.waitForTimeout(500);
    }
  }
}

// The Home strip shows exactly the server's four numbers (data-minor and the printed money), which
// are the expected ones; Being returned never shows here (nothing is ever on its way in this journey).
async function expectStripEqualsServer(page, expected, label) {
  const summary = await walletSummary(page);
  expect(fourNumbers(summary), `${label}: available, reserved, in ads, spent on the server`).toEqual(expected);
  for (const [key, field] of MONEY_CELLS) {
    const cell = page.getByTestId(`studio-money-${key}`);
    await expect(cell, `${label}: the ${key} cell`).toHaveAttribute('data-minor', String(summary.usd[field]));
    await expect(cell.locator('.studio-home-money-value')).toHaveText(usd(summary.usd[field]));
  }
  expect(summary.usd.beingReturnedMinor, `${label}: nothing on its way back`).toBe(0);
  await expect(page.getByTestId('studio-money-returning')).toHaveCount(0);
  return summary;
}

async function expectDirection(page, language, label) {
  const frame = page.getByTestId('studio-v2-frame');
  await expect(frame, label).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
  expect(await frame.evaluate(el => getComputedStyle(el).direction), `${label} reads ${language === 'ar' ? 'right to left' : 'left to right'}`).toBe(language === 'ar' ? 'rtl' : 'ltr');
}

// Every screen of the journey is reached within two taps of Home: the counter starts at Home and
// each tap on the way to a screen counts.
function tapCounter() {
  const counter = { taps: 0 };
  counter.home = () => { counter.taps = 0; };
  counter.tap = async (locator, label) => {
    counter.taps += 1;
    expect(counter.taps, `${label} is within two taps of Home`).toBeLessThanOrEqual(2);
    await locator.click();
  };
  return counter;
}

async function openHome(page, user, language) {
  await signInStudio(page, user);
  await expect(page.getByTestId('studio-v2-frame')).toBeVisible({ timeout: BOOT_TIMEOUT });
  // The sign-in flow restores the requested view once its data is in (it rewrites the address and
  // cancels the page's reads): the journey starts after that, like a person would.
  await page.waitForFunction(() => typeof _postLoginRoutePromise === 'undefined' || _postLoginRoutePromise === null, null, { timeout: BOOT_TIMEOUT });
  await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });
  await setLanguage(page, language);
  await expect(page.getByTestId('studio-money-available')).toHaveAttribute('data-minor', /^-?\d+$/, { timeout: BOOT_TIMEOUT });
}

// The customer reopens the app at its front door (a fresh page load, still signed in) and sees what
// staff did meanwhile.
async function reopenHome(page, language) {
  await page.goto('/studio');
  await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });
  await expectDirection(page, language, 'Home after a reload');
  await expect(page.getByTestId('studio-money-available')).toHaveAttribute('data-minor', /^-?\d+$/, { timeout: BOOT_TIMEOUT });
}

// From Home, the quick boost as "a new ad without a post": own text, a photo, where people go, then
// $10.00 a day for 7 days, then Send. Returns the request id. One tap from Home to the wizard.
async function sendOwnTextBoost(page, { language, taps, words }) {
  await taps.tap(page.getByTestId('studio-goal-grow'), 'the quick boost');
  const builder = page.getByTestId('studio-builder');
  await expect(builder).toHaveAttribute('data-kind', 'boost');
  await expect(builder).toHaveAttribute('data-step', '1');
  await expect.poll(() => tabParam(page)).toBe('builder');
  await expect(page.getByTestId('studio-builder-kind-new'), 'a new ad without a post').toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('studio-nav'), 'focus mode: no bottom nav in the wizard').toBeHidden();
  await expectDirection(page, language, 'wizard step 1');
  if (language === 'ar') await expect(page.getByTestId('studio-builder-step')).toHaveText(ARABIC);

  // 1 What to promote: the page name (nothing is linked on the e2e server), the text, one photo, a phone.
  await page.locator('#studio-b-page-name').fill(words.page);
  await page.locator('#studio-b-text').fill(words.text);
  await page.locator('#ads-studio-image-input').setInputFiles({ name: 'offer.png', mimeType: 'image/png', buffer: makePng(48, 48, [16, 185, 129]) });
  await expect(page.locator('.studio-b-photo img')).toHaveCount(1, { timeout: 15_000 });
  await page.locator('#studio-b-destination').fill('091 234 5678');
  await expectNoPageOverflow(page, `wizard step 1 (${language})`);
  await page.getByTestId('studio-builder-next').click();
  await expect(builder).toHaveAttribute('data-step', '2');

  // 2 Budget and days: an amount per day (typed in this language's digits), 7 days, the live total
  // and the wallet line from the server.
  await page.getByTestId('studio-builder-budget-daily').click();
  await expect(page.getByTestId('studio-builder-budget-daily')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#studio-b-budget').fill(words.perDay);
  await page.getByTestId('studio-builder-days-7').click();
  await expect(page.getByTestId('studio-builder-days-7')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('studio-builder-total')).toContainText(usd(TOTAL_MINOR));
  await expect(page.getByTestId('studio-builder-total')).toContainText(usd(DAILY_MINOR));
  await expect(page.getByTestId('studio-builder-wallet')).toContainText(usd(TOP_UP_MINOR));
  await expect(page.getByTestId('studio-builder-wallet-short')).toHaveCount(0);
  await expectNoPageOverflow(page, `wizard step 2 (${language})`);
  await page.getByTestId('studio-builder-next').click();
  await expect(builder).toHaveAttribute('data-step', '3');

  // 3 Review and send: the rights box, then Send reserves the total (nothing is charged).
  const id = await page.evaluate(() => String((_studioBuilder.session && _studioBuilder.session.id) || ''));
  expect(id).toMatch(/^campaign_/);
  await expect(page.getByTestId('studio-builder-problems')).toHaveCount(0);
  await page.locator('#studio-b-rights').check();
  await page.getByTestId('studio-builder-send').click();
  await expect(page.getByTestId('studio-builder-sent')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('studio-builder-sent-money')).toContainText(usd(TOTAL_MINOR));
  if (language === 'ar') await expect(page.getByTestId('studio-builder-sent-money')).toHaveText(ARABIC);
  return id;
}

// The sent request on the server: a daily quick boost of 7 x $10.00 holding its $70.00 total.
async function expectSentOnServer(api, id, words) {
  const { data } = await readRequest(api, id);
  expect(data).toMatchObject({
    status: 'Submitted', boostType: 'boost_page', primaryText: words.text, pageName: words.page, destination: '+218912345678',
    budgetType: 'daily', budgetMinorUSD: DAILY_MINOR, durationDays: DAYS, totalBudgetMinorUSD: TOTAL_MINOR
  });
  expect(fourNumbers(await jsonOrThrow(await api.get('/api/studio/wallet/summary'), 'The summary after the send'))).toEqual([TOP_UP_MINOR - TOTAL_MINOR, TOTAL_MINOR, 0, 0]);
}

// The Home button of the "Sent" screen (the bottom nav is hidden in the wizard). The send asks for both
// summaries again at once; leaving the wizard while they are still on their way would cancel them (the
// app aborts a screen's reads on a navigation) and Home would show the numbers from before the send
// until its next read. The journey lets them land first, like a person who watches the money line settle.
async function homeFromSent(page, taps, words) {
  await page.waitForFunction(() => !studioDataState('wallet').loading && !studioDataState('campaigns').loading, null, { timeout: BOOT_TIMEOUT });
  await page.getByTestId('studio-builder-sent').getByRole('button', { name: words.home, exact: true }).click();
  await expectCustomerTab(page, 'home');
  taps.home();
}

const actionIds = page => page.locator('[data-testid^="studio-ad-action-"]').evaluateAll(buttons =>
  buttons.map(button => button.getAttribute('data-testid').replace('studio-ad-action-', '')));

// The reviewer approves the request on the Team desk (a second browser, the staff pilot): the
// in-page sheet names the $70.00 the approval charges. Returns the staff page's errors.
async function approveOnDesk(browser, contextOptions, baseURL, reviewer, id) {
  const context = await browser.newContext({ ...contextOptions, baseURL });
  const staff = await context.newPage();
  const errors = collectPageErrors(staff);
  try {
    await staff.setViewportSize(PHONE);
    await signInStudio(staff, reviewer);
    await expect(staff.getByTestId('studio-staff-frame')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await staff.goto(`/studio?tab=review&section=requests&id=${encodeURIComponent(id)}`);
    await expect(staff.getByTestId('studio-desk-request-detail')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(staff.getByTestId('studio-desk-decision')).toBeVisible();
    await expect(staff.getByTestId('studio-desk-decision')).toContainText(usd(TOTAL_MINOR));
    await staff.getByTestId('studio-desk-approve').click();
    const sheet = staff.getByTestId('studio-desk-sheet-approve');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(usd(TOTAL_MINOR));
    await sheet.getByTestId('studio-desk-sheet-confirm').click();
    await expect(staff.getByTestId('studio-desk-outcome')).toHaveAttribute('data-decision', 'Approved', { timeout: BOOT_TIMEOUT });
    await expect(sheet).toHaveCount(0);
    return errors;
  } finally {
    await context.close();
  }
}

test.describe('Albayan Studio v2 money journey (pilot)', () => {
  test.beforeEach(() => {
    test.setTimeout(180_000);
  });

  for (const language of ['en', 'ar']) {
    test(`${language}: quick boost of 7 x $10 sent from the wizard -> Home reserves $70 -> My ads waits -> Withdraw -> Draft again, $70 available (RTL in Arabic, two taps from Home, no console errors)`, async ({ page, playwright, baseURL }, testInfo) => {
      fullMatrixOnly(testInfo);
      const words = WORDS[language];
      const seed = await seedMoneyCustomer(playwright, baseURL, testInfo, language);
      const errors = collectPageErrors(page);
      let nativeDialogs = 0;
      page.on('dialog', dialog => { nativeDialogs += 1; dialog.dismiss().catch(() => {}); });
      const taps = tapCounter();
      try {
        await page.setViewportSize(PHONE);
        await openHome(page, seed.customer, language);
        await expectDirection(page, language, 'Home');
        await expectStripEqualsServer(page, [TOP_UP_MINOR, 0, 0, 0], 'Home after the confirmed top-up');
        await expect(page.getByTestId('studio-money-available').locator('dt')).toHaveText(words.available);
        await expect(page.getByTestId('studio-money-reserved').locator('dt')).toHaveText(words.reserved);
        await expectNoPageOverflow(page, `Home (${language})`);

        // The wizard (one tap from Home), then Send.
        const id = await sendOwnTextBoost(page, { language, taps, words });
        await expectSentOnServer(seed.customerApi, id, words);

        // Home: Reserved $70.00, Available $30.00, exactly the server's numbers.
        await homeFromSent(page, taps, words);
        await expectDirection(page, language, 'Home after the send');
        await expectStripEqualsServer(page, [TOP_UP_MINOR - TOTAL_MINOR, TOTAL_MINOR, 0, 0], 'Home after the send');
        await expect(page.getByTestId(`studio-tracker-${id}`)).toContainText(words.waiting);

        // My ads (one tap): the request waits for review; its card (two taps) shows the reserve.
        await taps.tap(page.getByTestId('studio-nav-campaigns'), 'My ads');
        await expectCustomerTab(page, 'campaigns');
        const card = page.getByTestId(`studio-ad-${id}`);
        await expect(card).toHaveAttribute('data-stage', '2');
        await expect(card.locator('.studio-stage-chip')).toHaveText(words.waiting);
        await expect(card).toContainText(usd(TOTAL_MINOR));
        await expectDirection(page, language, 'My ads');
        await expectNoPageOverflow(page, `My ads (${language})`);
        await taps.tap(card, 'the request');
        await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(id);
        const detail = page.getByTestId('studio-ad-detail');
        await expect(detail).toHaveAttribute('data-stage', '2');
        await expect(detail.locator('.studio-stage-chip')).toHaveText(words.waiting);
        await expect(page.getByTestId('studio-ad-track')).toHaveAttribute('data-step', 'sent');
        await expect(page.getByTestId('studio-ad-reserved')).toContainText(words.reservedRow);
        await expect(page.getByTestId('studio-ad-reserved')).toContainText(usd(TOTAL_MINOR));
        await expect(page.getByTestId('studio-ad-money'), 'daily x days is spelled out').toContainText(`${usd(DAILY_MINOR)} × ${DAYS}`);
        await expect(page.getByTestId('studio-ad-chain'), 'nothing paid before an approval').toHaveCount(0);
        await expect.poll(() => actionIds(page)).toEqual(['withdraw', 'ask']);
        await expectNoPageOverflow(page, `request detail (${language})`);

        // Back on Home, the tracker row (one tap) opens the request and Withdraw (two taps) opens the sheet.
        await page.getByTestId('studio-nav-home').click();
        await expectCustomerTab(page, 'home');
        taps.home();
        await taps.tap(page.getByTestId(`studio-tracker-${id}`), 'the request from its tracker');
        await expect(detail).toBeVisible();
        await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(id);
        await taps.tap(page.getByTestId('studio-ad-action-withdraw'), 'the Withdraw sheet');
        const sheet = page.getByTestId('studio-sheet-withdraw');
        await expect(sheet).toBeVisible();
        await expect(sheet).toContainText(words.withdrawTitle);
        await expect(sheet).toContainText(usd(TOTAL_MINOR));
        expect(await sheet.evaluate(el => getComputedStyle(el).direction), 'the sheet follows the language').toBe(language === 'ar' ? 'rtl' : 'ltr');
        await page.getByTestId('studio-sheet-confirm').click();
        await expect(sheet).toHaveCount(0);

        // Draft again: the request, the server and the money.
        await expect(detail).toHaveAttribute('data-stage', '1');
        await expect(detail.locator('.studio-stage-chip')).toHaveText(words.draft);
        await expect(page.getByTestId('studio-ad-reserved')).toHaveCount(0);
        expect((await readRequest(seed.customerApi, id)).data.status).toBe('Draft');
        expect(fourNumbers(await jsonOrThrow(await seed.customerApi.get('/api/studio/wallet/summary'), 'The summary after the withdraw'))).toEqual([TOP_UP_MINOR, 0, 0, 0]);
        await page.getByTestId('studio-nav-home').click();
        await expectCustomerTab(page, 'home');
        taps.home();
        await expectDirection(page, language, 'Home after the withdraw');
        await expect(page.getByTestId('studio-money-reserved')).toHaveAttribute('data-minor', '0');
        await expectStripEqualsServer(page, [TOP_UP_MINOR, 0, 0, 0], 'Home after the withdraw');
        await expect(page.getByTestId(`studio-tracker-${id}`), 'a draft is not "an ad now"').toHaveCount(0);

        // The wallet (one tap) says the same.
        await taps.tap(page.getByTestId('studio-home-wallet-link'), 'the wallet');
        await expectCustomerTab(page, 'wallet');
        await expect(page.getByTestId('studio-wallet-numbers')).toBeVisible();
        await expect(page.getByTestId('studio-wallet-available-amount')).toHaveText(usd(TOP_UP_MINOR));
        await expect(page.getByTestId('studio-wallet-reserved-amount')).toHaveText(usd(0));
        await expectDirection(page, language, 'Wallet');
        if (language === 'ar') for (const text of await page.getByTestId('studio-screen-wallet').allInnerTexts()) expect(text).toMatch(ARABIC);
        expect(nativeDialogs, 'no native confirm/prompt/alert').toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await seed.customerApi.dispose();
      }
    });
  }

  test('send -> a reviewer approves on the Team desk -> the customer sees "In your ads $70" -> a staff stop of the never-linked ad (the real route) returns it all; the strip equals the wallet summary at every step', async ({ page, browser, contextOptions, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const words = WORDS.en;
    const seed = await seedMoneyCustomer(playwright, baseURL, testInfo, 'staff');
    const errors = collectPageErrors(page);
    let nativeDialogs = 0;
    page.on('dialog', dialog => { nativeDialogs += 1; dialog.dismiss().catch(() => {}); });
    const taps = tapCounter();
    let reviewerApi = null;
    try {
      await page.setViewportSize(PHONE);
      await openHome(page, seed.customer, 'en');
      await expectStripEqualsServer(page, [TOP_UP_MINOR, 0, 0, 0], 'Home after the confirmed top-up');

      // Send: $70.00 reserved.
      const id = await sendOwnTextBoost(page, { language: 'en', taps, words });
      await expectSentOnServer(seed.customerApi, id, words);
      await homeFromSent(page, taps, words);
      await expectStripEqualsServer(page, [TOP_UP_MINOR - TOTAL_MINOR, TOTAL_MINOR, 0, 0], 'Home after the send');

      // The reviewer approves on the desk: the reserve becomes the ad's payment.
      const staffErrors = await approveOnDesk(browser, contextOptions, baseURL, seed.reviewer, id);
      expect(staffErrors, 'the Team desk logged no errors').toEqual([]);
      const approved = await readRequest(seed.customerApi, id);
      expect(approved.data.status).toBe('Approved');
      expect(approved.data.paidMinorUSD).toBe(TOTAL_MINOR);
      expect(fourNumbers(await jsonOrThrow(await seed.customerApi.get('/api/studio/wallet/summary'), 'The summary after the approval'))).toEqual([TOP_UP_MINOR - TOTAL_MINOR, 0, TOTAL_MINOR, 0]);

      // The customer reopens the app: "In your ads $70.00", nothing reserved, no "Meta used" before a link.
      await reopenHome(page, 'en');
      await expect(page.getByTestId('studio-money-in-ads')).toHaveAttribute('data-minor', String(TOTAL_MINOR), { timeout: BOOT_TIMEOUT });
      await expect(page.getByTestId('studio-money-in-ads').locator('dt')).toHaveText(words.inAds);
      await expect(page.getByTestId('studio-money-in-ads').locator('.studio-home-money-value')).toHaveText(usd(TOTAL_MINOR));
      await expectStripEqualsServer(page, [TOP_UP_MINOR - TOTAL_MINOR, 0, TOTAL_MINOR, 0], 'Home after the approval');
      await expect(page.getByTestId('studio-money-meta-used'), 'no "Meta used" line before a Meta link').toHaveCount(0);
      taps.home();
      await taps.tap(page.getByTestId(`studio-tracker-${id}`), 'the approved request');
      const detail = page.getByTestId('studio-ad-detail');
      await expect(detail).toHaveAttribute('data-stage', '4');
      await expect(detail.locator('.studio-stage-chip')).toHaveText(words.approved);
      const paid = page.locator('[data-testid="studio-ad-chain"][data-bucket="inAds"]');
      await expect(paid).toHaveCount(1);
      await expect(paid).toContainText(words.inAds);
      await expect(paid).toContainText(usd(TOTAL_MINOR));
      await expect(page.getByTestId('studio-ad-reserved')).toHaveCount(0);
      await expect(page.getByTestId('studio-ad-meta-used')).toHaveCount(0);
      await expect.poll(() => actionIds(page)).toEqual(['stop', 'ask_stop', 'ask']);

      // A staff stop (the real route, the reviewer's own session) of an ad that was never linked to
      // Meta: the server returns the whole payment on its own (settleBasis never_linked). This is the
      // never-linked STAFF rule; the customer's own stop before the start date is the next test.
      reviewerApi = await openUserApi(playwright, baseURL, seed.reviewer);
      const current = await readRequest(reviewerApi, id);
      const stopped = await jsonOrThrow(await reviewerApi.post(`/api/ad-studio/campaigns/${encodeURIComponent(id)}/stop`, {
        data: { expectedLastModified: current.lastModified, operationId: `e2e-money-stop-${seed.tag}`, closeReason: 'staff_stop' }
      }), 'The staff stop');
      expect(stopped.data).toMatchObject({ status: 'Stopped', closeReason: 'staff_stop', refundMinorUSD: TOTAL_MINOR, settleBasis: 'never_linked' });
      expect(fourNumbers(await jsonOrThrow(await seed.customerApi.get('/api/studio/wallet/summary'), 'The summary after the stop'))).toEqual([TOP_UP_MINOR, 0, 0, 0]);

      // The customer: the whole $70.00 is available again; the request is stopped, its money came back in full.
      await reopenHome(page, 'en');
      await expect(page.getByTestId('studio-money-available')).toHaveAttribute('data-minor', String(TOP_UP_MINOR), { timeout: BOOT_TIMEOUT });
      await expectStripEqualsServer(page, [TOP_UP_MINOR, 0, 0, 0], 'Home after the staff stop');
      taps.home();
      await taps.tap(page.getByTestId('studio-nav-campaigns'), 'My ads');
      await expectCustomerTab(page, 'campaigns');
      await page.getByTestId('studio-ads-filter-finished').click();
      const card = page.getByTestId(`studio-ad-${id}`);
      await expect(card).toHaveAttribute('data-stage', '12');
      await expect(card.locator('.studio-stage-chip')).toHaveText(words.stopped);
      await card.click();
      await expect(detail).toHaveAttribute('data-stage', '12');
      await expect(page.getByTestId('studio-ad-chain')).toContainText(words.returnedInFull);
      await expect(page.getByTestId('studio-ad-chain')).toContainText(usd(TOTAL_MINOR));
      await expect(page.getByTestId('studio-ad-reserved')).toHaveCount(0);
      await expectNoPageOverflow(page, 'stopped request');

      // Arabic: the same numbers, right to left.
      await setLanguage(page, 'ar');
      await expectDirection(page, 'ar', 'stopped request (AR)');
      await expect(detail.locator('.studio-stage-chip')).toHaveText(WORDS.ar.stopped);
      await expect(page.getByTestId('studio-ad-chain')).toContainText(WORDS.ar.returnedInFull);
      await page.getByTestId('studio-nav-home').click();
      await expectCustomerTab(page, 'home');
      await expect(page.getByTestId('studio-money-in-ads').locator('dt')).toHaveText(WORDS.ar.inAds);
      await expectStripEqualsServer(page, [TOP_UP_MINOR, 0, 0, 0], 'Home after the staff stop (AR)');
      await expectNoPageOverflow(page, 'Home after the staff stop (AR)');
      expect(nativeDialogs, 'no native confirm/prompt/alert').toBe(0);
      expect(errors).toEqual([]);
    } finally {
      if (reviewerApi) await reviewerApi.dispose();
      await seed.customerApi.dispose();
    }
  });

  test('send -> a reviewer approves -> the customer stops the ad before its start date from the app (Stop -> sheet -> confirm) -> Stopped, the whole $70 back; the strip equals the wallet summary', async ({ page, browser, contextOptions, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const words = WORDS.en;
    const seed = await seedMoneyCustomer(playwright, baseURL, testInfo, 'own');
    const errors = collectPageErrors(page);
    let nativeDialogs = 0;
    page.on('dialog', dialog => { nativeDialogs += 1; dialog.dismiss().catch(() => {}); });
    const taps = tapCounter();
    try {
      await page.setViewportSize(PHONE);
      await openHome(page, seed.customer, 'en');
      await expectStripEqualsServer(page, [TOP_UP_MINOR, 0, 0, 0], 'Home after the confirmed top-up');

      // Send, then the reviewer approves on the desk: $70.00 paid, nothing reserved.
      const id = await sendOwnTextBoost(page, { language: 'en', taps, words });
      await expectSentOnServer(seed.customerApi, id, words);
      await homeFromSent(page, taps, words);
      await expectStripEqualsServer(page, [TOP_UP_MINOR - TOTAL_MINOR, TOTAL_MINOR, 0, 0], 'Home after the send');
      const staffErrors = await approveOnDesk(browser, contextOptions, baseURL, seed.reviewer, id);
      expect(staffErrors, 'the Team desk logged no errors').toEqual([]);
      const approved = await readRequest(seed.customerApi, id);
      expect(approved.data.status).toBe('Approved');
      expect(approved.data.startDate, 'the quick boost starts on its send day, so the customer may still stop it').toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(fourNumbers(await jsonOrThrow(await seed.customerApi.get('/api/studio/wallet/summary'), 'The summary after the approval'))).toEqual([TOP_UP_MINOR - TOTAL_MINOR, 0, TOTAL_MINOR, 0]);

      // The customer reopens the app: the approved ad (one tap), then Stop (two taps) opens the sheet
      // that names the whole payment; confirming it is the customer's own stop through the real route.
      await reopenHome(page, 'en');
      await expect(page.getByTestId('studio-money-in-ads')).toHaveAttribute('data-minor', String(TOTAL_MINOR), { timeout: BOOT_TIMEOUT });
      await expectStripEqualsServer(page, [TOP_UP_MINOR - TOTAL_MINOR, 0, TOTAL_MINOR, 0], 'Home after the approval');
      taps.home();
      await taps.tap(page.getByTestId(`studio-tracker-${id}`), 'the approved request');
      const detail = page.getByTestId('studio-ad-detail');
      await expect(detail).toHaveAttribute('data-stage', '4');
      await expect.poll(() => actionIds(page)).toEqual(['stop', 'ask_stop', 'ask']);
      await taps.tap(page.getByTestId('studio-ad-action-stop'), 'the Stop sheet');
      const sheet = page.getByTestId('studio-sheet-stop');
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText(words.stopTitle);
      await expect(sheet).toContainText(usd(TOTAL_MINOR));
      await expect(sheet.getByTestId('studio-sheet-confirm')).toHaveText(words.stopConfirm);
      await page.getByTestId('studio-sheet-confirm').click();
      await expect(sheet).toHaveCount(0);

      // Stopped: the request on screen and on the server, the whole $70.00 back, nothing held.
      await expect(detail).toHaveAttribute('data-stage', '12');
      await expect(detail.locator('.studio-stage-chip')).toHaveText(words.stopped);
      await expect(page.getByTestId('studio-ad-chain')).toContainText(words.returnedInFull);
      await expect(page.getByTestId('studio-ad-chain')).toContainText(usd(TOTAL_MINOR));
      await expect(page.getByTestId('studio-ad-reserved')).toHaveCount(0);
      await expect.poll(() => actionIds(page)).toEqual(['archive']);
      const stopped = await readRequest(seed.customerApi, id);
      expect(stopped.data).toMatchObject({ status: 'Stopped', closeReason: 'customer_stop', refundMinorUSD: TOTAL_MINOR, spendMinorUSD: 0 });
      expect(fourNumbers(await jsonOrThrow(await seed.customerApi.get('/api/studio/wallet/summary'), 'The summary after the customer stop'))).toEqual([TOP_UP_MINOR, 0, 0, 0]);
      await expectNoPageOverflow(page, 'stopped request (own stop)');

      // Home: exactly the server's numbers, the whole top-up available again; a stopped ad is not "an ad now".
      await page.getByTestId('studio-nav-home').click();
      await expectCustomerTab(page, 'home');
      await expectStripEqualsServer(page, [TOP_UP_MINOR, 0, 0, 0], 'Home after the customer stop');
      await expect(page.getByTestId('studio-money-in-ads').locator('.studio-home-money-value')).toHaveText(usd(0));
      await expect(page.getByTestId(`studio-tracker-${id}`)).toHaveCount(0);
      expect(nativeDialogs, 'no native confirm/prompt/alert').toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await seed.customerApi.dispose();
    }
  });

  test('smoke: the confirmed top-up shows on Home as the server says, on this browser', async ({ page, playwright, baseURL }, testInfo) => {
    test.skip(testInfo.project.name === FULL_MATRIX_PROJECT, 'mobile-chromium runs the full journeys above');
    const seed = await seedMoneyCustomer(playwright, baseURL, testInfo, 'smoke');
    const errors = collectPageErrors(page);
    try {
      await openHome(page, seed.customer, 'en');
      await expectStripEqualsServer(page, [TOP_UP_MINOR, 0, 0, 0], `Home on ${testInfo.project.name}`);
      await expect(page.getByTestId('studio-goal-grow')).toBeEnabled();
      await expectNoPageOverflow(page, `Home on ${testInfo.project.name}`);
      expect(errors).toEqual([]);
    } finally {
      await seed.customerApi.dispose();
    }
  });
});
