// Settings -> Data Management with a server (redesign, finding B-09). "Import" and "Clear All Data"
// work only without a server; with one they could only answer "not allowed". They are no longer
// offered as buttons there: one sentence says where they work. What does work with a server (the
// partial report, the integrity check, the full backup) stays.
const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL = 'e2e.admin@albayan.example.com';
const ADMIN_PASSWORD = 'E2eAdminPassword123!';

test('with a server, Settings shows no Import or Clear All Data button and says so in one sentence', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
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
  expect(await page.evaluate(() => isServerModeEnabled())).toBe(true);

  await page.evaluate(() => navigateTo('settings'));
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe('settings');
  const data = page.locator('#settings-data');
  const sentence = data.locator('.settings-local-only');
  await sentence.scrollIntoViewIfNeeded();
  await expect(sentence).toBeVisible();
  await expect(sentence).toHaveText('"Import Backup" and "Clear All Data" work only without a server.');
  await expect(data.locator('button[onclick="importData()"], button[onclick="clearAllData()"]')).toHaveCount(0);
  await expect(data.locator('button[onclick="exportData()"]')).toBeVisible();
  await expect(data.locator('button[onclick="runDataIntegrityAudit()"]')).toBeVisible();
  // The sentence stays inside the card at this size.
  const fits = await page.evaluate(() => {
    const card = document.getElementById('settings-data').getBoundingClientRect();
    const line = document.querySelector('#settings-data .settings-local-only').getBoundingClientRect();
    return line.left >= card.left - 1 && line.right <= card.right + 1 && document.documentElement.scrollWidth <= window.innerWidth;
  });
  expect(fits, 'inside the card, no sideways scroll').toBe(true);

  await page.evaluate(() => toggleLanguage());
  await expect.poll(() => page.evaluate(() => state.language)).toBe('ar');
  await expect(page.locator('#settings-data .settings-local-only')).toHaveText('«استيراد نسخة احتياطية» و«مسح كل البيانات» يعملان بدون خادم فقط.');
  await page.evaluate(() => toggleLanguage());
  expect(errors).toEqual([]);
});
