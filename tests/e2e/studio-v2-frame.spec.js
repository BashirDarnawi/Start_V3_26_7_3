// Studio v2 frame (P2-02a-d, P2-08): the shell in a real browser. GET /api/studio/me is answered by the
// test (page.route), so no rollout record or env switch is touched and every other spec keeps the
// classic studio. The e2e admin signs in; /me decides the layout.
const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL = 'e2e.admin@albayan.example.com';
const ADMIN_PASSWORD = 'E2eAdminPassword123!';

async function signIn(page) {
  await page.goto('/');
  await expect(page.locator('#login-form')).toBeVisible();
  await page.locator('#login-email').fill(ADMIN_EMAIL);
  await page.locator('#login-password').fill(ADMIN_PASSWORD);
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/auth/login')),
    page.locator('#login-form button[type="submit"]').click()
  ]);
  expect(response.ok()).toBe(true);
  await page.waitForFunction(() => !!state.currentUser?.id);
}

function meReply(overrides = {}) {
  return {
    ui: 'v2', staffDesk: 'classic', services: { help: false, stopRequest: false, tiktok: false },
    capabilities: {}, intake: { open: true }, adLimits: { minTotalMinorUSD: 500, maxTotalMinorUSD: 200000, minPerDayMinorUSD: 100, maxDays: 90 },
    serviceHours: {}, contact: {}, isAdmin: false, isStaff: false, metaConnection: {}, ...overrides
  };
}

async function answerMe(page, overrides) {
  await page.route('**/api/studio/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(meReply(overrides)) }));
}

// ?tab=dashboard is the pinned classic alias of Home (PLAN §5.1); WebKit restores that name after a Back (seen in the release
// run), so both spell Home here — the screen assertions that follow prove which screen is on.
const tab = page => { const value = new URL(page.url()).searchParams.get('tab'); return value === 'dashboard' ? 'home' : value; };
const param = (page, name) => new URL(page.url()).searchParams.get(name);

test('the v2 frame draws when /me says v2; nav drives ?tab= and Back follows the model', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page);
  await answerMe(page);
  await page.goto('/studio?tab=home');
  const frame = page.getByTestId('studio-v2-frame');
  await expect(frame).toBeVisible();
  for (const id of ['home', 'campaigns', 'replies', 'wallet', 'help', 'inbox', 'account']) await expect(page.getByTestId(`studio-nav-${id}`)).toBeVisible();
  await expect(page.getByTestId('studio-nav-home')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('studio-screen-home')).toBeVisible();

  await page.getByTestId('studio-nav-wallet').click();
  await expect.poll(() => tab(page)).toBe('wallet');
  await expect(page.getByTestId('studio-screen-wallet')).toBeVisible();  // the Wallet screen itself (15m, P2-06)
  await expect(page.getByTestId('studio-nav-wallet')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('studio-nav-home')).not.toHaveAttribute('aria-current', 'page');

  await page.getByTestId('studio-nav-help').click();  // between tabs: replaced, not stacked
  await expect.poll(() => tab(page)).toBe('help');
  await page.getByTestId('studio-back').click();
  await expect.poll(() => tab(page)).toBe('home');
  await expect(page.getByTestId('studio-screen-home')).toBeVisible();

  await page.getByTestId('studio-nav-inbox').click();
  await expect(page.getByTestId('studio-screen-inbox')).toBeVisible();
  await page.goBack();  // the browser's Back agrees with the in-app one
  await expect.poll(() => tab(page)).toBe('home');
  await page.goBack();  // Home leaves the studio
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  expect(errors).toEqual([]);
});

test('builder focus mode hides the section bar; Back walks the steps; a deep link gets its parents', async ({ page }) => {
  await signIn(page);
  await answerMe(page);
  await page.goto('/studio?tab=builder&step=3');
  await expect(page.getByTestId('studio-builder-step')).toHaveText('Step 3 of 6: Content');
  await expect(page.getByTestId('studio-nav')).toBeHidden();
  await expect(page.getByTestId('studio-nav')).toHaveAttribute('hidden', '');
  await expect(page.getByTestId('studio-close')).toBeVisible();
  await page.getByTestId('studio-back').click();
  await expect.poll(() => param(page, 'step')).toBe('2');
  await page.goBack();
  await expect.poll(() => param(page, 'step')).toBe('1');
  await page.getByTestId('studio-builder-next').click();
  await expect.poll(() => param(page, 'step')).toBe('2');
  await page.getByTestId('studio-close').click();
  await expect.poll(() => tab(page)).toBe('home');
  await expect(page.getByTestId('studio-nav')).toBeVisible();

  await page.goto('/studio?tab=campaigns&id=req_frame_1');
  await expect(page.getByTestId('studio-screen-campaigns')).toHaveAttribute('data-id', 'req_frame_1');
  await page.getByTestId('studio-back').click();
  await expect.poll(() => param(page, 'id')).toBe(null);
  await expect.poll(() => tab(page)).toBe('campaigns');
  await page.goBack();
  await expect.poll(() => tab(page)).toBe('home');
});

