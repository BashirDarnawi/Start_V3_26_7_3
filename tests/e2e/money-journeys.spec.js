const { test, expect } = require('@playwright/test');

// These journeys drive the desktop layout (tabs, dropdowns, the transfer dialog);
// the phone layouts have their own compact rows and are covered by design-system.spec.js.
test.skip(({ isMobile }) => isMobile, 'Money journeys use the desktop layout');

// Money-critical office journeys that the other browser specs do not drive.
//
// Every test signs in as the disposable E2E admin, seeds ONLY its own
// customer/receipt/product rows (unique names via Date.now() + project name),
// drives the real office buttons wherever the harness allows it, and then
// verifies the SERVER state through the app's own apiJson() so an optimistic
// client paint can never make a test pass on its own.
//
// Seeding goes through the app's own functions (addRecord, apiMutateAd,
// WALLET.credit, ...) exactly like critical-flows.spec.js and
// design-system.spec.js do. Never point this suite at a live server:
// playwright.config.js refuses non-local base URLs and
// scripts/start-e2e-server.js recreates the SQLite database for each run.
//
// Run only this file with:
//   npx playwright test tests/e2e/money-journeys.spec.js
// (or one browser: npx playwright test tests/e2e/money-journeys.spec.js --project=desktop-chromium)

const ADMIN_EMAIL = 'e2e.admin@albayan.example.com';
const ADMIN_PASSWORD = 'E2eAdminPassword123!';
const PIXEL_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PIXEL = `data:image/png;base64,${PIXEL_BASE64}`;
const REASON = 'E2E automated reason, at least ten characters long';

let serialCounter = 10;

// ---------------------------------------------------------------------------
// Shared helpers (same login / row / seeding style as critical-flows.spec.js)
// ---------------------------------------------------------------------------

async function waitForLiveSync(page, timeout = 30000) {
  await page.waitForFunction(() => typeof _serverLiveSync !== 'undefined' && !!_serverLiveSync.timer, null, { timeout });
}

async function signIn(page, { email = ADMIN_EMAIL, password = ADMIN_PASSWORD, requireLiveSync = true } = {}) {
  await page.goto('/');
  // A device that already remembers an account offers its chooser first.
  const chooser = page.getByRole('button', { name: 'Use another account', exact: true });
  if (await chooser.isVisible().catch(() => false)) await chooser.click();
  await expect(page.locator('#login-form')).toBeVisible();
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  const [loginResponse] = await Promise.all([
    page.waitForResponse(response => response.url().includes('/api/auth/login')),
    page.locator('#login-form button[type="submit"]').click()
  ]);
  expect(loginResponse.ok(), `Login for ${email} failed with HTTP ${loginResponse.status()}`).toBe(true);
  await page.waitForFunction(() => typeof state !== 'undefined' && !!state.currentUser?.id);
  // The live-sync poller starts only after the post-login full load settled;
  // waiting for it makes every seed and refresh below deterministic.
  if (requireLiveSync) await waitForLiveSync(page);
  else await waitForLiveSync(page, 15000).catch(() => {});
}

// Lists render compact rows; a row expands into the full card (with its
// action buttons) on tap.
async function expandRow(page, kind, id) {
  const row = page.locator(`[data-shell-row="${kind}"][data-shell-row-id="${id}"] > button`).first();
  await row.waitFor({ timeout: 15000 });
  if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
}

