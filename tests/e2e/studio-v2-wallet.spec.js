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
  studioMe
} = require('./helpers/studio-v2');

// Albayan Studio v2 Wallet (P2-06) and Account (P2-07) journeys, 15m-studio-wallet.js. Every project
// makes its OWN pilot customers (helpers/studio-v2.js); the money comes through the real routes: a
// payment request made on the screen and confirmed by the e2e admin, an admin credit, a request
// created, submitted and approved, and the e2e seed door for Meta's figures. The full matrix runs on
// mobile-chromium at 390 px; desktop-chromium and mobile-webkit run one smoke pass. Run with:
//   npx playwright test tests/e2e/studio-v2-wallet.spec.js --project=mobile-chromium

const FULL_MATRIX_PROJECT = 'mobile-chromium';
const BOOT_TIMEOUT = 20_000;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC';

function fullMatrixOnly(testInfo) {
  test.skip(testInfo.project.name !== FULL_MATRIX_PROJECT, 'The full wallet matrix runs on mobile-chromium (P2-13)');
}

// Money exactly as the screens print it (studioUsd / studioLyd in 15g).
function grouped(minor) {
  const abs = Math.abs(minor);
  return `${String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(abs % 100).padStart(2, '0')}`;
}
const usd = minor => (minor < 0 ? `-$${grouped(minor)}` : `$${grouped(minor)}`);
const lyd = (minor, language = 'en') => `${minor < 0 ? '-' : ''}${grouped(minor)} ${language === 'ar' ? 'د.ل' : 'LYD'}`;
// wallet_payments.lyd_minor_for: ceil(amount x rate), the rate rounded to 4 places.
const lydFor = (minor, rate) => Math.floor((minor * Math.floor(rate * 10000 + 0.5) + 9999) / 10000);

let setup = null;
let addedRateId = '';

// The project's pilot customers, and a dollar rate when the database has none (so a dollar
// payment request can say what to pay in dinars). The rate is dated long ago, so it never outranks
// a real one, and it is removed after the file.
function walletSetup(playwright, baseURL, testInfo) {
  if (!setup) {
    setup = (async () => {
      const admin = await openAdminApi(playwright, baseURL);
      try {
        // Short: the e-mail's local part must stay within 64 characters on every project.
        const tag = `${projectToken(testInfo).replace('chromium', 'cr').replace('webkit', 'wk')}-${Date.now().toString(36)}`;
        const users = {};
        for (const name of ['charge', 'ads', 'plan', 'account', 'layout']) users[name] = await createStudioUser(admin.api, 'customer', `w-${name}-${tag}`);
        await addToPilot(admin, { customers: Object.values(users).map(user => user.id) });
        const methods = await (await admin.api.get('/api/wallet/payment-requests/methods')).json();
        if (!methods.rate) {
          addedRateId = `e2e_wallet_rate_${tag}`.slice(0, 80);
          const made = await admin.api.post('/api/collections/exchangeRateHistory', {
            data: { id: addedRateId, data: { id: addedRateId, rate: 6.9, date: '2001-01-02T00:00:00.000Z', userId: admin.adminId } }
          });
          expect(made.ok(), `adding the e2e dollar rate: ${await made.text()}`).toBe(true);
        }
        return { users, tag };
      } finally {
        await admin.api.dispose();
      }
    })().catch(error => {
      setup = null;
      throw error;
    });
  }
  return setup;
}

test.afterAll(async ({ playwright, baseURL }) => {
  if (!addedRateId) return;
  const admin = await openAdminApi(playwright, baseURL);
  try {
    await admin.api.delete(`/api/collections/exchangeRateHistory/${encodeURIComponent(addedRateId)}`);
  } finally {
    addedRateId = '';
    await admin.api.dispose();
  }
});

// The page's own apiJson (the signed-in customer, the site's origin).
function pageApi(page, path, options = { method: 'GET' }) {
  return page.evaluate(({ path, options }) => apiJson(path, options), { path, options });
}

