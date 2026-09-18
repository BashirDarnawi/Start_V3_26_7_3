// Real-DOM tests of the shared modal decoration. No app backend, account, or
// network is used; original inputs/handlers are compared before and after.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/15-modals.js'), 'utf8');
const helper = source.slice(source.indexOf('function decorateAppModalPanel('), source.indexOf('\nfunction renderModal()'));
if (!helper.startsWith('function decorateAppModalPanel(')) throw new Error('Modal presentation helper missing');
let passed = 0;

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('**/*', route => route.abort());
    async function setup(content, options = {}) {
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app-modal" class="mobile-dialog-overlay app-dialog-overlay fixed inset-0 z-50 flex justify-center p-4"><div id="panel" class="glass-panel app-dialog-panel max-w-lg p-6">${content}</div></div></body></html>`);
      await page.addScriptTag({ content: helper });
      await page.evaluate(options => {
        window.closeCount = 0;
        window.submitCount = 0;
        window.closeModal = () => { window.closeCount += 1; };
        document.querySelector('form')?.addEventListener('submit', event => { event.preventDefault(); window.submitCount += 1; });
        decorateAppModalPanel(document.querySelector('#panel'), options);
      }, { kind: 'customer', isEdit: false, isArabic: false, ...options });
    }
    async function test(name, fn) {
      await fn(); passed += 1; console.log(`  PASS  ${name}`);
    }

    await test('preserves an existing title identity and names the dialog', async () => {
      await setup('<h2 id="kept-title">Edit Customer</h2><form id="modal-form"><input id="customer-name" value="Saved name"></form>');
      assert.equal(await page.locator('#panel').getAttribute('role'), 'dialog');
      assert.equal(await page.locator('#panel').getAttribute('aria-modal'), 'true');
      assert.equal(await page.locator('#panel').getAttribute('aria-labelledby'), 'kept-title');
      assert.equal(await page.getByRole('heading', { name: 'Edit Customer', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).count(), 1);
    });

    await test('receipt forms without a heading receive one localized title only', async () => {
      await setup('<div><label>Phone</label><input id="receipt-phone-search"><h3>Financial details</h3></div>', { kind: 'receipt', isEdit: true, isArabic: true });
      assert.equal(await page.getByRole('heading', { name: 'تعديل وصل', exact: true }).count(), 1);
      assert.equal(await page.locator('#panel').getAttribute('dir'), 'rtl');
      assert.equal(await page.getByRole('button', { name: 'إغلاق', exact: true }).count(), 1);
      assert.equal(await page.locator('h3').textContent(), 'Financial details');
    });

    await test('existing header X is reused, while the footer Cancel remains unchanged', async () => {
      await setup('<header><h2>New Ad</h2><button id="old-close" type="button" onclick="closeModal()"><i data-lucide="x"></i></button></header><form><button id="old-cancel" type="button" onclick="closeModal()">Cancel</button></form>', { kind: 'ad' });
      assert.equal(await page.locator('.app-dialog-close').count(), 1);
      assert.equal(await page.locator('.app-dialog-close').getAttribute('id'), 'old-close');
      assert.equal(await page.locator('#old-cancel').textContent(), 'Cancel');
      assert.equal(await page.locator('#old-cancel').getAttribute('onclick'), 'closeModal()');
      assert.equal(await page.locator('#old-cancel').getAttribute('type'), 'button');
    });

    await test('new close action uses the existing handler without submitting the form', async () => {
      await setup('<form id="modal-form"><h2>Customer</h2><input id="customer-name" value="Name"><button type="submit">Save</button></form>');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => [window.closeCount, window.submitCount]), [1, 0]);
    });

    await test('decoration never changes values, field IDs, money rules, or handlers', async () => {
      const result = await page.evaluate(() => {
        const panel = document.createElement('div');
        panel.innerHTML = '<h2>Receipt</h2><form id="modal-form"><label>Amount</label><input id="amount" value="9.7" inputmode="decimal" oninput="sanitizeMoneyInput(this)" required><select id="payment-status" onchange="keepExisting(this.value)"><option selected value="not_paid">Not paid</option></select><input id="saved-record" type="hidden" value="receipt-old"><button id="submit" type="submit" onclick="existingSave()">Save</button></form>';
        const controls = () => Array.from(panel.querySelectorAll('input, select, button#submit')).map(element => ({
          id: element.id, value: element.value, type: element.getAttribute('type'),
          oninput: element.getAttribute('oninput'), onchange: element.getAttribute('onchange'), onclick: element.getAttribute('onclick'),
          required: element.required, inputmode: element.getAttribute('inputmode')
        }));
        const before = controls();
        decorateAppModalPanel(panel, { kind: 'receipt' });
        return { before, after: controls() };
      });
      assert.deepEqual(result.after, result.before);
    });

    await test('visible adjacent labels associate with fields, without guessing grouped or hidden inputs', async () => {
      await setup('<h2>Fields</h2><label>Name</label><input id="customer-name"><label for="explicit">Keep</label><input id="other"><label id="group-label">Money</label><div><input id="usd"><input id="lyd"></div><label id="hidden-label">Hidden metadata</label><input type="hidden" id="meta">');
      assert.equal(await page.getByLabel('Name', { exact: true }).getAttribute('id'), 'customer-name');
      assert.equal(await page.locator('label[for="explicit"]').count(), 1);
      assert.equal(await page.locator('#group-label').getAttribute('for'), null);
      assert.equal(await page.locator('#hidden-label').getAttribute('for'), null);
    });

    await test('repeated decoration never duplicates titles or close actions', async () => {
      await setup('<h2>Customer</h2><form id="modal-form"><input id="customer-name"></form>');
      await page.evaluate(() => decorateAppModalPanel(document.querySelector('#panel'), { kind: 'customer' }));
      assert.equal(await page.locator('h2').count(), 1);
      assert.equal(await page.locator('.app-dialog-titlebar').count(), 1);
      assert.equal(await page.locator('.app-dialog-close').count(), 1);
    });

    await test('compound navigation action is not mistaken for a Close button', async () => {
      await setup('<h2>No Pages Found</h2><button onclick="closeModal(); navigateTo(\'pages\')">Go to Pages</button>', { kind: 'ad' });
      assert.equal(await page.locator('.app-dialog-close').count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Go to Pages', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Go to Pages', exact: true }).getAttribute('class'), null);
    });

    // Match index.html's real stylesheet order. No ignored local design
    // snippets may influence a permanent regression test or differ in CI.
    const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8')
      + fs.readFileSync(path.join(root, 'assets/tailwind.css'), 'utf8');
    for (const rtl of [false, true]) {
      await test(`phone shell fits 320px with ${rtl ? 'Arabic' : 'English'} heading and accessible touch targets`, async () => {
        await page.setViewportSize({ width: 320, height: 700 });
        await setup(`<h2>${rtl ? 'تعديل معلومات العميل وتفاصيل الحساب المحفوظة' : 'Edit customer information and saved account details'}</h2><form id="modal-form"><label>Name</label><input id="customer-name" class="glass-input w-full"></form>`, { isArabic: rtl });
        await page.addStyleTag({ content: css });
        await expect(page.locator('#customer-name')).toHaveCSS('font-size', '16px');
        const sizes = await page.evaluate(() => {
          const panel = document.querySelector('#panel');
          const close = panel.querySelector('.app-dialog-close');
          const rect = close.getBoundingClientRect();
          return { width: rect.width, height: rect.height, overflow: panel.scrollWidth > panel.clientWidth,
            inputSize: getComputedStyle(panel.querySelector('input')).fontSize };
        });
        assert.ok(sizes.width >= 44 && sizes.height >= 44);
        assert.equal(sizes.overflow, false);
        assert.equal(sizes.inputSize, '16px');
      });
    }

    await test('long form uses the outer phone scroll surface and its final action stays reachable', async () => {
      await page.setViewportSize({ width: 390, height: 420 });
      await setup('<h2>Receipt</h2><form id="modal-form" class="overflow-y-auto" style="max-height:200px"><div style="height:1100px">All existing fields remain here</div><button id="final-save" type="submit">Save receipt</button></form>');
      await page.addStyleTag({ content: css });
      assert.equal(await page.locator('#modal-form').evaluate(element => getComputedStyle(element).maxHeight), 'none');
      assert.equal(await page.locator('#modal-form').evaluate(element => getComputedStyle(element).overflowY), 'visible');
      await page.locator('#final-save').scrollIntoViewIfNeeded();
      const rect = await page.locator('#final-save').boundingBox();
      assert.ok(rect.y >= 0 && rect.y + rect.height <= 420);
    });
    console.log(`\n${passed} shared modal presentation regressions passed.`);
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
