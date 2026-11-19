// The app's own question box (redesign round 2). The browser's confirm and prompt boxes are gone:
// every "are you sure?" and every "type a value" is asked in the app's own dialog (#app-ask), in the
// app's look and language. This spec drives one real flow that uses both kinds in a row (Audit logs ->
// Cleanup: first the number of days in a field, then the delete question) on every engine and size.
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

async function openAudit(page) {
  await page.evaluate(() => navigateTo('audit'));
  await expect.poll(() => page.evaluate(() => state.currentView)).toBe('audit');
  const cleanup = page.locator('button[onclick="cleanupAuditLogs()"]');
  await expect(cleanup).toBeVisible();
  return cleanup;
}

test('Audit cleanup asks for the days and then for the delete in the app\'s own box; Escape and Cancel stop it, a yes sends it once', async ({ page, isMobile }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let browserBoxes = 0;
  page.on('dialog', dialog => { browserBoxes += 1; dialog.dismiss().catch(() => {}); });
  const cleanups = [];
  page.on('request', request => { if (request.url().includes('/api/audit/cleanup')) cleanups.push(request.postDataJSON()); });

  await signIn(page);
  const cleanup = await openAudit(page);
  const box = page.locator('#app-ask');
  const field = box.locator('#app-ask-input');
  const cancel = box.locator('.management-button-row button').first();
  const yes = box.locator('.management-button-row button').last();

  // --- The question with a field: the suggested value is there and has the focus. Escape answers nothing. ---
  await cleanup.click();
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute('role', 'alertdialog');
  await expect(box).toHaveAttribute('aria-modal', 'true');
  await expect(box.locator('#app-ask-title')).toHaveText('Delete audit logs older than how many days? (default: 365)');
  await expect(field).toHaveValue('365');
  await expect(field).toBeFocused();
  await expect(cancel).toHaveText('Cancel');
  await expect(yes).toHaveText('Confirm');
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  if (!isMobile) await expect(cleanup).toBeFocused();  // the focus goes back to where the question came from

  // --- A typed value, then the delete question: red Delete, the focus on Cancel, Tab stays inside. ---
  await cleanup.click();
  await field.fill('400');
  await yes.click();
  await expect(box.locator('#app-ask-title')).toContainText('Delete all audit logs older than 400 days?');
  await expect(box.locator('#app-ask-text')).toContainText('This action cannot be undone.');
  await expect(field).toHaveCount(0);
  await expect(yes).toHaveText('Delete');
  await expect(yes).toHaveClass(/is-danger/);
  if (!isMobile) {
    await expect(cancel).toBeFocused();  // never the confirming button
    await page.keyboard.press('Tab');
    await expect(yes).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(yes).toBeFocused();
    // The search palette (Ctrl+K) cannot open behind a question.
    await page.keyboard.press('Control+k');
    expect(await page.evaluate(() => !!state.commandPaletteOpen)).toBe(false);
  }
  // The box is on top of everything and is the only thing that takes a tap: a tap beside it answers no.
  const size = page.viewportSize();
  await page.mouse.click(Math.round(size.width / 2), 12);
  await expect(box).toHaveCount(0);
  expect(cleanups, 'Escape, then a tap beside the box: nothing was sent').toEqual([]);

  // --- On a phone the question is a sheet at the bottom of the screen; on a desk a centred window. ---
  await cleanup.click();
  await field.press('Enter');  // Enter in the field confirms the suggested 365
  await expect(yes).toHaveText('Delete');
  const panel = await box.locator('.app-dialog-panel').boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(size.width);
  if (isMobile) expect(size.height - (panel.y + panel.height), 'the sheet sits at the bottom').toBeLessThan(40);
  else expect(Math.abs((panel.x + panel.width / 2) - size.width / 2), 'the window is centred').toBeLessThan(140);

  // --- Cancel sends nothing; a yes sends the cleanup once, with the days that were typed. ---
  await cancel.click();
  await expect(box).toHaveCount(0);
  expect(cleanups).toEqual([]);
  await cleanup.click();
  await field.fill('365');
  await yes.click();
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/audit/cleanup')),
    yes.click()
  ]);
  expect(response.status(), await response.text()).toBe(200);
  await expect(box).toHaveCount(0);
  expect(cleanups).toEqual([{ days_to_keep: 365 }]);

  // --- In Arabic the same box reads right to left, with Arabic buttons. ---
  await page.evaluate(() => toggleLanguage());
  await expect.poll(() => page.evaluate(() => state.language)).toBe('ar');
  const cleanupAr = await openAudit(page);
  await cleanupAr.click();
  await expect(box.locator('.app-dialog-panel')).toHaveAttribute('dir', 'rtl');
  await expect(cancel).toHaveText('إلغاء');
  await expect(yes).toHaveText('تأكيد');
  await cancel.click();
  await expect(box).toHaveCount(0);
  await page.evaluate(() => toggleLanguage());

  expect(browserBoxes, 'no browser confirm/prompt/alert').toBe(0);
  expect(errors).toEqual([]);
});
