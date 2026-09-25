const { test, expect } = require('@playwright/test');
const {
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
  openAdminApi,
  projectToken,
  setLanguage,
  signInStudio,
  studioMe,
  tabParam
} = require('./helpers/studio-v2');

// Albayan Studio v2 journeys (plan tasks P2-13 harness, P2-02a/b/c/d, P2-10). The v2 layout shows
// only when GET /api/studio/me says ui === 'v2': the e2e server runs the kill switch at "pilot"
// and each project creates its OWN pilot users below and adds them to the rollout allowlist
// through the real admin settings API. The customer layout is never switched on for everyone, so
// the shared e2e admin (design-system.spec.js, critical-flows.spec.js) keeps the classic studio.
//
// The full matrix runs on mobile-chromium at 390 px; desktop-chromium and mobile-webkit run one
// smoke pass. Run only this file with:
//   npx playwright test tests/e2e/studio-v2.spec.js --project=mobile-chromium

const FULL_MATRIX_PROJECT = 'mobile-chromium';
// A page load boots the app, then the layout waits for GET /api/studio/me.
const BOOT_TIMEOUT = 20_000;

function fullMatrixOnly(testInfo) {
  test.skip(testInfo.project.name !== FULL_MATRIX_PROJECT, 'The full v2 matrix runs on mobile-chromium (P2-13)');
}

// One set of dedicated users per project (per worker), made on first use.
let pilotUsers = null;
function studioUsers(playwright, baseURL, testInfo) {
  if (!pilotUsers) {
    pilotUsers = (async () => {
      const admin = await openAdminApi(playwright, baseURL);
      try {
        const tag = `${projectToken(testInfo)}-${Date.now()}`;
        const pilot = await createStudioUser(admin.api, 'customer', `pilot-${tag}`);
        const classic = await createStudioUser(admin.api, 'customer', `classic-${tag}`);
        const reviewer = await createStudioUser(admin.api, 'reviewer', `reviewer-${tag}`);
        await addToPilot(admin, { customers: [pilot.id], staff: [reviewer.id] });
        return { pilot, classic, reviewer };
      } finally {
        await admin.api.dispose();
      }
    })().catch(error => {
      pilotUsers = null;
      throw error;
    });
  }
  return pilotUsers;
}

async function openPilotHome(page, user) {
  await signInStudio(page, user);
  const me = await studioMe(page);
  expect(me.ui, 'the server puts this pilot customer on the v2 layout').toBe('v2');
  await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });
  return me;
}

