// Every width between a phone and a computer (redesign round 4, item 7: tablets). Tablets keep the phone's bottom
// bar, as the approved design says; what they did not have was a check at their own sizes. Measuring at 601 to
// 1,024 px found amounts of money cut off, under an icon or split over two lines, and one label cut short on the
// narrowest phone. These tests hold the fixes at every width, with short and with seven-digit amounts, in English
// and Arabic. The phone projects set tablet-sized windows themselves; computer widths run on a desktop project
// (Chromium here; desktop Safari where the owner's check runs this file with it).
//
// The app draws its own scrollbar, 8 px wide (style.css). Where a browser shows it, a page that scrolls is 8 px
// narrower than its window: Safari's test engine does, and so does any browser on a computer. This project's
// Chromium runs hide scrollbars, so there the page is the window. At computer sizes Safari also decides the
// styles' screen-width conditions from what is left. So nothing here compares with the window's width: "wide
// enough" is read from the page itself, as its visible width and as the very conditions the styles use. (The
// first version compared with the window and failed on Safari's engine for that reason alone: a 601 px window
// is a 593 px page there, which rightly gets the phone's rules.)
//
// Two kinds of expectation follow from that. That every amount and every name is whole is expected everywhere.
// How many tiles share a row is not expected for a given width at all: the tiles are measured ("spare" below:
// the room of the row, less what the tiles need at their narrowest), and they are expected to share the row
// wherever they fit with at least 6 px to spare. Within a few pixels of fitting, a browser's own way of
// measuring text decides, and either answer is right. In this project's Chromium the dashboard's two tiles fit a
// 1,280 px page by 0.2 px and the three Customers totals a 901 px page by 3.3 px: an expectation tied to those
// widths would hold or break with the next browser version, for no change in the app.
//
// At phone size Safari's engine goes one step further: the page itself answers "as wide as the window", yet a
// bar anchored to both edges ends 8 px short of it, where the scrollbar is drawn. So the bottom bar is compared
// with a probe anchored exactly as it is, not with any width the page reports. (The second version asked the
// page and failed there.)
//
// Everything that depends on such geometry, and every name of the bar, is collected (expect.soft): one run lists
// every mismatch at every width instead of stopping at the first. An amount that is not whole stops the test at once.
const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL = 'e2e.admin@albayan.example.com';
const ADMIN_PASSWORD = 'E2eAdminPassword123!';
const PHONES = [320, 344, 360, 390, 430];
const TABLETS = [600, 601, 700, 767, 768, 820, 900];
const COMPUTERS = [901, 1000, 1024, 1100, 1199, 1200, 1279, 1280, 1366, 1440, 1920];
const AMOUNTS = ['', '12,350.00', '123,456.00', '1,234,567.89'];

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

async function setLanguage(page, language) {
  await page.evaluate(lang => { if (state.language !== lang) toggleLanguage(); }, language);
  await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
}

// The page is the window, less the room of a scrollbar where one is shown (none in Chromium here; the app's
// own 8 px in Safari's test engine). A page narrower than that would be a fault of its own, and must not
// hide behind the width-dependent checks below.
function expectPageOfWindow(page, width, where) {
  expect.soft(width - page, `${where}: the page is as wide as its window, less a scrollbar at most`).toBeGreaterThanOrEqual(0);
  expect.soft(width - page, `${where}: the page is as wide as its window, less a scrollbar at most`).toBeLessThanOrEqual(20);
}

const widthsFor = testInfo => (testInfo.project.name.startsWith('desktop-') ? [...PHONES, ...TABLETS, ...COMPUTERS] : [...PHONES, ...TABLETS]);

