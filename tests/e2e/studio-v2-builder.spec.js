const zlib = require('zlib');
const { test, expect } = require('@playwright/test');
const {
  ARABIC,
  PHONE,
  addToPilot,
  collectPageErrors,
  createStudioUser,
  expectNoPageOverflow,
  openAdminApi,
  projectToken,
  setLanguage,
  signInStudio,
  studioMe,
  tabParam
} = require('./helpers/studio-v2');

// Albayan Studio v2 request builder (plan tasks P2-05a-e): the quick boost and the full request in
// a real browser, against the e2e server (ALBAYAN_STUDIO_V2=pilot). Each project makes its OWN pilot
// customers (helpers/studio-v2.js), funds them through the admin top-up route and, for the Fix
// journey, has the e2e admin send a request back through the real review route.
//
// The full matrix runs on mobile-chromium at 390 px; desktop-chromium and mobile-webkit run one smoke
// pass. Run only this file with:
//   npx playwright test tests/e2e/studio-v2-builder.spec.js --project=mobile-chromium

const FULL_MATRIX_PROJECT = 'mobile-chromium';
const BOOT_TIMEOUT = 20_000;
const POST_LINK = 'https://www.facebook.com/albayan.e2e/posts/1234567890';

function fullMatrixOnly(testInfo) {
  test.skip(testInfo.project.name !== FULL_MATRIX_PROJECT, 'The builder matrix runs on mobile-chromium (P2-13)');
}

// A small solid PNG (the photo path compresses whatever it gets; the server checks the result).
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

