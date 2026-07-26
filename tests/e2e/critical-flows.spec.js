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
