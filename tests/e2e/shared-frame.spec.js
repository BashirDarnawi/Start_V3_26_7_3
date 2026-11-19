// The shared frame (redesign M4): the area switcher, the sections of each area, the account menu,
// the rail between 901 and 1279 px, and centred dialogs on tablets. The test sets its own window
// sizes, so it runs in the desktop project only. It was written and run on Chromium; the phone
// drawer and the phone sheet are covered by the existing phone specs on every engine.
const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL = 'e2e.admin@albayan.example.com';
const ADMIN_PASSWORD = 'E2eAdminPassword123!';

test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || isMobile, 'sets desktop and tablet window sizes itself');

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
  await expect(page.locator('#app-sidebar')).toBeAttached();
}

const openMenus = page => page.evaluate(() => Array.from(document.querySelectorAll('#app-sidebar .frame-menu'), menu => menu.open));
const sidebarWidth = page => page.evaluate(() => Math.round(document.getElementById('app-sidebar').getBoundingClientRect().width));
const sections = page => page.evaluate(() => Array.from(document.querySelectorAll('#app-sidebar .workspace-sidebar-nav .frame-link'), link => link.textContent.trim()));
const awayFromSidebar = page => page.mouse.move(900, 500);

test('the Admin changes area from the switcher by keyboard and pointer, each area lists its own sections, and one account menu holds theme, language, privacy, deletion and sign-out', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await awayFromSidebar(page);
  expect(await sidebarWidth(page)).toBe(264);

  // The Admin starts on the owner dashboard: its sidebar lists the dashboard and the other areas.
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe('control-center');
  expect(await sections(page)).toEqual(['Owner dashboard', 'Albayan Manager', 'Ads Studio', 'Clothes System', 'Services']);

  // Keyboard: Enter opens the switcher, Tab walks into it, Escape closes it and returns to its button.
  const switcher = page.locator('#app-sidebar .frame-head summary');
  await switcher.focus();
  await page.keyboard.press('Enter');
  expect(await openMenus(page)).toEqual([true, false]);
  await expect(page.locator('#app-sidebar .frame-head .frame-menu-list button')).toHaveText(['Owner dashboard', 'Albayan Manager', 'Ads Studio', 'Clothes System', 'Services']);
  await expect(page.locator('#app-sidebar .frame-head .frame-menu-list [aria-current="true"]')).toHaveText('Owner dashboard');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.closest('.frame-menu-list') !== null)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await openMenus(page)).toEqual([false, false]);
  expect(await page.evaluate(() => document.activeElement === document.querySelector('#app-sidebar .frame-head summary'))).toBe(true);

  // Pointer: Albayan Manager opens its first screen with every section in view, no Services Hub in between.
  await switcher.click();
  await page.locator('#app-sidebar .frame-head .frame-menu-list button', { hasText: 'Albayan Manager' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/analytics');
  expect(await sections(page)).toEqual(['Owner dashboard', 'Analytics', 'Customers', 'Receipts', 'Pages', 'Ads', 'Deliveries', 'Reconciliation', 'Collect a debt', 'Reminders', 'Users', 'Audit Logs', 'Settings']);
  await expect(page.locator('#app-sidebar .frame-link[aria-current="page"]')).toHaveText('Analytics');
  const lastLine = page.locator('#app-sidebar .workspace-sidebar-nav .frame-link').last();
  await expect(lastLine).toBeInViewport({ ratio: 1 });  // Settings needs no scrolling at 900 px high
  await page.locator('#app-sidebar .frame-link', { hasText: 'Collect a debt' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/collect');

  // Services: the platform's own screens sit in the frame with the search and their own name in the top bar.
  await switcher.click();
  await page.locator('#app-sidebar .frame-head .frame-menu-list button', { hasText: 'Services' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  expect(await sections(page)).toEqual(['Owner dashboard', 'Services Hub', 'Smart Systems', 'Wallet', 'Charge wallet', 'Plans & bundles']);
  await expect(page.locator('.workspace-topbar .workspace-global-search')).toBeVisible();
  await page.locator('#app-sidebar .frame-link', { hasText: 'Wallet' }).first().click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/wallet');
  await expect(page.locator('.workspace-topbar')).toContainText('Wallet');
  await page.locator('#app-sidebar .workspace-sidebar-nav .frame-link', { hasText: 'Owner dashboard' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/control-center');

  // The account menu: one open at a time, a click elsewhere closes it, and theme switches from it.
  await switcher.click();
  await page.locator('#app-sidebar .frame-account summary').click();
  expect(await openMenus(page)).toEqual([false, true]);
  const account = page.locator('#app-sidebar .frame-account .frame-menu-list');
  await expect(account).toBeInViewport({ ratio: 1 });
  for (const control of ['button[onclick^="editUser("]', 'button[onclick="toggleTheme()"]', 'button[onclick="toggleLanguage()"]', 'a[href$="/privacy"]', 'a[href$="/delete-account"]', 'button[onclick="handleLogout()"]']) {
    await expect(account.locator(control)).toHaveCount(1);
  }
  await page.mouse.click(900, 500);
  expect(await openMenus(page)).toEqual([false, false]);
  await page.locator('#app-sidebar .frame-account summary').click();
  await account.locator('button[onclick="toggleTheme()"]').click();
  await expect.poll(() => page.evaluate(() => state.theme)).toBe('dark');
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(errors).toEqual([]);
});

test('from 901 to 1279 px the sidebar is a rail of icons that keeps every name and opens for the keyboard; the page never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await signIn(page);
  await page.evaluate(() => navigateTo('receipts'));
  await expect.poll(() => new URL(page.url()).pathname).toBe('/receipts');
  await awayFromSidebar(page);
  await expect.poll(() => sidebarWidth(page)).toBe(72);
  // The content starts where the rail ends and nothing overflows.
  const layout = await page.evaluate(() => ({ contentStart: Math.round(document.querySelector('.app-main').getBoundingClientRect().left), overflow: document.documentElement.scrollWidth - innerWidth }));
  expect(layout).toEqual({ contentStart: 72, overflow: 0 });
  // Every line still has its name for a screen reader although only the icon is drawn.
  await expect(page.getByRole('button', { name: 'Receipts', exact: true }).first()).toBeAttached();
  expect(await page.evaluate(() => Array.from(document.querySelectorAll('#app-sidebar .frame-link'), link => link.textContent.trim()).filter(Boolean).length)).toBe(13);
  // The keyboard opens the rail to full width, so the names are readable while moving through it.
  await page.locator('#app-sidebar .frame-head summary').focus();
  await expect.poll(() => sidebarWidth(page)).toBe(264);
  await page.keyboard.press('Enter');
  await expect(page.locator('#app-sidebar .frame-head .frame-menu-list')).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement.blur());
  await expect.poll(() => sidebarWidth(page)).toBe(72);
  // In Arabic the rail sits on the right and the content ends where it starts.
  await page.evaluate(() => toggleLanguage());
  await awayFromSidebar(page);
  await expect.poll(() => page.evaluate(() => Math.round(innerWidth - document.querySelector('.app-main').getBoundingClientRect().right))).toBe(72);
  expect(await page.evaluate(() => Math.round(innerWidth - document.getElementById('app-sidebar').getBoundingClientRect().right))).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
});

test('on a tablet a dialog is a centred window as wide as it needs, and takes the top position while a field is in use', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await signIn(page);
  await page.evaluate(() => navigateTo('customers'));
  await expect.poll(() => new URL(page.url()).pathname).toBe('/customers');
  await page.evaluate(() => showCustomerModal());
  const panel = page.locator('#app-modal .app-dialog-panel');
  await expect(panel).toBeVisible();
  const box = () => page.evaluate(() => { const r = document.querySelector('#app-modal .app-dialog-panel').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(innerHeight - r.bottom), left: Math.round(r.left), right: Math.round(innerWidth - r.right), width: Math.round(r.width) }; });
  const resting = await box();
  expect(Math.abs(resting.top - resting.bottom)).toBeLessThanOrEqual(2);   // centred, not a sheet on the bottom edge
  expect(Math.abs(resting.left - resting.right)).toBeLessThanOrEqual(2);
  expect(resting.width).toBeLessThanOrEqual(448);                           // its own max-w-md, not the full 820 px
  await panel.locator('input').first().click();
  await expect.poll(async () => (await box()).top).toBeLessThanOrEqual(16);  // the phone rule's top position, kept
  expect((await box()).width).toBe(resting.width);
});