// Writes `amount` into the money tiles (the page's text only; nothing is saved) and measures every tile:
// is its amount whole, on one line, inside its tile and clear of the tile's icon? `row` is the tiles' common row,
// `per` how many of them the design puts side by side and `start` the width the design starts each tile from
// (in px, or as a share of the row when it is 1 or less); "spare" is what would be left of the row's room.
function measureTiles(page, tile, value, icon, amount, row, per, start) {
  return page.evaluate(([tileSelector, valueSelector, iconSelector, text, rowSelector, perRow, startFrom]) => {
    const found = [];
    const tiles = [...document.querySelectorAll(tileSelector)].map(card => {
      const value = card.querySelector(valueSelector);
      const leaf = document.createTreeWalker(value, NodeFilter.SHOW_TEXT).nextNode();
      if (text && /\d[\d,]*\.\d\d/.test(leaf.nodeValue)) leaf.nodeValue = leaf.nodeValue.replace(/\d[\d,]*\.\d\d/, text);
      const range = document.createRange();
      range.selectNodeContents(value);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
      const box = card.getBoundingClientRect();
      const name = `"${value.textContent.replace(/[⁦-⁩]/g, '').trim()}"`;
      if (Math.max(...rects.map(rect => rect.right)) > box.right - 0.5 || Math.min(...rects.map(rect => rect.left)) < box.left + 0.5) found.push(`${name} is cut by the edge of its tile`);
      if (new Set(rects.map(rect => Math.round(rect.top))).size > 1) found.push(`${name} is on two lines`);
      if (box.right > document.documentElement.clientWidth + 0.5 || box.left < -0.5) found.push(`the tile of ${name} lies outside the screen`);
      const mark = iconSelector ? card.querySelector(iconSelector) : null;
      let beside = null;
      if (mark && mark.getClientRects().length) {
        const i = mark.getBoundingClientRect();
        if (rects.some(rect => rect.left < i.right - 0.5 && rect.right > i.left + 0.5 && rect.top < i.bottom - 0.5 && rect.bottom > i.top + 0.5)) found.push(`${name} lies under its icon`);
        beside = i.top < Math.max(...rects.map(rect => rect.bottom)) && i.bottom > box.top;  // the icon shares the tile's rows with the text
      }
      return { top: Math.round(box.top), width: Math.round(box.width * 10) / 10, size: parseFloat(getComputedStyle(value).fontSize), beside };
    });
    // The room of the row, less what `perRow` tiles side by side claim before the row is shared out: for each
    // tile the wider of the design's starting width (72 px for a Customers total, 40 % of the row for a money
    // tile of the dashboard) and its own narrowest width (it is asked for that for a moment and put back as it
    // was). In the design that sum decides whether the tiles share a row; a style that starts the tiles wider
    // and so stacks them needlessly leaves "spare" as it is and is noticed. The least over the groups of tiles.
    const line = document.querySelector(rowSelector);
    const lineStyle = getComputedStyle(line);
    const room = line.getBoundingClientRect().width - parseFloat(lineStyle.paddingLeft) - parseFloat(lineStyle.paddingRight);
    const gap = parseFloat(lineStyle.columnGap) || 0;
    const narrowest = [...document.querySelectorAll(tileSelector)].map(card => {
      const begin = startFrom <= 1 ? room * startFrom : startFrom;
      const keep = card.getAttribute('style');
      for (const [property, setting] of [['flex', '0 0 auto'], ['width', 'min-content'], ['min-width', 'min-content'], ['max-width', 'none']]) card.style.setProperty(property, setting, 'important');
      const wide = card.getBoundingClientRect().width;
      if (keep === null) card.removeAttribute('style'); else card.setAttribute('style', keep);
      return Math.max(begin, wide);
    });
    let spare = Infinity;
    for (let first = 0; first + perRow <= narrowest.length; first += perRow) {
      spare = Math.min(spare, room - narrowest.slice(first, first + perRow).reduce((sum, wide) => sum + wide, 0) - gap * (perRow - 1));
    }
    return {
      found, tiles, rows: new Set(tiles.map(item => item.top)).size, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      spare: Math.round(spare * 10) / 10,
      // What the page itself says about its width (see the note at the top of this file).
      page: document.documentElement.clientWidth,
      phone: matchMedia('(max-width: 600px)').matches, narrow: matchMedia('(max-width: 599px)').matches,
      laptop: matchMedia('(min-width: 1000px) and (max-width: 1279px)').matches, computer: matchMedia('(min-width: 1280px)').matches
    };
  }, [tile, value, icon, amount, row, per, start]);
}