// GET /api/studio/me through the page. Right after sign-in the app's own navigation may cancel a
// read in flight (AbortError): that read is simply asked again.
async function readMe(page) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await studioMe(page);
    } catch (error) {
      if (attempt >= 4 || !/AbortError|signal is aborted/.test(String(error && error.message))) throw error;
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

async function openWallet(page, user) {
  await signInStudio(page, user);
  const me = await readMe(page);
  expect(me.ui, 'this pilot customer gets the v2 layout').toBe('v2');
  await expect(page.getByTestId('studio-v2-frame')).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.getByTestId('studio-nav-wallet').click();
  await expectCustomerTab(page, 'wallet');
  await expect(page.getByTestId('studio-wallet-numbers')).toBeVisible();
}

// The four numbers on screen are the server's own (GET /api/studio/wallet/summary).
async function expectNumbersFromServer(page) {
  const summary = await pageApi(page, '/api/studio/wallet/summary');
  const tiles = { available: summary.usd.availableMinor, reserved: summary.usd.reservedMinor, 'in-ads': summary.usd.inAdsMinor, spent: summary.usd.spentMinor };
  for (const [key, minor] of Object.entries(tiles)) await expect(page.getByTestId(`studio-wallet-${key}-amount`)).toHaveText(usd(minor));
  await expect(page.getByTestId('studio-wallet-lyd-amount')).toHaveText(lyd(summary.lyd.balanceMinor, await page.evaluate(() => state.language)));
  return summary;
}

async function adminCall(playwright, baseURL, fn) {
  const admin = await openAdminApi(playwright, baseURL);
  try {
    return await fn(admin);
  } finally {
    await admin.api.dispose();
  }
}

async function adminJson(response, label) {
  const body = await response.text();
  expect(response.ok(), `${label}: HTTP ${response.status()} ${body.slice(0, 300)}`).toBe(true);
  return body ? JSON.parse(body) : null;
}

test.describe('Albayan Studio v2 wallet and account (pilot)', () => {
  test.beforeEach(() => {
    test.setTimeout(120_000);
  });

  test('add money: purpose, amount, method, a confirm screen, then the PAY- code; the admin confirms and Available follows the server', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { users } = await walletSetup(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await openWallet(page, users.charge);
    const before = await expectNumbersFromServer(page);
    await expect(page.getByTestId('studio-wallet-meta-used'), 'no "Meta used" line without a linked ad').toHaveCount(0);
    await expect(page.getByTestId('studio-wallet-being-returned')).toHaveCount(0);
    await expect(page.getByTestId('studio-wallet-lyd')).not.toContainText('$');

    // Purpose first, then the amount (a ready amount), the method, and a confirm screen.
    await page.getByTestId('studio-wallet-add').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe('add-money');
    await expect(page.getByTestId('studio-wallet-add-step')).toHaveText('Step 1 of 4: Purpose');
    await page.getByTestId('studio-wallet-purpose-ads').click();
    await expect(page.getByTestId('studio-wallet-add-step')).toHaveText('Step 2 of 4: Amount');
    for (const minor of [1000, 2500, 5000, 10000]) await expect(page.getByTestId(`studio-wallet-preset-${minor}`)).toHaveText(usd(minor));
    await page.getByTestId('studio-wallet-add-next').click();
    await expect(page.locator('#studio-wallet-add-error')).toHaveText('Choose or type an amount.');
    await page.getByTestId('studio-wallet-preset-2500').click();
    await expect(page.getByTestId('studio-wallet-preset-2500')).toHaveAttribute('aria-pressed', 'true');
    const { rate } = await pageApi(page, '/api/wallet/payment-requests/methods');
    expect(rate && rate.usdToLyd, 'a dollar rate exists').toBeGreaterThan(0);
    await expect(page.locator('#studio-wallet-amount-help')).toHaveText(`= $25.00 · about ${lyd(lydFor(2500, rate.usdToLyd))} at today's rate (estimate)`);
    await page.getByTestId('studio-wallet-add-next').click();
    await expect(page.getByTestId('studio-wallet-add-step')).toHaveText('Step 3 of 4: Method');
    await page.getByTestId('studio-wallet-method-adfali').click();
    await expect(page.getByTestId('studio-wallet-add-step')).toHaveText('Step 4 of 4: Confirm');
    await expect(page.getByTestId('studio-wallet-confirm-purpose')).toHaveText('My ads (dollars)');
    await expect(page.getByTestId('studio-wallet-confirm-amount')).toHaveText('$25.00');
    await expect(page.getByTestId('studio-wallet-confirm-method')).toHaveText('Adfali');
    await expect(page.getByTestId('studio-wallet-confirm-lyd')).toContainText(lyd(lydFor(2500, rate.usdToLyd)));
    // Nothing exists on the server before the confirm button.
    expect((await pageApi(page, '/api/wallet/payment-requests')).requests).toHaveLength(0);

    await page.getByTestId('studio-wallet-create').click();
    await expect(page.getByTestId('studio-wallet-created')).toBeVisible();
    const reference = (await page.getByTestId('studio-wallet-created-reference').innerText()).trim();
    expect(reference).toMatch(/^PAY-[A-Z0-9]{8}$/);
    const mine = (await pageApi(page, '/api/wallet/payment-requests')).requests;
    expect(mine, 'exactly one payment request, whatever the taps').toHaveLength(1);
    const row = mine[0].data;
    expect([row.reference, row.amountMinor, row.currency, row.method, row.status]).toEqual([reference, 2500, 'USD', 'adfali', 'pending']);
    await expect(page.getByTestId('studio-wallet-created-amount')).toHaveText('$25.00');
    await expect(page.getByTestId('studio-wallet-created-lyd')).toHaveText(lyd(row.amountMinorLYD));
    await expect(page.getByTestId('studio-wallet-created-instruction')).toHaveText(
      `Pay ${grouped(row.amountMinorLYD)} LYD via Adfali and keep the code ${reference} in the payment note.`);

    // Back in the wallet: the waiting request with its code; it survives a reload (server truth).
    await page.getByTestId('studio-wallet-done').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(null);
    const pending = page.getByTestId('studio-wallet-pending-item');
    await expect(pending).toHaveCount(1);
    await expect(pending.getByTestId('studio-wallet-reference')).toHaveText(reference);
    await expect(pending).toContainText('Waiting for our confirmation');
    await expect(pending.getByTestId('studio-wallet-pending-amount')).toHaveText('$25.00');
    await page.reload();
    await expectCustomerTab(page, 'wallet', { frameTimeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-wallet-pending-item').getByTestId('studio-wallet-reference')).toHaveText(reference);

    // The admin confirms the payment; Refresh shows the server's new numbers.
    await adminCall(playwright, baseURL, async ({ api }) => {
      await adminJson(await api.post(`/api/wallet/payment-requests/${encodeURIComponent(mine[0].id)}/confirm`, { data: {} }), 'Confirming the payment');
    });
    await page.getByTestId('studio-wallet-refresh').click();
    await expect(page.getByTestId('studio-wallet-pending-item')).toHaveCount(0);
    await expect(page.getByTestId('studio-wallet-available-amount')).toHaveText(usd(before.usd.availableMinor + 2500));
    await expectNumbersFromServer(page);
    await expect(page.getByTestId('studio-wallet-history-item').first()).toContainText('Added to your wallet');
    await expectNoPageOverflow(page, 'wallet after a confirmed payment');
    expect(errors).toEqual([]);
  });

  test('money of each ad: grouped by ad, "Meta used" only once Meta is linked and checked', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { users, tag } = await walletSetup(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await adminCall(playwright, baseURL, async ({ api }) => {
      await adminJson(await api.post('/api/wallet/top-ups', {
        data: { userId: users.ads.id, amountMinor: 5000, currency: 'USD', idempotencyKey: `e2e-wallet-credit-${tag}` }
      }), 'The admin credit');
    });
    await openWallet(page, users.ads);
    await expect(page.getByTestId('studio-wallet-ads-empty')).toBeVisible();

    // A $20 request: created and submitted by the customer, approved by the admin.
    const name = `Wallet e2e ad ${tag}`.slice(0, 80);
    const created = await pageApi(page, '/api/collections/adCampaignRequests', { method: 'POST', body: { data: {
      name, objective: 'messages', platforms: ['facebook', 'instagram'], pageName: 'Wallet E2E Page',
      primaryText: 'Message us for this week\'s offer.', headline: 'Weekly offer', description: 'Wallet e2e.',
      callToAction: 'Send Message', destination: 'https://wa.me/218910000000', locations: ['Tripoli, Libya'],
      ageMin: 18, ageMax: 55, genders: ['all'], languages: ['Arabic'], interests: ['Shopping'],
      startDate: '2027-01-10', endDate: '2027-01-14', budgetMinorUSD: 2000, budgetType: 'lifetime',
      notes: '', specialAdCategories: ['none'], creativeImages: [PNG], creativeAssetIds: []
    } } });
    const submitted = await pageApi(page, `/api/ad-studio/campaigns/${encodeURIComponent(created.id)}/submit`, {
      method: 'POST', body: { expectedLastModified: created.lastModified, operationId: `e2e-wallet-submit-${tag}` }
    });
    await page.getByTestId('studio-wallet-refresh').click();
    await expect(page.getByTestId('studio-wallet-reserved-amount')).toHaveText('$20.00');
    await expect(page.getByTestId('studio-wallet-reserved-item')).toContainText(name);
    await adminCall(playwright, baseURL, async ({ api }) => {
      await adminJson(await api.post(`/api/ad-studio/campaigns/${encodeURIComponent(created.id)}/review`, {
        data: { expectedLastModified: submitted.lastModified, decision: 'Approved', note: '', operationId: `e2e-wallet-review-${tag}`, reviewReasonCode: '' }
      }), 'Approving the request');
    });
    await page.getByTestId('studio-wallet-refresh').click();
    await expect(page.getByTestId('studio-wallet-in-ads-amount')).toHaveText('$20.00');
    await expectNumbersFromServer(page);
    const card = page.locator(`[data-testid="studio-wallet-ad"][data-campaign="${created.id}"]`);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(name);
    await expect(card.getByTestId('studio-wallet-cycle')).toHaveAttribute('data-state', 'in_ads');
    await expect(card).toContainText(`Ad budget paid: ${name}`);
    await expect(page.getByTestId('studio-wallet-meta-used'), 'approved but not linked: no "Meta used"').toHaveCount(0);
    await expect(card.getByTestId('studio-wallet-ad-meta-used')).toHaveCount(0);

    // Meta linked and checked (the seed door writes what the results sync would): "Meta used" appears.
    const now = new Date().toISOString();
    await adminCall(playwright, baseURL, async ({ api }) => {
      await adminJson(await api.post('/api/studio/test/seed-results', { data: {
        campaignId: created.id,
        link: { metaAdAccountId: '9876543210', metaCampaignId: `12${String(Date.now()).slice(-10)}` },
        results: { lastSyncedAt: now, spendMinorUSD: 340, spendConfirmedAt: now, currency: 'USD', insightsState: 'ok', syncState: 'ok',
          campaignEffectiveStatus: 'ACTIVE', adStatusCounts: { ACTIVE: 1 }, anyAdDelivering: true }
      } }), 'Seeding Meta results');
    });
    await page.getByTestId('studio-wallet-refresh').click();
    await expect(page.getByTestId('studio-wallet-meta-used')).toHaveText(/^Meta used \$3\.40 so far · checked (just now|\d+ min ago)$/);
    await expect(card.getByTestId('studio-wallet-ad-meta-used')).toHaveText(/^Meta used \$3\.40 so far/);
    await expectNumbersFromServer(page);

    await setLanguage(page, 'ar');
    await expect(page.getByTestId('studio-wallet-meta-used')).toHaveText(/^استخدمت ميتا \$3\.40 حتى الآن/);
    await expect(page.getByTestId('studio-v2-frame')).toHaveAttribute('dir', 'rtl');
    await expectNoPageOverflow(page, 'wallet with an ad (AR)');
    expect(errors).toEqual([]);
  });

  test('dinars for the plan in Arabic: never "$", Arabic digits, the receipt step, and cancel through the in-page sheet', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { users } = await walletSetup(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    let nativeDialogs = 0;
    page.on('dialog', dialog => { nativeDialogs += 1; dialog.dismiss().catch(() => {}); });
    await page.setViewportSize(PHONE);
    await openWallet(page, users.plan);
    await setLanguage(page, 'ar');
    await expect(page.getByTestId('studio-wallet-lyd')).toContainText('رصيد الاشتراك (بالدينار)');
    await expect(page.getByTestId('studio-wallet-lyd-amount')).toHaveText(/ د\.ل$/);

    await page.getByTestId('studio-wallet-add-lyd').click();
    await expect(page.getByTestId('studio-wallet-add-step')).toHaveText('الخطوة 2 من 4: المبلغ');
    await page.locator('#studio-wallet-amount').fill('٥٠');
    await expect(page.locator('#studio-wallet-amount-help')).toHaveText('= 50.00 د.ل');
    await page.getByTestId('studio-wallet-add-next').click();
    await page.getByTestId('studio-wallet-method-bank_transfer').click();
    await expect(page.getByTestId('studio-wallet-confirm-amount')).toHaveText('50.00 د.ل');
    await expect(page.getByTestId('studio-wallet-confirm-lyd')).toHaveCount(0);
    await expect(page.getByTestId('studio-wallet-confirm')).not.toContainText('$');
    await page.getByTestId('studio-wallet-create').click();
    await expect(page.getByTestId('studio-wallet-created')).toBeVisible();
    await expect(page.getByTestId('studio-wallet-created-amount')).toHaveText('50.00 د.ل');
    await expect(page.getByTestId('studio-wallet-created')).not.toContainText('$');
    await expect(page.getByTestId('studio-wallet-created').getByTestId('studio-wallet-receipt')).toBeVisible();
    const reference = (await page.getByTestId('studio-wallet-created-reference').innerText()).trim();
    await expect(page.getByTestId('studio-wallet-created-instruction')).toHaveText(`حوّل 50.00 د.ل واكتب ${reference} في بيان الحوالة ثم أرفق صورة الإيصال هنا.`);
    const [row] = (await pageApi(page, '/api/wallet/payment-requests')).requests;
    expect([row.data.currency, row.data.amountMinor, row.data.method]).toEqual(['LYD', 5000, 'bank_transfer']);

    // In the wallet: the dinar request, then Cancel asks in the in-page sheet (Escape keeps it).
    await page.getByTestId('studio-wallet-done').click();
    const pending = page.locator('[data-testid="studio-wallet-pending-item"][data-currency="LYD"]');
    await expect(pending).toContainText('50.00 د.ل');
    await expect(pending).not.toContainText('$');
    await pending.getByTestId('studio-wallet-cancel').click();
    const sheet = page.getByTestId('studio-wallet-cancel-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('role', 'alertdialog');
    await expect(sheet).toContainText(reference);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(pending).toHaveCount(1);
    await pending.getByTestId('studio-wallet-cancel').click();
    await page.getByTestId('studio-sheet-confirm').click();
    await expect(page.getByTestId('studio-wallet-pending-item')).toHaveCount(0);
    await expect(page.locator('[data-testid="studio-wallet-history-item"][data-status="canceled"]')).toContainText(reference);
    const after = (await pageApi(page, '/api/wallet/payment-requests')).requests;
    expect(after.map(item => item.data.status)).toEqual(['canceled']);
    expect(nativeDialogs, 'no native confirm/prompt/alert').toBe(0);
    for (const text of await page.getByTestId('studio-screen-wallet').allInnerTexts()) expect(text).toMatch(ARABIC);
    await expectNoPageOverflow(page, 'wallet in Arabic');
    expect(errors).toEqual([]);
  });

  test('account: name read only, WhatsApp saved only with consent (E.164), kept after a reload, removal asks first; language; sign out', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { users } = await walletSetup(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await signInStudio(page, users.account);
    await expect(page.getByTestId('studio-v2-frame')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await page.getByTestId('studio-nav-account').click();
    await expect(page.getByTestId('studio-screen-account')).toBeVisible();
    const userName = await page.evaluate(() => state.currentUser.name);
    await expect(page.getByTestId('studio-account-name')).toHaveText(userName);
    await expect(page.getByTestId('studio-account-name').locator('input')).toHaveCount(0);
    await expect(page.getByTestId('studio-account-whatsapp-none')).toBeVisible();
    // P5-07: the customer terms (the terms section of the privacy page) next to Privacy.
    await expect(page.getByTestId('studio-account-terms')).toHaveAttribute('href', '/privacy#terms');
    await expect(page.getByTestId('studio-account-terms')).toHaveText(/Customer terms/);
    const termsPage = await page.request.get('/privacy');
    expect(termsPage.ok(), 'the privacy page answers on the studio site').toBe(true);
    expect(await termsPage.text()).toContain('id="terms"');

    await page.getByTestId('studio-account-whatsapp-add').click();
    await page.locator('#studio-account-whatsapp').fill('091 234 5678');
    await expect(page.locator('#studio-account-whatsapp-help')).toHaveText('We will save it as +218912345678.');
    await page.getByTestId('studio-account-whatsapp-save').click();
    await expect(page.getByTestId('studio-account-whatsapp-error')).toHaveText('Tick the box to allow us to contact you on WhatsApp.');
    expect((await pageApi(page, '/api/studio/profile')).whatsappNumber, 'nothing stored without consent').toBe(null);

    await page.locator('#studio-account-whatsapp-consent').check();
    await page.getByTestId('studio-account-whatsapp-save').click();
    await expect(page.getByTestId('studio-account-whatsapp-number')).toHaveText('+218912345678');
    expect((await pageApi(page, '/api/studio/profile')).whatsappNumber).toBe('+218912345678');
    await page.goto('/studio?tab=account');
    await expect(page.getByTestId('studio-account-whatsapp-number')).toHaveText('+218912345678', { timeout: BOOT_TIMEOUT });

    await page.getByTestId('studio-account-whatsapp-remove').click();
    const sheet = page.getByTestId('studio-account-remove-sheet');
    await expect(sheet).toBeVisible();
    await page.getByTestId('studio-sheet-confirm').click();
    await expect(page.getByTestId('studio-account-whatsapp-none')).toBeVisible();
    expect((await pageApi(page, '/api/studio/profile')).whatsappNumber).toBe(null);

    await page.getByTestId('studio-account-language').click();
    await expect(page.getByTestId('studio-v2-frame')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('studio-account-whatsapp')).toContainText('واتساب (اختياري)');
    await expectNoPageOverflow(page, 'account (AR)');
    // Sign out runs the app's own flow: the session ends and the sign-in screen (or its account chooser) shows.
    await page.getByTestId('studio-account-logout').click();
    await page.waitForFunction(() => typeof state !== 'undefined' && !state.currentUser);
    await expect(page.getByTestId('studio-v2-frame')).toHaveCount(0);
    await expect(page.locator('#login-form').or(page.getByRole('button', { name: 'إضافة حساب آخر', exact: true }))).toBeVisible();
    expect(errors).toEqual([]);
  });

  for (const [language, theme] of [['en', 'light'], ['ar', 'dark']]) {
    test(`wallet, Add money and account fit 320-820 px with 44 px controls (${language}, ${theme})`, async ({ page, playwright, baseURL }, testInfo) => {
      fullMatrixOnly(testInfo);
      const { users, tag } = await walletSetup(playwright, baseURL, testInfo);
      const errors = collectPageErrors(page);
      await adminCall(playwright, baseURL, async ({ api }) => {
        await adminJson(await api.post('/api/wallet/top-ups', {
          data: { userId: users.layout.id, amountMinor: 123456789, currency: 'USD', idempotencyKey: `e2e-wallet-layout-${language}-${tag}` }
        }), 'A large admin credit');
      });
      await page.setViewportSize(PHONE);
      await openWallet(page, users.layout);
      await page.evaluate(({ language, theme }) => {
        if (state.language !== language) toggleLanguage();
        shellSetTheme(theme);
      }, { language, theme });
      await expect(page.getByTestId('studio-v2-frame')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
      const screens = [
        ['wallet', () => page.evaluate(() => studioV2Go({ tab: 'wallet' }))],
        ['add', () => page.evaluate(() => studioWalletOpenAdd('ads'))],
        ['account', () => page.evaluate(() => studioV2Open('account'))]
      ];
      for (const [name, open] of screens) {
        await open();
        await expect(page.getByTestId(name === 'account' ? 'studio-screen-account' : 'studio-screen-wallet')).toBeVisible();
        if (name === 'wallet') await expect(page.getByTestId('studio-wallet-numbers')).toBeVisible();
        for (const width of [320, 360, 390, 412, 820]) {
          await page.setViewportSize({ width, height: 800 });
          const layout = await page.evaluate(() => {
            const inside = element => { const box = element.getBoundingClientRect(); return box.width === 0 || (box.left >= -1 && box.right <= innerWidth + 1); };
            const frame = '[data-testid="studio-v2-frame"]';
            return {
              overflow: document.documentElement.scrollWidth - innerWidth,
              outside: [...document.querySelectorAll(`${frame} button, ${frame} h1, ${frame} h2, ${frame} p, ${frame} dd, ${frame} input, ${frame} label`)]
                .filter(element => !inside(element)).map(element => (element.getAttribute('data-testid') || element.textContent).trim().slice(0, 40)),
              small: [...document.querySelectorAll(`${frame} button, ${frame} label.studio-v2-action, ${frame} a.studio-v2-row`)].filter(element => {
                const box = element.getBoundingClientRect();
                return box.width > 0 && (box.width < 43.5 || box.height < 43.5);
              }).map(element => element.getAttribute('data-testid') || element.textContent.trim().slice(0, 30))
            };
          });
          expect(layout.overflow, `${name} overflows at ${width}px`).toBeLessThanOrEqual(1);
          expect(layout.outside, `${name} at ${width}px`).toEqual([]);
          expect(layout.small, `${name} touch targets at ${width}px`).toEqual([]);
        }
        await page.setViewportSize(PHONE);
      }
      // A seven-figure balance wraps inside its tile instead of widening the page (checked above).
      await page.evaluate(() => studioV2Go({ tab: 'wallet' }));
      const summary = await expectNumbersFromServer(page);
      expect(summary.usd.availableMinor).toBeGreaterThanOrEqual(123456789);
      expect(errors).toEqual([]);
    });
  }

  test('smoke: wallet numbers from the server and the account screen on this browser', async ({ page, playwright, baseURL }, testInfo) => {
    test.skip(testInfo.project.name === FULL_MATRIX_PROJECT, 'mobile-chromium runs the full matrix above');
    const { users } = await walletSetup(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await openWallet(page, users.charge);
    await expectNumbersFromServer(page);
    await page.getByTestId('studio-nav-account').click();
    await expect(page.getByTestId('studio-account-whatsapp')).toBeVisible();
    await expect(page.getByTestId('studio-account-whatsapp-none')).toBeVisible();
    await expectNoPageOverflow(page, `wallet and account on ${testInfo.project.name}`);
    expect(errors).toEqual([]);
  });
});
