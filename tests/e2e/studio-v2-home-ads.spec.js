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

// Albayan Studio v2 Home (P2-03) and My ads (P2-04) with real server data: each test seeds its OWN
// pilot customer through the real APIs (a USD top-up by the e2e admin, a draft, a request waiting for
// review, one sent back with a reason, one approved that has not started, and a pending LYD payment),
// so the money strip can be compared with GET /api/studio/wallet/summary and the sheets move real
// money. The customer layout stays a pilot (never "on" for everyone).
//
// The full matrix runs on mobile-chromium at 390 px; desktop-chromium and mobile-webkit run one smoke.
//   npx playwright test tests/e2e/studio-v2-home-ads.spec.js --project=mobile-chromium

const FULL_MATRIX_PROJECT = 'mobile-chromium';
const BOOT_TIMEOUT = 20_000;
const WIDTHS = [320, 360, 390, 412, 820];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC';
const MONEY_CELLS = [['available', 'availableMinor'], ['reserved', 'reservedMinor'], ['in-ads', 'inAdsMinor'], ['spent', 'spentMinor']];
const CONTACT = { whatsapp: '+218912345678', phone: '+218912345678', email: 'help@albayan.example.com' };

function fullMatrixOnly(testInfo) {
  test.skip(testInfo.project.name !== FULL_MATRIX_PROJECT, 'The full v2 matrix runs on mobile-chromium (P2-13)');
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

function libyaDay(offsetDays) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + offsetDays * 86400000));
}

function completeRequest(name) {
  return {
    name, objective: 'messages', platforms: ['facebook', 'instagram'], pageName: 'E2E Studio Page',
    primaryText: "Message us for this week's offer.", headline: 'Weekly offer', description: 'A studio v2 journey request.',
    callToAction: 'Send Message', destination: 'https://wa.me/218910000000', locations: ['Tripoli, Libya'],
    ageMin: 18, ageMax: 55, genders: ['all'], languages: ['Arabic'], interests: ['Shopping'],
    startDate: libyaDay(30), endDate: libyaDay(36), durationDays: 7, budgetMinorUSD: 2500, budgetType: 'lifetime',
    notes: '', specialAdCategories: ['none'], creativeImages: [PNG], creativeAssetIds: []
  };
}

