const { test, expect } = require('@playwright/test');
const {
  ARABIC,
  PHONE,
  STAFF_SECTIONS,
  addToPilot,
  collectPageErrors,
  createStudioUser,
  expectNoPageOverflow,
  openAdminApi,
  projectToken,
  setLanguage,
  signInStudio
} = require('./helpers/studio-v2');

// The Albayan Studio v2 Team desk (P3-06b/c/d, P3-13, P3-17, M12; src/systems/ads_studio/15p-studio-desk.js and
// 15q-studio-admin.js in the staff-only bundle studio-staff.js) with real server data. Each test seeds its OWN
// customer, reviewer and, where needed, desk admin through the real APIs; the staff join the Team desk pilot
// (staffDesk 'pilot' + staffAllowlist), the shared e2e admin stays classic, and the customer layout is never
// switched on for everyone. Meta is not configured here: the results rows come from the guarded seed door.
//
// The full matrix runs on mobile-chromium at 390 px; desktop-chromium and mobile-webkit run one smoke.
//   npx playwright test tests/e2e/studio-staff.spec.js --project=mobile-chromium

const FULL_MATRIX_PROJECT = 'mobile-chromium';
const BOOT_TIMEOUT = 20_000;
const PULSE_TIMEOUT = 60_000;  // the desk polls the pulse every 20 s (PLAN.md §5.5 J10; the M12 target is 60 s)
const WIDTHS = [320, 360, 390, 412, 820];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP4//8/AAX+Av4zEpUUAAAAAElFTkSuQmCC';
const STUDIO_NAME = /^ALB-S-[A-Z0-9]{6,12} · /;

function fullMatrixOnly(testInfo) {
  test.skip(testInfo.project.name !== FULL_MATRIX_PROJECT, 'The full Team desk matrix runs on mobile-chromium (P2-13)');
}

