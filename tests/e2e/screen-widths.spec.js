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
// How many tiles share a row is expected only where the styles' conditions and the page see the same width
// ("agree" below): where a browser gives the styles the window's width and the page 8 px less (Safari's engine
// at phone size; Chrome on a computer), a row may give way a few pixels earlier, which is what the wrapping is for.
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
  expect(width - page, `${where}: the page is as wide as its window, less a scrollbar at most`).toBeGreaterThanOrEqual(0);
  expect(width - page, `${where}: the page is as wide as its window, less a scrollbar at most`).toBeLessThanOrEqual(20);
}

const widthsFor = testInfo => (testInfo.project.name.startsWith('desktop-') ? [...PHONES, ...TABLETS, ...COMPUTERS] : [...PHONES, ...TABLETS]);

// Writes `amount` into the money tiles (the page's text only; nothing is saved) and measures every tile:
// is its amount whole, on one line, inside its tile and clear of the tile's icon?
function measureTiles(page, tile, value, icon, amount) {
  return page.evaluate(([tileSelector, valueSelector, iconSelector, text]) => {
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
    return {
      found, tiles, rows: new Set(tiles.map(item => item.top)).size, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // What the page itself says about its width (see the note at the top of this file).
      page: document.documentElement.clientWidth, agree: matchMedia(`(max-width: ${document.documentElement.clientWidth}px)`).matches,
      phone: matchMedia('(max-width: 600px)').matches, narrow: matchMedia('(max-width: 599px)').matches, computer: matchMedia('(min-width: 1280px)').matches
    };
  }, [tile, value, icon, amount]);
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
  const measure = amount => measureTiles(page, tile, '.workspace-stat-value', '.workspace-stat-layout > :last-child', amount);

  for (const language of ['en', 'ar']) {
    await setLanguage(page, language);
    for (const amount of AMOUNTS) {
      for (const width of widthsFor(testInfo)) {
        await page.setViewportSize({ width, height: 900 });
        const where = `${width}px, ${language}, ${amount || 'as drawn'}`;
        // (crossing 900 px draws the page again: the check waits for the layout to settle)
        await expect.poll(async () => (await measure(amount)).found, { message: where, timeout: 5000 }).toEqual([]);
        const seen = await measure(amount);
        expect(seen.sideways, `${where}: the page does not scroll sideways`).toBe(0);
        expectPageOfWindow(seen.page, width, where);
        expect(Math.min(...seen.tiles.map(item => item.width)), `${where}: no tile is narrower than 72 px`).toBeGreaterThanOrEqual(72);
        // Two five-digit totals share the row with the count from 360 px up, on every screen.
        if (amount === '12,350.00' && seen.agree && seen.page >= 360) expect(seen.rows, `${where}: the three totals share one row`).toBe(1);
        // With room to spare the three tiles are equals (the third tile sits in a wrapper of its own in the page).
        if (amount === '12,350.00' && seen.page >= 1440) expect(Math.max(...seen.tiles.map(item => item.width)) - Math.min(...seen.tiles.map(item => item.width)), `${where}: three equal tiles`).toBeLessThanOrEqual(1.5);
        // From the tablet up (wherever the phone's rules do not apply) each money tile shows its icon beside the amount, not above it.
        if (!seen.phone) expect(seen.tiles.slice(1).map(item => item.beside), `${where}: the icons stand beside the amounts`).toEqual([true, true]);
        // The amount grows with the screen instead of jumping from 18 to 30 px at 768 px.
        if (width === 768) expect(seen.tiles[1].size, `${where}: the size of an amount at 768 px`).toBeLessThanOrEqual(20);
        if (seen.computer) expect(seen.tiles[1].size, `${where}: the size of an amount on a computer`).toBe(30);
      }
    }
    // Seven digits in both totals do not fit one row of a 768 px tablet in English: the row gives way, the amounts stay whole.
    if (language === 'en') {
      await page.setViewportSize({ width: 768, height: 900 });
      await expect.poll(async () => (await measure('1,234,567.89')).rows, { timeout: 5000 }).toBeGreaterThan(1);
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
  const measure = amount => measureTiles(page, tile, 'strong', '', amount);

  for (const language of ['en', 'ar']) {
    await setLanguage(page, language);
    await expect(page.locator(tile)).toHaveCount(4);
    for (const amount of AMOUNTS) {
      for (const width of widthsFor(testInfo)) {
        await page.setViewportSize({ width, height: 900 });
        const where = `${width}px, ${language}, ${amount || 'as drawn'}`;
        await expect.poll(async () => (await measure(amount)).found, { message: where, timeout: 5000 }).toEqual([]);
        const seen = await measure(amount);
        expect(seen.sideways, `${where}: the page does not scroll sideways`).toBe(0);
        expectPageOfWindow(seen.page, width, where);
        // Five-digit amounts: one tile to a row on a phone, two to a row from 600 px up (the card is the full
        // width below 768 px, half of it from there; beside "Needs you today" from 1,200 px).
        if (amount === '12,350.00' && seen.agree) expect(seen.rows, `${where}: rows of money tiles`).toBe(seen.narrow ? 4 : 2);
        // Whatever the amounts, a row holds one tile or two, never a third squeezed in.
        const perRow = seen.tiles.reduce((count, item) => { count[item.top] = (count[item.top] || 0) + 1; return count; }, {});
        expect(Math.max(...Object.values(perRow)), `${where}: money tiles in one row`).toBeLessThanOrEqual(2);
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
      page: document.documentElement.clientWidth, small: matchMedia('(max-width: 359px)').matches
    };
  });
  for (const language of ['en', 'ar']) {
    await setLanguage(page, language);
    for (const width of [...PHONES, ...TABLETS]) {
      await page.setViewportSize({ width, height: 844 });
      const where = `${width}px, ${language}`;
      await expect(bar, where).toBeVisible();
      const seen = await measure();
      // From edge to edge of what the page can show (a scrollbar, where a browser draws one, is not the page's).
      expectPageOfWindow(seen.page, width, where);
      expect([seen.fixed, seen.left, seen.right, seen.bottom], `${where}: a bar fixed along the bottom edge`).toEqual(['fixed', 0, seen.page, seen.height]);
      expect(seen.items.map(item => item.name), where).toEqual(language === 'ar' ? ['اللوحة', 'الوصولات', 'العملاء', 'المزيد'] : ['Dashboard', 'Receipts', 'Customers', 'More']);
      for (const item of seen.items) {
        // "Dashboard" and "Customers" were cut short with "…" at 320 px (63 px of text in 59).
        expect([item.cut, item.lines], `${where}: "${item.name}" is whole, on one line`).toEqual([false, 1]);
        expect(item.height, `${where}: "${item.name}" is at least 44 px tall`).toBeGreaterThanOrEqual(44);
        // 12 px, the navigation size of the project's text floor; 11 px (the floor itself) under 360 px.
        expect(item.size, `${where}: the size of "${item.name}"`).toBe(seen.small ? 11 : 12);
      }
      expect(seen.sideways, `${where}: the page does not scroll sideways`).toBe(0);
    }
  }
  // A computer has the side list instead.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(bar).toBeHidden();
  await setLanguage(page, 'en');
  expect(errors).toEqual([]);
});