test('the Customers totals are whole at every width from a phone to a computer: never cut, never under the icon, never narrower than 72 px', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 820, height: 900 });
  await signIn(page);
  await page.evaluate(() => navigateTo('customers'));
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe('customers');
  const tile = '#workspace-view-content .workspace-stat-card';
  await expect(page.locator(tile)).toHaveCount(3);
  const measure = amount => measureTiles(page, tile, '.workspace-stat-value', '.workspace-stat-layout > :last-child', amount, '[data-view="customers"] .page-header + .grid-cols-2', 3, 72);

  for (const language of ['en', 'ar']) {
    await setLanguage(page, language);
    for (const amount of AMOUNTS) {
      for (const width of widthsFor(testInfo)) {
        await page.setViewportSize({ width, height: 900 });
        const where = `${width}px, ${language}, ${amount || 'as drawn'}`;
        // (crossing 900 px draws the page again: the check waits for the layout to settle)
        await expect.poll(async () => (await measure(amount)).found, { message: where, timeout: 5000 }).toEqual([]);
        const seen = await measure(amount);
        expect.soft(seen.sideways, `${where}: the page does not scroll sideways`).toBe(0);
        expectPageOfWindow(seen.page, width, where);
        expect.soft(Math.min(...seen.tiles.map(item => item.width)), `${where}: no tile is narrower than 72 px`).toBeGreaterThanOrEqual(72);
        expect(Number.isFinite(seen.spare), `${where}: the row's spare room could be measured`).toBe(true);
        // Two five-digit totals share the row with the count wherever the three fit with room to spare ...
        if (amount === '12,350.00' && seen.spare >= 6) expect.soft(seen.rows, `${where}: the three totals share one row (${seen.spare} px to spare)`).toBe(1);
        // ... and on a phone from 360 px they do fit (the promise of round 3; about 11 px to spare in Chromium).
        if (amount === '12,350.00' && seen.page >= 360 && seen.page <= 430) expect.soft(seen.rows, `${where}: on a phone from 360 px the three totals share one row`).toBe(1);
        // With room to spare the three tiles are equals (the third tile sits in a wrapper of its own in the page).
        if (amount === '12,350.00' && seen.page >= 1440) expect.soft(Math.max(...seen.tiles.map(item => item.width)) - Math.min(...seen.tiles.map(item => item.width)), `${where}: three equal tiles`).toBeLessThanOrEqual(1.5);
        // From the tablet up (wherever the phone's rules do not apply) each money tile shows its icon beside the amount, not above it.
        if (!seen.phone) expect.soft(seen.tiles.slice(1).map(item => item.beside), `${where}: the icons stand beside the amounts`).toEqual([true, true]);
        // The amount grows with the screen instead of jumping from 18 to 30 px at 768 px.
        if (width === 768) expect.soft(seen.tiles[1].size, `${where}: the size of an amount at 768 px`).toBeLessThanOrEqual(20);
        // ... and has grown well past the phone's 18 px on a small laptop (2.35 % of a 1,000 px screen is 23.5 px).
        if (seen.laptop) expect.soft(seen.tiles[1].size, `${where}: the size of an amount on a small laptop`).toBeGreaterThanOrEqual(22);
        if (seen.computer) expect.soft(seen.tiles[1].size, `${where}: the size of an amount on a computer`).toBe(30);
      }
    }
    // Seven digits in both totals do not fit one row where the tablet's larger amounts begin (the styles'
    // 768 px condition) in English: the row gives way, the amounts stay whole. That is a 768 px window where the
    // page is the window, and a 776 px one where the scrollbar's 8 px come off first (Safari at computer size:
    // there a 768 px window is a 760 px page with the smaller amounts, which do fit one row).
    if (language === 'en') {
      let start = 768;
      for (; start <= 800; start += 1) {
        await page.setViewportSize({ width: start, height: 900 });
        if (await page.evaluate(() => matchMedia('(min-width: 768px)').matches)) break;
      }
      expect(start, 'the window at which the styles\' 768 px condition begins to hold').toBeLessThanOrEqual(788);
      await expect.poll(async () => (await measure('1,234,567.89')).found, { message: `${start}px, en, seven digits`, timeout: 5000 }).toEqual([]);
      await expect.poll(async () => (await measure('1,234,567.89')).rows, { message: `${start}px, en, seven digits: the row gives way`, timeout: 5000 }).toBeGreaterThan(1);
    }
  }
  await setLanguage(page, 'en');
  expect(errors).toEqual([]);
});

test('the dashboard\'s money tiles never break an amount: two to a row while the amounts fit, a row each when they do not', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 820, height: 900 });
  await signIn(page);
  await page.evaluate(() => navigateTo('control-center'));
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe('control-center');
  const tile = '.management-figure';
  await expect(page.locator(tile)).toHaveCount(4);
  const measure = amount => measureTiles(page, tile, 'strong', '', amount, '.management-figures', 2, 0.4);

  for (const language of ['en', 'ar']) {
    await setLanguage(page, language);
    await expect(page.locator(tile)).toHaveCount(4);
    for (const amount of AMOUNTS) {
      for (const width of widthsFor(testInfo)) {
        await page.setViewportSize({ width, height: 900 });
        const where = `${width}px, ${language}, ${amount || 'as drawn'}`;
        await expect.poll(async () => (await measure(amount)).found, { message: where, timeout: 5000 }).toEqual([]);
        const seen = await measure(amount);
        expect.soft(seen.sideways, `${where}: the page does not scroll sideways`).toBe(0);
        expectPageOfWindow(seen.page, width, where);
        expect(Number.isFinite(seen.spare), `${where}: the row's spare room could be measured`).toBe(true);
        // Five-digit amounts: one tile to a row where the phone's rule holds (the styles' 599 px condition), and
        // from there up two to a row wherever two fit with room to spare (the card is the full width below
        // 768 px, half of it from there; beside "Needs you today" from 1,200 px).
        if (amount === '12,350.00' && seen.narrow) expect.soft(seen.rows, `${where}: one money tile to a row on a phone`).toBe(4);
        if (amount === '12,350.00' && !seen.narrow && seen.spare >= 6) expect.soft(seen.rows, `${where}: two money tiles to a row (${seen.spare} px to spare)`).toBe(2);
        // Whatever the amounts, a row holds one tile or two, never a third squeezed in.
        const perRow = seen.tiles.reduce((count, item) => { count[item.top] = (count[item.top] || 0) + 1; return count; }, {});
        expect.soft(Math.max(...Object.values(perRow)), `${where}: money tiles in one row`).toBeLessThanOrEqual(2);
      }
    }
  }
  await setLanguage(page, 'en');
  expect(errors).toEqual([]);
});

