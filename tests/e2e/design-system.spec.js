const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

// These tests use the disposable server from playwright.config.js. Never seed
// a remote URL, reuse a personal account, or submit real payment/Meta actions.
const ADMIN_EMAIL = 'e2e.admin@albayan.example.com';
const ADMIN_PASSWORD = 'E2eAdminPassword123!';
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function signIn(page) {
  await page.goto('/');
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(page.url()).hostname);
  await expect(page.locator('#login-form')).toBeVisible();
  await page.locator('#login-email').fill(ADMIN_EMAIL);
  await page.locator('#login-password').fill(ADMIN_PASSWORD);
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/auth/login')),
    page.locator('#login-form button[type="submit"]').click()
  ]);
  expect(response.ok()).toBe(true);
  await page.waitForFunction(() => !!state.currentUser?.id && !!_serverLiveSync.timer);
}

async function openView(page, view, path) {
  await page.evaluate(id => navigateTo(id), view);
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe(view);
  if (path) await expect.poll(() => new URL(page.url()).pathname).toBe(path);
  await expect(page.locator('#workspace-view-content')).toBeVisible();
  await expect(page.locator('#workspace-view-content')).not.toHaveText('');
}

async function appearance(page, language, theme) {
  await page.evaluate(({ language, theme }) => {
    if (state.language !== language) toggleLanguage();
    shellSetTheme(theme);
  }, { language, theme });
  await expect(page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
}

async function assertPageAndCardsFit(page, label) {
  const layout = await page.evaluate(() => {
    const width = innerWidth;
    const visible = element => {
      const box = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && css.display !== 'none' && css.visibility !== 'hidden';
    };
    // Ads intentionally retain their desktop table and compact phone rows.
    // Both it and the redesigned operational cards must fit without hiding
    // information in a horizontal scroller. Include their action controls.
    const cards = [...document.querySelectorAll(
      '#workspace-view-content .hub-card, #workspace-view-content .glass-panel, #workspace-view-content [data-shell-row], #workspace-view-content [data-shell-detail="ads"], #workspace-view-content .ops-delivery-card, #workspace-view-content .ops-reconciliation-card, #workspace-view-content .workspace-record-actions > button, #workspace-view-content .ads-summary-table button'
    )].filter(visible);
    return {
      pageOverflow: document.documentElement.scrollWidth - width,
      adsOverflow: [...document.querySelectorAll('#ads-table-container')].filter(visible)
        .map(element => element.scrollWidth - element.clientWidth),
      outsideCards: cards.filter(element => {
        const box = element.getBoundingClientRect();
        return box.left < -1 || box.right > width + 1;
      }).map(element => ({ kind: element.getAttribute('data-shell-row') || element.className,
        text: element.textContent.trim().slice(0, 70) })).slice(0, 5)
    };
  });
  expect(layout.pageOverflow, `${label}: page width`).toBeLessThanOrEqual(1);
  for (const overflow of layout.adsOverflow) {
    expect(overflow, `${label}: all Ads columns fit without horizontal scrolling`).toBeLessThanOrEqual(1);
  }
  expect(layout.outsideCards, `${label}: card bounds`).toEqual([]);
}

async function assertTouchable(locator, label) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box.width, `${label}: tap width`).toBeGreaterThanOrEqual(43.5);
  expect(box.height, `${label}: tap height`).toBeGreaterThanOrEqual(43.5);
}

async function captureDesign(page, testInfo, name) {
  // Dismiss only transient notices through their real close action so they
  // cannot cover the content being inspected in a successful screenshot.
  const notices = page.locator('button[aria-label="Close notification"]');
  await notices.evaluateAll(buttons => buttons.forEach(button => button.click()));
  await expect(notices).toHaveCount(0);
  const directory = path.resolve(__dirname, '../../.tmp/design-qa');
  await fs.mkdir(directory, { recursive: true });
  const width = page.viewportSize().width;
  const language = await page.locator('html').getAttribute('lang');
  const filename = `${testInfo.project.name}-${width}-${language}-${name}.png`;
  // Artifact-only screenshots use one pixel per CSS pixel. Device emulation
  // and all geometry/touch assertions remain unchanged; avoid encoding nine
  // times the image area on a 3x phone display during a multi-route check.
  const body = await page.screenshot({ path: path.join(directory, filename), scale: 'css' });
  await testInfo.attach(filename, { body, contentType: 'image/png' });
}

