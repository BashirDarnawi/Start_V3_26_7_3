// The two public pages, /privacy and /delete-account (redesign round 3, template T16). They need no sign-in
// and are one self-contained file each. They show one language at a time, follow the language and theme
// chosen in the app, and open the language of a part named in the address (#terms, #terms-ar). With scripts
// off, both languages show one after the other, as the pages always did.
const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL = 'e2e.admin@albayan.example.com';
const ADMIN_PASSWORD = 'E2eAdminPassword123!';
const PAGES = [
  { address: '/privacy', english: 'Privacy Policy — Albayan', arabic: 'سياسة الخصوصية — البيان' },
  { address: '/delete-account', english: 'Request account deletion — Albayan', arabic: 'طلب حذف حسابك في البيان' }
];

const english = page => page.locator('article#en');
const arabic = page => page.locator('article#ar');
const sideways = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const topOf = async locator => Math.round((await locator.boundingBox()).y);

// Script errors anywhere, and anything the browser reports as an error while one of the two pages is open.
function collectErrors(page) {
  const errors = [];
  const onPublicPage = () => PAGES.some(({ address }) => new URL(page.url()).pathname === address);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && onPublicPage()) errors.push(message.text()); });
  return errors;
}

test('each public page shows one language, its two buttons switch it, and the address keeps the choice', async ({ page }) => {
  const errors = collectErrors(page);
  for (const { address, english: englishTitle, arabic: arabicTitle } of PAGES) {
    // The tests' browser is English and nothing is saved by the app yet.
    await page.goto(address);
    await expect(english(page)).toBeVisible();
    await expect(arabic(page)).toBeHidden();
    await expect(page).toHaveTitle(englishTitle);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const toEnglish = page.locator('.langs a[data-set-lang="en"]');
    const toArabic = page.locator('.langs a[data-set-lang="ar"]');
    await expect(toEnglish).toHaveAttribute('aria-current', 'true');
    await expect(toArabic).not.toHaveAttribute('aria-current', 'true');
    for (const button of [toEnglish, toArabic]) {
      const box = await button.boundingBox();
      expect(Math.min(box.width, box.height), `${address}: a language button is at least 44 px`).toBeGreaterThanOrEqual(44);
    }
    expect(await sideways(page), `${address}: no sideways scrolling in English`).toBeLessThanOrEqual(0);

    await toArabic.click();
    await expect(arabic(page)).toBeVisible();
    await expect(english(page)).toBeHidden();
    await expect(page).toHaveTitle(arabicTitle);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(toArabic).toHaveAttribute('aria-current', 'true');
    await expect(toEnglish).not.toHaveAttribute('aria-current', 'true');
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(`${address}?lang=ar`);
    expect(await sideways(page), `${address}: no sideways scrolling in Arabic`).toBeLessThanOrEqual(0);

    // The address now says which language: a reload, or the same address opened by someone else, keeps it.
    await page.reload();
    await expect(arabic(page)).toBeVisible();
    await expect(english(page)).toBeHidden();

    await toEnglish.click();
    await expect(english(page)).toBeVisible();
    await expect(arabic(page)).toBeHidden();
    expect(new URL(page.url()).search).toBe('?lang=en');
  }
  expect(errors).toEqual([]);
});

