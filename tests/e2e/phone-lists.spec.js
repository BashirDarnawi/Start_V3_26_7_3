// Phones: the first record sooner (redesign round 2, finding B-16). On a phone-sized screen the Filters
// button sits beside the search, the quick filters follow on one row, and the first record of a list
// starts on the first screen. Runs in the phone projects on every engine; the desktop project sets a
// phone-sized window itself.
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
  await page.waitForFunction(() => !!state.currentUser?.id && !!_serverLiveSync.timer, null, { timeout: 30000 });
}

test('on a phone the Filters button shares a row with the search and the first customer starts on the first screen', async ({ page, isMobile }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (!isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const tag = `${testInfo.project.name}-${Date.now()}`;
  const customerId = await page.evaluate(async tag => {
    const customer = { id: generateId('cust'), name: `Phone List ${tag}`, phones: [`092${String(Date.now()).slice(-7)}`], platform: 'Facebook', joinDate: new Date().toISOString(), profileLinks: [] };
    if (!await addRecord(state.customers, customer)) throw new Error('Customer seed failed');
    return customer.id;
  }, tag);
  await page.evaluate(() => navigateTo('customers'));
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe('customers');
  const viewport = page.viewportSize();
  const top = async locator => Math.round((await locator.boundingBox()).y);
  const search = page.locator('.smart-filter-primary > .smart-search-field');
  const filters = page.locator('.smart-filter-primary > .workspace-filter-toggle');
  const chips = page.locator('.smart-filter-primary > .smart-filter-chips');
  await expect(filters).toBeVisible();
  // One row: search, then the Filters button; the quick filters under them, on one row.
  const searchBox = await search.boundingBox(), filtersBox = await filters.boundingBox(), chipsBox = await chips.boundingBox();
  expect(Math.abs((searchBox.y + searchBox.height / 2) - (filtersBox.y + filtersBox.height / 2))).toBeLessThanOrEqual(3);
  expect(chipsBox.y).toBeGreaterThanOrEqual(searchBox.y + searchBox.height);
  expect(filtersBox.height).toBeGreaterThanOrEqual(44);
  expect(chipsBox.height, 'the quick filters fit one row').toBeLessThanOrEqual(56);
  // The button shows its first word; a screen reader still gets the whole name, and it still opens the full panel.
  await expect(filters).toHaveAccessibleName(/Filters\s*&\s*sort/);
  await expect(filters).toHaveAttribute('aria-expanded', 'false');
  await filters.click();
  await expect(page.locator('#customers-advanced-filters')).toBeVisible();
  await expect(filters).toHaveAccessibleName(/Hide filters/);
  await filters.click();
  await expect(page.locator('#customers-advanced-filters')).toBeHidden();
  // The three totals share one row.
  const tiles = await page.locator('#workspace-view-content .workspace-stat-card').evaluateAll(cards => cards.map(card => Math.round(card.getBoundingClientRect().top)));
  expect(tiles.length).toBe(3);
  expect(Math.max(...tiles) - Math.min(...tiles)).toBeLessThanOrEqual(1);
  // The first record starts in the upper two thirds of the first screen (before: at its bottom edge).
  const firstCard = page.locator('#customers-grid > .workspace-record').first();
  await expect(firstCard).toBeVisible();
  expect(await top(firstCard)).toBeLessThan(Math.round(viewport.height * 2 / 3));
  await expect(page.locator(`[data-shell-row="customers"][data-shell-row-id="${customerId}"]`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

  // Deliveries: the stage counters and the delivery log come before the money summary.
  await page.evaluate(() => navigateTo('deliveries'));
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe('deliveries');
  await expect(page.locator('.ops-deliveries > .ops-hero')).toBeVisible();
  const order = await page.evaluate(() => ['.ops-hero', '.ops-pipeline', '.ops-board', '.ops-kpi-rail', '.ops-fee-strip'].map(name => Math.round(document.querySelector(`.ops-deliveries > ${name}`).getBoundingClientRect().top)));
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  const counters = await page.locator('.ops-deliveries > .ops-pipeline > div').evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().top)));
  expect(counters.length).toBe(4);
  expect(Math.max(...counters) - Math.min(...counters), 'four counters on one row').toBeLessThanOrEqual(1);
  expect(await top(page.locator('.ops-deliveries .ops-controls')), 'the search of the delivery log is on the first screen').toBeLessThan(viewport.height - 160);
  // The two lists keep their names for a screen reader although the small labels are not drawn.
  await expect(page.locator('.ops-deliveries .ops-controls select').first()).toHaveAccessibleName('Status');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(errors).toEqual([]);
});
