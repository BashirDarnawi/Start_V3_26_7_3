// "Undo" in a message (redesign round 3, DESIGN.md 7.6): where the app already has a way back, the message
// that confirms an action offers that way back as a button. Checked here with a real server on a receipt
// marked collected: the message offers Undo, pressing it saves "not collected" (what the receipt's own
// button saves), and a reload shows the server kept it.
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

const collected = (page, id) => page.evaluate(receiptId => {
  const receipt = state.receipts.find(row => row.id === receiptId);
  return receipt ? [receipt.collected === true, receipt.collectedAmount ?? null] : null;
}, id);

test('the "Collected" message offers Undo; pressing it marks the receipt not collected again, and the server keeps that', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page);
  const tag = `${testInfo.project.name}-${Date.now()}`;
  const receiptId = await page.evaluate(async label => {
    const customer = { id: generateId('cust'), name: `Undo Customer ${label}`, phones: [`095${Date.now().toString().slice(-7)}`],
      platform: 'Facebook', joinDate: new Date().toISOString(), profileLinks: [] };
    if (!await addRecord(state.customers, customer)) throw new Error('Customer seed failed');
    const receipt = { id: generateId('receipt'), recordType: 'receipt', customerId: customer.id, customerName: customer.name,
      status: 'Paid', paymentStatus: 'Paid', isPaid: true, paymentMethod: 'Cash (LYD)', amountUSD: 20, amountLocal: 100, exchangeRate: 5 };
    if (!await addRecord(state.receipts, receipt)) throw new Error('Receipt seed failed');
    return receipt.id;
  }, tag);
  expect(await collected(page, receiptId)).toEqual([false, null]);

  // Mark it collected the way the receipt's own button does: the question, then "Yes, same".
  await page.evaluate(id => openCollectReceiptModal(id), receiptId);
  const dialog = page.locator('#collect-receipt-modal');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Yes, same/ }).click();
  await expect.poll(() => collected(page, receiptId)).toEqual([true, 100]);
  await expect(dialog).toHaveCount(0);

  // The message says what was recorded, the amount written the one way, and offers the way back.
  const message = page.locator('#notification-container [role="status"]').filter({ hasText: 'Recorded 100.00 LYD' });
  await expect(message).toContainText('Collected');
  const undo = message.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeVisible();
  // Its laid-out height (the message is still gliding in, which shrinks the drawn box for a moment).
  expect(await undo.evaluate(button => button.offsetHeight), 'the Undo button is full height for a finger').toBeGreaterThanOrEqual(44);

  await undo.click();
  await expect.poll(() => collected(page, receiptId)).toEqual([false, null]);
  await expect(message).toHaveCount(0);
  await expect(page.locator('#notification-container').getByText('Receipt marked as not collected')).toBeVisible();
  // The way back's own message offers nothing further.
  await expect(page.locator('#notification-container').getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);

  // What the server holds after a reload.
  await page.reload();
  await page.waitForFunction(id => !!state.currentUser?.id && state.receipts.some(row => row.id === id), receiptId, { timeout: 30000 });
  expect(await collected(page, receiptId)).toEqual([false, null]);
  expect(errors).toEqual([]);
});

test('in Arabic the button reads «تراجع», and a message without a way back has no such button', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page);
  await page.evaluate(() => { if (state.language !== 'ar') toggleLanguage(); });
  const receiptId = await page.evaluate(async label => {
    const customer = { id: generateId('cust'), name: `Undo Arabic ${label}`, phones: [`096${Date.now().toString().slice(-7)}`],
      platform: 'Facebook', joinDate: new Date().toISOString(), profileLinks: [] };
    if (!await addRecord(state.customers, customer)) throw new Error('Customer seed failed');
    const receipt = { id: generateId('receipt'), recordType: 'receipt', customerId: customer.id, customerName: customer.name,
      status: 'Paid', paymentStatus: 'Paid', isPaid: true, paymentMethod: 'Cash (LYD)', amountUSD: 20, amountLocal: 100, exchangeRate: 5 };
    if (!await addRecord(state.receipts, receipt)) throw new Error('Receipt seed failed');
    return receipt.id;
  }, `${testInfo.project.name}-${Date.now()}`);
  await page.evaluate(id => openCollectReceiptModal(id), receiptId);
  await page.locator('#collect-receipt-modal').getByRole('button', { name: /نعم، كما الوصل/ }).click();
  await expect.poll(() => collected(page, receiptId)).toEqual([true, 100]);
  const undo = page.locator('#notification-container').getByRole('button', { name: 'تراجع', exact: true });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect.poll(() => collected(page, receiptId)).toEqual([false, null]);
  await expect(page.locator('#notification-container').getByRole('button', { name: 'تراجع', exact: true })).toHaveCount(0);
  await page.evaluate(() => { if (state.language !== 'en') toggleLanguage(); });
  expect(errors).toEqual([]);
});
