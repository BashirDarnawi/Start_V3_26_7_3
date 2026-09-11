const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL = 'e2e.admin@albayan.example.com';
const ADMIN_PASSWORD = 'E2eAdminPassword123!';

async function signIn(page) {
  await page.goto('/');
  await expect(page.locator('#login-form')).toBeVisible();
  await page.locator('#login-email').fill(ADMIN_EMAIL);
  await page.locator('#login-password').fill(ADMIN_PASSWORD);
  const [loginResponse] = await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/auth/login')),
    page.locator('#login-form button[type="submit"]').click()
  ]);
  expect(loginResponse.ok(), `Login failed with HTTP ${loginResponse.status()}`).toBe(true);
  // Admins land on the Services Hub, which intentionally has no workspace
  // sidebar. Wait on authenticated application state instead of a screen-
  // specific element, then each test can open the route it needs.
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.currentUser?.id);
  await expect(page.getByText(/welcome,?\s*e2e administrator/i)).toBeVisible();
}

function safeProjectToken(projectName) {
  return projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

test('an upgrade refreshes an existing receipt at the same revision without recreating it', async ({ page }, testInfo) => {
  await signIn(page);
  const receiptId = await page.evaluate(async label => {
    const customer = { id: generateId('cust'), name: `Upgrade Customer ${label}`,
      phones: [`094${Date.now().toString().slice(-7)}`], platform: 'Facebook',
      joinDate: new Date().toISOString(), profileLinks: [] };
    if (!await addRecord(state.customers, customer)) throw new Error('Customer seed failed');
    const receipt = { id: generateId('receipt'), recordType: 'receipt', customerId: customer.id,
      customerName: customer.name, status: 'Not Paid', isPaid: false, amountUSD: 120,
      amountLocal: 600, debtAmountUSD: 120, debtAmountLocal: 600, exchangeRate: 5,
      deliveryStatus: 'Office', statusDetail: { notPaidCollection: 'office' } };
    if (!await addRecord(state.receipts, receipt)) throw new Error('Receipt seed failed');
    return receipt.id;
  }, safeProjectToken(testInfo.project.name));
  await page.goto('/receipts');
  const button = page.locator(`button[data-receipt-id="${receiptId}"][aria-label^="Cover part"]`);
  await expect(button).toBeVisible();
  const result = await page.evaluate(async id => {
    stopServerLiveSync();
    const path = `/api/collections/receipts/${encodeURIComponent(id)}`;
    const before = await apiJson(path);
    const row = state.receipts.find(item => item.id === id);
    // Simulate a cached summary from an older app; its server revision did
    // not change when the new read rules were deployed.
    row.customerOutstandingUSD = 999;
    _serverLiveSync.dataCompatibilityVersion = 0;
    _serverLiveSync.lastCompatibilityCheckAt = 0;
    const refresh = await refreshServerDataCompatibility();
    const current = state.receipts.find(item => item.id === id);
    const after = await apiJson(path);
    return { refresh, cachedOutstanding: current.customerOutstandingUSD ?? null,
      before, after, acknowledged: _serverLiveSync.dataCompatibilityVersion };
  }, receiptId);
  expect(result.refresh?.refreshed).toBe(true);
  expect(result.cachedOutstanding).toBeNull();
  expect(result.before).toEqual(result.after);
  expect(result.acknowledged).toBeGreaterThan(0);
  await button.click();
  const dialog = page.locator('#company-debt-coverage-modal');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('$120.00');
  await expect(dialog).not.toContainText('$999.00');
});

for (const transition of ['expiry', 'logout']) {
  test(`company-debt dialog is private and closes completely on ${transition}`, async ({ page, context }, testInfo) => {
    await signIn(page);
    const seeded = await page.evaluate(async label => {
      const customer = {
        id: generateId('cust'), name: `Private Coverage ${label}`,
        phones: [`093${Date.now().toString().slice(-7)}`],
        platform: 'Facebook', joinDate: new Date().toISOString(), profileLinks: [],
      };
      if (!await addRecord(state.customers, customer)) throw new Error('Customer seed failed');
      const receipt = {
        id: generateId('receipt'), recordType: 'receipt', customerId: customer.id,
        customerName: customer.name, status: 'Not Paid', isPaid: false,
        amountUSD: 120, amountLocal: 600, debtAmountUSD: 120, debtAmountLocal: 600,
        exchangeRate: 5, deliveryStatus: 'Office', statusDetail: { notPaidCollection: 'office' },
      };
      if (!await addRecord(state.receipts, receipt)) throw new Error('Receipt seed failed');
      return { receiptId: receipt.id, customerName: customer.name };
    }, `${safeProjectToken(testInfo.project.name)} ${transition}`);
    await page.goto('/receipts');
    const button = page.locator(`button[data-receipt-id="${seeded.receiptId}"][aria-label^="Cover part"]`);
    await expect(button).toBeVisible();
    await button.click();
    const dialog = page.locator('#company-debt-coverage-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(seeded.customerName);
    await expect(dialog).toContainText('$120.00');
    if (transition === 'expiry') {
      await context.clearCookies();
      await page.evaluate(() => handleServerAuthExpired(getServerSessionIdentity()));
    } else {
      await page.evaluate(() => handleLogout());
    }
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(seeded.customerName, { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
    // A used device intentionally offers its saved-account chooser first.
    await page.getByRole('button', { name: 'Use another account', exact: true }).click();
    await expect(page.locator('#login-form')).toBeVisible();
  });
}

test('administrator can create a customer and duplicate phones are blocked', async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto('/customers');

  const token = safeProjectToken(testInfo.project.name);
  const customerName = `E2E Customer ${token}`;
  const duplicateName = `Duplicate E2E ${token}`;
  const phone = token.includes('webkit') ? '0918000103' : token.includes('mobile') ? '0918000102' : '0918000101';

  await page.getByRole('button', { name: /add customer/i }).click();
  await expect(page.locator('#app-modal')).toBeVisible();
  await page.locator('#customer-name').fill(customerName);
  await page.locator('.customer-phone').first().fill(phone);
  await page.getByRole('button', { name: /create customer/i }).click();

  await expect(page.locator('#app-modal')).toBeHidden();
  await expect(page.getByText(customerName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /add customer/i }).click();
  await page.locator('#customer-name').fill(duplicateName);
  await page.locator('.customer-phone').first().fill(phone);
  await page.getByRole('button', { name: /create customer/i }).click();

  await expect(page.getByText(/duplicate phone number/i)).toBeVisible();
  await expect(page.locator('#app-modal')).toBeVisible();
  await page.getByRole('button', { name: /cancel/i }).click();
  await expect(page.getByText(duplicateName, { exact: true })).toHaveCount(0);
});

test('receipt photos open from the outside card action', async ({ page }, testInfo) => {
  await signIn(page);
  const token = safeProjectToken(testInfo.project.name);
  const seeded = await page.evaluate(async projectToken => {
    const customer = {
      id: generateId('cust'),
      name: `Photo Customer ${projectToken}`,
      phones: [`092${Date.now().toString().slice(-7)}`],
      platform: 'Facebook',
      joinDate: new Date().toISOString(),
      profileLinks: []
    };
    if (!await addRecord(state.customers, customer)) throw new Error('Customer seed failed');

    const now = Date.now();
    const receipt = {
      id: generateId('receipt'),
      receiptNo: `E2E-PHOTO-${projectToken}-${now}`,
      serialNumber: `S${String(now).slice(-8)}`,
      customerId: customer.id,
      customerName: customer.name,
      status: 'Paid',
      paymentStatus: 'Paid',
      paymentMethod: 'Cash (LYD)',
      amountUSD: 10,
      amountLocal: 97,
      exchangeRate: 9.7,
      collected: true,
      collectionDate: new Date().toISOString(),
      photos: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=']
    };
    if (!await addRecord(state.receipts, receipt)) throw new Error('Receipt seed failed');
    return { receiptId: receipt.id, serialNumber: receipt.serialNumber };
  }, token);

  await page.goto('/receipts');
  await expect(page.getByText(seeded.serialNumber, { exact: false })).toBeVisible();
  await page.locator(`button[data-receipt-id="${seeded.receiptId}"][aria-label^="View receipt photos"]`).click();
  await expect(page.locator('#receipt-photo-viewer')).toBeVisible();
  await expect(page.locator('#receipt-photo-viewer-image')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.getByRole('button', { name: /close photo/i }).click();
  await expect(page.locator('#receipt-photo-viewer')).toHaveCount(0);
});

test('copied photos paste into an ad while text fields keep normal paste', async ({ page }) => {
  await signIn(page);
  await page.goto('/ads');
  // Render the real ad form directly so this focused clipboard regression does
  // not depend on a page/customer fixture created by a different test.
  await page.evaluate(() => {
    stopServerLiveSync();
    const customerId = generateId('cust');
    state.customers.push({
      id: customerId,
      name: 'Clipboard Photo Customer',
      phones: ['0950000001'],
      platform: 'Facebook',
      joinDate: new Date().toISOString(),
      profileLinks: []
    });
    state.pages.push({
      id: generateId('page'),
      name: 'Clipboard Photo Page',
      metaPageId: '100000000000099',
      category: 'E2E',
      customerIds: [customerId],
      createdAt: new Date().toISOString(),
      _deleted: false
    });
    state.activeModal = 'ad';
    state.modalData = null;
    updateUrlParams({ modal: 'ad', id: 'new' });
    renderModal();
  });
  await expect(page.locator('#app-modal')).toBeVisible();
  await expect(page.getByRole('button', { name: /paste photo/i })).toBeVisible();

  const textPasteResult = await page.evaluate(() => {
    const bytes = Uint8Array.from([137, 80, 78, 71]);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'also-an-image.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
    document.getElementById('ad-page-search').dispatchEvent(event);
    return { prevented: event.defaultPrevented };
  });
  expect(textPasteResult.prevented).toBe(false);

  const pasteResult = await page.evaluate(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'copied.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
    const zone = document.querySelector('[data-photo-paste-target="ad"]');
    zone.focus();
    zone.dispatchEvent(event);
    return { prevented: event.defaultPrevented };
  });
  expect(pasteResult.prevented).toBe(true);
  await expect(page.locator('#ad-photo-previews img')).toHaveCount(1);
});

test('critical workspace routes fit the viewport and forms open', async ({ page }) => {
  await signIn(page);

  for (const route of ['/customers', '/receipts', '/ads']) {
    await page.goto(route);
    await expect(page.locator('#app-sidebar')).toBeAttached();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${route} has horizontal overflow`).toBeLessThanOrEqual(1);
  }

  await page.goto('/receipts');
  await page.getByRole('button', { name: /new receipt/i }).click();
  const chooser = page.locator('#new-receipt-chooser');
  await expect(chooser).toBeVisible();
  await chooser.getByRole('button', { name: /^new receipt/i }).click();
  await expect(page.locator('#app-modal')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(async () => {
    if (getVisibleRecords(state.customers).length > 0) return;
    const customer = {
      id: generateId('cust'),
      name: 'E2E Ad Form Customer',
      phones: [`094${Date.now().toString().slice(-7)}`],
      platform: 'Facebook',
      joinDate: new Date().toISOString(),
      profileLinks: []
    };
    if (!await addRecord(state.customers, customer)) throw new Error('Ad-form customer seed failed');
  });
  await page.goto('/ads');
  await page.waitForFunction(() => getVisibleRecords(state.customers).length > 0);
  await page.getByRole('button', { name: /add ad/i }).click();
  await expect(page.locator('#app-modal')).toBeVisible();
  const modalFits = await page.locator('#app-modal').evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.left >= -1 && box.right <= window.innerWidth + 1;
  });
  expect(modalFits).toBe(true);
});

test('workspace stays usable across small phones, tablets, and landscape screens', async ({ page }) => {
  await signIn(page);

  const viewports = [
    { name: 'small phone portrait', width: 320, height: 568 },
    { name: 'common Android portrait', width: 360, height: 640 },
    { name: 'modern phone portrait', width: 390, height: 844 },
    { name: 'small phone landscape', width: 667, height: 375 },
    { name: 'large phone landscape', width: 932, height: 430 },
    { name: 'tablet portrait', width: 768, height: 1024 }
  ];

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    for (const route of ['/customers', '/receipts', '/ads']) {
      await page.goto(route);
      await expect(page.locator('#app-sidebar')).toBeAttached();

      const layout = await page.evaluate(() => {
        const viewportWidth = window.innerWidth;
        const visibleControls = [...document.querySelectorAll('button, a, input, select, textarea')]
          .filter(element => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
          });
        const outsideControls = visibleControls.filter(element => {
          const box = element.getBoundingClientRect();
          return box.left < -1 || box.right > viewportWidth + 1;
        });
        return {
          overflow: document.documentElement.scrollWidth - viewportWidth,
          outsideControls: outsideControls.map(element => element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName).slice(0, 5)
        };
      });

      expect(layout.overflow, `${route} overflows on ${viewport.name}`).toBeLessThanOrEqual(1);
      expect(layout.outsideControls, `${route} has unreachable controls on ${viewport.name}`).toEqual([]);
    }
  }
});

test('lazy Clothes and Studio features load with their responsive styles', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 820, height: 1024 });
  await page.goto('/clothes-system');
  const tabs = page.locator('.clothes-tab-bar');
  await expect(tabs).toBeVisible();
  await expect(tabs).toHaveCSS('flex-wrap', 'wrap');

  await page.goto('/studio');
  await expect(page.getByRole('heading', { name: 'Albayan Ads Studio', exact: true })).toBeVisible();
  const columns = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'grid md:grid-cols-[1fr_auto]';
    probe.innerHTML = '<span>Primary content</span><span>Action</span>';
    document.body.appendChild(probe);
    const count = getComputedStyle(probe).gridTemplateColumns.split(' ').length;
    probe.remove();
    return count;
  });
  expect(columns).toBe(2);
  for (const width of [320, 390, 820]) {
    await page.setViewportSize({ width, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `Studio overflows at ${width}px`).toBeLessThanOrEqual(1);
  }
});

test('administrator can run the read-only data integrity check', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  const [auditResponse] = await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/admin/data-integrity')),
    page.getByRole('button', { name: /check data integrity/i }).click()
  ]);
  expect(auditResponse.ok(), `Integrity audit failed with HTTP ${auditResponse.status()}`).toBe(true);
  await expect(page.locator('#app-modal')).toBeVisible();
  await expect(page.getByRole('heading', { name: /data integrity check/i })).toBeVisible();
  await expect(page.getByText(/records checked/i)).toBeVisible();
  await page.getByRole('button', { name: /^close$/i }).click();
  await expect(page.locator('#app-modal')).toBeHidden();
});

test('Meta Ads connection manager is safe, readable, and phone-sized', async ({ page }) => {
  await signIn(page);
  await page.goto('/ads');
  const [statusResponse] = await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/meta-ads/status')),
    page.getByRole('button', { name: /meta sync/i }).click()
  ]);
  expect(statusResponse.ok(), `Meta status failed with HTTP ${statusResponse.status()}`).toBe(true);
  const modal = page.locator('#meta-ads-modal');
  await expect(modal).toBeVisible();
  await expect(page.getByText(/read-only.*accounting and photos are never changed/i)).toBeVisible();
  await expect(page.getByText(/setup needed/i)).toBeVisible();
  await expect(page.getByText(/never type the access token into albayan or chat/i)).toBeVisible();
  await expect(modal.locator('code')).not.toContainText('secret-token-must-never-leak');
  await expect(modal.locator('code')).not.toContainText('secret-app-value-must-never-leak');
  const bounds = await modal.locator(':scope > div').evaluate(element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: window.innerWidth, height: window.innerHeight };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.top).toBeGreaterThanOrEqual(-1);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1);
  await modal.getByRole('button', { name: /close/i }).click();
  await expect(modal).toHaveCount(0);
});

test('analytics cards open daily, weekly, monthly details and the private cost ledger', async ({ page }) => {
  await signIn(page);
  await page.goto('/analytics');

  await page.getByRole('button', { name: /ad revenue \(paid\)/i }).click();
  const breakdownRoot = page.locator('#analytics-breakdown-dialog');
  const breakdown = breakdownRoot.getByRole('dialog');
  await expect(breakdown).toBeVisible();
  await expect(breakdown.getByRole('heading', { name: /paid ad revenue breakdown/i })).toBeVisible();
  await breakdown.getByRole('button', { name: /weekly/i }).click();
  await expect(breakdown.getByRole('button', { name: /weekly/i })).toHaveClass(/bg-white/);
  await breakdown.getByRole('button', { name: /monthly/i }).click();
  await expect(breakdown.getByRole('button', { name: /monthly/i })).toHaveClass(/bg-white/);
  await breakdown.getByRole('button', { name: /close/i }).click();
  await expect(breakdownRoot).toHaveCount(0);

  await page.getByRole('button', { name: /receipts volume/i }).click();
  await expect(page.getByRole('heading', { name: /receipts volume breakdown/i })).toBeVisible();
  await page.locator('#analytics-breakdown-dialog').getByRole('dialog').getByRole('button', { name: /close/i }).click();

  await page.getByRole('button', { name: /collection status/i }).click();
  await expect(page.getByRole('heading', { name: /collection status breakdown/i })).toBeVisible();
  await page.locator('#analytics-breakdown-dialog').getByRole('dialog').getByRole('button', { name: /close/i }).click();

  await page.getByRole('button', { name: /record dollar purchase/i }).click();
  const ledger = page.locator('#dollar-purchase-dialog');
  await expect(ledger).toBeVisible();
  await expect(ledger.getByRole('heading', { name: /facebook dollar purchase ledger/i })).toBeVisible();
  const bounds = await ledger.locator('section').evaluate(element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.top).toBeGreaterThanOrEqual(-1);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1);
});