async function jsonOk(response, label) {
  const text = await response.text();
  if (!response.ok()) throw new Error(`${label} failed with HTTP ${response.status()}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// Dedicated pilot customers per project (per worker): funded, broke, and one for the Fix journey.
let builderUsers = null;
function studioUsers(playwright, baseURL, testInfo) {
  if (!builderUsers) {
    builderUsers = (async () => {
      const admin = await openAdminApi(playwright, baseURL);
      try {
        // Short tags: an email name may have at most 64 characters.
        const tag = `${projectToken(testInfo)}-${Date.now().toString(36)}`;
        const funded = await createStudioUser(admin.api, 'customer', `bf-${tag}`);
        const broke = await createStudioUser(admin.api, 'customer', `bb-${tag}`);
        const fixer = await createStudioUser(admin.api, 'customer', `bx-${tag}`);
        await addToPilot(admin, { customers: [funded.id, broke.id, fixer.id] });
        for (const [user, amountMinor] of [[funded, 30000], [fixer, 20000]]) {
          await jsonOk(await admin.api.post('/api/wallet/top-ups', {
            data: { userId: user.id, amountMinor, currency: 'USD', idempotencyKey: `e2e-builder-topup-${user.id}`, memo: 'E2E builder top-up' }
          }), `Funding ${user.email}`);
        }
        return { funded, broke, fixer };
      } finally {
        await admin.api.dispose();
      }
    })().catch(error => {
      builderUsers = null;
      throw error;
    });
  }
  return builderUsers;
}

async function openPilot(page, user) {
  await signInStudio(page, user);
  const me = await studioMe(page);
  expect(me.ui, 'the server puts this pilot customer on the v2 layout').toBe('v2');
  await expect(page.getByTestId('studio-v2-frame')).toBeVisible({ timeout: BOOT_TIMEOUT });
  // The sign-in flow restores the requested view once its data is in (it rewrites the address and
  // cancels the page's reads): the journeys start after that, like a person would.
  await page.waitForFunction(() => typeof _postLoginRoutePromise === 'undefined' || _postLoginRoutePromise === null, null, { timeout: BOOT_TIMEOUT });
}

const param = (page, name) => new URL(page.url()).searchParams.get(name);

// The shell reads an address without a section as a full request (the app's start-up rewrite after
// sign-in keeps only ?tab=), so a full request may show either; a quick boost always names itself.
async function expectStep(page, section, step) {
  await expect.poll(() => tabParam(page)).toBe('builder');
  await expect.poll(() => param(page, 'step')).toBe(String(step));
  const allowed = section === 'full' ? ['full', null] : [section];
  await expect.poll(() => allowed.includes(param(page, 'section'))).toBe(true);
  await expect(page.getByTestId('studio-builder')).toHaveAttribute('data-kind', section);
  await expect(page.getByTestId('studio-builder')).toHaveAttribute('data-step', String(step));
}

// Every change is on the server: nothing waiting, nothing on its way, the last save succeeded.
async function waitSaved(page) {
  await expect.poll(() => page.evaluate(() => {
    const session = _studioBuilder.session;
    return !!session && session.created && !session.dirty && !session.timer && !session.inFlight && session.status === 'saved';
  }), { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId('studio-builder-save')).toHaveAttribute('data-state', 'saved');
}

// The customer's own API session (the site's Origin, like the browser), for reads and set-up. The
// page's own requests are left alone: the app cancels a page's calls when it moves (after sign-in it
// restores the requested view once).
const userApis = new Map();
function userApi(playwright, baseURL, user) {
  if (!userApis.has(user.id)) {
    userApis.set(user.id, (async () => {
      const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } });
      await jsonOk(await api.post('/api/auth/login', { data: { email: user.email, password: user.password } }), `Signing in ${user.email}`);
      return api;
    })());
  }
  return userApis.get(user.id);
}

test.afterAll(async () => {
  for (const pending of userApis.values()) {
    try { await (await pending).dispose(); } catch (_) { /* already gone */ }
  }
  userApis.clear();
});

// The request as the server has it (with its photos).
async function readRequest(api, id) {
  return jsonOk(await api.get(`/api/collections/adCampaignRequests/${encodeURIComponent(id)}`), 'Reading the request');
}

async function walletSummary(api) {
  return jsonOk(await api.get('/api/studio/wallet/summary'), 'Reading the wallet summary');
}

function openDraftId(page) {
  return page.evaluate(() => String((_studioBuilder.session && _studioBuilder.session.id) || ''));
}

// Home: ?tab= is empty, the pinned 'dashboard' id or 'home' (PLAN.md §5.1).
async function expectHome(page) {
  await expect.poll(() => [null, 'dashboard', 'home'].includes(tabParam(page))).toBe(true);
  await expect(page.getByTestId('studio-screen-home')).toBeVisible();
}

function uniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 14)}`;
}

// No sideways scroll, every control inside the screen and at least 44 px (the frame spec's rule).
async function builderLayout(page) {
  return page.evaluate(() => {
    const inside = element => { const box = element.getBoundingClientRect(); return box.width === 0 || (box.left >= -1 && box.right <= innerWidth + 1); };
    const frame = '[data-testid="studio-v2-frame"]';
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      outside: [...document.querySelectorAll(`${frame} button, ${frame} h1, ${frame} h2, ${frame} p, ${frame} input, ${frame} select, ${frame} textarea`)]
        .filter(element => !inside(element)).map(element => (element.getAttribute('data-testid') || element.id || element.textContent.trim()).slice(0, 40)),
      small: [...document.querySelectorAll(`${frame} button`)].filter(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.width < 43.5 || box.height < 43.5);
      }).map(element => element.getAttribute('data-testid') || element.textContent.trim().slice(0, 30))
    };
  });
}