async function seedRecords(page, project) {
  return page.evaluate(async ({ project, photo }) => {
    const createdAt = new Date().toISOString();
    const token = `${project}-${Date.now()}`;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    context.fillStyle = '#155dfc';
    context.fillRect(0, 0, 1, 1);
    const secondPhoto = canvas.toDataURL('image/png');
    const customer = {
      id: generateId('cust'),
      name: `Design ${token} شركة الاختبار للاعلانات والتسويق والخدمات المتكاملة Very Long Customer Name`,
      phones: [`097${Date.now().toString().slice(-7)}`], platform: 'Facebook',
      joinDate: createdAt, createdAt, profileLinks: []
    };
    if (!await addRecord(state.customers, customer)) throw new Error('Design customer seed failed');
    const pageRow = { id: generateId('page'), name: `Design Page ${token} اسم صفحة طويل لاختبار العرض على الهاتف`,
      category: 'Long bilingual business category فئة تجارية', customerIds: [customer.id], createdAt };
    if (!await addRecord(state.pages, pageRow)) throw new Error('Design page seed failed');
    const paid = { id: generateId('receipt'), recordType: 'receipt', customerId: customer.id,
      customerName: customer.name, serialNumber: `S${Date.now()}`, status: 'Paid', isPaid: true,
      paymentMethod: 'Cash (LYD)', amountUSD: 100000.25, amountLocal: 970002.43,
      exchangeRate: 9.7, collected: true, createdAt, photos: [photo],
      statusDetail: { paidCollection: 'office' } };
    if (!await addRecord(state.receipts, paid)) throw new Error('Design paid receipt seed failed');
    const unpaid = { id: generateId('receipt'), recordType: 'receipt', customerId: customer.id,
      customerName: customer.name, status: 'Not Paid', isPaid: false, amountUSD: 987654.32,
      amountLocal: 9580246.90, debtAmountUSD: 987654.32, debtAmountLocal: 9580246.90,
      exchangeRate: 9.7, deliveryStatus: 'Office', createdAt,
      statusDetail: { notPaidCollection: 'office' } };
    if (!await addRecord(state.receipts, unpaid)) throw new Error('Design unpaid receipt seed failed');
    const adId = generateId('ad');
    const mutation = await apiMutateAd({ action: 'create', adId,
      idempotencyKey: generateId('design'), data: {
        customerId: customer.id, customerName: customer.name, pageId: pageRow.id,
        pageName: pageRow.name, status: 'Active', paymentStatus: 'paid', exchangeRate: 9.7,
        amountUSD: 12345.67, amountLocal: 119753.00, startDate: '2026-09-14',
        endDate: '2026-09-21', createdAt, collectionMethod: 'in_shop',
        receiptId: paid.id, receiptAllocations: [{ receiptId: paid.id, amountUSD: 12345.67 }],
        adPhotos: [photo, secondPhoto], notes: 'Design-only disposable fixture; never a real Meta ad.'
      } });
    applyValidatedServerEntityBatch([
      { collection: 'ads', entity: mutation.ad },
      ...mutation.updatedReceipts.map(entity => ({ collection: 'receipts', entity }))
    ], 'design-test-seed');
    return { customer: customer.id, page: pageRow.id, paid: paid.id, unpaid: unpaid.id,
      ad: adId, user: state.currentUser.id };
  }, { project: project.replace(/[^a-z0-9-]/gi, ''), photo: PIXEL });
}

function rowSelector(kind, id) {
  return `[data-shell-row="${kind}"][data-shell-row-id="${id}"]`;
}

function adDetailSelector(id) {
  return `[data-shell-detail="ads"][data-shell-detail-id="${id}"]`;
}

