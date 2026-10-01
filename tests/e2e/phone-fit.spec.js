// Phone fit: the measurable promises behind "the app works nicely on any
// phone". Each one was a real defect found by a device-size sweep on
// 2026-10-01 (320-430 px phones, iPad, landscape): headers that scrolled
// away, money that wrapped mid-number, 25 px native selects on WebKit, and
// an Arabic install whose overlays laid out LTR after every cold start.
const { test, expect } = require('@playwright/test');

const ADMIN = { email: 'e2e.admin@albayan.example.com', password: 'E2eAdminPassword123!' };

async function signIn(page) {
  await page.goto('/');
  const chooser = page.getByRole('button', { name: 'Use another account', exact: true });
  if (await chooser.isVisible().catch(() => false)) await chooser.click();
  await expect(page.locator('#login-form')).toBeVisible();
  await page.locator('#login-email').fill(ADMIN.email);
  await page.locator('#login-password').fill(ADMIN.password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.currentUser?.id);
  await page.waitForFunction(() => !!_serverLiveSync?.timer || window.__albayanInitSettled === true);
}
const go = (page, route) => page.evaluate(r => navigateTo(r), route).then(() => page.waitForTimeout(400));
async function expectNoOverflow(page, label) {
  const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scrollWidth, `${label}: horizontal overflow`).toBeLessThanOrEqual(innerWidth + 1);
}

// Phone layouts only: the desktop shell has no phone header or bottom nav.
test.skip(({ isMobile }) => !isMobile, 'phone layout only');

for (const viewport of [{ width: 320, height: 568 }, null]) {
  const label = viewport ? '320x568 (smallest phone)' : 'the project viewport';
  test(`phone fit at ${label}: no overflow, sticky header, one-line money, tappable selects, Arabic direction after reload`, async ({ page }) => {
    if (viewport) await page.setViewportSize(viewport);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await signIn(page);
    for (const route of ['analytics', 'customers', 'receipts', 'ads', 'deliveries', 'more']) {
      await go(page, route);
      await expectNoOverflow(page, route);
    }
    await go(page, 'customers');
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(250);
    const headerTop = await page.evaluate(() => document.querySelector('.mobile-app-header')?.getBoundingClientRect().top);
    expect(headerTop, 'the phone header scrolled away instead of sticking').toBeGreaterThanOrEqual(-1);
    // Packaged-app layout: Capacitor pads the body by the status-bar inset; the
    // stuck header must also cover that band (no list text under the clock).
    // The classes are added after the app's own DOMContentLoaded handler, which
    // resets them, so the app boots into the packaged layout on the next load.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => setTimeout(() => {
        document.body.classList.add('platform-capacitor', 'platform-ios');
        document.documentElement.style.setProperty('--safe-area-inset-top', '47px');
      }, 0));
    });
    await page.reload();
    await page.waitForFunction(() => typeof state !== 'undefined' && !!state.currentUser?.id && window.__albayanInitSettled === true);
    await go(page, 'customers');
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForTimeout(300);
    const underClock = await page.evaluate(() => {
      const hit = document.elementFromPoint(Math.round(window.innerWidth / 2), 12);
      const header = document.querySelector('.mobile-app-header');
      const ok = !!hit && !!header && (hit === header || header.contains(hit));
      return ok ? '' : `${hit?.tagName}.${String(hit?.className || '').slice(0, 40)}`;
    });
    expect(underClock, 'list content showed under the status bar instead of the header').toBe('');
    await page.evaluate(() => window.scrollTo(0, 600));
    const wrapped = await page.evaluate(() => Array.from(document.querySelectorAll('.workspace-stat-value')).filter(el => {
      const fontSize = parseFloat(getComputedStyle(el).fontSize);
      return el.getBoundingClientRect().height > fontSize * 1.7;
    }).map(el => el.textContent.trim()));
    expect(wrapped, 'a money total wrapped onto two lines').toEqual([]);
    await go(page, 'deliveries');
    const shortSelects = await page.evaluate(() => Array.from(document.querySelectorAll('select')).filter(s => {
      const r = s.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 40;
    }).map(s => `${s.className.slice(0, 40)} ${Math.round(s.getBoundingClientRect().height)}px`));
    expect(shortSelects, 'a select is too short to tap').toEqual([]);
    await page.evaluate(() => { if (state.language !== 'ar') toggleLanguage(); });
    await page.reload();
    await page.waitForFunction(() => typeof state !== 'undefined' && window.__albayanInitSettled === true);
    expect(await page.evaluate(() => document.documentElement.getAttribute('dir')), 'Arabic install booted LTR').toBe('rtl');
    expect(await page.evaluate(() => document.documentElement.getAttribute('lang'))).toBe('ar');
    await go(page, 'customers');
    await expectNoOverflow(page, 'customers (Arabic)');
    await page.evaluate(() => { if (state.language !== 'en') toggleLanguage(); });
    expect(errors).toEqual([]);
  });
}
