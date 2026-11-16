const { test, expect } = require('@playwright/test');

// 2026-11-16: a tab opened before a release asks for a lazy bundle with the OLD main bundle's ?v=.
// The server answers a small notice instead of the new bundle (which could stop half-way inside
// the old page and leave a dead menu). No sign-in is needed: the notice is the same everywhere.
test('a tab from before the release is told to reload, and "Later" leaves the page as it was', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#app')).not.toBeEmpty();
  const mainScript = await page.locator('script[src*="script.js"]').first().getAttribute('src');
  expect(mainScript).toMatch(/\?v=/);

  // The current version still gets the real bundle: nothing is shown.
  await page.addScriptTag({ url: `/meta-tools.js?${mainScript.split('?')[1]}` });
  await expect(page.locator('#albayan-stale-build')).toHaveCount(0);

  await page.addScriptTag({ url: '/studio.js?v=from-an-older-release' });
  await page.addScriptTag({ url: '/clothes.js?v=from-an-older-release' });
  const notice = page.locator('#albayan-stale-build');
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('A new version is available');
  await expect(notice.getByRole('button', { name: 'Reload now' })).toBeFocused();
  await notice.getByRole('button', { name: 'Later' }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.locator('#app')).not.toBeEmpty();

  await page.addScriptTag({ url: '/admin-tools.js?v=from-an-older-release' });
  await Promise.all([page.waitForEvent('load'), page.locator('#albayan-stale-build').getByRole('button', { name: 'Reload now' }).click()]);
  await expect(page.locator('#albayan-stale-build')).toHaveCount(0);
  expect(errors).toEqual([]);
});
