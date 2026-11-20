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
  shown,
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
      // Redesign round 4: the sections are one navigation; while a request is written it steps aside.
      await expect(page.locator('.studio-section-tabs [aria-current="page"]')).toHaveCount(tab === 'builder' ? 0 : 1);
      await expect(page.locator('.studio-section-tabs')).toHaveCount(tab === 'builder' ? 0 : 1);
      await expect(page.getByTestId('studio-v2-frame')).toHaveCount(0);
      await expect(page.getByTestId('studio-staff-frame')).toHaveCount(0);
      await expect(page.getByTestId('studio-nav')).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });

  // Redesign round 4 (wireframe 14): the classic sections were a row of buttons above every page (a grid of two rows on
  // phones). They are one navigation now: a bar at the bottom of a phone, a list beside the page on a computer.
  test('classic navigation: a bar at the bottom of a phone and a list beside the page on a computer, whole names at every size in both languages; a request left unsent is found again', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { classic } = await studioUsers(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await signInStudio(page, classic);
    await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible();
    const nav = page.locator('.studio-classic nav.sc-nav');
    await expect(nav).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(nav.getByRole('button')).toHaveText(['Home', 'My ads', 'Posts', 'Replies']);
    await expect(nav.locator('[aria-current="page"]')).toHaveText('Home');
    const measure = () => page.evaluate(() => {
      const bar = document.querySelector('.studio-classic nav.sc-nav');
      const main = document.querySelector('.studio-classic .sc-main');
      const box = bar.getBoundingClientRect();
      const items = [...bar.querySelectorAll('.sc-tab')].map(item => {
        const r = item.getBoundingClientRect(); const word = item.querySelector('span'); const style = getComputedStyle(word);
        return { name: word.textContent, top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), height: Math.round(r.height),
          cut: word.scrollWidth > word.clientWidth + 1 || item.scrollWidth > item.clientWidth + 1, wraps: `${style.overflowWrap} ${style.wordBreak}`, size: parseFloat(style.fontSize) };
      });
      scrollTo(0, document.documentElement.scrollHeight);
      const end = main.getBoundingClientRect().bottom;
      const barTop = bar.getBoundingClientRect().top;
      scrollTo(0, 0);
      return { position: getComputedStyle(bar).position, left: Math.round(box.left), right: Math.round(box.right), bottom: Math.round(box.bottom), top: Math.round(box.top),
        mainLeft: Math.round(main.getBoundingClientRect().left), mainRight: Math.round(main.getBoundingClientRect().right), items, end: Math.round(end), barTop: Math.round(barTop), width: innerWidth, height: innerHeight };
    });
    for (const language of ['en', 'ar']) {
      await setLanguage(page, language);
      // Phones and a tablet: the bar spans the bottom edge; every name is whole and every item large enough to press.
      for (const width of [320, 360, 390, 430, 820]) {
        await page.setViewportSize({ width, height: 800 });
        const at = `${language} ${width}`;
        const seen = await measure();
        expect([seen.position, seen.left, seen.right, seen.bottom], `${at}: a bar fixed along the bottom edge`).toEqual(['fixed', 0, width, seen.height]);
        expect(seen.items.length).toBe(4);
        for (const [index, item] of seen.items.entries()) {
          expect(item.height, `${at}: "${item.name}" is at least 44 px tall`).toBeGreaterThanOrEqual(44);
          expect([item.cut, item.wraps], `${at}: "${item.name}" is whole and never broken inside a word`).toEqual([false, 'normal normal']);
          // 11 px on a phone (up to six sections share the width); a tablet has room for the main bar's 12 px.
          expect(item.size, `${at}: the size of "${item.name}"`).toBe(width >= 600 ? 12 : 11);
          if (index) expect(language === 'ar' ? item.right <= seen.items[index - 1].left + 1 : item.left >= seen.items[index - 1].right - 1, `${at}: "${item.name}" stands beside the one before it`).toBe(true);
        }
        expect(seen.end, `${at}: the end of the page stays above the bar`).toBeLessThanOrEqual(seen.barTop + 1);
        await expectNoPageOverflow(page, `classic navigation ${at}`);
      }
      // A computer: the same sections as a list beside the page (on the right in Arabic), one under the other.
      for (const width of [1024, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        const at = `${language} ${width}`;
        const seen = await measure();
        expect(seen.position, `${at}: the list stays in view while the page scrolls`).toBe('sticky');
        expect(language === 'ar' ? seen.left >= seen.mainRight : seen.right <= seen.mainLeft, `${at}: the list stands beside the page, not above it`).toBe(true);
        for (const [index, item] of seen.items.entries()) {
          expect(item.height, `${at}: "${item.name}" is at least 44 px tall`).toBeGreaterThanOrEqual(44);
          expect(item.cut, `${at}: "${item.name}" is whole`).toBe(false);
          if (index) expect(item.top, `${at}: "${item.name}" is under the one before it`).toBeGreaterThanOrEqual(seen.items[index - 1].bottom - 1);
        }
        await expectNoPageOverflow(page, `classic navigation ${at}`);
      }
    }
    // The fullest bar: staff with Help on see six sections. Drawn by the app's own navigation with that list, the six
    // names stay whole on the narrowest phones in both languages (the longest single word is Arabic: «المنشورات»).
    await page.evaluate(() => {
      window.__sections = adsStudioTabsForUser;
      adsStudioTabsForUser = () => [...window.__sections(), { id: 'help', icon: 'life-buoy', label: 'Help', labelAr: 'المساعدة' }, { id: 'review', icon: 'badge-check', label: 'Review Queue', labelAr: 'طلبات المراجعة' }];
      render();
    });
    for (const language of ['en', 'ar']) {
      await setLanguage(page, language);
      await expect(nav.getByRole('button')).toHaveCount(6);
      for (const width of [320, 360, 390, 600, 768]) {
        await page.setViewportSize({ width, height: 800 });
        const seen = await measure();
        for (const item of seen.items) {
          expect([item.cut, item.wraps], `six sections, ${language} ${width}: "${item.name}" is whole`).toEqual([false, 'normal normal']);
          expect(item.size, `six sections, ${language} ${width}: the size of "${item.name}"`).toBe(width >= 600 ? 12 : width < 360 ? 9.5 : 11);
          expect(item.height, `six sections, ${language} ${width}: "${item.name}" is at least 44 px tall`).toBeGreaterThanOrEqual(44);
        }
        const count = await nav.locator('.sc-tab > b').evaluate(el => { const b = el.getBoundingClientRect(); const item = el.parentElement.getBoundingClientRect(); return b.left >= item.left - 1 && b.right <= item.right + 1 && b.top >= item.top - 1; });
        expect(count, `six sections, ${language} ${width}: the queue's count stays on its own item`).toBe(true);
        await expectNoPageOverflow(page, `six classic sections ${language} ${width}`);
      }
    }
    await page.evaluate(() => { adsStudioTabsForUser = window.__sections; render(); });
    await expect(nav.getByRole('button')).toHaveCount(4);
    await setLanguage(page, 'en');
    await page.setViewportSize(PHONE);

    // "New request" is the main button of Home; while the request is written the navigation steps aside.
    await page.getByRole('button', { name: 'New request', exact: true }).click();
    await expect.poll(() => tabParam(page)).toBe('builder');
    await expect(nav).toHaveCount(0);
    await expect(page.locator('.studio-classic .sc-body')).toHaveClass(/is-focus/);
    // Closed without a word typed: nothing to come back to.
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(() => tabParam(page)).toBe('campaigns');
    await expect(nav.locator('[aria-current="page"]')).toHaveText('My ads');
    const unsent = page.locator('[data-ads-studio-open-draft]');
    await expect(unsent).toHaveCount(0);
    // With a name typed, closing keeps it: My ads shows one line that opens the same request again, and so does Home.
    await page.getByRole('button', { name: 'New request', exact: true }).click();
    await page.locator('#ads-studio-field-name').fill('Winter test');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(unsent).toHaveCount(1);
    await expect(unsent).toContainText('Not sent yet: Winter test');
    await nav.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.locator('[data-ads-studio-needs] .sc-need').first()).toContainText('Not sent yet: Winter test');
    await unsent.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => tabParam(page)).toBe('builder');
    await expect(page.locator('#ads-studio-field-name')).toHaveValue('Winter test');
    await expect(nav).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  // Redesign round 4 (proposal S3): in the classic layout the sentence on how to pay was a message that faded, and a
  // waiting request was one line. It is now the card the new layout draws, and it stays until the payment is
  // confirmed or cancelled.
  test('classic wallet: a waiting charge request is a card with the code, Copy, the amount, the method and how to pay; it fits 320-1280 px in both languages; Cancel turns it into a line', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    const { classic } = await studioUsers(playwright, baseURL, testInfo);
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await signInStudio(page, classic);
    await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible();
    const amount = page.locator('#ads-studio-charge-amount');
    await expect(amount).toBeVisible({ timeout: BOOT_TIMEOUT });
    const methods = page.locator('input[name="ads-studio-charge-method"]');
    await expect(methods.first()).toBeAttached({ timeout: BOOT_TIMEOUT });
    // The card of the request about to be made does not exist yet, and the form says who confirms, in the new layout's words.
    const cards = page.locator('.studio-classic [data-testid="studio-wallet-pending-item"]');
    await expect(cards).toHaveCount(0);
    await expect(page.locator('.studio-classic')).toContainText('You get a reference code. We confirm payments during our working hours. The money appears here as soon as we do.');
    await expect(page.locator('.studio-classic')).not.toContainText('once the payment company is connected');
    const methodId = await methods.first().getAttribute('value');
    const methodName = (await page.locator(`label:has(#ads-studio-method-${methodId}) .font-bold`).first().innerText()).trim();
    await methods.first().check();
    await amount.fill('12');
    const [response] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).pathname === '/api/wallet/payment-requests' && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create charge request', exact: true }).click()
    ]);
    expect(response.ok(), `the charge request was refused with HTTP ${response.status()}`).toBe(true);
    const made = await response.json();
    const reference = String(made.data.reference);
    expect(reference).toMatch(/^PAY-[A-Z0-9]{4,16}$/);

    const card = page.locator(`.studio-classic [data-testid="studio-wallet-pending-item"][data-reference="${reference}"]`);
    await expect(card).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(card.getByTestId('studio-wallet-reference')).toHaveText(reference);
    await expect(card.getByTestId('studio-wallet-pending-amount')).toHaveText(shown('$12.00'));
    await expect(card).toContainText('Waiting for our confirmation');
    await expect(card).toContainText(methodName);
    await expect(card.getByTestId('studio-wallet-instruction')).toContainText(reference);  // how to pay stays on screen
    await expect(card).toContainText('We confirm payments during our working hours. The money appears here as soon as we do.');
    const copy = card.getByTestId('studio-wallet-copy');
    const cancel = card.getByRole('button', { name: 'Cancel request', exact: true });
    await expect(copy).toHaveText('Copy code');
    // Every size from a small phone to a small laptop, in both languages: nothing runs off the page, every button is
    // large enough to press, and no button's words are cut.
    for (const language of ['en', 'ar']) {
      await setLanguage(page, language);
      for (const width of [320, 360, 390, 430, 820, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await card.scrollIntoViewIfNeeded();
        await expectNoPageOverflow(page, `classic payment card ${language} ${width}`);
        const facts = await card.evaluate(el => {
          const box = el.getBoundingClientRect();
          return [...el.querySelectorAll('button, label.studio-v2-action')].map(control => {
            const r = control.getBoundingClientRect();
            return { text: control.innerText.trim(), height: Math.round(r.height), inside: r.left >= box.left - 1 && r.right <= box.right + 1, cut: control.scrollWidth > control.clientWidth + 1 };
          });
        });
        expect(facts.length, `${language} ${width}: Copy and Cancel are there (and the question, where Help is on)`).toBeGreaterThanOrEqual(2);
        for (const control of facts) {
          expect(control.height, `${language} ${width}: "${control.text}" is at least 44 px tall`).toBeGreaterThanOrEqual(44);
          expect(control.inside && !control.cut, `${language} ${width}: "${control.text}" stays whole inside the card`).toBe(true);
        }
        // An icon and its word never touch.
        const gap = await copy.evaluate(el => {
          const icon = el.querySelector('svg, i'); const word = el.querySelector('span');
          if (!icon || !word) return -1;
          const i = icon.getBoundingClientRect(); const w = word.getBoundingClientRect();
          return Math.max(w.left - i.right, i.left - w.right);  // the space between the two, whichever comes first
        });
        expect(gap, `${language} ${width}: the Copy icon stands apart from its word`).toBeGreaterThanOrEqual(6);
      }
    }
    await expect(card).toContainText('بانتظار تأكيدنا');
    await setLanguage(page, 'en');
    await page.setViewportSize(PHONE);

    // Cancel: the card goes, and the request stays in the list as one line that says so.
    const [decided] = await Promise.all([
      page.waitForResponse(r => /^\/api\/wallet\/payment-requests\/[^/]+\/cancel$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
      cancel.click()
    ]);
    expect(decided.ok()).toBe(true);
    await expect(card).toHaveCount(0, { timeout: BOOT_TIMEOUT });
    const line = page.locator('.studio-classic .studio-wallet-request', { hasText: reference });
    await expect(line).toBeVisible();
    await expect(line.locator('[data-status="canceled"]')).toHaveText('Canceled');
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