test.describe('Albayan Studio v2 (pilot)', () => {
  test.beforeEach(() => {
    test.setTimeout(90_000);
  });

  test('frame renders: a pilot customer gets the v2 frame, its five tabs and RTL in Arabic', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { pilot } = await studioUsers(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    const me = await openPilotHome(page, pilot);
    expect(me.staffDesk, 'a customer never gets the Team desk').toBe('classic');

    const frame = page.getByTestId('studio-v2-frame');
    for (const tab of [...CUSTOMER_TABS, ...HEADER_TABS]) await expect(page.getByTestId(`studio-nav-${tab}`)).toBeVisible();
    await expect(page.getByTestId('studio-nav')).toBeVisible();
    await expect(page.getByTestId('studio-staff-frame')).toHaveCount(0);
    await expect(page.locator('.studio-section-tabs'), 'the classic tab bar is gone').toHaveCount(0);
    await expectNoPageOverflow(page, 'v2 Home (EN)');

    // Every tab opens its own screen and becomes the current one.
    for (const tab of CUSTOMER_TABS.slice(1)) {
      await page.getByTestId(`studio-nav-${tab}`).click();
      await expectCustomerTab(page, tab);
    }
    await page.getByTestId('studio-nav-home').click();
    await expectCustomerTab(page, 'home');

    // Arabic: the whole frame reads right to left, the tabs run from the right and speak Arabic.
    await setLanguage(page, 'ar');
    await expect(frame).toBeVisible();
    expect(await frame.evaluate(el => getComputedStyle(el).direction)).toBe('rtl');
    for (const tab of CUSTOMER_TABS) {
      const label = await page.getByTestId(`studio-nav-${tab}`).evaluate(el => `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`);
      expect(label, `the ${tab} tab label in Arabic`).toMatch(ARABIC);
    }
    const first = await page.getByTestId(`studio-nav-${CUSTOMER_TABS[0]}`).boundingBox();
    const last = await page.getByTestId(`studio-nav-${CUSTOMER_TABS[CUSTOMER_TABS.length - 1]}`).boundingBox();
    expect(first && last && first.x > last.x, 'in Arabic Home is the rightmost tab').toBe(true);
    await expectCustomerTab(page, 'home');
    await expectNoPageOverflow(page, 'v2 Home (AR)');

    // And back to English, labels in English again.
    await setLanguage(page, 'en');
    expect(await frame.evaluate(el => getComputedStyle(el).direction)).toBe('ltr');
    await expect(page.getByTestId('studio-nav-home')).toHaveText(LATIN);
    expect(errors).toEqual([]);
  });

  test('classic stays for others: a customer outside the allowlist keeps the classic studio', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { classic } = await studioUsers(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await signInStudio(page, classic);
    const me = await studioMe(page);
    expect([me.ui, me.staffDesk], 'the server keeps this customer on the classic layout').toEqual(['classic', 'classic']);

    await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible();
    await expect(page.locator('.studio-section-tabs')).toBeVisible();
    for (const tab of ['dashboard', 'campaigns', 'builder', 'posts', 'replies']) {
      await page.evaluate(id => setAdsStudioTab(id), tab);
      await expect.poll(() => tabParam(page)).toBe(tab);
      await expect(page.locator('.studio-section-tabs [role="tab"][aria-selected="true"]')).toHaveCount(1);
      await expect(page.getByTestId('studio-v2-frame')).toHaveCount(0);
      await expect(page.getByTestId('studio-staff-frame')).toHaveCount(0);
      await expect(page.getByTestId('studio-nav')).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });

  test('back model: tabs go back to Home, tab hops replace, Home leaves the studio', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { pilot } = await studioUsers(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await openPilotHome(page, pilot);
    // A fresh studio page with another page before it, so "Back on Home" has somewhere to go.
    await page.goto('/privacy');
    await page.goto('/studio');
    await expectCustomerTab(page, 'home', { frameTimeout: BOOT_TIMEOUT });

    // In-app Back: Wallet -> Home.
    await page.getByTestId('studio-nav-wallet').click();
    await expectCustomerTab(page, 'wallet');
    await expect(page.getByTestId('studio-back')).toBeVisible();
    await page.getByTestId('studio-back').click();
    await expectCustomerTab(page, 'home');

    // Phone Back: Wallet -> Home.
    await page.getByTestId('studio-nav-wallet').click();
    await expectCustomerTab(page, 'wallet');
    await page.goBack();
    await expectCustomerTab(page, 'home');

    // Moving between tabs replaces the entry: Wallet -> Help, then Back = Home (not Wallet).
    await page.getByTestId('studio-nav-wallet').click();
    await expectCustomerTab(page, 'wallet');
    await page.getByTestId('studio-nav-help').click();
    await expectCustomerTab(page, 'help');
    await page.goBack();
    await expectCustomerTab(page, 'home');

    // The header's Inbox and Account go back to Home too (in-app Back and phone Back).
    await page.getByTestId('studio-nav-inbox').click();
    await expect(page.getByTestId('studio-screen-inbox')).toBeVisible();
    await expect.poll(() => tabParam(page)).toBe('inbox');
    await page.getByTestId('studio-back').click();
    await expectCustomerTab(page, 'home');
    await page.getByTestId('studio-nav-account').click();
    await expect(page.getByTestId('studio-screen-account')).toBeVisible();
    await expect.poll(() => tabParam(page)).toBe('account');
    await page.goBack();
    await expectCustomerTab(page, 'home');

    // Home: Back leaves the studio (the page before it).
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/privacy');
    expect(errors).toEqual([]);
  });

  test('builder focus mode: the bottom nav is hidden while building a request', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { pilot } = await studioUsers(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await openPilotHome(page, pilot);
    await page.goto('/studio?tab=builder');
    await expect(page.getByTestId('studio-v2-frame')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-nav')).toHaveAttribute('hidden');
    await expect(page.getByTestId('studio-nav-home')).toBeHidden();
    await expect(page.getByTestId('studio-back')).toBeVisible();
    await page.goto('/studio?tab=wallet');
    await expectCustomerTab(page, 'wallet', { frameTimeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-nav')).not.toHaveAttribute('hidden');
    expect(errors).toEqual([]);
  });

  // The request builder (P2-05) keeps the Back model: an address straight to step 3 gets steps 1 and 2
  // (and Home) put under it, so the in-app Back and the phone's Back walk the steps down.
  test('back model: builder step 3 goes back to step 2 (P2-05)', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { pilot } = await studioUsers(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await openPilotHome(page, pilot);
    await page.goto('/studio?tab=builder&step=3');
    await expect(page.getByTestId('studio-nav')).toHaveAttribute('hidden');
    await expect.poll(() => new URL(page.url()).searchParams.get('step')).toBe('3');
    await page.getByTestId('studio-back').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('step')).toBe('2');
    await expect.poll(() => tabParam(page)).toBe('builder');
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get('step')).toBe('1');
    expect(errors).toEqual([]);
  });

  test('reviewer nav: a reviewer in the Team desk pilot gets the staff frame with no wallet items', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { reviewer } = await studioUsers(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await signInStudio(page, reviewer, '/studio?tab=review');
    const me = await studioMe(page);
    expect([me.staffDesk, me.ui, me.isStaff, me.isAdmin]).toEqual(['v2', 'classic', true, false]);

    const staffFrame = page.getByTestId('studio-staff-frame');
    for (const language of ['en', 'ar']) {
      await setLanguage(page, language);
      await expect(staffFrame).toBeVisible({ timeout: BOOT_TIMEOUT });
      for (const section of STAFF_SECTIONS) await expect(page.getByTestId(`studio-staffnav-${section}`)).toBeVisible();
      await expect(page.locator('[data-testid*="wallet"]'), 'no wallet item anywhere').toHaveCount(0);
      const labels = (await page.locator('[data-testid^="studio-staffnav-"]').allTextContents()).join(' ');
      expect(labels, `staff nav (${language}) never offers the wallet`).not.toMatch(/wallet|محفظ/i);
      await expect(page.getByTestId('studio-v2-frame'), 'the customer layout is not shown to staff').toHaveCount(0);
      await expectNoPageOverflow(page, `Team desk (${language})`);
    }
    expect(errors).toEqual([]);
  });

  test('smoke: the v2 frame renders on this browser', async ({ page, playwright, baseURL }, testInfo) => {
    test.skip(testInfo.project.name === FULL_MATRIX_PROJECT, 'mobile-chromium runs the full matrix above');
    const { pilot } = await studioUsers(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await openPilotHome(page, pilot);
    await expect(page.getByTestId('studio-staff-frame')).toHaveCount(0);
    await expectNoPageOverflow(page, `v2 Home on ${testInfo.project.name}`);
    expect(errors).toEqual([]);
  });
});