function projectToken(testInfo) {
  return testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

function uniqueTag(testInfo) {
  return `${projectToken(testInfo)}-${Date.now()}`;
}

// Digits only, no leading zero: the server's serial rule for receipts.
function uniqueSerial() {
  serialCounter += 1;
  return `${Date.now()}${serialCounter}`;
}

function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

// Read one server row through the app's own apiJson; returns the entity data
// with the server revision attached (EntityResponse.lastModified).
async function readEntity(page, collection, id) {
  const row = await page.evaluate(
    ({ collection, id }) => apiJson(`/api/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { method: 'GET' }),
    { collection, id }
  );
  if (!row || typeof row !== 'object' || !row.data) {
    throw new Error(`Unexpected ${collection}/${id} response: ${JSON.stringify(row).slice(0, 300)}`);
  }
  return { ...row.data, _lastModified: row.lastModified };
}

async function pollEntity(page, collection, id, pick, expected, timeout = 15000) {
  await expect.poll(async () => pick(await readEntity(page, collection, id)), { timeout }).toEqual(expected);
  return readEntity(page, collection, id);
}

// What the customer still owes on one receipt: only an unpaid receipt carries
// debt, and company-covered dollars are no longer the customer's to pay.
function receiptOutstandingUSD(receipt) {
  const state = String(receipt.status || '').trim().toLowerCase();
  if (state !== 'not paid' || receipt.isPaid === true) return 0;
  const debt = Number(receipt.debtAmountUSD ?? receipt.amountUSD ?? 0) || 0;
  const covered = Number(receipt.companyCoveredUSD || 0) || 0;
  return Math.round(Math.max(debt - covered, 0) * 100) / 100;
}

async function seedCustomer(page, name, phonePrefix = '091') {
  return page.evaluate(async ({ name, phonePrefix }) => {
    const customer = {
      id: generateId('cust'), name,
      phones: [`${phonePrefix}${Date.now().toString().slice(-7)}`],
      platform: 'Facebook', joinDate: new Date().toISOString(), profileLinks: []
    };
    if (!await addRecord(state.customers, customer)) throw new Error(`Customer seed failed: ${name}`);
    return { id: customer.id, name: customer.name };
  }, { name, phonePrefix });
}

async function seedReceipt(page, receipt) {
  return page.evaluate(async receipt => {
    const row = { id: generateId('receipt'), recordType: 'receipt', createdAt: new Date().toISOString(), ...receipt };
    if (!await addRecord(state.receipts, row)) throw new Error('Receipt seed failed');
    return row.id;
  }, receipt);
}

function unpaidOfficeReceipt(customer, extra = {}) {
  return {
    customerId: customer.id, customerName: customer.name,
    status: 'Not Paid', isPaid: false,
    amountUSD: 120, amountLocal: 600, debtAmountUSD: 120, debtAmountLocal: 600, exchangeRate: 5,
    deliveryStatus: 'Office', statusDetail: { notPaidCollection: 'office' },
    // How the debt is expected to be collected; the edit form reopens with it.
    plannedPayments: [{ method: 'Cash (LYD)', amount: 600, rate: 1, rate2: 5, collectionType: 'office', deliveryPersonId: '' }],
    ...extra
  };
}

function paidOfficeReceipt(customer, extra = {}) {
  const serial = uniqueSerial();
  const now = new Date().toISOString();
  return {
    customerId: customer.id, customerName: customer.name,
    serialNumber: serial, finalReceiptNo: serial,
    status: 'Paid', isPaid: true, paymentMethod: 'Cash (LYD)',
    amountUSD: 100, amountLocal: 500, exchangeRate: 5,
    collected: true, collectionDate: now,
    deliveryStatus: 'Office', isReceivedInOffice: true,
    statusDetail: { paidCollection: 'office' },
    payments: [{ method: 'Cash (LYD)', amount: 500, rate: 1, rate2: 5, collectionType: 'office' }],
    ...extra
  };
}

// The office confirms money actions with window.confirm/prompt. Accept every
// dialog; prompts (forced month close, unlock reason) get a real reason.
function autoAcceptDialogs(page, promptText = REASON) {
  const handler = dialog => {
    dialog.accept(dialog.type() === 'prompt' ? promptText : undefined).catch(() => {});
  };
  page.on('dialog', handler);
  return () => page.off('dialog', handler);
}

// Business calendar of the server (ALBAYAN_BUSINESS_TIMEZONE defaults to
// Africa/Tripoli): only a completed month can be closed.
function previousMonthPeriod() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const year = Number(parts.find(part => part.type === 'year').value);
  const month = Number(parts.find(part => part.type === 'month').value);
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${previous.year}-${String(previous.month).padStart(2, '0')}`;
}

// Create a user through the real admin Users screen (Users -> Add User).
async function createUserViaUi(page, { name, email, password, role }) {
  await page.goto('/users');
  await page.getByRole('button', { name: /add user/i }).click();
  const modal = page.locator('#app-modal');
  await expect(modal).toBeVisible();
  await modal.locator('#user-name').fill(name);
  await modal.locator('#user-email').fill(email);
  await modal.locator('#user-password').fill(password);
  await modal.locator('#user-role').selectOption(role);
  const [response] = await Promise.all([
    page.waitForResponse(r => /\/api\/users\/?(\?|$)/.test(r.url()) && r.request().method() === 'POST'),
    modal.getByRole('button', { name: /create user/i }).click()
  ]);
  const body = await response.text();
  expect(response.ok(), `User creation failed with HTTP ${response.status()}: ${body}`).toBe(true);
  const created = JSON.parse(body);
  expect(created.id).toBeTruthy();
  await expect(modal).toBeHidden();
  return created;
}

// Open one Clothes System tab: deep link first (/clothes-system?tab=...),
// then the real tab-bar button so the tab is active even if the URL restore
// ever changes. Tab labels come from CLOTHES_TABS in clothes.js.
async function openClothesTab(page, tab) {
  const labels = { products: /^products$/i, shipments: /^shipments$/i, orders: /^orders$/i };
  await page.goto(`/clothes-system?tab=${tab}`);
  const tabBar = page.locator('.clothes-tab-bar');
  await expect(tabBar).toBeVisible();
  await tabBar.getByRole('button', { name: labels[tab] }).click();
}

// openClothesTab reloads the page, and the Clothes collections arrive after
// the first paint: a modal opened before the products are in state renders an
// empty product list and never refreshes it (the release gate hit this twice).
async function waitForClothesProduct(page, productId) {
  await page.waitForFunction(
    id => typeof state !== 'undefined' && Array.isArray(state.clothesProducts) && state.clothesProducts.some(p => p && p.id === id),
    productId,
    { timeout: 30_000 }
  );
}

// Open the second browser session (driver / subscriber) with the same base URL
// and business timezone as the project under test.
async function openSecondSession(browser, baseURL) {
  const context = await browser.newContext({ baseURL, locale: 'en-US', timezoneId: 'Africa/Tripoli' });
  const page = await context.newPage();
  return { context, page };
}

// ---------------------------------------------------------------------------
// 1. Driver delivery completion
// ---------------------------------------------------------------------------

test('a delivery driver completes an assigned unpaid receipt and the customer debt clears', async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  await signIn(page);
  const tag = uniqueTag(testInfo);

  // The office creates the driver account on the Users screen.
  const driverPassword = 'E2eDriverPassword123!';
  const driver = await createUserViaUi(page, {
    name: `E2E Driver ${tag}`,
    email: `e2e.driver.${tag}@albayan.example.com`,
    password: driverPassword,
    role: 'Delivery'
  });

  const customer = await seedCustomer(page, `Delivery Customer ${tag}`, '093');
  // An unpaid delivery receipt assigned to the driver. The server issues the
  // temporary D-number itself and requires deliveryPersonId for this shape.
  const receiptId = await seedReceipt(page, {
    customerId: customer.id, customerName: customer.name,
    status: 'Not Paid', isPaid: false,
    amountUSD: 120, amountLocal: 600, debtAmountUSD: 120, debtAmountLocal: 600, exchangeRate: 5,
    deliveryStatus: 'Needs Delivery', deliveryPersonId: driver.id, receiptType: 'DELIVERY_TEMP',
    statusDetail: { notPaidCollection: 'delivery' },
    deliveryPlaceName: `E2E delivery place ${tag}`, quotedDeliveryFee: 20,
    plannedPayments: [{ method: 'Cash (LYD)', amount: 600, rate: 1, rate2: 5, collectionType: 'delivery', deliveryPersonId: driver.id }]
  });
  const before = await pollEntity(page, 'receipts', receiptId, row => row.deliveryStatus, 'Needs Delivery');
  expect(before.tempReceiptNo, 'server should issue a temporary D-number').toMatch(/^D\d+$/);
  expect(receiptOutstandingUSD(before)).toBe(120);

  // The driver works in their own browser session (second context).
  const driverSession = await openSecondSession(browser, baseURL);
  const driverPage = driverSession.page;
  const finalNo = uniqueSerial();
  try {
    await signIn(driverPage, { email: driver.email || `e2e.driver.${tag}@albayan.example.com`, password: driverPassword, requireLiveSync: false });
    await driverPage.goto('/delivery');

    const acceptButton = driverPage.locator(`button[onclick="acceptDelivery('${receiptId}')"]`);
    await expect(acceptButton, 'the assigned delivery should appear on the driver dashboard').toBeVisible({ timeout: 20000 });
    const [acceptResponse] = await Promise.all([
      driverPage.waitForResponse(r => r.url().includes(`/api/collections/receipts/${encodeURIComponent(receiptId)}`) && r.request().method() === 'PATCH'),
      acceptButton.click()
    ]);
    expect(acceptResponse.status(), await acceptResponse.text()).toBe(200);

    const deliveredButton = driverPage.locator(`button[onclick="openReceiptDeliveryCompletionModal('${receiptId}')"]`);
    await expect(deliveredButton).toBeVisible();
    await deliveredButton.click();
    const modal = driverPage.locator('#delivery-complete-modal');
    await expect(modal).toBeVisible();

    await modal.locator('#delivery-final-receipt-no').fill(finalNo);
    const collectedRow = modal.locator('#delivery-collected-payments .payment-split-item').first();
    await collectedRow.locator('.payment-amount').fill('600');
    await collectedRow.locator('.payment-rate1').fill('1');
    await collectedRow.locator('.payment-rate2').fill('5');
    await modal.locator('#delivery-fee-amount').fill('20');

    // Proof photo through the real Upload input (compressed by the app).
    await modal.locator('input[type="file"]').setInputFiles({ name: 'proof.png', mimeType: 'image/png', buffer: Buffer.from(PIXEL_BASE64, 'base64') });
    const photoReady = await driverPage
      .waitForFunction(() => String(document.getElementById('delivery-receipt-image-data')?.dataset?.imageData || '').startsWith('data:image'), null, { timeout: 10000 })
      .then(() => true).catch(() => false);
    if (!photoReady) {
      // Some engines cannot decode the 1x1 fixture through the canvas
      // compressor; fall back to the same field the upload handler writes.
      await driverPage.evaluate(pixel => {
        const hidden = document.getElementById('delivery-receipt-image-data');
        hidden.dataset.imageData = pixel;
        document.getElementById('delivery-receipt-image-preview').src = pixel;
        updateReceiptDeliveryCompletionComputed();
      }, PIXEL);
    }

    const [completeResponse] = await Promise.all([
      driverPage.waitForResponse(r => r.url().includes(`/api/collections/receipts/${encodeURIComponent(receiptId)}`) && r.request().method() === 'PATCH'),
      modal.locator('#delivery-complete-submit').click()
    ]);
    expect(completeResponse.status(), await completeResponse.text()).toBe(200);
    await expect(modal).toHaveCount(0);
  } finally {
    await driverSession.context.close();
  }

  // Server truth, read by the office session.
  const after = await pollEntity(page, 'receipts', receiptId, row => row.deliveryStatus, 'Delivered');
  expect(after.status).toBe('Paid');
  expect(after.isPaid).toBe(true);
  expect(after.finalReceiptNo).toBe(finalNo);
  expect(Number(after.amountCollectedFromCustomer)).toBe(600);
  expect(Number(after.actualDeliveryFeeCollected)).toBe(20);
  expect(after.paymentResult).toBe('PAID_EXACT');
  expect(Number(after.amountUSD)).toBeCloseTo(120, 2);
  expect(after.receiptImage).toMatch(/^data:image\//);
  // The customer's debt on this receipt went from $120 to nothing.
  expect(receiptOutstandingUSD(after)).toBe(0);
});

// ---------------------------------------------------------------------------
// 2. Settle then unsettle an in-shop unpaid receipt
// ---------------------------------------------------------------------------

test('an in-shop unpaid receipt is settled from the receipts screen and later returned to debt', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await signIn(page);
  const tag = uniqueTag(testInfo);
  const customer = await seedCustomer(page, `Settle Customer ${tag}`, '094');
  const receiptId = await seedReceipt(page, unpaidOfficeReceipt(customer));
  await pollEntity(page, 'receipts', receiptId, row => row.status, 'Not Paid');

  // --- Settle: edit the receipt, switch the status tab to Paid, save. ---
  await page.goto('/receipts');
  await expandRow(page, 'receipts', receiptId);
  await page.locator(`button[onclick="editReceipt('${receiptId}')"]`).click();
  const modal = page.locator('#app-modal');
  await expect(modal).toBeVisible();
  await modal.locator('#receipt-status-tabs button[data-status="Paid"]').click();
  const serial = uniqueSerial();
  await modal.locator('#receipt-serial').fill(serial);
  const paymentRow = modal.locator('#receipt-payments-container .payment-split-item').first();
  await paymentRow.locator('.payment-amount').fill('600');
  await paymentRow.locator('.payment-rate1').fill('1');
  await paymentRow.locator('.payment-rate2').fill('5');
  const [settleResponse] = await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/receipts/${encodeURIComponent(receiptId)}/settle`)),
    modal.locator('#receipt-save-btn').click()
  ]);
  expect(settleResponse.status(), await settleResponse.text()).toBe(200);
  await expect(modal).toBeHidden();

  const settled = await pollEntity(page, 'receipts', receiptId, row => row.status, 'Paid');
  expect(settled.isPaid).toBe(true);
  expect(settled.serialNumber).toBe(serial);
  expect(Number(settled.amountUSD)).toBeCloseTo(120, 2);
  expect(settled.collectionDate).toBeTruthy();
  expect(receiptOutstandingUSD(settled)).toBe(0);

  // Fund an ad from the now-paid receipt so the reverse edit has to run the
  // server's /unsettle cascade (paid rows move into the ad's due pool).
  const adId = await page.evaluate(async ({ customerId, receiptId, tag, startDate, endDate }) => {
    const createdAt = new Date().toISOString();
    const pageRow = { id: generateId('page'), name: `Settle Page ${tag}`, category: 'E2E', customerIds: [customerId], createdAt };
    if (!await addRecord(state.pages, pageRow)) throw new Error('Page seed failed');
    const receipt = state.receipts.find(row => row && row.id === receiptId);
    const adId = generateId('ad');
    const mutation = await apiMutateAd({ action: 'create', adId, idempotencyKey: generateId('money'), data: {
      customerId, customerName: receipt?.customerName || '', pageId: pageRow.id, pageName: pageRow.name,
      status: 'Active', paymentStatus: 'paid', exchangeRate: 5, amountUSD: 50, amountLocal: 250,
      startDate, endDate, createdAt, collectionMethod: 'in_shop', receiptId,
      receiptAllocations: [{ receiptId, amountUSD: 50 }],
      notes: 'Disposable E2E fixture; never a real Meta ad.'
    } });
    applyValidatedServerEntityBatch([
      { collection: 'ads', entity: mutation.ad },
      ...mutation.updatedReceipts.map(entity => ({ collection: 'receipts', entity }))
    ], 'money-journeys-seed');
    return adId;
  }, { customerId: customer.id, receiptId, tag, startDate: isoDaysFromNow(0).slice(0, 10), endDate: isoDaysFromNow(7).slice(0, 10) });
  const fundedAd = await readEntity(page, 'ads', adId);
  expect((fundedAd.receiptAllocations || []).some(row => String(row.receiptId) === receiptId)).toBe(true);

  // --- Unsettle: edit again, switch the tab back to Not Paid, confirm, save. ---
  await page.goto('/receipts');
  await expandRow(page, 'receipts', receiptId);
  await page.locator(`button[onclick="editReceipt('${receiptId}')"]`).click();
  await expect(modal).toBeVisible();
  await modal.locator('#receipt-status-tabs button[data-status="Not Paid"]').click();
  const stopDialogs = autoAcceptDialogs(page);
  try {
    const [unsettleResponse] = await Promise.all([
      page.waitForResponse(r => r.url().includes(`/api/receipts/${encodeURIComponent(receiptId)}/unsettle`)),
      modal.locator('#receipt-save-btn').click()
    ]);
    expect(unsettleResponse.status(), await unsettleResponse.text()).toBe(200);
  } finally {
    stopDialogs();
  }
  await expect(modal).toBeHidden();

  const debt = await pollEntity(page, 'receipts', receiptId, row => row.status, 'Not Paid');
  expect(debt.isPaid).toBe(false);
  expect(receiptOutstandingUSD(debt)).toBe(120);
  // The ad's $50 funding moved from the paid pool into its due pool.
  const convertedAd = await pollEntity(page, 'ads', adId, row =>
    (row.dueAllocations || []).filter(item => String(item.receiptId) === receiptId).reduce((sum, item) => sum + Number(item.amountUSD || 0), 0), 50);
  expect(String(convertedAd.paymentStatus || '').toLowerCase().replace(/\s+/g, '_')).toBe('not_paid');
  expect((convertedAd.receiptAllocations || []).filter(item => String(item.receiptId) === receiptId)
    .reduce((sum, item) => sum + Number(item.amountUSD || 0), 0)).toBe(0);
});

// ---------------------------------------------------------------------------
// 3. Transfer paid receipt balance (transfer dialog)
// ---------------------------------------------------------------------------

// NOTE: the app's transfer dialog moves credit from a PAID receipt to ANOTHER
// customer (the server rejects the same customer: "Target customer must be
// different") and creates a TRANSFER_IN receipt for them. So the journey is
// "paid receipt of customer A -> new paid receipt of customer B", and both
// receipts plus the transfer ledger row are verified.
test('paid receipt credit is transferred through the transfer dialog and both receipts balance', async ({ page }, testInfo) => {
  await signIn(page);
  const tag = uniqueTag(testInfo);
  const source = await seedCustomer(page, `Transfer Source ${tag}`, '095');
  const target = await seedCustomer(page, `Transfer Target ${tag}`, '096');
  const sourceReceiptId = await seedReceipt(page, paidOfficeReceipt(source));
  await pollEntity(page, 'receipts', sourceReceiptId, row => row.status, 'Paid');

  await page.goto('/receipts');
  await expandRow(page, 'receipts', sourceReceiptId);
  await page.locator(`button[onclick="showReceiptTransferModal('${sourceReceiptId}')"]`).first().click();
  const modal = page.locator('#app-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('$100.00');
  await modal.locator('#transfer-target-customer').selectOption(target.id);
  await modal.locator('#transfer-amount-usd').fill('40');
  await modal.locator('#transfer-note').fill(`E2E transfer ${tag}`);
  const [transferResponse] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/receipts/transfers') && r.request().method() === 'POST'),
    modal.locator('#receipt-transfer-submit').click()
  ]);
  const transferBody = await transferResponse.text();
  expect(transferResponse.status(), transferBody).toBe(200);
  const transfer = JSON.parse(transferBody);
  const targetReceiptId = transfer.targetReceipt.id;
  await expect(modal).toBeHidden();

  // Ledger on the source receipt.
  const sourceRow = await pollEntity(page, 'receipts', sourceReceiptId, row => (row.transfers || []).length, 1);
  const ledger = sourceRow.transfers[0];
  expect(Number(ledger.amountUSD)).toBeCloseTo(40, 2);
  expect(String(ledger.toCustomerId)).toBe(target.id);
  expect(String(ledger.toReceiptId)).toBe(targetReceiptId);
  expect(sourceRow.status).toBe('Paid');
  expect(Number(sourceRow.amountUSD)).toBeCloseTo(100, 2);

  // The money arrived as a real TRANSFER_IN receipt for the target customer.
  const targetRow = await readEntity(page, 'receipts', targetReceiptId);
  expect(targetRow.receiptType).toBe('TRANSFER_IN');
  expect(String(targetRow.customerId)).toBe(target.id);
  expect(targetRow.status).toBe('Paid');
  expect(targetRow.isPaid).toBe(true);
  expect(Number(targetRow.amountUSD)).toBeCloseTo(40, 2);
  expect(String(targetRow.transferFromReceiptId)).toBe(sourceReceiptId);

  // Remaining spendable balance as the app computes it from server rows.
  const remaining = await page.evaluate(({ sourceReceiptId, targetReceiptId }) => ({
    source: getReceiptUsageStats(state.receipts.find(row => row && row.id === sourceReceiptId)).remainingUSD,
    target: getReceiptUsageStats(state.receipts.find(row => row && row.id === targetReceiptId)).remainingUSD
  }), { sourceReceiptId, targetReceiptId });
  expect(remaining.source).toBeCloseTo(60, 2);
  expect(remaining.target).toBeCloseTo(40, 2);
});

// ---------------------------------------------------------------------------
// 4. Company-funds coverage submitted on an unpaid receipt that funds an ad
// ---------------------------------------------------------------------------

test('company funds coverage is submitted on an unpaid receipt that funds an ad', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await signIn(page);
  const tag = uniqueTag(testInfo);
  const customer = await seedCustomer(page, `Coverage Customer ${tag}`, '097');
  const receiptId = await seedReceipt(page, unpaidOfficeReceipt(customer));
  await pollEntity(page, 'receipts', receiptId, row => row.status, 'Not Paid');

  // An In Shop ad that reserves $50 of this unpaid receipt's debt (due pool).
  // If the ad seed is refused by a stricter server rule the coverage journey
  // still runs on the plain unpaid receipt; the annotation says which happened.
  const adId = await page.evaluate(async ({ customerId, receiptId, tag, startDate, endDate }) => {
    try {
      const createdAt = new Date().toISOString();
      const pageRow = { id: generateId('page'), name: `Coverage Page ${tag}`, category: 'E2E', customerIds: [customerId], createdAt };
      if (!await addRecord(state.pages, pageRow)) throw new Error('Page seed failed');
      const receipt = state.receipts.find(row => row && row.id === receiptId);
      const adId = generateId('ad');
      const mutation = await apiMutateAd({ action: 'create', adId, idempotencyKey: generateId('money'), data: {
        customerId, customerName: receipt?.customerName || '', pageId: pageRow.id, pageName: pageRow.name,
        status: 'Active', paymentStatus: 'not_paid', collectionMethod: 'in_shop', receiptId,
        dueAllocations: [{ receiptId, amountUSD: 50 }], amountUSD: 50, amountLocal: 250, exchangeRate: 5,
        startDate, endDate, createdAt, notes: 'Disposable E2E fixture; never a real Meta ad.'
      } });
      applyValidatedServerEntityBatch([
        { collection: 'ads', entity: mutation.ad },
        ...mutation.updatedReceipts.map(entity => ({ collection: 'receipts', entity }))
      ], 'money-journeys-seed');
      return { adId, error: '' };
    } catch (error) {
      return { adId: '', error: String(error?.message || error) };
    }
  }, { customerId: customer.id, receiptId, tag, startDate: isoDaysFromNow(0).slice(0, 10), endDate: isoDaysFromNow(7).slice(0, 10) });
  testInfo.annotations.push({ type: 'ad-seed', description: adId.adId ? `funded ad ${adId.adId}` : `ad seed skipped: ${adId.error}` });

  await page.goto('/receipts');
  await expandRow(page, 'receipts', receiptId);
  await page.locator(`button[data-receipt-id="${receiptId}"][aria-label^="Cover part"]`).click();
  const dialog = page.locator('#company-debt-coverage-modal');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(customer.name);
  await dialog.locator('#company-coverage-amount').fill('40');
  await dialog.locator('#company-coverage-reason').fill(`E2E company coverage ${tag}`);
  const [coverageResponse] = await Promise.all([
    page.waitForResponse(r => r.url().includes(`/api/receipts/${encodeURIComponent(receiptId)}/company-coverages`)),
    dialog.locator('#company-coverage-submit').click()
  ]);
  const coverageBody = await coverageResponse.text();
  expect(coverageResponse.status(), coverageBody).toBe(200);
  await expect(dialog).toHaveCount(0);

  const covered = await pollEntity(page, 'receipts', receiptId, row => Number(row.companyCoveredUSD || 0), 40);
  // Coverage is a business expense, never a customer payment.
  expect(covered.status).toBe('Not Paid');
  expect(covered.isPaid).toBe(false);
  expect(Number(covered.companyCoverageCount || 0)).toBe(1);
  expect(receiptOutstandingUSD(covered)).toBe(80);
  if (adId.adId) {
    const coverage = JSON.parse(coverageBody);
    expect((coverage.updatedAds || []).some(entity => entity.id === adId.adId), 'the funded ad should be part of the coverage commit').toBe(true);
  }
});

// ---------------------------------------------------------------------------
// 5. Month close, refused edit (423), unlock with a reason
// ---------------------------------------------------------------------------

test('closing a month blocks receipt edits with 423 until an admin unlocks it with a reason', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await signIn(page);
  const tag = uniqueTag(testInfo);
  const period = previousMonthPeriod();
  const customer = await seedCustomer(page, `Closed Month Customer ${tag}`, '098');
  // A paid receipt whose business date sits in the completed month.
  const receiptId = await seedReceipt(page, paidOfficeReceipt(customer, {
    date: `${period}-15`, receiptDate: `${period}-15`,
    createdAt: `${period}-15T10:00:00.000Z`, collectionDate: `${period}-15T10:00:00.000Z`
  }));
  const seeded = await pollEntity(page, 'receipts', receiptId, row => row.status, 'Paid');
  expect(String(seeded.date || seeded.createdAt || '')).toContain(period);

  const stopDialogs = autoAcceptDialogs(page, `E2E forced close ${tag}: leftover fixtures from other specs`);
  try {
    // --- Close the month from the Control Center. ---
    await page.goto('/control-center');
    const periodInput = page.locator('#control-center-period');
    await expect(periodInput).toBeVisible();
    await periodInput.evaluate((input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, period);
    const [closeResponse] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/admin/operations/financial-periods/close')),
      page.getByRole('button', { name: /close month/i }).click()
    ]);
    const closeBody = await closeResponse.text();
    expect(closeResponse.status(), closeBody).toBe(200);
    expect(JSON.parse(closeBody).status).toBe('closed');
    const closedRow = page.locator('.management-closed-periods > div', { hasText: period });
    await expect(closedRow.getByRole('button', { name: /unlock/i })).toBeVisible();

    // --- A later edit of a receipt in that month is refused (HTTP 423). ---
    await page.goto('/receipts');
    await expandRow(page, 'receipts', receiptId);
    await page.locator(`button[onclick="editReceipt('${receiptId}')"]`).click();
    const modal = page.locator('#app-modal');
    await expect(modal).toBeVisible();
    // A paid-keeping edit is committed through /settle; a narrow edit through
    // PATCH. Either write must be refused while the month is closed.
    const [editResponse] = await Promise.all([
      page.waitForResponse(r =>
        (r.url().includes(`/api/receipts/${encodeURIComponent(receiptId)}/settle`) ||
         (r.url().includes(`/api/collections/receipts/${encodeURIComponent(receiptId)}`) && r.request().method() === 'PATCH'))),
      modal.locator('#receipt-save-btn').click()
    ]);
    const editBody = await editResponse.text();
    expect(editResponse.status(), editBody).toBe(423);
    expect(editBody).toContain(period);
    await expect(page.getByText(/is closed/i).first()).toBeVisible();
    await expect(modal).toBeVisible();
    const unchanged = await readEntity(page, 'receipts', receiptId);
    expect(unchanged._lastModified).toBe(seeded._lastModified);

    // --- Unlock with a reason. ---
    await page.goto('/control-center');
    await expect(closedRow.getByRole('button', { name: /unlock/i })).toBeVisible();
    const [unlockResponse] = await Promise.all([
      page.waitForResponse(r => r.url().includes(`/api/admin/operations/financial-periods/${period}/unlock`)),
      closedRow.getByRole('button', { name: /unlock/i }).click()
    ]);
    const unlockBody = await unlockResponse.text();
    expect(unlockResponse.status(), unlockBody).toBe(200);
    const unlocked = JSON.parse(unlockBody);
    expect(unlocked.status).toBe('open');
    expect(String(unlocked.unlockReason || '')).toContain('E2E');
  } finally {
    stopDialogs();
  }

  await expect.poll(async () => {
    const rows = await page.evaluate(() => apiJson('/api/admin/operations/financial-periods', { method: 'GET' }));
    const row = (Array.isArray(rows) ? rows : []).find(item => String(item.period) === period);
    return row ? String(row.status) : 'missing';
  }).toBe('open');
  await expect(page.locator('.management-closed-periods > div', { hasText: period })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 6. Clothes: product -> received shipment -> partially paid order -> price edit -> cancel
// ---------------------------------------------------------------------------

test('clothes stock survives a received shipment, a partially paid order, a price edit and a cancellation', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  // The bootstrap admin holds every subscription automatically, so the
  // Clothes System opens without a paywall.
  await signIn(page);
  const tag = uniqueTag(testInfo);
  const productName = `E2E Shirt ${tag}`;
  const stopDialogs = autoAcceptDialogs(page);
  try {
    // --- Product with one variant (stock arrives with the shipment). ---
    await openClothesTab(page, 'products');
    await page.getByRole('button', { name: /add product/i }).click();
    const modal = page.locator('#app-modal');
    await expect(modal).toBeVisible();
    await modal.locator('#clothes-product-name').fill(productName);
    await modal.locator('#clothes-product-cost').fill('5');
    await modal.locator('#clothes-product-price').fill('60');
    const variantRow = modal.locator('#clothes-variant-rows .clothes-variant-row').first();
    await variantRow.locator('input[type="text"]').nth(0).fill('Black');
    await variantRow.locator('input[type="text"]').nth(1).fill('M');
    await variantRow.locator('input[type="number"]').fill('0');
    const [productResponse] = await Promise.all([
      page.waitForResponse(r => /\/api\/collections\/clothesProducts\/?(\?|$)/.test(r.url()) && r.request().method() === 'POST'),
      modal.locator('button[type="submit"]').click()
    ]);
    const productBody = await productResponse.text();
    expect(productResponse.ok(), productBody).toBe(true);
    const productId = JSON.parse(productBody).id;
    await expect(modal).toBeHidden();
    const product = await readEntity(page, 'clothesProducts', productId);
    expect(product.variants).toHaveLength(1);
    expect(Number(product.variants[0].qty || 0)).toBe(0);
    const stockOf = row => Number((row.variants || [])[0]?.qty || 0);

    // --- Shipment of 10 pieces, received into stock. ---
    await openClothesTab(page, 'shipments');
    await waitForClothesProduct(page, productId);
    await page.getByRole('button', { name: /add shipment/i }).click();
    await expect(modal).toBeVisible();
    await modal.locator('#clothes-shipment-ref').fill(`E2E shipment ${tag}`);
    await modal.locator('#clothes-shipment-supplier').fill('E2E supplier');
    const shipLine = modal.locator('#clothes-ship-lines .clothes-line-row').first();
    await shipLine.locator('select').first().selectOption(productId);
    // Picking the product re-renders the line with its variant list enabled.
    const shipVariant = modal.locator('#clothes-ship-lines .clothes-line-row').first().locator('select').nth(1);
    await expect(shipVariant).toBeEnabled();
    await shipVariant.selectOption('v:0');
    const shipLineAfter = modal.locator('#clothes-ship-lines .clothes-line-row').first();
    await shipLineAfter.locator('input[type="number"]').first().fill('10');
    await shipLineAfter.locator('input[inputmode="decimal"]').first().fill('5');
    const [shipmentResponse] = await Promise.all([
      page.waitForResponse(r => /\/api\/collections\/clothesShipments\/?(\?|$)/.test(r.url()) && r.request().method() === 'POST'),
      modal.locator('button[type="submit"]').click()
    ]);
    const shipmentBody = await shipmentResponse.text();
    expect(shipmentResponse.ok(), shipmentBody).toBe(true);
    const shipmentId = JSON.parse(shipmentBody).id;
    await expect(modal).toBeHidden();

    const shipmentStatus = page.locator(`select[onchange="setClothesShipmentStatus('${shipmentId}', this.value)"]`);
    await expect(shipmentStatus).toBeVisible();
    const [receiveResponse] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/clothes/shipments/mutate')),
      shipmentStatus.selectOption('Received')
    ]);
    expect(receiveResponse.status(), await receiveResponse.text()).toBe(200);
    await pollEntity(page, 'clothesProducts', productId, stockOf, 10);
    const receivedShipment = await readEntity(page, 'clothesShipments', shipmentId);
    expect(receivedShipment.status).toBe('Received');
    expect(receivedShipment.stockApplied).toBe(true);

    // --- Order selling 2 pieces, marked Partially Paid. ---
    await openClothesTab(page, 'orders');
    await waitForClothesProduct(page, productId);
    await page.getByRole('button', { name: /new order/i }).click();
    await expect(modal).toBeVisible();
    await modal.locator('#clothes-order-customer').fill(`E2E Buyer ${tag}`);
    await modal.locator('#clothes-order-phone').fill('0910000000');
    await modal.locator('#clothes-order-lines .clothes-line-row').first().locator('select').first().selectOption(productId);
    const orderVariant = modal.locator('#clothes-order-lines .clothes-line-row').first().locator('select').nth(1);
    await expect(orderVariant).toBeEnabled();
    await orderVariant.selectOption('v:0');
    const orderLine = modal.locator('#clothes-order-lines .clothes-line-row').first();
    await orderLine.locator('input[type="number"]').first().fill('2');
    await orderLine.locator('input[inputmode="decimal"]').first().fill('60');
    await modal.locator('#clothes-order-paystatus').selectOption('Partially Paid');
    await modal.locator('#clothes-order-paid').fill('50');
    const [orderResponse] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/clothes/orders/mutate')),
      modal.locator('button[type="submit"]').click()
    ]);
    const orderBody = await orderResponse.text();
    expect(orderResponse.status(), orderBody).toBe(200);
    const orderId = JSON.parse(orderBody).order.id;
    await expect(modal).toBeHidden();
    await pollEntity(page, 'clothesProducts', productId, stockOf, 8);
    const order = await readEntity(page, 'clothesOrders', orderId);
    expect(order.paymentStatus).toBe('Partially Paid');
    expect(Number(order.amountPaidLYD)).toBe(50);
    expect(order.stockDeducted).toBe(true);

    // --- Editing the product price must succeed while pieces are sold. ---
    await openClothesTab(page, 'products');
    // The order moved the product to a new version on the server. The reloaded page can
    // paint the cached copy first; editing that stale copy is (correctly) a 409 conflict,
    // so wait until the browser holds the version with the sold pieces taken out.
    await page.waitForFunction(
      id => typeof state !== 'undefined' && Array.isArray(state.clothesProducts)
        && state.clothesProducts.some(p => p && p.id === id && Number((p.variants || [])[0]?.qty || 0) === 8),
      productId,
      { timeout: 30_000 }
    );
    await page.locator(`button[onclick="editClothesProduct('${productId}')"]`).click();
    await expect(modal).toBeVisible();
    await modal.locator('#clothes-product-price').fill('75');
    const [priceResponse] = await Promise.all([
      page.waitForResponse(r => r.url().includes(`/api/collections/clothesProducts/${encodeURIComponent(productId)}`) && r.request().method() === 'PATCH'),
      modal.locator('button[type="submit"]').click()
    ]);
    expect(priceResponse.status(), await priceResponse.text()).toBe(200);
    await expect(modal).toBeHidden();
    const repriced = await pollEntity(page, 'clothesProducts', productId, row => Number(row.priceLYD), 75);
    expect(stockOf(repriced), 'a price edit must not touch stock').toBe(8);

    // --- Cancel the order: the 2 pieces return to stock. ---
    await openClothesTab(page, 'orders');
    await waitForClothesProduct(page, productId);
    const orderStatus = page.locator(`select[onchange="setClothesOrderStatus('${orderId}', this.value)"]`);
    await expect(orderStatus).toBeVisible();
    const [cancelResponse] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/clothes/orders/mutate')),
      orderStatus.selectOption('Canceled')
    ]);
    expect(cancelResponse.status(), await cancelResponse.text()).toBe(200);
    await pollEntity(page, 'clothesProducts', productId, stockOf, 10);
    const canceled = await readEntity(page, 'clothesOrders', orderId);
    expect(canceled.status).toBe('Canceled');
    expect(canceled.stockDeducted).toBe(false);
  } finally {
    stopDialogs();
  }
});

// ---------------------------------------------------------------------------
// 7. Wallet top-up and plan purchase
// ---------------------------------------------------------------------------

// NOTE: in server mode the Wallet screen hides the manual admin top-up form
// ("top-ups must come from external funding rails"), so the top-up itself is
// recorded through the app's own WALLET.credit() (the same function the
// hidden form calls). Wallets belong to platform USERS, so the "customer" is
// a subscriber account created on the Users screen. The plan purchase is
// driven through the real paywall sheet in the subscriber's own session.
test('an admin wallet top-up funds a subscriber plan purchase and the ledger balances', async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  await signIn(page);
  const tag = uniqueTag(testInfo);
  const memberPassword = 'E2eMemberPassword123!';
  const memberEmail = `e2e.member.${tag}@albayan.example.com`;
  const member = await createUserViaUi(page, { name: `E2E Member ${tag}`, email: memberEmail, password: memberPassword, role: 'Employee' });

  // Top-ups: $25.00 (USD wallet) and 50.00 LYD (plans are priced in LYD).
  const credits = await page.evaluate(async ({ userId, tag }) => {
    if (!(state.users || []).some(user => user && String(user.id) === userId)) {
      const users = await apiJson('/api/users', { method: 'GET' });
      const created = (Array.isArray(users) ? users : []).find(user => String(user.id) === userId);
      if (created) state.users.push(created);
    }
    const usd = await WALLET.credit(userId, 0, { currency: 'USD', amountMinor: 2500, idempotencyKey: generateId('topup'), memo: `E2E USD top-up ${tag}` });
    const lyd = await WALLET.credit(userId, 0, { currency: 'LYD', amountMinor: 5000, idempotencyKey: generateId('topup'), memo: `E2E LYD top-up ${tag}` });
    return { usdId: usd.id, lydId: lyd.id };
  }, { userId: member.id, tag });
  const usdCredit = await readEntity(page, 'walletTransactions', credits.usdId);
  expect(usdCredit.type).toBe('credit');
  expect(usdCredit.currency).toBe('USD');
  expect(Number(usdCredit.amountMinor)).toBe(2500);
  expect(String(usdCredit.toUserId)).toBe(member.id);
  const lydCredit = await readEntity(page, 'walletTransactions', credits.lydId);
  expect(lydCredit.currency).toBe('LYD');
  expect(Number(lydCredit.amountMinor)).toBe(5000);

  // Give the Clothes System plan a real price (30.00 LYD) so the purchase
  // actually debits the wallet. Restored to its previous price afterwards.
  const PLAN_ID = 'svc:clothes_system';
  const catalog = await page.evaluate(() => apiJson('/api/admin/subscription-plans', { method: 'GET' }));
  const normalizePlan = plan => ({
    id: String(plan.id), serviceIds: Array.isArray(plan.serviceIds) ? plan.serviceIds : [],
    name: String(plan.name || plan.id), nameAr: String(plan.nameAr || plan.name || plan.id),
    priceMinor: Math.max(0, Math.trunc(Number(plan.priceMinor) || 0)), currency: 'LYD',
    durationDays: Math.max(1, Math.min(3660, Math.trunc(Number(plan.durationDays) || 30))),
    badge: plan.badge || null,
    savingsPct: Number.isFinite(Number(plan.savingsPct)) && plan.savingsPct !== null && plan.savingsPct !== '' ? Math.trunc(Number(plan.savingsPct)) : null,
    active: plan.active !== false, sortOrder: Math.trunc(Number(plan.sortOrder) || 0)
  });
  const originalPlans = (Array.isArray(catalog?.plans) ? catalog.plans : []).map(normalizePlan);
  const targetPlan = originalPlans.find(plan => plan.id === PLAN_ID);
  expect(targetPlan, `plan ${PLAN_ID} should exist in the catalog`).toBeTruthy();
  const pricedPlans = originalPlans.map(plan => plan.id === PLAN_ID ? { ...plan, priceMinor: 3000, active: true } : plan);
  const savedCatalog = await page.evaluate(({ plans, version }) => apiAdminSaveSubscriptionPlans(plans, version), { plans: pricedPlans, version: Number(catalog?.version || 0) });
  let catalogVersion = Number(savedCatalog?.version || 0);

  const memberSession = await openSecondSession(browser, baseURL);
  let purchase = null;
  try {
    const memberPage = memberSession.page;
    await signIn(memberPage, { email: memberEmail, password: memberPassword, requireLiveSync: false });
    // The subscriber's ledger must show the 50.00 LYD before the paywall
    // will offer the purchase button.
    await expect.poll(() => memberPage.evaluate(id => WALLET.getBalanceMinor(id, 'LYD'), member.id), { timeout: 20000 }).toBe(5000);
    // The paywall sheet the Smart Systems hub opens for a locked service.
    await memberPage.evaluate(() => showSubscriptionModal('clothes_system', 'clothes_system'));
    const sheet = memberPage.locator('#app-modal');
    await expect(sheet).toBeVisible();
    const subscribeButton = sheet.getByRole('button', { name: /subscribe/i }).first();
    await expect(subscribeButton).toContainText('30.00');
    await expect(sheet).toContainText('50.00');
    await expect(subscribeButton).toBeEnabled();
    const [purchaseResponse] = await Promise.all([
      memberPage.waitForResponse(r => r.url().includes('/api/subscriptions/purchase-plan')),
      subscribeButton.click()
    ]);
    const purchaseBody = await purchaseResponse.text();
    expect(purchaseResponse.status(), purchaseBody).toBe(200);
    purchase = JSON.parse(purchaseBody);
    await expect(sheet).toBeHidden();
    await expect.poll(() => memberPage.evaluate(id => WALLET.getBalanceMinor(id, 'LYD'), member.id), { timeout: 20000 }).toBe(2000);
    expect(await memberPage.evaluate(id => WALLET.getBalanceMinor(id, 'USD'), member.id)).toBe(2500);
  } finally {
    await memberSession.context.close();
    // Put the catalog price back so later specs see the shipped catalog.
    await page.evaluate(({ plans, version }) => apiAdminSaveSubscriptionPlans(plans, version), { plans: originalPlans, version: catalogVersion })
      .then(saved => { catalogVersion = Number(saved?.version || catalogVersion); })
      .catch(() => {});
  }

  // Server ledger: one posted payment of 30.00 LYD and an active subscription.
  expect(purchase.payment, 'a priced plan must produce a payment row').toBeTruthy();
  const payment = await readEntity(page, 'walletTransactions', purchase.payment.id);
  expect(payment.currency).toBe('LYD');
  expect(Number(payment.amountMinor)).toBe(3000);
  expect(String(payment.fromUserId)).toBe(member.id);
  expect(String(payment.status || 'posted')).toBe('posted');
  const subscription = await readEntity(page, 'serviceSubscriptions', purchase.subscriptions[0].id);
  expect(String(subscription.userId)).toBe(member.id);
  expect(subscription.serviceId).toBe('clothes_system');
  expect(String(subscription.status).toLowerCase()).toBe('active');
  expect(new Date(subscription.expiresAt).getTime()).toBeGreaterThan(Date.now());
  // Balances from the admin session's view of the same ledger. Poll like the member view above: one live-sync
  // tick can still be behind the purchase when the machine is busy (seen once: 5000 instead of 2000).
  await expect.poll(() => page.evaluate(async id => {
    if (typeof serverLiveSyncTick === 'function') await serverLiveSyncTick().catch(() => {});
    return `${WALLET.getBalanceMinor(id, 'LYD')}/${WALLET.getBalanceMinor(id, 'USD')}`;
  }, member.id), { timeout: 20000 }).toBe('2000/2500');
});