test('the privacy page lists its nine parts, each line brings its part to the top, and a part named in the address opens in its own language', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/privacy?lang=en');
  const lines = english(page).locator('.toc a');
  await expect(lines).toHaveCount(9);
  await expect(english(page).locator('.toc-title')).toHaveText('On this page');
  // The nine lines are the nine headings of the text, in the same order.
  const headings = await english(page).locator('.text h2').allTextContents();
  expect(await lines.allTextContents()).toEqual(headings);

  await lines.filter({ hasText: 'Your rights' }).click();
  await expect(page.locator('#rights')).toBeInViewport();
  expect(await topOf(page.locator('#rights > h2')), 'the heading sits at the top of the screen').toBeLessThan(120);
  expect(new URL(page.url()).hash).toBe('#rights');
  await expect(english(page)).toBeVisible();

  // The links the app uses: the customer terms in English and in Arabic, whatever language the page had before.
  await page.goto('/privacy#terms-ar');
  await expect(arabic(page)).toBeVisible();
  await expect(english(page)).toBeHidden();
  await expect(page.locator('#terms-ar')).toBeInViewport();
  await expect(arabic(page).locator('.toc-title')).toHaveText('في هذه الصفحة');
  await expect(arabic(page).locator('.toc a')).toHaveCount(9);
  expect(await arabic(page).locator('.toc a').allTextContents()).toEqual(await arabic(page).locator('.text h2').allTextContents());

  await page.goto('/privacy?lang=ar#terms');   // the part named in the address decides before ?lang=
  await expect(english(page)).toBeVisible();
  await expect(arabic(page)).toBeHidden();
  await expect(page.locator('#terms')).toBeInViewport();

  // The address changes while the page is open (a typed address, the Back button): the language follows the part.
  await page.evaluate(() => { location.hash = 'retention-ar'; });
  await expect(arabic(page)).toBeVisible();
  await expect(english(page)).toBeHidden();
  await expect(page.locator('#retention-ar')).toBeInViewport();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('both public pages follow the language and the theme chosen in the app', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#login-form')).toBeVisible();
  await page.locator('#login-email').fill(ADMIN_EMAIL);
  await page.locator('#login-password').fill(ADMIN_PASSWORD);
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/auth/login')),
    page.locator('#login-form button[type="submit"]').click()
  ]);
  expect(response.ok()).toBe(true);
  await page.waitForFunction(() => !!state.currentUser?.id && !!_serverLiveSync.timer, null, { timeout: 30000 });

  // The app's own switches (the account menu calls these two functions).
  await page.evaluate(() => {
    if (state.language !== 'ar') toggleLanguage();
    while (state.theme !== 'dark') toggleTheme();
  });
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('albayan_complete_state') || 'null');
    return [saved && saved.language, localStorage.getItem('albayan_theme')].join();
  })).toBe('ar,dark');

  for (const { address, arabic: arabicTitle } of PAGES) {
    await page.goto(address);
    await expect(arabic(page)).toBeVisible();
    await expect(english(page)).toBeHidden();
    await expect(page).toHaveTitle(arabicTitle);
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
    // dark canvas, light text (the app's dark theme)
    expect(await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color])).toEqual(['rgb(13, 20, 35)', 'rgb(239, 244, 255)']);
  }

  // Back to English and light in the app: the pages follow again.
  await page.goto('/');
  await page.waitForFunction(() => !!state.currentUser?.id, null, { timeout: 30000 });
  await page.evaluate(() => {
    if (state.language !== 'en') toggleLanguage();
    while (state.theme !== 'light') toggleTheme();
  });
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('albayan_complete_state') || 'null');
    return [saved && saved.language, localStorage.getItem('albayan_theme')].join();
  })).toBe('en,light');
  await page.goto('/privacy');
  await expect(english(page)).toBeVisible();
  await expect(arabic(page)).toBeHidden();
  await expect(page.locator('html')).toHaveClass(/(^|\s)light(\s|$)/);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(238, 241, 250)');
  expect(errors).toEqual([]);
});

test.describe('with scripts off', () => {
  test.use({ javaScriptEnabled: false });

  test('both languages show one after the other, English first, and the two buttons are plain links to each', async ({ page }) => {
    for (const { address, english: englishTitle } of PAGES) {
      await page.goto(address);
      await expect(page).toHaveTitle(englishTitle);
      await expect(english(page)).toBeVisible();
      await expect(arabic(page)).toBeVisible();
      const first = await english(page).boundingBox();
      const second = await arabic(page).boundingBox();
      expect(second.y, `${address}: Arabic follows English`).toBeGreaterThanOrEqual(first.y + first.height);
      await expect(page.locator('.langs a[href="#en"]')).toHaveText('English');
      await expect(page.locator('.langs a[href="#ar"]')).toHaveText('العربية');
      await expect(arabic(page)).toHaveAttribute('dir', 'rtl');
      await expect(arabic(page)).toHaveAttribute('lang', 'ar');
    }
  });
});
