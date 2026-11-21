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
  // The three totals share one row while their amounts fit (the test below covers amounts that do not). What they
  // hold depends on the records other tests have saved, up to eight digits in a full run, so the two money totals
  // are first given an ordinary amount (the page's text only): the positions below are those of an ordinary day.
  await page.evaluate(() => document.querySelectorAll('#workspace-view-content .workspace-stat-card .workspace-stat-value').forEach((value, index) => {
    if (index) document.createTreeWalker(value, NodeFilter.SHOW_TEXT).nextNode().nodeValue = '12,350.00 LYD';
  }));
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
  // The driver filter keeps its name for a screen reader although its small label is not drawn; the
  // status filter is a named row of tabs with counts since round 3, and "All" says how many jobs the log holds.
  await expect(page.locator('.ops-deliveries .ops-controls select')).toHaveCount(1);
  await expect(page.locator('.ops-deliveries .ops-controls select')).toHaveAccessibleName('Driver');
  const statusTabs = page.getByRole('group', { name: 'Delivery status' }).getByRole('button');
  await expect(statusTabs).toHaveCount(6);
  await expect(statusTabs.first()).toHaveAttribute('aria-pressed', 'true');
  const jobs = await page.evaluate(() => getDeliveryRows().length);
  await expect(statusTabs.first()).toHaveText(`All${jobs}`);
  // The plain title row took the place of the blue block: its text is dark on the page, not white on blue.
  expect(await page.locator('.ops-deliveries > .ops-hero').evaluate(hero => getComputedStyle(hero).backgroundImage + '|' + getComputedStyle(hero).backgroundColor)).toBe('none|rgba(0, 0, 0, 0)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(errors).toEqual([]);
});