test.describe('Albayan Studio v2 request builder (pilot)', () => {
  test.beforeEach(() => {
    test.setTimeout(120_000);
  });

  test('quick boost submits end to end in Arabic at 390 px (pasted post link, Arabic digits, money reserved)', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { funded } = await studioUsers(playwright, baseURL, testInfo);
    const api = await userApi(playwright, baseURL, funded);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await openPilot(page, funded);
    await setLanguage(page, 'ar');
    const before = await walletSummary(api);

    await page.goto('/studio?tab=builder&section=boost');
    await expect(page.getByTestId('studio-builder')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expectStep(page, 'boost', 1);
    await expect(page.getByTestId('studio-v2-frame')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('studio-builder-step')).toHaveText(ARABIC);
    await expect(page.getByTestId('studio-nav')).toBeHidden();
    await expect(page.getByTestId('studio-builder-kind-post')).toHaveAttribute('aria-pressed', 'true');

    // No page is linked in the e2e server: the post link is pasted, with the page name.
    await expect(page.locator('#studio-b-post-link')).toBeVisible();
    await page.getByTestId('studio-builder-next').click();
    await expect(page.getByTestId('studio-builder-error-post')).toBeVisible();
    await expectStep(page, 'boost', 1);
    await page.locator('#studio-b-post-link').fill(POST_LINK);
    await expect(page.getByTestId('studio-builder-error-post')).toBeHidden();
    await page.locator('#studio-b-page-name').fill('متجر البيان التجريبي');
    await expectNoPageOverflow(page, 'quick boost step 1 (AR)');
    await page.getByTestId('studio-builder-next').click();
    await expectStep(page, 'boost', 2);

    // Budget & days: Arabic-Indic digits, the live total, the wallet line from the server.
    await page.locator('#studio-b-budget').fill('٥٠');
    await expect(page.getByTestId('studio-builder-total')).toContainText('$50.00');
    await expect(page.getByTestId('studio-builder-days-7')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('studio-builder-wallet')).toContainText('$300.00');
    await expect(page.getByTestId('studio-builder-wallet-short')).toHaveCount(0);
    await expectNoPageOverflow(page, 'quick boost step 2 (AR)');
    await page.getByTestId('studio-builder-next').click();
    await expectStep(page, 'boost', 3);

    // Review & send: the rights box is required; the send reserves the total, nothing is charged.
    const id = await openDraftId(page);
    expect(id).toMatch(/^campaign_/);
    await expect(page.getByTestId('studio-builder-problems')).toHaveCount(0);
    await page.getByTestId('studio-builder-send').click();
    await expect(page.getByTestId('studio-builder-error-rights')).toBeVisible();
    await page.locator('#studio-b-rights').check();
    await expect(page.getByTestId('studio-builder-error-rights')).toBeHidden();
    await page.getByTestId('studio-builder-send').click();
    await expect(page.getByTestId('studio-builder-sent')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('studio-builder-sent-money')).toContainText('$50.00');
    await expect(page.getByTestId('studio-builder-sent-money')).toHaveText(ARABIC);

    const saved = await readRequest(api, id);
    expect(saved.data).toMatchObject({
      status: 'Submitted', boostType: 'boost_post', sourcePostRef: POST_LINK, pageName: 'متجر البيان التجريبي',
      goalDetail: 'post_engagement', objective: 'engagement', budgetType: 'lifetime', budgetMinorUSD: 5000,
      durationDays: 7, totalBudgetMinorUSD: 5000, locationKeys: ['libya']
    });
    const after = await walletSummary(api);
    expect(after.usd.reservedMinor - before.usd.reservedMinor).toBe(5000);
    expect(before.usd.availableMinor - after.usd.availableMinor).toBe(5000);

    await page.getByTestId('studio-builder-view-sent').click();
    await expect.poll(() => tabParam(page)).toBe('campaigns');
    await expect.poll(() => param(page, 'id')).toBe(id);
    expect(errors).toEqual([]);
  });

  test('full request: goal, page, content with a photo, city chips, a daily budget with the per-day floor; drafts save as you go', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { funded } = await studioUsers(playwright, baseURL, testInfo);
    const api = await userApi(playwright, baseURL, funded);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await openPilot(page, funded);
    await setLanguage(page, 'en');
    await page.evaluate(() => studioBuilderStart('full'));
    await expectStep(page, 'full', 1);
    await expect(page.getByTestId('studio-builder-step')).toHaveText('Step 1 of 6: Goal');

    // 1 Goal (the server's goal list).
    await page.getByTestId('studio-builder-goal-website_visits').click();
    await expect(page.getByTestId('studio-builder-goal-website_visits')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('studio-builder-next').click();
    await expectStep(page, 'full', 2);
    await waitSaved(page);
    const id = await openDraftId(page);
    let saved = await readRequest(api, id);
    expect(saved.data).toMatchObject({ status: 'Draft', goalDetail: 'website_visits', objective: 'traffic' });

    // 2 Page: nothing linked, so the name is written; the request-a-link path is offered.
    await expect(page.getByTestId('studio-builder-request-link')).toBeVisible();
    await page.locator('#studio-b-page-name').fill('E2E Shop');
    await expect(page.getByTestId('studio-builder-platform-facebook')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('studio-builder-next').click();
    await expectStep(page, 'full', 3);

    // 3 Content: Next names what is missing; each problem clears when fixed.
    await page.getByTestId('studio-builder-next').click();
    for (const field of ['text', 'photos', 'destination']) await expect(page.getByTestId(`studio-builder-error-${field}`)).toBeVisible();
    await page.locator('#studio-b-text').fill('Fresh bread every morning — order before 9.');
    await expect(page.getByTestId('studio-builder-error-text')).toBeHidden();
    await page.locator('#ads-studio-image-input').setInputFiles({ name: 'bread.png', mimeType: 'image/png', buffer: makePng() });
    await expect(page.locator('.studio-b-photo img')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId('studio-builder-error-photos')).toBeHidden();
    await page.locator('#studio-b-destination').fill('091 234 5678');
    await expect(page.getByTestId('studio-builder-error-destination')).toBeHidden();
    await waitSaved(page);
    saved = await readRequest(api, id);
    expect(saved.data.primaryText).toBe('Fresh bread every morning — order before 9.');
    expect(saved.data.destination).toBe('+218912345678');
    expect(saved.data.creativeImages).toHaveLength(1);
    await page.getByTestId('studio-builder-next').click();
    await expectStep(page, 'full', 4);

    // 4 Audience: city chips (location keys), ages typed in Arabic digits, gender.
    await page.getByTestId('studio-builder-place-tripoli').click();
    await page.getByTestId('studio-builder-place-benghazi').click();
    await expect(page.getByTestId('studio-builder-place-libya')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#studio-b-age-min').fill('٢٥');
    await page.locator('#studio-b-age-max').fill('45');
    await page.getByTestId('studio-builder-gender-female').click();
    await page.getByTestId('studio-builder-next').click();
    await expectStep(page, 'full', 5);

    // 5 Budget & days: an amount per day under Meta's floor is named (the $5 total is met: 0.90 x 7);
    // the total follows the days.
    await page.getByTestId('studio-builder-budget-daily').click();
    await page.locator('#studio-b-budget').fill('0.9');
    await expect(page.getByTestId('studio-builder-total')).toContainText('$6.30');
    await page.getByTestId('studio-builder-next').click();
    await expect(page.getByTestId('studio-builder-error-budget')).toContainText('$1.00 a day');
    await expectStep(page, 'full', 5);
    await page.getByTestId('studio-builder-days-3').click();
    await page.locator('#studio-b-budget').fill('5');
    await expect(page.getByTestId('studio-builder-error-budget')).toBeHidden();
    await expect(page.getByTestId('studio-builder-total')).toContainText('$15.00');
    await expect(page.getByTestId('studio-builder-total')).toContainText('$5.00 a day');
    await page.getByTestId('studio-builder-next').click();
    await expectStep(page, 'full', 6);

    // 6 Review & send.
    await expect(page.getByTestId('studio-builder-problems')).toHaveCount(0);
    await page.locator('#studio-b-rights').check();
    await page.getByTestId('studio-builder-send').click();
    await expect(page.getByTestId('studio-builder-sent')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('studio-builder-sent-money')).toContainText('$15.00');
    saved = await readRequest(api, id);
    expect(saved.data).toMatchObject({
      status: 'Submitted', goalDetail: 'website_visits', objective: 'traffic', pageName: 'E2E Shop',
      locationKeys: ['tripoli', 'benghazi'], ageMin: 25, ageMax: 45, genders: ['female'],
      budgetType: 'daily', budgetMinorUSD: 500, durationDays: 3, totalBudgetMinorUSD: 1500, callToAction: 'Learn More'
    });
    expect(errors).toEqual([]);
  });

  test('a short wallet offers Add money and names a payment waiting for confirmation; Send stays off', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { broke } = await studioUsers(playwright, baseURL, testInfo);
    const api = await userApi(playwright, baseURL, broke);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    const payment = await jsonOk(await api.post('/api/wallet/payment-requests', {
      data: { amountMinor: 2500, currency: 'USD', method: 'adfali', idempotencyKey: uniqueId('e2e-builder-pay') }
    }), 'Asking to add money');
    const reference = String(payment.data.reference);
    expect(reference).toMatch(/^PAY-/);
    await openPilot(page, broke);
    await setLanguage(page, 'en');

    await page.evaluate(() => studioBuilderStart('boost'));
    await page.locator('#studio-b-post-link').fill(POST_LINK);
    await page.locator('#studio-b-page-name').fill('Broke Shop');
    await page.getByTestId('studio-builder-next').click();
    await expectStep(page, 'boost', 2);
    await page.locator('#studio-b-budget').fill('20');
    await expect(page.getByTestId('studio-builder-wallet')).toContainText('$0.00');
    await expect(page.getByTestId('studio-builder-wallet-short')).toContainText('$20.00');
    await expect(page.getByTestId('studio-builder-pending')).toContainText(reference);
    await expect(page.getByTestId('studio-builder-pending')).toContainText('$25.00');
    await page.getByTestId('studio-builder-next').click();
    await expectStep(page, 'boost', 3);
    await page.locator('#studio-b-rights').check();
    await expect(page.getByTestId('studio-builder-send')).toBeDisabled();

    // Arabic: the same lines, and money keeps its "$" (never LYD here).
    await setLanguage(page, 'ar');
    await expect(page.getByTestId('studio-builder-pending')).toHaveText(ARABIC);
    await expect(page.getByTestId('studio-builder-pending')).toContainText(reference);
    await setLanguage(page, 'en');

    // Add money opens Wallet's own Add money on "my ads" with the missing $20.00 filled in; the draft is kept.
    await page.getByTestId('studio-builder-add-money').click();
    await expect.poll(() => tabParam(page)).toBe('wallet');
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe('add-money');
    await expect(page.getByTestId('studio-screen-wallet')).toBeVisible();
    await expect(page.getByTestId('studio-wallet-add-step')).toHaveText('Step 2 of 4: Amount');
    await expect(page.locator('#studio-wallet-amount')).toHaveValue('20.00');
    const id = await openDraftId(page);
    await expect.poll(async () => (await readRequest(api, id)).data.status).toBe('Draft');
    expect(errors).toEqual([]);
  });

  test('Fix: photo and Fix: budget open the right step with the field highlighted; Close keeps the draft', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { fixer } = await studioUsers(playwright, baseURL, testInfo);
    const api = await userApi(playwright, baseURL, fixer);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);

    // Two sent requests (a full one with a photo, a quick boost), made through the real routes, then
    // sent back by the e2e admin with a reason.
    const photo = `data:image/png;base64,${makePng(32, 32, [220, 38, 38]).toString('base64')}`;
    const libyaDay = offset => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(Date.now() + offset * 86400000));
    const base = { platforms: ['facebook'], pageName: 'Fixer Shop', locationKeys: ['libya'], locations: ['All of Libya'], ageMin: 18, ageMax: 65, genders: ['all'],
      startDate: libyaDay(0), endDate: libyaDay(6), durationDays: 7, budgetType: 'lifetime', budgetMinorUSD: 2000 };
    const records = [
      { id: uniqueId('campaign'), ...base, name: 'Fixer full', goalDetail: 'messages', objective: 'messages', primaryText: 'Hello', callToAction: 'Send Message', destination: '+218912345678', creativeImages: [photo] },
      { id: uniqueId('campaign'), ...base, name: 'Fixer boost', boostType: 'boost_post', goalDetail: 'post_engagement', objective: 'engagement', sourcePostRef: POST_LINK, callToAction: 'Send Message' }
    ];
    const ids = [];
    for (const record of records) {
      const created = await jsonOk(await api.post('/api/collections/adCampaignRequests?include_media=false', { data: { id: record.id, data: record } }), 'Creating a request');
      await jsonOk(await api.post(`/api/ad-studio/campaigns/${encodeURIComponent(record.id)}/submit`, {
        data: { expectedLastModified: created.data._lastModified, operationId: uniqueId('e2e-submit') }
      }), 'Sending a request');
      ids.push(record.id);
    }

    const admin = await openAdminApi(playwright, baseURL);
    try {
      for (const [id, reason, note] of [[ids[0], 'creative_quality', 'The photo is too dark — please use a brighter one.'], [ids[1], 'budget_dates', 'Please run it for at least 10 days.']]) {
        const current = await jsonOk(await admin.api.get(`/api/collections/adCampaignRequests/${encodeURIComponent(id)}?include_media=false`), 'Reading the request');
        await jsonOk(await admin.api.post(`/api/ad-studio/campaigns/${encodeURIComponent(id)}/review`, {
          data: { expectedLastModified: current.data._lastModified, decision: 'Changes Requested', note, operationId: `e2e-review-${id.slice(-12)}-x`, reviewReasonCode: reason }
        }), 'Sending the request back');
      }
    } finally {
      await admin.api.dispose();
    }
    await openPilot(page, fixer);
    await setLanguage(page, 'en');

    expect(await page.evaluate(() => [studioBuilderFixLabel('creative_quality'), studioBuilderFixLabel('budget_dates'), studioBuilderFixLabel('targeting', 'boost')]))
      .toEqual(['Fix: photo', 'Fix: budget', 'Fix: audience']);

    // Fix: photo -> full request, step 3 (Content), the photo field highlighted, the team's words shown.
    expect(await page.evaluate(id => studioBuilderFix(id, 'creative_quality'), ids[0])).toBe(true);
    await expectStep(page, 'full', 3);
    const photos = page.locator('.studio-b [data-field="photos"]');
    await expect(photos).toHaveAttribute('data-fix', '1');
    await expect(photos).toHaveClass(/is-fix/);
    await expect(page.getByTestId('studio-builder-fix-banner')).toContainText('Photo or video quality');
    await expect(page.getByTestId('studio-builder-fix-banner')).toContainText('too dark');
    await expect(page.getByTestId('studio-builder-fix-reason')).toHaveText('Fix: photo');
    await expect(page.locator('.studio-b-photo img')).toHaveCount(1);

    // Replace the photo; the change saves by itself; Close keeps the draft (still sent back, new photo).
    await page.locator('.studio-b-photo-remove').first().click();
    await page.locator('#ads-studio-image-input').setInputFiles({ name: 'bright.png', mimeType: 'image/png', buffer: makePng(40, 40, [250, 204, 21]) });
    await expect(page.locator('.studio-b-photo img')).toHaveCount(1, { timeout: 15_000 });
    await expect(photos).not.toHaveClass(/is-fix/);
    await waitSaved(page);
    await page.getByTestId('studio-close').click();
    await expectHome(page);
    const kept = await readRequest(api, ids[0]);
    expect(kept.data.status).toBe('Changes Requested');
    expect(kept.data.creativeImages).toHaveLength(1);
    expect(kept.data.creativeImages[0]).not.toBe(photo);

    // Fix: budget on a quick boost -> step 2 of the boost with the budget highlighted.
    expect(await page.evaluate(id => studioBuilderFix(id, 'budget_dates'), ids[1])).toBe(true);
    await expectStep(page, 'boost', 2);
    await expect(page.locator('.studio-b [data-field="budget"]')).toHaveAttribute('data-fix', '1');
    await expect(page.getByTestId('studio-builder-fix-banner')).toContainText('Budget or dates');
    await page.locator('#studio-b-days').fill('10');
    await expect(page.getByTestId('studio-builder-total')).toContainText('10 days');
    await waitSaved(page);
    expect((await readRequest(api, ids[1])).data.durationDays).toBe(10);

    // The re-send works from the review step (the request goes back to the team).
    await page.getByTestId('studio-builder-next').click();
    await expectStep(page, 'boost', 3);
    await page.locator('#studio-b-rights').check();
    await page.getByTestId('studio-builder-send').click();
    await expect(page.getByTestId('studio-builder-sent')).toBeVisible({ timeout: 20_000 });
    expect((await readRequest(api, ids[1])).data.status).toBe('Submitted');
    expect(errors).toEqual([]);
  });

  test('back model in the builder, the post picker of a linked page, and a reload keeps the draft', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { broke } = await studioUsers(playwright, baseURL, testInfo);
    const api = await userApi(playwright, baseURL, broke);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    // A linked page and its recent posts, answered by the test (the e2e server has no Meta).
    await page.route('**/api/studio/pages', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pages: [{ id: 'spg_e2e_page_1', name: 'Bakery <b>Page</b>', hasFacebook: true, hasInstagram: false, healthy: true }] }) }));
    await page.route('**/api/studio/pages/spg_e2e_page_1/recent-posts*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      pageId: 'spg_e2e_page_1', checkedAt: new Date().toISOString(),
      platforms: { fb: { state: 'ok', checkedAt: new Date().toISOString() } },
      posts: [
        { id: '1111_2222', platform: 'fb', excerpt: 'Our new cakes <script>x</script>', imageUrl: '', permalink: 'https://www.facebook.com/1111/posts/2222', createdAt: new Date().toISOString() },
        { id: '1111_3333', platform: 'fb', excerpt: 'Weekend offer', imageUrl: '', permalink: 'https://www.facebook.com/1111/posts/3333', createdAt: new Date().toISOString() }
      ]
    }) }));
    await openPilot(page, broke);
    await setLanguage(page, 'en');

    // Back walks the steps (the shell's model), then leaves to Home.
    await page.goto('/studio?tab=builder&step=3');
    await expect(page.getByTestId('studio-builder-step')).toHaveText('Step 3 of 6: Content', { timeout: BOOT_TIMEOUT });
    await page.getByTestId('studio-back').click();
    await expect.poll(() => param(page, 'step')).toBe('2');
    await page.goBack();
    await expect.poll(() => param(page, 'step')).toBe('1');
    await page.getByTestId('studio-back').click();
    await expectHome(page);

    // The quick boost lists the linked page's posts; a tap picks one (server strings escaped).
    await page.evaluate(() => studioBuilderStart('boost'));
    await expect(page.getByTestId('studio-builder-post-0')).toBeVisible();
    await expect(page.getByTestId('studio-builder-post-0')).toContainText('Our new cakes <script>x</script>');
    expect(await page.locator('.studio-b script, .studio-b b').count()).toBe(0);
    await page.getByTestId('studio-builder-post-1').click();
    await expect(page.getByTestId('studio-builder-post-1')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('studio-builder-next').click();
    await expectStep(page, 'boost', 2);
    await waitSaved(page);
    const id = await openDraftId(page);
    const saved = await readRequest(api, id);
    expect(saved.data).toMatchObject({ boostType: 'boost_post', sourcePostId: '1111_3333', sourcePostPlatform: 'fb', connectedAssetId: 'spg_e2e_page_1', pageName: 'Bakery <b>Page</b>'.replace(/[<>]/g, '') });

    // A reload on step 2 comes back to the same draft (this tab remembers which one).
    await page.locator('#studio-b-budget').fill('12.5');
    await waitSaved(page);
    expect((await readRequest(api, id)).data.budgetMinorUSD).toBe(1250);
    await page.reload();
    await expect(page.getByTestId('studio-builder')).toHaveAttribute('data-step', '2', { timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-builder')).toHaveAttribute('data-kind', 'boost');
    await expect(page.locator('#studio-b-budget')).toHaveValue('12.50');
    expect(await openDraftId(page)).toBe(id);
    await page.getByTestId('studio-back').click();
    await expectStep(page, 'boost', 1);
    await expect(page.getByTestId('studio-builder-post-1')).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });

  for (const [language, theme] of [['en', 'light'], ['ar', 'dark']]) {
    test(`every builder step fits 320-820 px with 44 px controls (${language}, ${theme})`, async ({ page, playwright, baseURL }, testInfo) => {
      fullMatrixOnly(testInfo);
      const { broke } = await studioUsers(playwright, baseURL, testInfo);
      const errors = collectPageErrors(page);
      await page.setViewportSize(PHONE);
      await openPilot(page, broke);
      await page.evaluate(({ language, theme }) => {
        if (state.language !== language) toggleLanguage();
        shellSetTheme(theme);
      }, { language, theme });
      for (const [section, steps] of [['full', 6], ['boost', 3]]) {
        await page.evaluate(kind => studioBuilderStart(kind), section);
        await expect(page.getByTestId('studio-builder')).toHaveAttribute('data-kind', section);
        for (let step = 1; step <= steps; step++) {
          await page.evaluate(({ section, step }) => studioV2Go({ tab: 'builder', section, step }), { section, step });
          await expect(page.getByTestId('studio-builder')).toHaveAttribute('data-step', String(step));
          for (const width of [320, 360, 390, 412, 820]) {
            await page.setViewportSize({ width, height: 800 });
            const layout = await builderLayout(page);
            expect(layout.overflow, `${section} step ${step} overflows at ${width}px`).toBeLessThanOrEqual(1);
            expect(layout.outside, `${section} step ${step} at ${width}px`).toEqual([]);
            expect(layout.small, `${section} step ${step} touch targets at ${width}px`).toEqual([]);
          }
          await page.setViewportSize(PHONE);
        }
      }
      expect(errors).toEqual([]);
    });
  }

  test('smoke: the quick boost opens on this browser', async ({ page, playwright, baseURL }, testInfo) => {
    test.skip(testInfo.project.name === FULL_MATRIX_PROJECT, 'mobile-chromium runs the full matrix above');
    const { broke } = await studioUsers(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await openPilot(page, broke);
    await page.evaluate(() => studioBuilderStart('boost'));
    await expectStep(page, 'boost', 1);
    await expect(page.getByTestId('studio-builder-next')).toBeVisible();
    await expectNoPageOverflow(page, `quick boost on ${testInfo.project.name}`);
    expect(errors).toEqual([]);
  });
});