// One pilot customer with $100.00 and four requests: a draft, one waiting for review ($25 reserved),
// one sent back (creative_quality + a note) and one approved before its start day ($25 in the ads);
// plus a pending 50.00 LYD payment. The customer is on the v2 layout pilot.
async function seedCustomer(playwright, baseURL, testInfo, label, { requests = true } = {}) {
  const admin = await openAdminApi(playwright, baseURL);
  const origin = new URL(baseURL).origin;
  const customerApi = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: origin } });
  try {
    const tag = `${label}-${projectToken(testInfo)}-${Date.now()}`;
    const user = await createStudioUser(admin.api, 'customer', tag);
    await addToPilot(admin, { customers: [user.id] });
    if (!requests) return { user, ids: {} };
    await jsonOrThrow(await admin.api.post('/api/wallet/top-ups', {
      data: { userId: user.id, amountMinor: 10000, currency: 'USD', idempotencyKey: `e2e-v2-topup-${tag}`, memo: 'E2E studio v2 journeys' }
    }), 'The USD top-up');
    await jsonOrThrow(await customerApi.post('/api/auth/login', { data: { email: user.email, password: user.password } }), 'Customer login');
    const ids = {};
    const create = async (key, name) => {
      const id = `e2e_v2_${key}_${tag}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80);
      const created = await jsonOrThrow(await customerApi.post('/api/collections/adCampaignRequests', { data: { id, data: completeRequest(name) } }), `Creating ${key}`);
      ids[key] = id;
      return created;
    };
    const submit = async (key, created) => jsonOrThrow(await customerApi.post(`/api/ad-studio/campaigns/${ids[key]}/submit`, {
      data: { expectedLastModified: created.lastModified, operationId: `e2e-submit-${key}-${tag}` }
    }), `Submitting ${key}`);
    const review = async (key, submitted, decision, extra = {}) => jsonOrThrow(await admin.api.post(`/api/ad-studio/campaigns/${ids[key]}/review`, {
      data: { expectedLastModified: submitted.lastModified, decision, note: extra.note || '', operationId: `e2e-review-${key}-${tag}`, ...extra }
    }), `Reviewing ${key}`);

    await create('draft', 'E2E draft not sent');
    await submit('wait', await create('wait', 'E2E waiting for review'));
    await review('fix', await submit('fix', await create('fix', 'E2E sent back')), 'Changes Requested',
      { reviewReasonCode: 'creative_quality', note: 'Please use a brighter photo.' });
    await review('approved', await submit('approved', await create('approved', 'E2E approved, not started')), 'Approved');
    const payment = await jsonOrThrow(await customerApi.post('/api/wallet/payment-requests', {
      data: { amountMinor: 5000, currency: 'LYD', method: 'adfali', idempotencyKey: `e2e-v2-pay-${tag}` }
    }), 'The pending LYD payment');
    return { user, ids, paymentRef: String((payment.data && payment.data.reference) || '') };
  } finally {
    await customerApi.dispose();
    await admin.api.dispose();
  }
}

async function openHome(page, user) {
  await signInStudio(page, user);
  await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });
  await expect(page.getByTestId('studio-home')).toBeVisible();
  await expect(page.getByTestId('studio-money-available')).toHaveAttribute('data-minor', /^-?\d+$/, { timeout: BOOT_TIMEOUT });
}

function walletSummary(page) {
  return page.evaluate(() => apiJson('/api/studio/wallet/summary', { method: 'GET' }));
}

// The strip shows exactly the server's numbers (data-minor and the text), and Being returned only when non-zero.
async function expectStripEqualsServer(page) {
  const summary = await walletSummary(page);
  for (const [key, field] of MONEY_CELLS) {
    const cell = page.getByTestId(`studio-money-${key}`);
    await expect(cell).toHaveAttribute('data-minor', String(summary.usd[field]));
    await expect(cell.locator('.studio-home-money-value')).toHaveText(usd(summary.usd[field]));
  }
  if (summary.usd.beingReturnedMinor) await expect(page.getByTestId('studio-money-returning')).toHaveAttribute('data-minor', String(summary.usd.beingReturnedMinor));
  else await expect(page.getByTestId('studio-money-returning')).toHaveCount(0);
  return summary;
}

// No sideways scroll, nothing outside the screen, 44 px touch targets, at every phone and tablet width.
async function expectFits(page, label) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.evaluate(() => {
      const inside = element => { const box = element.getBoundingClientRect(); return box.width === 0 || (box.left >= -1 && box.right <= innerWidth + 1); };
      const frame = '[data-testid="studio-v2-frame"]';
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        outside: [...document.querySelectorAll(`${frame} button, ${frame} h1, ${frame} h2, ${frame} p, ${frame} dd`)]
          .filter(element => !inside(element)).map(element => element.textContent.trim().slice(0, 40)),
        small: [...document.querySelectorAll(`${frame} button`)].filter(element => {
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

async function answerMeWith(page, change) {
  await page.route('**/api/studio/me', async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: change(body) });
  });
}

const actionIds = page => page.locator('[data-testid^="studio-ad-action-"]').evaluateAll(buttons =>
  buttons.map(button => button.getAttribute('data-testid').replace('studio-ad-action-', '')));

test.describe('Albayan Studio v2 Home and My ads (pilot)', () => {
  test.beforeEach(() => {
    test.setTimeout(150_000);
  });

  test('home: the money strip equals the wallet summary; Needs you, trackers and goals; Arabic; fits 320-820 px', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const seed = await seedCustomer(playwright, baseURL, testInfo, 'home');
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await openHome(page, seed.user);

    const summary = await expectStripEqualsServer(page);
    expect([summary.usd.availableMinor, summary.usd.reservedMinor, summary.usd.inAdsMinor, summary.usd.spentMinor],
      'the seed: $100 added, $25 reserved, $25 paid into the approved ad').toEqual([5000, 2500, 2500, 0]);
    const frame = page.getByTestId('studio-v2-frame');
    expect(await frame.innerText(), 'no "Meta used" before a Meta link').not.toMatch(/Meta used/);

    const fix = page.getByTestId(`studio-need-fix-${seed.ids.fix}`);
    await expect(fix).toContainText('Needs your changes: Photo or video quality');
    await expect(fix).toContainText('Please use a brighter photo.');
    await expect(page.getByTestId(`studio-need-draft-${seed.ids.draft}`)).toContainText('Not sent yet: E2E draft not sent');
    const pay = page.getByTestId(`studio-need-pay-${seed.paymentRef}`);
    await expect(pay).toContainText(`${seed.paymentRef} · 50.00 LYD`);
    expect(await pay.innerText(), 'LYD never wears "$"').not.toContain('$');

    const waiting = page.getByTestId(`studio-tracker-${seed.ids.wait}`);
    await expect(waiting).toContainText('Waiting for Albayan review');
    await expect(waiting).toContainText('Next: Albayan team');
    await expect(page.getByTestId(`studio-tracker-${seed.ids.approved}`)).toContainText('Approved — being set up in Meta');
    await expect(page.getByTestId('studio-home-start'), 'Getting started is gone once a request was sent').toHaveCount(0);
    for (const goal of ['messages', 'promote', 'grow', 'comments', 'help']) await expect(page.getByTestId(`studio-goal-${goal}`)).toBeEnabled();
    await expectFits(page, 'Home (EN)');

    // A tracker row opens that request's detail; Back comes home again.
    await waiting.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(seed.ids.wait);
    await expect(page.getByTestId('studio-ad-detail')).toBeVisible();
    await page.getByTestId('studio-back').click();
    await page.getByTestId('studio-back').click();
    await expectCustomerTab(page, 'home');

    // A goal starts a new request in the builder, already on that goal.
    await page.getByTestId('studio-goal-messages').click();
    await expect.poll(() => tabParam(page)).toBe('builder');
    await expect(page.getByTestId('studio-builder')).toHaveAttribute('data-kind', 'full');
    await expect(page.getByTestId('studio-builder-goal-messages')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('studio-close').click();
    await expectCustomerTab(page, 'home');
    // "Not sent yet" continues that very draft in the builder.
    await page.getByTestId(`studio-need-draft-${seed.ids.draft}`).getByRole('button').click();
    await expect.poll(() => tabParam(page)).toBe('builder');
    await expect.poll(() => page.evaluate(() => String((_studioBuilder.session && _studioBuilder.session.id) || ''))).toBe(seed.ids.draft);
    await page.getByTestId('studio-close').click();
    await expectCustomerTab(page, 'home');

    // Arabic: right to left, Arabic words, the same numbers, LYD in dinars.
    await setLanguage(page, 'ar');
    expect(await frame.evaluate(el => getComputedStyle(el).direction)).toBe('rtl');
    await expect(page.getByTestId('studio-money-available').locator('dt')).toHaveText('متاح');
    await expect(page.getByTestId('studio-money-in-ads').locator('dt')).toHaveText('في إعلاناتك');
    await expectStripEqualsServer(page);
    await expect(page.getByTestId(`studio-need-fix-${seed.ids.fix}`)).toContainText('يحتاج تعديلك: جودة الصورة أو الفيديو');
    const payAr = await page.getByTestId(`studio-need-pay-${seed.paymentRef}`).innerText();
    expect(payAr).toContain('50.00 د.ل');
    expect(payAr).not.toContain('$');
    expect(await page.getByTestId('studio-home-needs').innerText()).toMatch(ARABIC);
    await expectFits(page, 'Home (AR)');
    await setLanguage(page, 'en');
    expect(errors).toEqual([]);
  });

  test('my ads: filters in the address, detail by stage, withdraw in a sheet (phone Back closes it first) returns the reserve', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const seed = await seedCustomer(playwright, baseURL, testInfo, 'ads');
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await openHome(page, seed.user);

    await page.getByTestId('studio-nav-campaigns').click();
    await expectCustomerTab(page, 'campaigns');
    const cards = page.locator('[data-testid="studio-ads-list"] .studio-ads-card');
    await expect(cards).toHaveCount(4);
    await expect(page.getByTestId('studio-ads-filter-all')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('studio-ads-filter-active').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBe('active');
    await expect(cards).toHaveCount(1);
    await expect(page.getByTestId(`studio-ad-${seed.ids.approved}`)).toBeVisible();
    await page.getByTestId('studio-ads-filter-waiting').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBe('waiting');
    await expect(cards).toHaveCount(3);
    await expectFits(page, 'My ads (waiting)');

    // The waiting request: its tracker, its reserve and only Withdraw / Ask about this.
    await page.getByTestId(`studio-ad-${seed.ids.wait}`).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(seed.ids.wait);
    await expect(page.getByTestId('studio-ad-track')).toHaveAttribute('data-step', 'sent');
    await expect(page.getByTestId('studio-ad-reserved')).toContainText('$25.00');
    expect(await actionIds(page)).toEqual(['withdraw', 'ask']);
    await expectFits(page, 'Ad detail (waiting)');

    // The sent-back request shows its reason and note, and Fix it.
    await page.getByTestId('studio-back').click();
    await page.getByTestId(`studio-ad-${seed.ids.fix}`).click();
    await expect(page.getByTestId('studio-ad-reason')).toContainText('Photo or video quality');
    await expect(page.getByTestId('studio-ad-reason')).toContainText('Please use a brighter photo.');
    expect(await actionIds(page)).toEqual(['edit', 'ask']);
    await page.getByTestId('studio-back').click();
    await page.getByTestId(`studio-ad-${seed.ids.wait}`).click();

    // Withdraw: an in-page sheet; the phone's Back closes it and stays on the request.
    await page.getByTestId('studio-ad-action-withdraw').click();
    const sheet = page.getByTestId('studio-sheet-withdraw');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Your reservation of $25.00 ends now');
    await page.goBack();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(seed.ids.wait);
    await expect(page.getByTestId('studio-ad-detail')).toBeVisible();
    // A person's pause: the platform's overlay model (01b) reads any surface closed within 300 ms
    // of a Back-close as closed by that same Back, and then leaves its history entry alone.
    await page.waitForTimeout(400);

    await page.getByTestId('studio-ad-action-withdraw').click();
    await expect(sheet).toBeVisible();
    await page.getByTestId('studio-sheet-confirm').click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('studio-ad-detail')).toHaveAttribute('data-stage', '1');
    await expect(page.getByTestId('studio-ad-detail').locator('.studio-stage-chip')).toContainText('Draft — not sent');
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(seed.ids.wait);
    await expect.poll(() => page.evaluate(() => !!(history.state && history.state.overlaySentinel)), { message: 'the sheet gave its history entry back' }).toBe(false);

    // Home: the reserve is back in Available, exactly as the server says.
    await page.getByTestId('studio-nav-home').click();
    await expectCustomerTab(page, 'home');
    await expect(page.getByTestId('studio-money-reserved')).toHaveAttribute('data-minor', '0');
    const summary = await expectStripEqualsServer(page);
    expect(summary.usd.availableMinor).toBe(7500);
    expect(errors).toEqual([]);
  });

  test('stop before the start day and archive; Ask to stop shows the public contact (coming soon)', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const seed = await seedCustomer(playwright, baseURL, testInfo, 'stop');
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await answerMeWith(page, body => ({ ...body, contact: CONTACT }));
    await openHome(page, seed.user);

    await page.goto(`/studio?tab=campaigns&id=${seed.ids.approved}`);
    await expect(page.getByTestId('studio-ad-detail')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-ad-detail')).toHaveAttribute('data-stage', '4');
    // Right after a page load the plain status (Approved = stage 4, no actions) shows until the
    // server's stage arrives with its actions a moment later: wait for those.
    await expect.poll(() => actionIds(page)).toEqual(['stop', 'ask_stop', 'ask']);
    expect(await page.getByTestId('studio-ad-detail').innerText(), 'no "Meta used" before a Meta link').not.toMatch(/Meta used/);

    await page.getByTestId('studio-ad-action-ask_stop').click();
    const ask = page.getByTestId('studio-sheet-ask-stop');
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('Coming soon');
    const whatsapp = await page.getByTestId('studio-contact-whatsapp').getAttribute('href');
    expect(whatsapp.startsWith('https://wa.me/218912345678?text=')).toBe(true);
    expect(decodeURIComponent(whatsapp)).toContain('E2E approved, not started');
    await expect(page.getByTestId('studio-contact-phone')).toHaveAttribute('href', 'tel:+218912345678');
    await expect(ask.getByTestId('studio-sheet-confirm')).toHaveCount(0);
    await page.getByTestId('studio-sheet-cancel').click();
    await expect(ask).toHaveCount(0);

    await page.getByTestId('studio-ad-action-stop').click();
    const stop = page.getByTestId('studio-sheet-stop');
    await expect(stop).toContainText('The full $25.00 you paid comes back');
    await page.getByTestId('studio-sheet-confirm').click();
    await expect(stop).toHaveCount(0);
    await expect(page.getByTestId('studio-ad-detail')).toHaveAttribute('data-stage', '12');
    await expect.poll(() => actionIds(page)).toEqual(['archive']);
    const afterStop = await walletSummary(page);
    expect([afterStop.usd.availableMinor, afterStop.usd.inAdsMinor, afterStop.usd.spentMinor], 'the full $25 came back').toEqual([7500, 0, 0]);

    await page.getByTestId('studio-ad-action-archive').click();
    await expect(page.getByTestId('studio-sheet-archive')).toContainText('Your money history stays in the wallet');
    await page.getByTestId('studio-sheet-confirm').click();
    await expect(page.getByTestId('studio-sheet-archive')).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('id')).toBe(null);
    await expect(page.getByTestId('studio-ads-list')).toBeVisible();
    await expect(page.getByTestId(`studio-ad-${seed.ids.approved}`)).toHaveCount(0);

    await page.getByTestId('studio-nav-home').click();
    await expectCustomerTab(page, 'home');
    await expectStripEqualsServer(page);
    expect(errors).toEqual([]);
  });

  test('getting started for a new customer, and the calm banner while new requests are paused', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const seed = await seedCustomer(playwright, baseURL, testInfo, 'start', { requests: false });
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await answerMeWith(page, body => ({ ...body, intake: { open: false } }));
    await openHome(page, seed.user);

    await expect(page.getByTestId('studio-intake-paused')).toContainText('New ad requests will open again soon — your drafts are saved.');
    const start = page.getByTestId('studio-home-start');
    await expect(start).toBeVisible();
    await expect(page.getByTestId('studio-start-plan')).toContainText('Done');
    await expect(page.getByTestId('studio-start-page').getByRole('button', { name: 'Pages' })).toBeVisible();
    await expect(page.getByTestId('studio-start-money').getByRole('button', { name: 'Add money' })).toBeVisible();
    await expect(page.getByTestId('studio-start-first')).toContainText('Send your first ad request');
    await expectStripEqualsServer(page);
    await expectFits(page, 'Home (new customer)');
    await page.getByTestId('studio-start-money').getByRole('button', { name: 'Add money' }).click();
    await expectCustomerTab(page, 'wallet');
    expect(errors).toEqual([]);
  });

  test('smoke: Home shows the server numbers on this browser', async ({ page, playwright, baseURL }, testInfo) => {
    test.skip(testInfo.project.name === FULL_MATRIX_PROJECT, 'mobile-chromium runs the full matrix above');
    const seed = await seedCustomer(playwright, baseURL, testInfo, 'smoke');
    const errors = collectPageErrors(page);
    await openHome(page, seed.user);
    await expectStripEqualsServer(page);
    await page.getByTestId('studio-nav-campaigns').click();
    await expect(page.locator('[data-testid="studio-ads-list"] .studio-ads-card')).toHaveCount(4);
    await expectNoPageOverflow(page, `Home and My ads on ${testInfo.project.name}`);
    expect(errors).toEqual([]);
  });
});