// Give each viewport an isolated context and fixture. A slow screenshot in
// one viewport must not consume the test budget for the next viewport.
for (const width of [1440, 1024, 390]) {
test(`Ads retain the classic table and phone rows while other operations keep cards and record shortcuts at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await signIn(page);
  const ids = await seedRecords(page, `workspace-${testInfo.project.name}`);
  await page.evaluate(async ids => {
    stopServerLiveSync();
    await (_serverLiveSync.tickPromise || Promise.resolve());
    // Read-only presentation projections. No real driver/Meta publishing,
    // financial writes, or fabricated server-owned fields go to the API.
    const delivery = state.receipts.find(row => row.id === ids.unpaid);
    delivery.deliveryStatus = 'Needs Delivery';
    delivery.statusDetail = { notPaidCollection: 'delivery' };
    const ad = state.ads.find(row => row.id === ids.ad);
    const ended = new Date(Date.now() - 3 * 86400000).toISOString();
    ad.endDate = ended;
    ad.startDate = new Date(Date.now() - 10 * 86400000).toISOString();
    ad.metaAdId = 'design-only-meta';
    ad.metaAdName = 'Summer campaign · حملة اختبار العرض';
    ad.metaAdAccountName = 'Business ad account';
    ad.metaAdAccountId = '123456789';
    ad.metaCurrency = 'USD';
    ad.metaTotalBudgetMinor = 1234567;
    ad.metaSpendMinor = 543210;
    ad.metaTotalRemainingBudgetMinor = 691357;
  }, ids);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await appearance(page, width === 1440 ? 'en' : 'ar', width === 1440 ? 'light' : 'dark');
    for (const view of ['ads', 'deliveries', 'reconciliation', 'control-center']) {
      await openView(page, view);
      if (view === 'control-center') await expect(page.locator('.management-workspace')).toBeVisible();
      if (view === 'ads') {
        const table = page.locator('#ads-table-container table.ads-summary-table');
        const summary = page.locator(rowSelector('ads', ids.ad));
        await expect(table).toBeVisible();
        await expect(table.locator('thead th')).toHaveCount(10);
        await expect(page.locator('[data-ad-campaign-card]')).toHaveCount(0);
        if (width > 900) {
          await expect(table.locator('thead')).toBeVisible();
          await expect(summary).toBeHidden();
          await expect(page.locator(adDetailSelector(ids.ad))).toBeVisible();
        } else {
          await expect(table.locator('thead')).toBeHidden();
          await expect(summary).toBeVisible();
          const toggle = summary.locator('button[aria-expanded]');
          if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
          await expect(page.locator(adDetailSelector(ids.ad))).toBeHidden();
          await assertTouchable(summary.locator('.meta-ad-thumbnail-button'), 'Collapsed ad photo');
        }
        const detail = await expandRow(page, 'ads', ids.ad);
        await assertTouchable(detail.locator('[data-action="view-ad-photos"]'), 'Outside ad photos');
        await expect(detail.locator('[data-action="choose-ad-main-photo"]')).toBeVisible();
        await expect(detail.locator('.ads-linked-receipts [data-action="view-ad-receipt"]')).toHaveAttribute('data-receipt-id', ids.paid);
        const actionCell = detail.locator('td').last();
        const receiptShortcut = actionCell.locator('.ads-linked-receipts [data-action="view-ad-receipt"]');
        await expect(receiptShortcut).toBeVisible();
        const cellBounds = await actionCell.boundingBox();
        const linkBounds = await receiptShortcut.boundingBox();
        expect(linkBounds.x).toBeGreaterThanOrEqual(cellBounds.x - 1);
        expect(linkBounds.x + linkBounds.width).toBeLessThanOrEqual(cellBounds.x + cellBounds.width + 1);
        await expect(detail.locator('td[data-payment-state="paid"] > span').first()).toHaveText('$12345.67');
      }
      if (view === 'deliveries') {
        await expect(page.locator(`[data-delivery-record="${ids.unpaid}"]`)).toBeVisible();
        await expect(page.locator('#delivery-log-results table')).toHaveCount(0);
      }
      if (view === 'reconciliation') {
        await expect(page.locator(`[data-reconciliation-card="${ids.ad}"]`)).toBeVisible();
        const spend = page.locator(`#reconciliation-spent-${ids.ad}`);
        await expect(spend).toBeEditable();
        // Preview only: changing a field must not send a financial mutation.
        await spend.fill('5000.25');
        await expect(page.locator(`#reconciliation-remaining-${ids.ad}`)).toHaveText('$7345.42');
      }
      await assertPageAndCardsFit(page, `${view} structural layout ${width}`);
      await captureDesign(page, testInfo, `${view}-workspace`);
    }
    await openView(page, 'receipts');
    const receipt = page.locator(rowSelector('receipts', ids.paid));
    await expect(receipt.locator('> button')).toHaveAttribute('aria-expanded', 'false');
    await assertTouchable(receipt.locator('[data-record-action="receiptPhotos"]'), 'Outside receipt photos');
    await receipt.locator('[data-record-action="receiptPhotos"]').click();
    await expect(page.locator('#receipt-photo-viewer')).toBeVisible();
    await page.evaluate(() => closeReceiptPhotoViewer());
    await receipt.locator('[data-record-action="receiptAds"]').click();
    await expect.poll(() => statePath(page)).toBe('/ads');
    const linkedAd = await expandRow(page, 'ads', ids.ad);
    await expect(linkedAd).toBeVisible();
    const linkedReceipt = linkedAd.locator(`.ads-linked-receipts [data-action="view-ad-receipt"][data-receipt-id="${ids.paid}"]`);
    await assertTouchable(linkedReceipt, 'Linked receipt shortcut');
    await linkedReceipt.click();
    await expect.poll(() => statePath(page)).toBe('/receipts');
    await expect.poll(() => page.evaluate(() => state.receiptRecordFilter)).toBe(ids.paid);
    await expect(page.locator(rowSelector('receipts', ids.paid))).toBeVisible();
    await expect(page.locator(rowSelector('receipts', ids.unpaid))).toHaveCount(0);
    await page.evaluate(() => {
      state.adReceiptFilter = '';
      state.adSearch = '';
      state.receiptRecordFilter = '';
      state.receiptCustomerFilter = '';
    });
    await openView(page, 'customers');
    await expect(page.locator(rowSelector('customers', ids.customer)).locator('[data-action="view-customer-receipts"]:visible')).toBeVisible();
    await assertPageAndCardsFit(page, `Directory shortcuts ${width}`);
    await captureDesign(page, testInfo, 'customers-workspace');
  }
  expect(errors).toEqual([]);
});
}