test('staff with the v2 desk get the Team desk frame with no wallet items', async ({ page }) => {
  await signIn(page);
  await answerMe(page, { ui: 'classic', staffDesk: 'v2', isStaff: true, isAdmin: true });
  await page.goto('/studio?tab=review&section=launch');
  const desk = page.getByTestId('studio-staff-frame');
  await expect(desk).toBeVisible();
  await expect(page.getByTestId('studio-v2-frame')).toHaveCount(0);
  for (const id of ['requests', 'launch', 'settle', 'tickets', 'health', 'more']) await expect(page.getByTestId(`studio-staffnav-${id}`)).toBeVisible();
  await expect(page.getByTestId('studio-staffnav-launch')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('studio-nav-wallet')).toHaveCount(0);
  expect(await desk.innerText()).not.toMatch(/wallet|payment/i);
  await page.getByTestId('studio-back').click();
  await expect.poll(() => param(page, 'section')).toBe('requests');
  await page.getByTestId('studio-staffnav-more').click();
  await expect(page.getByTestId('studio-staff-screen-more')).toBeVisible();
  await expect(page.getByTestId('studio-basics')).toBeVisible();
});

// P6-06: the per-session "Classic view" link (PLAN §12.2(e)). The choice lives in this tab's sessionStorage,
// survives a reload of the tab, never reaches another tab and never writes to the server.
test('Classic view: the v2 header link keeps this tab on the classic studio until "New studio"; a reload keeps it, another tab does not; nothing is written', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET' && /\/api\/studio\/admin\//.test(request.url())) writes.push(`${request.method()} ${request.url()}`); });
  await signIn(page);
  await answerMe(page);
  await page.goto('/studio?tab=wallet');
  await expect(page.getByTestId('studio-v2-frame')).toBeVisible();
  const link = page.getByTestId('studio-classic-view');
  await expect(link).toHaveText('Classic view');
  await link.click();
  await expect(page.getByTestId('studio-v2-frame')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible();
  await expect(page.locator('.studio-section-tabs')).toBeVisible();
  await expect.poll(() => tab(page)).toBe('home');  // wallet is no classic tab: the Overview
  await expect(page.getByTestId('studio-new-studio')).toHaveText('New studio');
  expect(await page.evaluate(() => sessionStorage.getItem('albayan.studio.v2.classic'))).toBe(await page.evaluate(() => state.currentUser.id));
  await page.reload();  // this tab keeps the choice, with no "Opening the studio…" wait
  await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible();
  await expect(page.getByTestId('studio-new-studio')).toBeVisible();
  await expect(page.getByTestId('studio-v2-frame')).toHaveCount(0);
  await expect(page.getByTestId('studio-v2-loading')).toHaveCount(0);
  const other = await context.newPage();  // another tab of the same browser: the new studio
  await answerMe(other);
  await other.goto('/studio?tab=home');
  await expect(other.getByTestId('studio-v2-frame')).toBeVisible();
  await expect(other.getByTestId('studio-classic-view')).toBeVisible();
  await other.close();
  await page.getByTestId('studio-new-studio').click();
  await expect(page.getByTestId('studio-v2-frame')).toBeVisible();
  await expect(page.getByTestId('studio-new-studio')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('albayan.studio.v2.classic'))).toBe(null);
  // Arabic: the same link in Arabic words.
  await page.evaluate(() => { if (state.language !== 'ar') toggleLanguage(); });
  await expect(page.getByTestId('studio-classic-view')).toHaveText('العرض القديم');
  await page.getByTestId('studio-classic-view').click();
  await expect(page.getByTestId('studio-new-studio')).toHaveText('الاستوديو الجديد');
  await page.getByTestId('studio-new-studio').click();
  await expect(page.getByTestId('studio-v2-frame')).toBeVisible();
  await page.evaluate(() => { if (state.language !== 'en') toggleLanguage(); });
  // /me says classic: the stored choice offers no "New studio" (there is nothing to go back to).
  await page.evaluate(() => sessionStorage.setItem('albayan.studio.v2.classic', state.currentUser.id));
  await answerMe(page, { ui: 'classic' });
  await page.goto('/studio');
  await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible();
  await page.waitForFunction(() => typeof studioMe === 'function' && !!studioMe());
  await expect(page.getByTestId('studio-new-studio')).toHaveCount(0);
  await page.evaluate(() => sessionStorage.removeItem('albayan.studio.v2.classic'));
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test('Classic view in the Team desk header: staff land on the classic review tab and "New studio" brings the desk back', async ({ page }) => {
  await signIn(page);
  await answerMe(page, { ui: 'classic', staffDesk: 'v2', isStaff: true, isAdmin: true });
  await page.goto('/studio?tab=review&section=launch');
  await expect(page.getByTestId('studio-staff-frame')).toBeVisible();
  await page.getByTestId('studio-classic-view').click();
  await expect(page.getByTestId('studio-staff-frame')).toHaveCount(0);
  await expect(page.locator('.studio-section-tabs')).toBeVisible();
  await expect.poll(() => tab(page)).toBe('review');
  await page.getByTestId('studio-new-studio').click();
  await expect(page.getByTestId('studio-staff-frame')).toBeVisible();
  await expect(page.getByTestId('studio-staffnav-launch')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('studio-new-studio')).toHaveCount(0);
});

test('the classic studio stays when /me says classic', async ({ page }) => {
  await signIn(page);
  await answerMe(page, { ui: 'classic', staffDesk: 'classic', isStaff: true, isAdmin: true });
  await page.goto('/studio');
  await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible();
  await expect(page.locator('.studio-section-tabs')).toBeVisible();
  await page.waitForFunction(() => typeof studioMe === 'function' && !!studioMe());
  await expect(page.getByTestId('studio-v2-frame')).toHaveCount(0);
  await page.evaluate(() => setAdsStudioTab('campaigns'));
  await expect.poll(() => tab(page)).toBe('campaigns');
});

for (const [language, theme] of [['en', 'light'], ['ar', 'dark']]) {
  test(`the v2 frame fits 320-820 px and shows a side rail on wide screens (${language}, ${theme})`, async ({ page }) => {
    await signIn(page);
    await answerMe(page);
    await page.goto('/studio?tab=replies');
    await expect(page.getByTestId('studio-v2-frame')).toBeVisible();
    await page.evaluate(({ language, theme }) => {
      if (state.language !== language) toggleLanguage();
      shellSetTheme(theme);
    }, { language, theme });
    await expect(page.getByTestId('studio-v2-frame')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
    for (const screen of ['replies', 'builder', 'account']) {
      await page.evaluate(id => studioV2Open(id), screen);
      await expect(page.getByTestId(`studio-screen-${screen}`)).toBeVisible();
      for (const width of [320, 360, 390, 412, 820]) {
        await page.setViewportSize({ width, height: 800 });
        const layout = await page.evaluate(() => {
          const inside = element => { const box = element.getBoundingClientRect(); return box.width === 0 || (box.left >= -1 && box.right <= innerWidth + 1); };
          const nav = document.querySelector('[data-testid="studio-nav"]');
          const navBox = nav && !nav.hidden ? nav.getBoundingClientRect() : null;
          return {
            overflow: document.documentElement.scrollWidth - innerWidth,
            outside: [...document.querySelectorAll('[data-testid="studio-v2-frame"] button, [data-testid="studio-v2-frame"] h1, [data-testid="studio-v2-frame"] p')]
              .filter(element => !inside(element)).map(element => element.textContent.trim().slice(0, 40)),
            small: [...document.querySelectorAll('[data-testid="studio-v2-frame"] button')].filter(element => {
              const box = element.getBoundingClientRect();
              return box.width > 0 && (box.width < 43.5 || box.height < 43.5);
            }).map(element => element.getAttribute('data-testid') || element.textContent.trim().slice(0, 30)),
            navAtBottom: navBox ? Math.abs(navBox.bottom - innerHeight) <= 1 : null
          };
        });
        expect(layout.overflow, `${screen} overflows at ${width}px`).toBeLessThanOrEqual(1);
        expect(layout.outside, `${screen} at ${width}px`).toEqual([]);
        expect(layout.small, `${screen} touch targets at ${width}px`).toEqual([]);
        if (screen !== 'builder') expect(layout.navAtBottom, `${screen} section bar at ${width}px`).toBe(true);
      }
    }
    await page.evaluate(() => studioV2Open('wallet'));
    await page.setViewportSize({ width: 1280, height: 900 });
    const rail = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="studio-nav"]');
      const box = nav.getBoundingClientRect();
      return { position: getComputedStyle(nav).position, width: box.width, top: box.top, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(rail.position).toBe('sticky');
    expect(rail.width).toBeGreaterThan(150);
    expect(rail.width).toBeLessThan(300);
    expect(rail.overflow).toBeLessThanOrEqual(1);
  });
}