async function jsonOrThrow(response, label) {
  const body = await response.text();
  if (!response.ok()) throw new Error(`${label} failed with HTTP ${response.status()}: ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : null;
}

function libyaDay(offsetDays) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + offsetDays * 86400000));
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600000).toISOString();
}

function completeRequest(name, extra = {}) {
  return {
    name, objective: 'messages', platforms: ['facebook', 'instagram'], pageName: 'E2E Desk Page',
    primaryText: "Message us for this week's offer.", headline: 'Weekly offer', description: 'A Team desk journey request.',
    callToAction: 'Send Message', destination: 'https://wa.me/218910000000', locations: ['Tripoli, Libya'],
    ageMin: 18, ageMax: 55, genders: ['all'], languages: ['Arabic'], interests: ['Shopping'],
    startDate: libyaDay(30), endDate: libyaDay(36), durationDays: 7, budgetMinorUSD: 2500, budgetType: 'lifetime',
    notes: '', specialAdCategories: ['none'], creativeImages: [PNG], creativeAssetIds: [], ...extra
  };
}

// An API session of one studio user (the browser's own Origin, like the site itself).
async function openUserApi(playwright, baseURL, user) {
  const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } });
  await jsonOrThrow(await api.post('/api/auth/login', { data: { email: user.email, password: user.password } }), `Login of ${user.email}`);
  return api;
}

// A second admin for the desk (the shared e2e admin never joins the pilot).
async function createDeskAdmin(api, tag) {
  const email = `e2e.studio.deskadmin.${tag}@albayan.example.com`;
  const password = 'E2eDeskAdminPassword123!';
  const created = await jsonOrThrow(await api.post('/api/users', { data: { name: `E2E Desk admin ${tag}`.slice(0, 100), email, password, role: 'Admin' } }), `Creating the desk admin ${email}`);
  expect(created.id, 'the desk admin needs an id').toBeTruthy();
  return { id: String(created.id), email, password, kind: 'admin' };
}

// Only the services entries change (the server merges them); the layout switches stay as they are.
async function setServices(api, services) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await jsonOrThrow(await api.get('/api/studio/admin/settings/rollout'), 'Reading the rollout setting');
    const response = await api.put('/api/studio/admin/settings/rollout', { data: { expectedVersion: current.version, value: { services } } });
    if (response.status() === 409) continue;
    const saved = await jsonOrThrow(response, 'Saving the services');
    expect(saved.value.ui, 'the v2 layout stays a pilot').not.toBe('on');
    return saved;
  }
  throw new Error('The rollout setting kept changing while this spec saved it (409 four times)');
}

// One customer with $200.00 and: two requests waiting for review, one approved and not linked, one
// approved, linked and ended (Meta's final read still pending), one approved, linked and never delivered;
// plus a pending LYD payment. A reviewer (and, on request, a desk admin) in the Team desk pilot.
async function seedDesk(playwright, baseURL, testInfo, label, { withAdmin = false, customerPilot = false } = {}) {
  const admin = await openAdminApi(playwright, baseURL);
  const customerApi = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } });
  try {
    const tag = `${label}-${projectToken(testInfo)}-${Date.now()}`;
    const customer = await createStudioUser(admin.api, 'customer', tag);
    const reviewer = await createStudioUser(admin.api, 'reviewer', tag);
    const deskAdmin = withAdmin ? await createDeskAdmin(admin.api, tag) : null;
    // The customer joins the layout pilot too (the shared helper keeps ui at 'pilot'); their browser is never opened here.
    await addToPilot(admin, { staff: [reviewer.id, ...(deskAdmin ? [deskAdmin.id] : [])], customers: [customer.id] });
    if (customerPilot) await setServices(admin.api, { help: 'pilot', stopRequest: 'pilot' });
    await jsonOrThrow(await admin.api.post('/api/wallet/top-ups', {
      data: { userId: customer.id, amountMinor: 20000, currency: 'USD', idempotencyKey: `e2e-desk-topup-${tag}`, memo: 'E2E Team desk journeys' }
    }), 'The USD top-up');
    await jsonOrThrow(await customerApi.post('/api/auth/login', { data: { email: customer.email, password: customer.password } }), 'Customer login');
    const ids = {};
    const create = async (key, name) => {
      const id = `e2e_desk_${key}_${tag}`.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80);
      const created = await jsonOrThrow(await customerApi.post('/api/collections/adCampaignRequests', { data: { id, data: completeRequest(name) } }), `Creating ${key}`);
      ids[key] = id;
      return created;
    };
    const submit = async (key, created) => jsonOrThrow(await customerApi.post(`/api/ad-studio/campaigns/${ids[key]}/submit`, {
      data: { expectedLastModified: created.lastModified, operationId: `e2e-desk-submit-${key}-${tag}` }
    }), `Submitting ${key}`);
    const approve = async (key, submitted) => jsonOrThrow(await admin.api.post(`/api/ad-studio/campaigns/${ids[key]}/review`, {
      data: { expectedLastModified: submitted.lastModified, decision: 'Approved', note: '', operationId: `e2e-desk-review-${key}-${tag}` }
    }), `Approving ${key}`);
    const seedResults = async (key, results) => jsonOrThrow(await admin.api.post('/api/studio/test/seed-results', { data: {
      campaignId: ids[key], link: { metaAdAccountId: '9876543210', metaCampaignId: `12${String(Date.now() + Object.keys(ids).length).slice(-10)}` }, results
    } }), `Seeding Meta results of ${key}`);

    await submit('wait', await create('wait', 'E2E waiting: send back'));
    await submit('wait2', await create('wait2', 'E2E waiting: approve'));
    await approve('approved', await submit('approved', await create('approved', 'E2E approved, not linked')));
    await approve('ended', await submit('ended', await create('ended', 'E2E ended, final read pending')));
    await approve('never', await submit('never', await create('never', 'E2E never delivered')));
    const now = new Date().toISOString();
    // Ended: Meta stopped delivering an hour ago, its spend was confirmed before the 48 h read is due
    // (the results sync stamps settleReadDueAt = deliveryEndedAt + spendDelayHours when delivery ends, P3-03).
    await seedResults('ended', { lastSyncedAt: now, spendMinorUSD: 340, spendConfirmedAt: hoursFromNow(-1), currency: 'USD', insightsState: 'ok', syncState: 'ok',
      campaignEffectiveStatus: 'PAUSED', adStatusCounts: { PAUSED: 1 }, anyAdDelivering: false, campaignStopTime: hoursFromNow(-2), deliveryEndedAt: hoursFromNow(-1), settleReadDueAt: hoursFromNow(47), lifetimeImpressions: 120, neverDelivered: false });
    // Never delivered: 0 impressions and $0 once delivery ended (D28: the whole payment returns at once).
    await seedResults('never', { lastSyncedAt: now, spendMinorUSD: 0, spendConfirmedAt: now, currency: 'USD', insightsState: 'ok', syncState: 'ok',
      campaignEffectiveStatus: 'PAUSED', adStatusCounts: { PAUSED: 1 }, anyAdDelivering: false, campaignStopTime: hoursFromNow(-2), deliveryEndedAt: hoursFromNow(-1), lifetimeImpressions: 0, neverDelivered: true });
    const payment = await jsonOrThrow(await customerApi.post('/api/wallet/payment-requests', {
      data: { amountMinor: 5000, currency: 'LYD', method: 'adfali', idempotencyKey: `e2e-desk-pay-${tag}` }
    }), 'The pending LYD payment');
    return { customer, reviewer, deskAdmin, ids, tag, paymentRef: String((payment.data && payment.data.reference) || '') };
  } finally {
    await customerApi.dispose();
    await admin.api.dispose();
  }
}

// Sign in on the studio door, then open the section by its address on a fresh load (as the other v2
// specs do): the post-login route restore rewrites a deep link to its bare ?tab= once the data has
// loaded (12-views restoreRequestedViewAfterLogin -> updateUrlForView keeps only the tab), so a
// section opened THROUGH the login form can lose its &section= a moment later.
async function openDesk(page, user, section = 'requests') {
  await signInStudio(page, user);
  await expect(page.getByTestId('studio-staff-frame')).toBeVisible({ timeout: BOOT_TIMEOUT });
  await page.goto(`/studio?tab=review&section=${section}`);
  await expect(page.getByTestId('studio-staff-frame')).toBeVisible({ timeout: BOOT_TIMEOUT });
  await expect(page.getByTestId('studio-desk')).toHaveAttribute('data-section', section, { timeout: BOOT_TIMEOUT });
}

async function requestState(playwright, baseURL, id) {
  const admin = await openAdminApi(playwright, baseURL);
  try {
    const entity = await jsonOrThrow(await admin.api.get(`/api/collections/adCampaignRequests/${encodeURIComponent(id)}`), `Reading ${id}`);
    return entity.data || {};
  } finally {
    await admin.api.dispose();
  }
}

test.describe('Team desk (v2 staff frame)', () => {
  test('reviewer: the queue with the pulse badge and title count, the decision box (reason + note, send back), approval through the in-page sheet with the studio name and Copy, the launch list and the classic link sheet, Arabic and 320-820 px', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    test.setTimeout(150_000);
    const seeded = await seedDesk(playwright, baseURL, testInfo, 'review');
    const errors = collectPageErrors(page);
    let nativeDialogs = 0;
    page.on('dialog', dialog => { nativeDialogs += 1; dialog.dismiss().catch(() => {}); });
    await page.setViewportSize(PHONE);
    await openDesk(page, seeded.reviewer);
    for (const id of STAFF_SECTIONS) await expect(page.getByTestId(`studio-staffnav-${id}`)).toBeVisible();
    await expect(page.getByTestId('studio-nav-wallet')).toHaveCount(0);
    const waitCard = page.getByTestId(`studio-desk-request-${seeded.ids.wait}`);
    await expect(waitCard).toBeVisible();
    await expect(waitCard).toContainText('E2E waiting: send back');
    await expect(waitCard).toContainText('$25.00');
    await expect(page.getByTestId(`studio-desk-request-${seeded.ids.wait2}`)).toBeVisible();
    // The pulse: the Requests badge counts the waiting requests and the title carries the team's count.
    await expect(page.getByTestId('studio-desk-badge-requests')).toHaveAttribute('data-count', /^[1-9]\d*$/, { timeout: BOOT_TIMEOUT });
    await expect.poll(() => page.title(), { timeout: BOOT_TIMEOUT }).toMatch(/^\(\d+\+?\) /);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await expectNoPageOverflow(page, `requests at ${width}px`);
    }
    await page.setViewportSize(PHONE);

    // Send back: a reason and a note are required; the customer's request changes.
    await waitCard.click();
    await expect(page.getByTestId('studio-desk-request-detail')).toBeVisible();
    await expect(page.getByTestId('studio-desk-brief')).toContainText("Message us for this week's offer.");
    await expect(page.getByTestId('studio-desk-photos')).toBeVisible();
    await page.getByTestId('studio-desk-changes').click();
    await expect(page.getByTestId('studio-desk-decision-error')).toBeVisible();
    await expect(page.getByTestId('studio-desk-decision-error')).toContainText('Choose a reason');
    await page.getByTestId('studio-desk-reason-creative_quality').click();
    await expect(page.getByTestId('studio-desk-reason-creative_quality')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('studio-desk-note').fill('Please use a brighter photo.');
    await page.getByTestId('studio-desk-changes').click();
    await expect(page.getByTestId('studio-desk-outcome')).toHaveAttribute('data-decision', 'Changes Requested', { timeout: BOOT_TIMEOUT });
    const sentBack = await requestState(playwright, baseURL, seeded.ids.wait);
    expect(sentBack.status).toBe('Changes Requested');
    expect(sentBack.reviewReasonCode).toBe('creative_quality');
    expect(sentBack.reviewNote).toBe('Please use a brighter photo.');

    // Approve: the in-page sheet confirms (money moves), then the studio name with Copy and the way to Launch.
    await page.getByTestId('studio-desk-back-queue').click();
    await expect(page.getByTestId(`studio-desk-request-${seeded.ids.wait}`)).toHaveCount(0);
    await page.getByTestId(`studio-desk-request-${seeded.ids.wait2}`).click();
    await expect(page.getByTestId('studio-desk-decision')).toBeVisible();
    await page.getByTestId('studio-desk-approve').click();
    const sheet = page.getByTestId('studio-desk-sheet-approve');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('$25.00');
    await sheet.getByTestId('studio-desk-sheet-confirm').click();
    await expect(page.getByTestId('studio-desk-outcome')).toHaveAttribute('data-decision', 'Approved', { timeout: BOOT_TIMEOUT });
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId('studio-desk-studio-name')).toHaveText(STUDIO_NAME);
    await expect(page.getByTestId(`studio-desk-copy-${seeded.ids.wait2}`)).toBeVisible();
    const approved = await requestState(playwright, baseURL, seeded.ids.wait2);
    expect(approved.status).toBe('Approved');
    expect(approved.studioName).toMatch(STUDIO_NAME);
    await page.getByTestId('studio-desk-to-launch').click();
    await expect(page.getByTestId('studio-desk')).toHaveAttribute('data-section', 'launch');
    const launchCard = page.getByTestId(`studio-desk-launch-${seeded.ids.wait2}`);
    await expect(launchCard).toBeVisible();
    await expect(launchCard).toContainText(approved.studioName);
    await expect(page.getByTestId(`studio-desk-launch-${seeded.ids.approved}`)).toBeVisible();
    await expect(page.getByTestId(`studio-desk-launch-${seeded.ids.ended}`)).toHaveCount(0);  // linked: not here
    await launchCard.getByTestId(`studio-desk-link-${seeded.ids.wait2}`).click();
    const linkSheet = page.locator(`[data-ads-studio-link-sheet="${seeded.ids.wait2}"]`);
    await expect(linkSheet).toBeVisible();
    await expect(linkSheet.locator('#ads-studio-link-campaign')).toBeVisible();
    await expect(linkSheet.locator('[data-ads-studio-name]')).toHaveText(approved.studioName);
    await linkSheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(linkSheet).toHaveCount(0);

    // Arabic: the desk reads right to left with Arabic labels and no overflow.
    await setLanguage(page, 'ar');
    await expect(page.getByTestId('studio-staff-frame')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('studio-desk-launch-head')).toContainText(ARABIC);
    await page.getByTestId('studio-staffnav-requests').click();
    await expect(page.getByTestId('studio-desk-requests-head')).toContainText('بانتظار المراجعة');
    await expectNoPageOverflow(page, 'requests (AR)');
    expect(nativeDialogs).toBe(0);
    expect(errors).toEqual([]);
  });

  test('settle: the ended list with the countdown to the final Meta read, a refused settle shown from the bilingual 409, and the never-delivered ad settled at once with the full return', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    test.setTimeout(120_000);
    const seeded = await seedDesk(playwright, baseURL, testInfo, 'settle');
    const errors = collectPageErrors(page);
    let nativeDialogs = 0;
    page.on('dialog', dialog => { nativeDialogs += 1; dialog.dismiss().catch(() => {}); });
    await page.setViewportSize(PHONE);
    await openDesk(page, seeded.reviewer, 'settle');
    const ended = page.getByTestId(`studio-desk-settle-${seeded.ids.ended}`);
    const never = page.getByTestId(`studio-desk-settle-${seeded.ids.never}`);
    await expect(ended).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(ended).toHaveAttribute('data-ready', '0');
    await expect(ended.getByTestId('studio-desk-settle-money')).toHaveText('Paid $25.00 · Meta used $3.40 · Return up to $21.60');
    await expect(ended.getByTestId(`studio-desk-countdown-${seeded.ids.ended}`)).toContainText(/Final Meta read in 4[5-7] h \d+ min/);
    await expect(ended.getByTestId(`studio-desk-check-${seeded.ids.ended}`)).toBeVisible();
    await expect(page.getByTestId(`studio-desk-override-${seeded.ids.ended}`)).toHaveCount(0);  // admin only
    await expect(never).toBeVisible();
    await expect(never).toHaveAttribute('data-ready', '1');
    await expect(never).toContainText('Meta never showed this ad');
    await expect(page.getByTestId(`studio-desk-settle-${seeded.ids.approved}`)).toHaveCount(0);  // not ended
    // The Settle badge counts every customer's ended ads (other specs' rows included): at least these two.
    await expect.poll(async () => Number(await page.getByTestId('studio-desk-badge-settle').getAttribute('data-count'))).toBeGreaterThanOrEqual(2);

    // The final read is still pending: the server refuses (409 SETTLE_NOT_READY) and the sheet says so.
    await ended.getByTestId(`studio-desk-finish-${seeded.ids.ended}`).click();
    const sheet = page.getByTestId('studio-desk-sheet-settle');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('studio-desk-refund')).toHaveValue('21.60');
    await sheet.getByTestId('studio-desk-sheet-confirm').click();
    await expect(sheet.getByTestId('studio-desk-sheet-error')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(sheet.getByTestId('studio-desk-sheet-error')).toContainText('The final amount is not ready');
    await sheet.getByTestId('studio-desk-sheet-cancel').click();
    await expect(sheet).toHaveCount(0);
    expect((await requestState(playwright, baseURL, seeded.ids.ended)).status).toBe('Approved');

    // Never delivered: the full $25.00 goes back now.
    await never.getByTestId(`studio-desk-finish-${seeded.ids.never}`).click();
    const sheet2 = page.getByTestId('studio-desk-sheet-settle');
    await expect(sheet2).toBeVisible();
    await expect(sheet2.getByTestId('studio-desk-refund')).toHaveValue('25.00');
    await sheet2.getByTestId('studio-desk-sheet-confirm').click();
    await expect(sheet2).toHaveCount(0, { timeout: BOOT_TIMEOUT });
    await expect(never).toHaveCount(0, { timeout: BOOT_TIMEOUT });
    const settled = await requestState(playwright, baseURL, seeded.ids.never);
    expect(settled.status).toBe('Stopped');
    expect(settled.closeReason).toBe('completed');
    expect(settled.refundMinorUSD).toBe(2500);
    expect(settled.settleBasis).toBe('never_delivered');
    await setLanguage(page, 'ar');
    await expect(ended.getByTestId(`studio-desk-countdown-${seeded.ids.ended}`)).toContainText('قراءة ميتا النهائية');
    await expectNoPageOverflow(page, 'settle (AR)');
    expect(nativeDialogs).toBe(0);
    // The browser logs the expected 409 of the refused settle as a failed resource; nothing else may be logged.
    expect(errors.filter(line => !/409 \(Conflict\).*\/api\/ad-studio\/campaigns\/[^/]+\/stop/.test(line))).toEqual([]);
  });

  test('admin: More lists the tools and every setting; the intake form saves with expectedVersion, a 409 reloads; payments, alerts, diagnostics and the collision report draw from the real routes', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    test.setTimeout(120_000);
    const seeded = await seedDesk(playwright, baseURL, testInfo, 'admin', { withAdmin: true });
    const errors = collectPageErrors(page);
    await page.setViewportSize(PHONE);
    await openDesk(page, seeded.deskAdmin, 'more');
    await expect(page.getByTestId('studio-admin-menu')).toBeVisible({ timeout: BOOT_TIMEOUT });
    for (const key of ['rollout', 'intake', 'capabilities', 'limits', 'settlement', 'hours', 'contact', 'targets', 'thresholds']) {
      await expect(page.getByTestId(`studio-admin-open-settings-${key}`)).toBeVisible();
    }
    await expect(page.getByTestId('studio-admin-count-payments')).toHaveText(/^[1-9]\d*$/, { timeout: PULSE_TIMEOUT });
    await expectNoPageOverflow(page, 'More (admin)');

    // Intake: save with the version that was read; a newer save elsewhere gives 409 and the reload flow.
    await page.getByTestId('studio-admin-open-settings-intake').click();
    const form = page.getByTestId('studio-admin-form-intake');
    await expect(form).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-admin-about')).toBeVisible();
    // The cap is a shared switch of this e2e database: the values stay high (other specs seed many
    // sends a day) and the default (500) is put back at the end.
    const versionBefore = Number(await form.getAttribute('data-version'));
    await page.getByTestId('studio-admin-intake-maxSubmissionsPerDay').fill('450');
    await page.getByTestId('studio-admin-save').click();
    await expect(page.getByTestId('studio-admin-saved')).toHaveAttribute('data-version', String(versionBefore + 1), { timeout: BOOT_TIMEOUT });
    const admin = await openAdminApi(playwright, baseURL);
    let elsewhere;
    try {
      const current = await jsonOrThrow(await admin.api.get('/api/studio/admin/settings/intake'), 'Reading intake');
      expect(current.value.maxSubmissionsPerDay).toBe(450);
      elsewhere = await jsonOrThrow(await admin.api.put('/api/studio/admin/settings/intake', { data: { expectedVersion: current.version, value: { maxSubmissionsPerDay: 460 } } }), 'Saving intake elsewhere');
    } finally {
      await admin.api.dispose();
    }
    await page.getByTestId('studio-admin-intake-maxSubmissionsPerDay').fill('455');
    await page.getByTestId('studio-admin-save').click();
    await expect(page.getByTestId('studio-admin-conflict')).toHaveAttribute('data-code', 'VERSION_CONFLICT', { timeout: BOOT_TIMEOUT });
    await page.getByTestId('studio-admin-reload').click();
    await expect(page.getByTestId('studio-admin-form-intake')).toHaveAttribute('data-version', String(elsewhere.version), { timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-admin-intake-maxSubmissionsPerDay')).toHaveValue('460');
    await expect(page.getByTestId('studio-admin-conflict')).toHaveCount(0);
    // A value outside the range never reaches the server: the form says so in words.
    await page.getByTestId('studio-admin-intake-maxSubmissionsPerDay').fill('0');
    await page.getByTestId('studio-admin-save').click();
    await expect(page.getByTestId('studio-admin-error')).toContainText('must be from 1 to 500');
    await page.getByTestId('studio-back').click();
    await expect(page.getByTestId('studio-admin-menu')).toBeVisible();

    // Payments waiting: the customer's pending LYD request with the classic confirmation buttons.
    await page.getByTestId('studio-admin-open-payments').click();
    await expect(page.getByTestId('studio-admin-payments')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-admin-payments')).toContainText(seeded.paymentRef);
    await expect(page.getByTestId('studio-admin-payments')).toContainText('50.00 LYD');
    await expect(page.getByTestId('studio-admin-payments').getByRole('button', { name: 'Confirm received' }).first()).toBeVisible();
    await expect(page.getByTestId('studio-admin-payment-wait').first()).toBeVisible();
    await page.getByTestId('studio-back').click();

    // Alerts, diagnostics and the collision report.
    await page.getByTestId('studio-admin-open-alerts').click();
    await expect(page.getByTestId('studio-admin-heartbeat')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-admin-alerts').or(page.getByTestId('studio-admin-alerts-empty'))).toBeVisible();
    await page.getByTestId('studio-back').click();
    await page.getByTestId('studio-admin-open-diagnostics').click();
    await expect(page.getByTestId('studio-admin-queues')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-admin-queue-reviews')).toBeVisible();
    await expect(page.getByTestId('studio-admin-capacity')).toContainText('cap 460 a day');
    await expect(page.getByTestId('studio-admin-money')).toBeVisible();
    await expect(page.getByTestId('studio-admin-owed')).toContainText('$');
    await expect(page.getByTestId('studio-admin-gonogo')).toBeVisible();
    await expect(page.getByTestId('studio-admin-baselines')).toBeVisible();
    await expectNoPageOverflow(page, 'diagnostics');
    await page.getByTestId('studio-back').click();
    await page.getByTestId('studio-admin-open-collisions').click();
    await expect(page.getByTestId('studio-admin-collision-counts')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-admin-collision-counts')).toContainText('studio_collision_repair.py');
    expect(await page.getByTestId('studio-desk').innerText()).not.toMatch(/apply/i);
    await setLanguage(page, 'ar');
    await expect(page.getByTestId('studio-admin-head-collisions')).toContainText('تقرير التعارض');
    await expectNoPageOverflow(page, 'collisions (AR)');
    // The intake cap goes back to its default for the specs that run after this one.
    const restore = await openAdminApi(playwright, baseURL);
    try {
      const current = await jsonOrThrow(await restore.api.get('/api/studio/admin/settings/intake'), 'Reading intake');
      await jsonOrThrow(await restore.api.put('/api/studio/admin/settings/intake', { data: { expectedVersion: current.version, value: { maxSubmissionsPerDay: 500 } } }), 'Restoring the intake cap');
    } finally {
      await restore.api.dispose();
    }
    // The browser logs the expected 409 of the conflict flow as a failed resource; nothing else may be logged.
    expect(errors.filter(line => !/409 \(Conflict\).*\/api\/studio\/admin\/settings\/intake/.test(line))).toEqual([]);
  });

  test('a customer stop request reaches an open desk: the Tickets badge turns urgent and the title count grows within the pulse interval', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    test.setTimeout(150_000);
    const seeded = await seedDesk(playwright, baseURL, testInfo, 'pulse', { customerPilot: true });
    await page.setViewportSize(PHONE);
    await openDesk(page, seeded.reviewer, 'tickets');
    await expect(page.getByTestId('studio-staff-tickets')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect.poll(() => page.title(), { timeout: BOOT_TIMEOUT }).toMatch(/^\(\d+\+?\) /);
    const countBefore = Number((await page.title()).match(/^\((\d+)\+?\)/)[1]);
    // Other specs' open stop requests share this database: the proof is the rise the desk observes.
    const stopsBefore = await page.evaluate(() => Number((_studioDesk.pulse.value || {}).stopRequests) || 0);
    const badgeBefore = Number(await page.getByTestId('studio-desk-badge-tickets').getAttribute('data-count').catch(() => null)) || 0;
    const customerApi = await openUserApi(playwright, baseURL, seeded.customer);
    try {
      const reply = await jsonOrThrow(await customerApi.post(`/api/ad-studio/campaigns/${seeded.ids.approved}/stop-request`, { data: { operationId: `e2e-desk-stop-${seeded.tag}`, note: 'Please stop it, the offer ended.' } }), 'The stop request');
      expect(reply.ticket && reply.ticket.number, 'the stop request opens an urgent ticket').toMatch(/^T-/);
    } finally {
      await customerApi.dispose();
    }
    const badge = page.getByTestId('studio-desk-badge-tickets');
    await expect.poll(() => page.evaluate(() => Number((_studioDesk.pulse.value || {}).stopRequests) || 0), { timeout: PULSE_TIMEOUT }).toBeGreaterThan(stopsBefore);
    await expect(badge).toHaveClass(/is-urgent/, { timeout: PULSE_TIMEOUT });
    await expect.poll(async () => Number(await badge.getAttribute('data-count')), { timeout: PULSE_TIMEOUT }).toBeGreaterThan(badgeBefore);
    await expect.poll(async () => Number(((await page.title()).match(/^\((\d+)\+?\)/) || [])[1] || 0), { timeout: PULSE_TIMEOUT }).toBeGreaterThan(countBefore);
    await expect(page.getByTestId('studio-desk')).toHaveAttribute('data-section', 'tickets');  // the desk stays where it was
  });

  test('admin: Acknowledge takes an alert out of the open list through the real route contract (single flight, replay-safe, UNKNOWN_ALERT in words), and Scan money now runs the real scan (a second press within 10 minutes shows the wait)', async ({ page, playwright, baseURL }, testInfo) => {
    fullMatrixOnly(testInfo);
    test.setTimeout(120_000);
    const seeded = await seedDesk(playwright, baseURL, testInfo, 'ack', { withAdmin: true });
    const errors = collectPageErrors(page);
    let nativeDialogs = 0;
    page.on('dialog', dialog => { nativeDialogs += 1; dialog.dismiss().catch(() => {}); });
    await page.setViewportSize(PHONE);
    // The e2e server raises no alert by itself (no jobs loop, no Meta): the list and the acknowledge answer come from
    // the route's own contract (studio_jobs list_alerts_page / acknowledge_alert), the desk code is the real one.
    const alert = id => ({ id, kind: 'stop_request_overdue', labels: { en: 'A stop request has waited longer than the target: pause the ad in Meta now', ar: 'انتظر طلب إيقاف أكثر من الوقت المحدد: أوقف الإعلان في ميتا الآن' }, relatedType: 'adCampaignRequests', relatedId: seeded.ids.ended, ownerId: null, day: libyaDay(0), firstAt: hoursFromNow(-2), lastAt: hoursFromNow(-1), count: 2, customerVisible: false, acknowledgedAt: null, acknowledgedBy: null, channelSentAt: null, details: {} });
    const open = new Map([['alrt_e2e_1', alert('alrt_e2e_1')], ['alrt_e2e_2', alert('alrt_e2e_2')]]);
    const acks = [];
    await page.route('**/api/studio/admin/alerts?**', route => route.fulfill({ json: { alerts: Array.from(open.values()), nextBefore: null, status: 'open', jobs: { enabled: false, late: false, lastTickAt: null } } }));
    await page.route('**/api/studio/admin/alerts/*/ack', route => {
      const id = route.request().url().match(/alerts\/([^/]+)\/ack/)[1];
      acks.push(id);
      if (id === 'alrt_e2e_2') return route.fulfill({ status: 404, json: { detail: { code: 'UNKNOWN_ALERT', message: 'No studio alert has this id' } } });
      const row = open.get(id);
      if (!row) return route.fulfill({ status: 404, json: { detail: { code: 'UNKNOWN_ALERT', message: 'No studio alert has this id' } } });
      open.delete(id);
      return route.fulfill({ json: { alert: { ...row, acknowledgedAt: new Date().toISOString(), acknowledgedBy: seeded.deskAdmin.id }, replay: false } });
    });
    await openDesk(page, seeded.deskAdmin, 'more');
    await expect(page.getByTestId('studio-admin-menu')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await page.getByTestId('studio-admin-open-alerts').click();
    const first = page.locator('[data-testid="studio-admin-alert"][data-id="alrt_e2e_1"]');
    await expect(first).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(first.getByTestId('studio-admin-alert-ack-alrt_e2e_1')).toContainText('Acknowledge');
    await expectNoPageOverflow(page, 'alerts with Acknowledge');
    await first.getByTestId('studio-admin-alert-ack-alrt_e2e_1').click();
    await expect(first).toHaveCount(0, { timeout: BOOT_TIMEOUT });  // the row left the open list
    await expect(page.locator('[data-testid="studio-admin-alert"][data-id="alrt_e2e_2"]')).toBeVisible();
    expect(acks.filter(id => id === 'alrt_e2e_1')).toHaveLength(1);
    // An alert another admin archived: the words of an alert, not of a campaign request; the list is read again.
    await page.getByTestId('studio-admin-alert-ack-alrt_e2e_2').click();
    await expect(page.locator('#notification-container [role="alert"]').filter({ hasText: 'No studio alert has this id. Refresh the page.' }).first()).toBeVisible({ timeout: BOOT_TIMEOUT });
    await page.getByTestId('studio-back').click();

    // Scan money now: the real route (admin, once every 10 minutes), the counts in words, then the wait.
    await page.getByTestId('studio-admin-open-diagnostics').click();
    const scan = page.getByTestId('studio-admin-scan-now');
    await expect(scan).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(scan).toContainText('Scan money now');
    const [scanResponse] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/studio/admin/integrity/scan') && r.request().method() === 'POST'),
      scan.click()
    ]);
    expect(scanResponse.status(), 'the first scan of this admin runs').toBe(200);
    const report = await scanResponse.json();
    expect(report.counts && Number.isInteger(report.counts.total), 'the scan answers the daily report').toBe(true);
    await expect(page.getByTestId('studio-admin-scan-note')).toHaveAttribute('data-total', String(report.counts.total), { timeout: BOOT_TIMEOUT });
    await expect(page.getByTestId('studio-admin-scan-note')).toContainText('Scan done');
    const [second] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/studio/admin/integrity/scan') && r.request().method() === 'POST'),
      scan.click()
    ]);
    expect(second.status(), 'one scan every 10 minutes').toBe(429);
    await expect(page.getByTestId('studio-admin-scan-note')).toContainText(/Please wait/, { timeout: BOOT_TIMEOUT });
    await setLanguage(page, 'ar');
    await expect(page.getByTestId('studio-admin-scan-now')).toContainText('افحص الأموال الآن');
    await expect(page.getByTestId('studio-admin-scan-note')).toContainText(ARABIC);
    await expectNoPageOverflow(page, 'diagnostics with Scan money now (AR)');
    expect(nativeDialogs).toBe(0);
    // The browser logs the mocked 404 and the expected 429 as failed resources; nothing else may be logged.
    expect(errors.filter(line => !/(404 \(Not Found\).*\/api\/studio\/admin\/alerts\/alrt_e2e_2\/ack|429 \(Too Many Requests\).*\/api\/studio\/admin\/integrity\/scan)/.test(line))).toEqual([]);
  });

  test('smoke: a reviewer in the Team desk pilot sees the real queue, opens a request and gets the decision box', async ({ page, playwright, baseURL }, testInfo) => {
    test.skip(testInfo.project.name === FULL_MATRIX_PROJECT, 'The full matrix above covers mobile-chromium');
    test.setTimeout(90_000);
    const seeded = await seedDesk(playwright, baseURL, testInfo, 'smoke');
    const errors = collectPageErrors(page);
    await openDesk(page, seeded.reviewer);
    const card = page.getByTestId(`studio-desk-request-${seeded.ids.wait}`);
    await expect(card).toBeVisible({ timeout: BOOT_TIMEOUT });
    await card.click();
    await expect(page.getByTestId('studio-desk-decision')).toBeVisible();
    await expect(page.getByTestId('studio-desk-reason-other')).toBeVisible();
    await page.getByTestId('studio-staffnav-settle').click();
    await expect(page.getByTestId(`studio-desk-settle-${seeded.ids.never}`)).toBeVisible({ timeout: BOOT_TIMEOUT });
    // WebKit reports the platform's refused data loads of a non-admin (401/403 on /api/users/public and on
    // the collections a reviewer may not read) as page errors rather than console lines; it is the same
    // platform noise the helper already ignores on Chromium.
    expect(errors.filter(line => !/^pageerror: .*\/api\/.* due to access control checks\.$/.test(line))).toEqual([]);
  });
});