async function statePath(page) { return new URL(page.url()).pathname; }

async function expandRow(page, kind, id) {
  const row = page.locator(rowSelector(kind, id));
  const toggle = row.locator('button[aria-expanded]').first();
  if (await toggle.isVisible()) {
    await assertTouchable(toggle, `${kind} summary`);
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  return kind === 'ads' ? page.locator(adDetailSelector(id)) : row.locator('.shell-row-body');
}

test('all manager destinations and lazy subsystem tabs survive the redesign', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const routes = [
    ['services-hub', '/'], ['control-center', '/control-center'], ['analytics', '/analytics'],
    ['customers', '/customers'], ['receipts', '/receipts'], ['pages', '/pages'], ['ads', '/ads'],
    ['deliveries', '/deliveries'], ['reconciliation', '/reconciliation'], ['users', '/users'],
    ['audit', '/audit-logs'], ['settings', '/settings'], ['more', '/more'], ['collect', '/collect'],
    ['reminders', '/reminders'], ['delivery-dashboard', '/delivery'], ['no-access', '/no-access'],
    ['smart-systems', '/smart-systems'], ['service-placeholder', '/service'], ['wallet', '/wallet'],
    ['plans', '/plans'], ['charge-wallet', '/charge-wallet'], ['clothes-system', '/clothes-system'],
    ['ads-studio', '/ads-studio']
  ];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [view, path] of routes) {
    if (view === 'service-placeholder') {
      await page.evaluate(() => { state.viewData = { serviceId: 'international_shipping' }; });
    }
    await openView(page, view, path);
    await assertPageAndCardsFit(page, path);
  }
  await page.waitForFunction(() => typeof renderClothesSystemView === 'function'
    && typeof renderSocialStudioPostsTab === 'function' && typeof renderControlCenterView === 'function');
  await openView(page, 'clothes-system');
  for (const tab of ['dashboard', 'products', 'shipments', 'orders']) {
    await page.evaluate(id => setClothesTab(id), tab);
    await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe(tab);
    await assertPageAndCardsFit(page, `Clothes ${tab}`);
  }
  await openView(page, 'ads-studio');
  for (const tab of ['dashboard', 'campaigns', 'builder', 'posts', 'replies', 'review']) {
    await page.evaluate(id => setAdsStudioTab(id), tab);
    await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe(tab);
    await assertPageAndCardsFit(page, `Studio ${tab}`);
  }
  expect(errors).toEqual([]);
});