test('the bottom bar keeps every name whole from 320 px to a 900 px tablet, in English and Arabic', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.evaluate(() => navigateTo('receipts'));
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe('receipts');
  const bar = page.locator('.mobile-bottom-nav');
  await expect(bar).toBeVisible();
  const measure = () => page.evaluate(() => {
    const nav = document.querySelector('.mobile-bottom-nav');
    const box = nav.getBoundingClientRect();
    // What a bar from edge to edge can span here: a probe anchored exactly as the bar is (fixed, left 0, right 0).
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:0;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    const room = probe.getBoundingClientRect();
    probe.remove();
    const items = [...nav.querySelectorAll('.mobile-bottom-nav-item')].map(item => {
      const word = [...item.querySelectorAll('span')].find(span => span.textContent.trim() && !span.querySelector('svg, i'));
      if (!word) return null;  // the round "+" in the middle has no name under it
      const range = document.createRange();
      range.selectNodeContents(word);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
      const edge = item.getBoundingClientRect();
      return {
        name: word.textContent.trim(), size: parseFloat(getComputedStyle(word).fontSize),
        cut: word.scrollWidth > word.clientWidth + 0.5 || Math.max(...rects.map(rect => rect.right)) > edge.right + 0.5 || Math.min(...rects.map(rect => rect.left)) < edge.left - 0.5,
        lines: new Set(rects.map(rect => Math.round(rect.top))).size, height: Math.round(edge.height), width: Math.round(edge.width)
      };
    }).filter(Boolean);
    return {
      items, fixed: getComputedStyle(nav).position, left: Math.round(box.left), right: Math.round(box.right), bottom: Math.round(box.bottom), height: innerHeight,
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      room: [Math.round(room.left), Math.round(room.right)], small: matchMedia('(max-width: 359px)').matches
    };
  });
  for (const language of ['en', 'ar']) {
    await setLanguage(page, language);
    for (const width of [...PHONES, ...TABLETS]) {
      await page.setViewportSize({ width, height: 844 });
      const where = `${width}px, ${language}`;
      await expect(bar, where).toBeVisible();
      const seen = await measure();
      // From edge to edge of what a bar can span (a scrollbar, where a browser draws one, is not the bar's).
      expectPageOfWindow(seen.room[1] - seen.room[0], width, where);
      expect.soft([seen.fixed, seen.left, seen.right, seen.bottom], `${where}: a bar fixed along the bottom edge, from edge to edge`).toEqual(['fixed', seen.room[0], seen.room[1], seen.height]);
      expect(seen.items.map(item => item.name), where).toEqual(language === 'ar' ? ['اللوحة', 'الوصولات', 'العملاء', 'المزيد'] : ['Dashboard', 'Receipts', 'Customers', 'More']);
      for (const item of seen.items) {
        // "Dashboard" and "Customers" were cut short with "…" at 320 px (63 px of text in 59).
        expect.soft([item.cut, item.lines], `${where}: "${item.name}" is whole, on one line`).toEqual([false, 1]);
        expect.soft(item.height, `${where}: "${item.name}" is at least 44 px tall`).toBeGreaterThanOrEqual(44);
        // 12 px, the navigation size of the project's text floor; 11 px (the floor itself) under 360 px.
        expect.soft(item.size, `${where}: the size of "${item.name}"`).toBe(seen.small ? 11 : 12);
      }
      expect.soft(seen.sideways, `${where}: the page does not scroll sideways`).toBe(0);
    }
  }
  // A computer has the side list instead.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(bar).toBeHidden();
  await setLanguage(page, 'en');
  expect(errors).toEqual([]);
});
