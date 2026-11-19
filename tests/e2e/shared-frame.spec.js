// The shared frame (redesign M4 and round 2): the area switcher, the sections of each area, the
// account menu, the rail between 901 and 1279 px, centred dialogs on tablets, and the two systems
// inside the frame (the Clothes System with its sections in the sidebar, the Ads Studio beside a
// narrow rail). The tests set their own window sizes, so they run in desktop projects only; the
// phone drawer and the phone sheet are covered by the existing phone specs on every engine.
const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL = 'e2e.admin@albayan.example.com';
const ADMIN_PASSWORD = 'E2eAdminPassword123!';

test.skip(({ isMobile }) => isMobile, 'sets desktop and tablet window sizes itself');

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

test('on a tablet card lists use two columns, a dialog is a centred window as wide as it needs, and it takes the top position while a field is in use', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await signIn(page);
  await page.evaluate(() => navigateTo('customers'));
  await expect.poll(() => new URL(page.url()).pathname).toBe('/customers');
  const grid = await page.evaluate(() => ({ columns: getComputedStyle(document.getElementById('customers-grid')).gridTemplateColumns.split(' ').length, overflow: document.documentElement.scrollWidth - innerWidth }));
  expect(grid).toEqual({ columns: 2, overflow: 0 });
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

test('the Clothes System sits in the frame on a wide screen: its sections are lines of the sidebar that open by address, and its own tab bar comes back on a tablet', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.locator('#app-sidebar .frame-head summary').click();
  await page.locator('#app-sidebar .frame-head .frame-menu-list button', { hasText: 'Clothes System' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/clothes-system');
  await expect(page.locator('#workspace-view-content').getByRole('heading', { name: 'Clothes System', exact: true })).toBeVisible();
  // The system hands its four sections to the frame once its bundle is there.
  await expect.poll(() => sections(page)).toEqual(['Owner dashboard', 'Dashboard', 'Products', 'Shipments', 'Orders']);
  await expect(page.locator('#app-sidebar .frame-head summary')).toContainText('Clothes System');
  await expect(page.locator('#app-sidebar .frame-link[aria-current="page"]')).toHaveText('Dashboard');
  expect(await sidebarWidth(page)).toBe(264);
  // Its own back link and tab bar step aside: the sidebar has them.
  await expect(page.locator('.clothes-tab-bar')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Back to Smart Systems' })).toBeHidden();
  // No platform top bar over the system's own header, and nothing scrolls sideways.
  await expect(page.locator('.workspace-topbar')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);

  // A section opens at its own address, and the browser's Back returns to the one before.
  await page.locator('#app-sidebar .frame-link', { hasText: 'Orders' }).click();
  await expect.poll(() => page.url().replace(/^https?:\/\/[^/]+/, '')).toBe('/clothes-system?tab=orders');
  await expect(page.locator('#app-sidebar .frame-link[aria-current="page"]')).toHaveText('Orders');
  await expect(page.getByRole('button', { name: /new order/i })).toBeVisible();
  await page.locator('#app-sidebar .frame-link', { hasText: 'Products' }).click();
  await expect.poll(() => page.url().replace(/^https?:\/\/[^/]+/, '')).toBe('/clothes-system?tab=products');
  await expect(page.getByRole('button', { name: /add product/i })).toBeVisible();
  await page.goBack();
  await expect.poll(() => page.url().replace(/^https?:\/\/[^/]+/, '')).toBe('/clothes-system?tab=orders');
  await expect(page.locator('#app-sidebar .frame-link[aria-current="page"]')).toHaveText('Orders');
  // The owner dashboard is one click away, without the Smart Systems screen in between.
  await page.locator('#app-sidebar .frame-link', { hasText: 'Owner dashboard' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/control-center');

  // A fresh load straight at the system's address: the sections appear as soon as the system's bundle is there.
  await page.goto('/clothes-system?tab=shipments');
  await expect.poll(() => sections(page), { timeout: 20000 }).toEqual(['Owner dashboard', 'Dashboard', 'Products', 'Shipments', 'Orders']);
  await expect(page.locator('#app-sidebar .frame-link[aria-current="page"]')).toHaveText('Shipments');
  // A section picked inside the page (as the quick actions of its dashboard do) moves the sidebar's mark too.
  await page.evaluate(() => setClothesTab('orders'));
  await expect(page.locator('#app-sidebar .frame-link[aria-current="page"]')).toHaveText('Orders');
  await expect(page.getByRole('button', { name: /new order/i })).toBeVisible();

  // On a tablet the system draws its own navigation, as on a phone: the tab bar and the back link are back.
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto('/clothes-system?tab=shipments');
  await expect(page.locator('.clothes-tab-bar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to Smart Systems' })).toBeVisible();
  await expect(page.locator('#app-sidebar')).not.toBeInViewport();
  await expect(page.locator('.mobile-bottom-nav')).toHaveCount(0);
  expect(await page.evaluate(() => ({ start: Math.round(document.querySelector('.app-main').getBoundingClientRect().left), overflow: document.documentElement.scrollWidth - innerWidth }))).toEqual({ start: 0, overflow: 0 });
  expect(errors).toEqual([]);
});

test('the Ads Studio sits beside a narrow rail of the frame at every wide size, keeps its own list of sections, and its own door has no frame', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.locator('#app-sidebar .frame-head summary').click();
  await page.locator('#app-sidebar .frame-head .frame-menu-list button', { hasText: 'Ads Studio' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/ads-studio');
  await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible();
  await awayFromSidebar(page);
  // A rail even at 1440 px: the Studio's own navigation is beside it, in the page.
  await expect(page.locator('#app-sidebar')).toHaveClass(/frame-rail/);
  await expect.poll(() => sidebarWidth(page)).toBe(72);
  expect(await page.evaluate(() => ({ start: Math.round(document.querySelector('.app-main').getBoundingClientRect().left), overflow: document.documentElement.scrollWidth - innerWidth }))).toEqual({ start: 72, overflow: 0 });
  expect(await sections(page)).toEqual(['Owner dashboard']);
  await expect(page.locator('.workspace-topbar')).toHaveCount(0);
  // The keyboard opens the rail; the switcher lists the areas with the Studio ticked; Escape closes it.
  await page.locator('#app-sidebar .frame-head summary').focus();
  await expect.poll(() => sidebarWidth(page)).toBe(264);
  await page.keyboard.press('Enter');
  await expect(page.locator('#app-sidebar .frame-head .frame-menu-list [aria-current="true"]')).toHaveText('Ads Studio');
  await page.keyboard.press('Escape');
  // The account menu is in the rail too.
  await page.locator('#app-sidebar .frame-account summary').click();
  await expect(page.locator('#app-sidebar .frame-account .frame-menu-list')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#app-sidebar .frame-account .frame-menu-list button').last()).toHaveText('Logout');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement.blur());
  await awayFromSidebar(page);
  await expect.poll(() => sidebarWidth(page)).toBe(72);
  // One click on the rail's first line leads to the owner dashboard, where the sidebar is full width again.
  await page.locator('#app-sidebar .frame-link').first().click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/control-center');
  await awayFromSidebar(page);
  await expect.poll(() => sidebarWidth(page)).toBe(264);

  // The Studio's own door is unchanged: only the Studio, with no frame around it.
  await page.goto('/studio');
  await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible();
  await expect(page.locator('#app-sidebar')).toHaveCount(0);
  expect(await page.evaluate(() => Math.round(document.querySelector('.app-main').getBoundingClientRect().left))).toBe(0);
  expect(errors).toEqual([]);
});

// Two made-up customers for the list tests (added through the app's own save, as the other specs do).
async function seedCustomers(page, tag) {
  return page.evaluate(async tag => {
    const made = [];
    for (const [index, name] of [`Panel One ${tag}`, `Panel Two ${tag}`].entries()) {
      const customer = { id: generateId('cust'), name, phones: [`091${String(Date.now() + index).slice(-7)}`], platform: 'Facebook', joinDate: new Date().toISOString(), profileLinks: [] };
      if (!await addRecord(state.customers, customer)) throw new Error(`Customer seed failed: ${name}`);
      made.push(customer.id);
    }
    return made;
  }, tag);
}

test('from 1280 px a record opens its details in a panel beside the list, one at a time; below that they open in place', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const [first, second] = await seedCustomers(page, `${testInfo.project.name}-${Date.now()}`);
  await page.evaluate(() => navigateTo('customers'));
  await expect.poll(() => new URL(page.url()).pathname).toBe('/customers');
  const row = id => page.locator(`[data-shell-row="customers"][data-shell-row-id="${id}"]`);
  const toggle = id => row(id).locator('> button');
  const body = id => row(id).locator('.shell-row-body');
  const box = async locator => { const r = await locator.boundingBox(); return { left: Math.round(r.x), right: Math.round(r.x + r.width), top: Math.round(r.y), width: Math.round(r.width) }; };
  await expect(toggle(first)).toBeVisible();
  const grid = await box(page.locator('#customers-grid'));
  const closedCard = await box(row(first));

  // Details: the card keeps its place in the list (first column) and its details take the second column.
  await toggle(first).click();
  await expect(toggle(first)).toHaveAttribute('aria-expanded', 'true');
  const card = body(first).locator('> .glass-panel');
  await expect(card).toBeVisible();
  const opened = await box(row(first));
  const panel = await box(card);
  expect(opened.left, 'the opened card is in the list column').toBe(grid.left);
  expect(opened.width, 'and stays one column wide (before: it took the whole row)').toBe(closedCard.width);
  expect(panel.left, 'the details start right of the list column').toBeGreaterThanOrEqual(opened.right + 10);
  expect(Math.abs(panel.right - grid.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(panel.width - closedCard.width)).toBeLessThanOrEqual(1);
  // Every other record is in the first column too: nothing is left beside or under the panel.
  expect(await page.evaluate(() => Array.from(document.querySelectorAll('#customers-grid > .workspace-record'), card => Math.round(card.getBoundingClientRect().left)).filter((left, index, all) => left !== all[0]).length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  // The actions of the full card are in the panel.
  await expect(card.locator(`button[onclick="editCustomer('${first}')"]`)).toBeVisible();

  // One at a time: another record takes the panel.
  await toggle(second).click();
  await expect(toggle(second)).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(first)).toHaveAttribute('aria-expanded', 'false');
  await expect(body(first)).toBeHidden();
  await expect(body(second).locator('> .glass-panel')).toBeVisible();
  // The panel stays in view while the list scrolls.
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(async () => (await box(body(second).locator('> .glass-panel'))).top).toBe(129);
  await expect(body(second).locator('.shell-panel-close')).toBeInViewport({ ratio: 1 });
  // Close (in the panel) closes it and hands the focus back to the record's own button.
  await body(second).locator('.shell-panel-close').click();
  await expect(toggle(second)).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle(second)).toBeFocused();
  await expect(page.locator('#customers-grid .shell-row-body:visible')).toHaveCount(0);

  // In Arabic the panel is on the left of the list.
  await page.evaluate(() => { window.scrollTo(0, 0); toggleLanguage(); });
  await toggle(first).click();
  await expect(body(first).locator('> .glass-panel')).toBeVisible();
  const mirrored = { card: await box(row(first)), panel: await box(body(first).locator('> .glass-panel')) };
  expect(mirrored.panel.right).toBeLessThanOrEqual(mirrored.card.left - 10);
  await expect(body(first).locator('.shell-panel-close')).toHaveText('إغلاق');
  await page.evaluate(() => toggleLanguage());

  // Under 1280 px the details open in place, as before: the opened card takes the row, and there is no Close button.
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(toggle(first)).toHaveAttribute('aria-expanded', 'true');
  const inPlace = { card: await box(row(first)), grid: await box(page.locator('#customers-grid')), details: await box(body(first).locator('> .glass-panel')) };
  expect(Math.abs(inPlace.card.width - inPlace.grid.width)).toBeLessThanOrEqual(1);
  expect(inPlace.details.left).toBeGreaterThanOrEqual(inPlace.card.left);
  expect(inPlace.details.right).toBeLessThanOrEqual(inPlace.card.right);
  await expect(body(first).locator('.shell-panel-close')).toBeHidden();
  await toggle(second).click();
  await expect(toggle(first)).toHaveAttribute('aria-expanded', 'true');   // in place, several records may stay open
  await expect(toggle(second)).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});

test('Home starts once: no second page title, and the figures follow as a section', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.evaluate(() => navigateTo('analytics'));
  await expect.poll(() => new URL(page.url()).pathname).toBe('/analytics');
  const content = page.locator('#workspace-view-content');
  await expect(content.locator('h1')).toHaveCount(1);
  await expect(content.getByRole('heading', { level: 1 })).toHaveText('Analytics');
  // The page name is in the frame's top bar; the heading itself takes no room, so the opening block is first on the page.
  const first = await content.locator('[data-manager-home-hero]').boundingBox();
  const title = await content.locator('h1').boundingBox();
  expect(title.width).toBeLessThanOrEqual(1);
  expect(Math.round(first.y)).toBeLessThanOrEqual(110);
  await expect(content.getByRole('heading', { level: 2, name: 'Breakdowns', exact: true })).toBeVisible();
  await expect(page.locator('.workspace-topbar')).toContainText('Analytics');
});