for (const width of [320, 390, 412]) {
test(`long-name and large-balance compact records fit small phones in English and Arabic dark mode at ${width}px`, async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await signIn(page);
  const ids = await seedRecords(page, testInfo.project.name);
  const entries = [ ['customers', ids.customer], ['receipts', ids.paid], ['pages', ids.page],
    ['users', ids.user], ['ads', ids.ad] ];
  {
    await page.setViewportSize({ width, height: 844 });
    await appearance(page, width === 390 ? 'en' : 'ar', width === 390 ? 'light' : 'dark');
    for (const [kind, id] of entries) {
      await openView(page, kind);
      const toggle = page.locator(rowSelector(kind, id)).locator('button[aria-expanded]').first();
      if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
      if (kind === 'ads') await expect(page.locator(adDetailSelector(id))).toBeHidden();
      await assertPageAndCardsFit(page, `${kind} collapsed at ${width}`);
      if (width !== 412 && ['receipts', 'ads'].includes(kind)) {
        await captureDesign(page, testInfo, `${kind}-collapsed`);
      }
      const detail = await expandRow(page, kind, id);
      await expect(detail).toBeVisible();
      await assertPageAndCardsFit(page, `${kind} expanded at ${width}`);
      const edit = detail.locator(`button[onclick^="edit${{ customers: 'Customer', receipts: 'Receipt', pages: 'Page', users: 'User', ads: 'Ad' }[kind]}("]`).first();
      await expect(edit).toBeVisible();
      // Trial only: verifies the real edit action is tappable without saving.
      await edit.click({ trial: true });
      if (kind === 'customers') {
        await expect(detail.locator('[data-action="view-customer-pages"]')).toBeVisible();
        await expect(detail.locator('[data-action="view-customer-receipts"]')).toBeVisible();
      } else if (kind === 'receipts') {
        await expect(detail.locator('[data-action="view-receipt-ads"]')).toBeVisible();
        await expect(detail.locator('button[onclick^="openReceiptPhotoViewer("]')).toBeVisible();
      } else if (kind === 'ads') {
        await expect(detail.locator('[data-action="view-ad-photos"]')).toBeVisible();
        await expect(detail.locator('[data-action="choose-ad-main-photo"]')).toBeVisible();
        if (width !== 390) {
          await expect(detail.locator('.payment-badge').first()).toHaveCSS('color', 'rgb(191, 219, 254)');
          await expect(detail.locator('[data-role="meta-page-summary"] .text-indigo-700').first()).toHaveCSS('color', 'rgb(165, 180, 252)');
        }
        if (width !== 412) await captureDesign(page, testInfo, 'ads-expanded');
      }
    }
    for (const view of ['collect', 'reminders', 'more', 'wallet', 'settings']) {
      await openView(page, view);
      await assertPageAndCardsFit(page, `${view} at ${width}`);
      if (width !== 412 && view === 'more') await captureDesign(page, testInfo, 'more');
    }
    await openView(page, 'analytics');
    await assertPageAndCardsFit(page, `Home at ${width}`);
    const splitAmounts = await page.locator('.shell-home-kpis .shell-kpi-value').evaluateAll(values => values.flatMap(value => {
      const text = value.firstChild;
      if (text?.nodeType !== Node.TEXT_NODE) return [];
      const number = text.textContent.match(/\d[\d,]*\.\d{2}/);
      if (!number) return [];
      const range = document.createRange();
      range.setStart(text, number.index);
      range.setEnd(text, number.index + number[0].length);
      const boxes = Array.from(range.getClientRects());
      return boxes.some(box => Math.abs(box.top - boxes[0].top) > 2) ? [number[0]] : [];
    }));
    expect(splitAmounts, `Home money must not split between digits at ${width}px`).toEqual([]);
    if (width !== 412) await captureDesign(page, testInfo, 'home');
  }
  await appearance(page, 'en', 'light');
  await openView(page, 'receipts');
  const filterToggle = page.locator('.workspace-filter-toggle');
  const filterPanel = page.locator('#receipts-advanced-filters');
  await expect(filterToggle).toHaveAccessibleName(/Filters & sort/);
  await expect(filterToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(filterPanel).toBeHidden();
  await filterToggle.click();
  await expect(filterPanel).toBeVisible();
  const debtSelect = filterPanel.locator('select').filter({ has: page.locator('option[value="any-debt"]') });
  await debtSelect.selectOption('any-debt');
  await expect(page.locator(rowSelector('receipts', ids.unpaid))).toBeVisible();
  await expect(page.locator(rowSelector('receipts', ids.paid))).toHaveCount(0);
  await filterToggle.click();
  await expect(filterPanel).toBeHidden();
  await expect.poll(() => page.evaluate(() => state.receiptDebtFilter)).toBe('any-debt');
  await expect(page.locator(rowSelector('receipts', ids.unpaid))).toBeVisible();
  await expect(page.locator(rowSelector('receipts', ids.paid))).toHaveCount(0);
  await filterToggle.click();
  await expect(debtSelect).toHaveValue('any-debt');
  await assertPageAndCardsFit(page, 'Receipt filters remain usable after disclosure');
});
}

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 932, height: 430 }]) {
test(`editable record forms retain labelled fields and reachable save and cancel controls at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await signIn(page);
  const ids = await seedRecords(page, `forms-${testInfo.project.name}`);
  await page.evaluate(pageId => {
    // Admin ad-page selection currently requires a Meta identity. Like the
    // existing clipboard regression, project a synthetic identity for this
    // read-only form check; never forge server-owned fields through an API or
    // contact Meta. Every customer/receipt/ad above still came from real local
    // transactions, and the forms below are cancelled without submission.
    stopServerLiveSync();
    state.pages.find(row => row.id === pageId).metaPageId = '100000000000099';
  }, ids.page);
  const forms = [
    { view: 'customers', id: ids.customer, fn: 'editCustomer', field: '#customer-name' },
    { view: 'receipts', id: ids.paid, fn: 'editReceipt', field: '#receipt-phone-search' },
    { view: 'pages', id: ids.page, fn: 'editPage', field: '#page-name' },
    { view: 'users', id: ids.user, fn: 'editUser', field: '#user-name' },
    { view: 'ads', id: ids.ad, fn: 'editAd', field: '#ad-page-search' }
  ];
  {
    await page.setViewportSize(viewport);
    await appearance(page, viewport.width === 390 ? 'en' : 'ar', viewport.width === 390 ? 'light' : 'dark');
    for (const form of forms) {
      await openView(page, form.view);
      const detail = await expandRow(page, form.view, form.id);
      await detail.locator(`button[onclick^="${form.fn}("]`).first().click();
      const modal = page.locator('#app-modal');
      await expect(modal).toBeVisible();
      const field = modal.locator(form.field);
      await expect(field).toBeVisible();
      await expect(field).toHaveAccessibleName(/\S/);
      if (form.view === 'receipts' && viewport.width !== 932) {
        await captureDesign(page, testInfo, 'receipt-form');
      }
      const save = form.view === 'receipts'
        ? modal.locator('#receipt-save-btn')
        : modal.locator('button[type="submit"]').first();
      await expect(save).toHaveAccessibleName(/\S/);
      await assertTouchable(save, `${form.view} save`);
      await save.click({ trial: true });
      const bounds = await modal.evaluate(element => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, width: innerWidth };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(-1);
      expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
      const cancel = modal.getByRole('button', { name: /^(cancel|إلغاء)$/i });
      await assertTouchable(cancel, `${form.view} cancel`);
      await cancel.click();
      await expect(modal).toBeHidden();
    }
  }
});
}

test('phone tabs stay tappable and below content while keyboard and More navigation work', async ({ page }) => {
  await signIn(page);
  for (const width of [320, 390, 412]) {
    await page.setViewportSize({ width, height: 844 });
    await openView(page, 'analytics');
    const nav = page.locator('.mobile-bottom-nav');
    await expect(nav).toBeVisible();
    const buttons = nav.locator('button');
    for (let index = 0; index < await buttons.count(); index++) {
      await assertTouchable(buttons.nth(index), `nav button ${index} at ${width}`);
    }
    const bounds = await nav.boundingBox();
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(845);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(839);
    await nav.getByRole('button', { name: 'More', exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/more');
    await assertPageAndCardsFit(page, `More nav at ${width}`);
  }
  await openView(page, 'customers');
  await page.getByRole('button', { name: /add customer/i }).click();
  const modal = page.locator('#app-modal');
  await expect(modal).toBeVisible();
  await modal.locator('#customer-name').focus();
  await expect(page.locator('body')).toHaveClass(/keyboard-open/);
  await expect(page.locator('.mobile-bottom-nav')).toBeHidden();
  await modal.getByRole('button', { name: /^cancel$/i }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator('.mobile-bottom-nav')).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  // Simulate asymmetric physical screen cutouts: RTL must not swap them.
  for (const width of [320, 844]) {
    await page.setViewportSize({ width, height: 844 });
    for (const language of ['en', 'ar']) {
      await appearance(page, language, 'light');
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--app-safe-left', '50px');
        document.documentElement.style.setProperty('--app-safe-right', '22px');
      });
      for (const selector of ['.app-content', '.mobile-app-header']) {
        await expect(page.locator(selector)).toHaveCSS('padding-left', '50px');
        await expect(page.locator(selector)).toHaveCSS('padding-right', '22px');
      }
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--app-safe-left');
    document.documentElement.style.removeProperty('--app-safe-right');
  });
});