// A fault that came in with the "paused" note in Milestone 4 and was found by a scan in round 3: on a phone
// the note sat beside the title and took the whole row, so the count under the title ("5 Facebook pages")
// was squeezed to one letter per line and the list started a screen lower.
test('on a phone the Pages title and its count keep their own row above the actions, in English and Arabic', async ({ page, isMobile }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (!isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.evaluate(() => navigateTo('pages'));
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe('pages');
  for (const language of ['en', 'ar']) {
    await page.evaluate(lang => { if (state.language !== lang) toggleLanguage(); }, language);
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
    const count = page.locator('#pages-count');
    await expect(count).toBeVisible();
    await expect(count).toHaveText(language === 'ar' ? /^\d+ صفحة فيسبوك$/ : /^\d+ Facebook pages$/);
    const facts = await page.evaluate(() => {
      const line = document.getElementById('pages-count'), header = line.closest('.page-header');
      const title = header.querySelector('h1').getBoundingClientRect(), actions = header.lastElementChild.getBoundingClientRect(), box = line.getBoundingClientRect();
      return { lines: Math.round(box.height / parseFloat(getComputedStyle(line).lineHeight)), countBottom: Math.round(box.bottom), actionsTop: Math.round(actions.top),
        titleWidth: Math.round(title.width), actionsWidth: Math.round(actions.width), headerWidth: Math.round(header.getBoundingClientRect().width), header: Math.round(header.getBoundingClientRect().height) };
    });
    expect(facts.lines, `${language}: the count is one line`).toBe(1);
    expect(facts.actionsTop, `${language}: the actions start under the count`).toBeGreaterThanOrEqual(facts.countBottom);
    expect(facts.actionsWidth, `${language}: the actions use the full width`).toBeGreaterThanOrEqual(facts.headerWidth - 2);
    expect(facts.header, `${language}: the header is no taller than a third of the screen`).toBeLessThan(Math.round(page.viewportSize().height / 3));
    await expect(page.locator('.page-header .workspace-paused')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  }
  await page.evaluate(() => { if (state.language !== 'en') toggleLanguage(); });
  expect(errors).toEqual([]);
});

// Redesign round 3, the final check. Two things a phone must never do to a total: cut an amount off at the edge
// of its tile, or cut a label inside a word. With three fixed thirds, "12,350.00 LYD" lost its currency behind
// the tile's edge at 360 and 390 px, and "Outstanding" was drawn on two lines at 320 px. The tiles now share a
// row only while their amounts fit, and take more rows when they do not.
test('on a phone the Customers totals are never cut: an amount of any length stays whole on one line, and the tiles take more rows when they must', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.evaluate(() => navigateTo('customers'));
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe('customers');
  await expect(page.locator('#workspace-view-content .workspace-stat-card')).toHaveCount(3);
  // Writes the amount into the two money totals (the page's text only; nothing is saved), then measures each tile.
  const measure = amount => page.evaluate(text => {
    const found = [];
    const cards = [...document.querySelectorAll('#workspace-view-content .workspace-stat-card')];
    const rows = cards.map((card, index) => {
      const value = card.querySelector('.workspace-stat-value');
      const leaf = document.createTreeWalker(value, NodeFilter.SHOW_TEXT).nextNode();
      if (text && index > 0) leaf.nodeValue = /د\.ل/.test(leaf.nodeValue) ? `${text} د.ل` : `${text} LYD`;
      const range = document.createRange();
      range.selectNodeContents(value);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
      const box = card.getBoundingClientRect();
      const name = `"${value.textContent.trim()}"`;
      if (Math.max(...rects.map(rect => rect.right)) > box.right - 0.5 || Math.min(...rects.map(rect => rect.left)) < box.left + 0.5) found.push(`${name} is cut by the edge of its tile`);
      if (new Set(rects.map(rect => Math.round(rect.top))).size > 1) found.push(`${name} is on two lines`);
      const label = card.querySelector('.workspace-stat-label');
      const words = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      for (let node = words.nextNode(); node; node = words.nextNode()) {
        let at = 0;
        for (const piece of node.nodeValue.split(/(\s+)/)) {
          if (piece.trim()) {
            const word = document.createRange();
            word.setStart(node, at);
            word.setEnd(node, at + piece.length);
            if (new Set([...word.getClientRects()].map(rect => Math.round(rect.top))).size > 1) found.push(`the label word "${piece}" is cut in two`);
          }
          at += piece.length;
        }
      }
      return Math.round(box.top);
    });
    return { found, rows: new Set(rows).size, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  }, amount);

  for (const language of ['en', 'ar']) {
    await page.evaluate(lang => { if (state.language !== lang) toggleLanguage(); }, language);
    await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
    // First as the page drew them (the language change has just drawn them again), then longer and longer.
    for (const amount of ['', '12,350.00', '123,456.00', '1,234,567.89']) {
      for (const width of [320, 344, 360, 375, 390, 412, 430]) {
        await page.setViewportSize({ width, height: 844 });
        const tiles = await measure(amount);
        const where = `${width}px, ${language}, ${amount || 'as drawn'}`;
        expect(tiles.found, where).toEqual([]);
        expect(tiles.sideways, `${where}: the page does not scroll sideways`).toBe(0);
        // The reason the three share a row at all (the first record sooner): they still do for five-digit amounts.
        // (As drawn they hold whatever other tests have saved, so nothing is expected of the rows then.)
        if (width >= 360 && amount === '12,350.00') expect(tiles.rows, `${where}: the three totals share one row`).toBe(1);
        // And they give the row up when the amounts need the room (certain in English at 320 px; Arabic is shorter).
        if (width === 320 && language === 'en' && amount === '1,234,567.89') expect(tiles.rows, `${where}: the totals take more than one row`).toBeGreaterThan(1);
      }
    }
  }
  await page.evaluate(() => { if (state.language !== 'en') toggleLanguage(); });
  expect(errors).toEqual([]);
});

// The same check for the short labels of other tiles that share a row on a phone. At 320 px four of them cut a
// word in two: "Deliveries" on the dashboard, "Assignment" and "Completed" on Deliveries, "Creates", "Updates"
// and "Deletes" on Audit logs.
test('on the narrowest phones no tile label is cut inside a word: the dashboard, Deliveries and Audit logs at 320 and 360 px, in English and Arabic', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 740 });
  await signIn(page);
  const cutWords = selector => page.evaluate(labels => {
    const found = [];
    const shown = [...document.querySelectorAll(labels)].filter(label => label.getClientRects().length);
    for (const label of shown) {
      const words = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      for (let node = words.nextNode(); node; node = words.nextNode()) {
        let at = 0;
        for (const piece of node.nodeValue.split(/(\s+)/)) {
          if (piece.trim().length > 2) {
            const word = document.createRange();
            word.setStart(node, at);
            word.setEnd(node, at + piece.length);
            if (new Set([...word.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size > 1) found.push(piece);
          }
          at += piece.length;
        }
      }
    }
    return { labels: shown.length, found, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  }, selector);
  const screens = [['control-center', '.management-door strong'], ['deliveries', '.ops-pipeline > div > span:not(.ops-step)'], ['audit', '.audit-facts dt']];
  for (const language of ['en', 'ar']) {
    for (const [view, labels] of screens) {
      await page.evaluate(name => navigateTo(name), view);
      await expect.poll(() => page.evaluate(() => state.currentView)).toBe(view);
      await page.evaluate(lang => { if (state.language !== lang) toggleLanguage(); }, language);
      await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
      await expect(page.locator(labels).first()).toBeVisible();
      for (const width of [320, 360]) {
        await page.setViewportSize({ width, height: 740 });
        const result = await cutWords(labels);
        expect(result.labels, `${view} shows its labels at ${width}px`).toBeGreaterThan(2);
        expect(result.found, `${view} at ${width}px in ${language}`).toEqual([]);
        expect(result.sideways, `${view} at ${width}px in ${language}: the page does not scroll sideways`).toBe(0);
      }
    }
  }
  await page.evaluate(() => { if (state.language !== 'en') toggleLanguage(); });
  expect(errors).toEqual([]);
});

// Redesign round 4 (DESIGN.md section 9, wireframe 09): on a phone the one main action of a screen stays in view
// above the bottom bar. Reminders is that screen: "Remind all overdue" used to be the last line of the list.
// The list is drawn by the app's own screen from twelve invented customers (no record is written).
test('on a phone the main button of Reminders stays in view above the bottom bar while the list is longer than the screen, and rests in its place at the end', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 700 });
  await signIn(page);
  await page.evaluate(() => {
    shellDebtorRows = () => Array.from({ length: 12 }, (_, index) => ({ customer: { id: `pin-${index}`, name: index % 2 ? `عميل تجريبي ${index + 1}` : `Invented customer ${index + 1}` }, dueLyd: 100 * (index + 1), dueUsd: 14 * (index + 1), overdue: index < 3, unpaid: [], ageDays: index < 3 ? 40 : 2 }));
    navigateTo('reminders');
  });
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe('reminders');
  const button = page.getByRole('button', { name: 'Remind all overdue (3)', exact: true });
  await expect(button).toBeVisible();
  // While it draws a screen the app holds the previous screen's height (12-views.js lockLayoutForRender) and lets
  // it go two animation frames later: about 20 ms on a Mac, about 350 ms in Linux WebKit (CI), where the end of the
  // list was measured inside the Dashboard's height and the button seemed to jump by 631 px. Measure at rest.
  const measure = async () => {
    await page.waitForFunction(() => !document.getElementById('app').classList.contains('is-rendering'), null, { timeout: 5000 });
    return measureNow();
  };
  const measureNow = () => page.evaluate(() => {
    const pin = document.querySelector('.phone-pin'); const main = pin.querySelector('button');
    const bar = document.querySelector('.mobile-bottom-nav');
    const rows = [...document.querySelectorAll('.hub-shell .hub-card button[onclick^="remindDebtor"]')];
    const box = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; };
    const b = box(main);
    // A row's own button whose middle lies behind the main button, or in the band between it and the bar, must not
    // be what a finger meets there.
    const pinTop = pin.getBoundingClientRect().top;
    const hit = rows.map(box).map(r => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 })).filter(point => point.y >= pinTop && point.y < innerHeight)
      .map(point => { const el = document.elementFromPoint(point.x, point.y); return !!el && !!el.closest('button[onclick^="remindDebtor"]'); });
    return { position: getComputedStyle(pin).position, button: b, barTop: bar ? box(bar).top : null, fab: box(document.querySelector('.mobile-bottom-nav-fab-circle') || bar), rows: rows.length, reachableUnder: hit.filter(Boolean).length,
      scrollY: Math.round(scrollY), max: document.documentElement.scrollHeight - innerHeight, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  for (const language of ['en', 'ar']) {
    await page.evaluate(lang => { if (state.language !== lang) toggleLanguage(); }, language);
    for (const [width, height] of [[320, 568], [360, 740], [390, 700], [430, 932], [820, 900]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => scrollTo(0, 0));
      const at = `${language} ${width}x${height}`;
      let seen = await measure();
      expect(seen.rows, at).toBe(12);
      expect(seen.max, `${at}: the list is longer than the screen`).toBeGreaterThan(100);
      // At the top of a long list: in view, above the bottom bar and clear of its raised "+" button, full width.
      expect(seen.position, at).toBe('sticky');
      expect(seen.button.bottom, `${at}: above the bottom bar`).toBeLessThanOrEqual(seen.barTop);
      expect(seen.button.bottom, `${at}: clear of the "+" button`).toBeLessThanOrEqual(seen.fab.top + 1);
      expect(seen.button.top, `${at}: on the screen`).toBeGreaterThan(seen.height / 2);
      expect(seen.button.height, `${at}: large enough to press`).toBeGreaterThanOrEqual(44);
      expect(seen.reachableUnder, `${at}: no row's own button shows through under the main button`).toBe(0);
      expect(seen.overflow, `${at}: nothing runs off the page`).toBeLessThanOrEqual(1);
      // Half way down it has not moved.
      await page.evaluate(y => scrollTo(0, y), Math.round(seen.max / 2));
      const middle = await measure();
      expect(Math.abs(middle.button.top - seen.button.top), `${at}: it stays where it is while the list moves`).toBeLessThanOrEqual(1);
      expect(middle.reachableUnder, `${at}, half way: no row's button shows through`).toBe(0);
      // At the end it rests after the last row, still above the bar.
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      const end = await measure();
      const last = await page.evaluate(() => Math.round([...document.querySelectorAll('.hub-shell .hub-card')].pop().getBoundingClientRect().bottom));
      expect(end.button.top, `${at}: at the end it follows the last row`).toBeGreaterThanOrEqual(last);
      expect(end.button.bottom, `${at}: at the end it is above the bar`).toBeLessThanOrEqual(end.barTop);
      expect(Math.abs(end.button.top - seen.button.top), `${at}: its resting place is its pinned place (no jump when the list ends)`).toBeLessThanOrEqual(1);
    }
  }
  // The sync badge lives in the same corner. While it shows (here: "Sync failed", which stays until pressed) it stands
  // clear of the main button, at the top of the list and at its end, in both languages.
  await page.setViewportSize({ width: 390, height: 700 });
  for (const language of ['en', 'ar']) {
    await page.evaluate(lang => { if (state.language !== lang) toggleLanguage(); _paintSyncIndicator('error'); }, language);
    for (const where of ['top', 'end']) {
      await page.evaluate(end => scrollTo(0, end ? document.documentElement.scrollHeight : 0), where === 'end');
      const boxes = await page.evaluate(() => {
        const box = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
        return { badge: box(document.getElementById('sync-status-indicator')), button: box(document.querySelector('.phone-pin button')), bar: box(document.querySelector('.mobile-bottom-nav')) };
      });
      expect(boxes.badge.bottom, `${language}, ${where}: the sync badge stands above the main button`).toBeLessThanOrEqual(boxes.button.top);
      expect(boxes.badge.top, `${language}, ${where}: the sync badge is on the screen`).toBeGreaterThan(60);
    }
    await page.evaluate(() => { const badge = document.getElementById('sync-status-indicator'); if (badge) badge.remove(); });
  }
  await page.evaluate(() => { if (state.language !== 'en') toggleLanguage(); });
  // While the keyboard is open the bottom bar is away and the button is back in its place in the page.
  await page.setViewportSize({ width: 390, height: 700 });
  await page.evaluate(() => { scrollTo(0, 0); document.body.classList.add('keyboard-open'); });
  expect((await measure()).position).toBe('static');
  await page.evaluate(() => document.body.classList.remove('keyboard-open'));
  expect((await measure()).position).toBe('sticky');
  // A computer has no bottom bar: the button is the last line of the list, as before.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await page.evaluate(() => getComputedStyle(document.querySelector('.phone-pin')).position))).toBe('static');
  // It still does its work: the next overdue customer with a usable number is asked for, or the skip is said.
  await page.setViewportSize({ width: 390, height: 700 });
  await button.click();
  await expect(page.locator('#notification-container')).toContainText(/No usable phone|Reminder opened|All reminded/);
  expect(errors).toEqual([]);
});
