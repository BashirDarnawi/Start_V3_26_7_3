// Real pointer presses with the production CSS and focus-tracking code. No
// backend, app accounts, shared e2e database, forced clicks or synthetic clicks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit, devices, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const init = fs.readFileSync(path.join(root, 'src/17-init.js'), 'utf8');
const start = init.indexOf('(function setupKeyboardOpenTracking()');
const end = init.indexOf('\n})();', start);
if (start < 0 || end < 0) throw new Error('Production keyboard tracking not found');
const keyboard = init.slice(start, end + '\n})();'.length);
const css = ['assets/tailwind.css', 'style.css'].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
let passed = 0, failed = 0;

async function main() {
  for (const [name, engine, options] of [
    ['desktop-chromium', chromium, { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } }],
    ['mobile-chromium', chromium, { ...devices['Pixel 7'], viewport: { width: 412, height: 844 } }],
    ['mobile-webkit', webkit, { ...devices['iPhone 15'], viewport: { width: 412, height: 844 } }]
  ]) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: keyboard });
    const reset = async () => {
      await page.setViewportSize(options.viewport);
      await page.evaluate(() => {
        document.body.className = '';
        document.documentElement.style.removeProperty('--app-visual-height');
        document.body.innerHTML = '<nav class="mobile-bottom-nav"><button>Home</button></nav>';
        window.actions = { cancel: 0, save: 0, close: 0 };
        window.openFixtureModal = () => {
          document.getElementById('app-modal')?.remove();
          const modal = document.createElement('div');
          modal.id = 'app-modal';
          modal.className = 'mobile-dialog-overlay app-dialog-overlay fixed inset-0 z-50 flex items-center justify-center p-4';
          modal.innerHTML = '<div class="glass-panel app-dialog-panel w-full max-w-md"><header class="app-dialog-titlebar"><h2>Add Customer</h2><button id="close" class="app-dialog-close" type="button">Close</button></header><form id="modal-form" style="display:flex;flex-direction:column;gap:16px;min-height:620px"><label for="name">Name</label><input id="name" class="glass-input" value="Existing customer"><label for="phone">Phone</label><input id="phone" class="glass-input" type="tel" value="123"><div style="flex:1">Other existing form fields</div><footer style="display:flex;gap:16px"><button id="save" type="submit" class="flex-1 bg-indigo-600 text-white px-4 py-3 rounded-xl">Save</button><button id="cancel" type="button" class="app-dialog-cancel flex-1 px-4 py-3 rounded-xl">Cancel</button></footer></form></div>';
          document.body.appendChild(modal);
          for (const action of ['cancel', 'close']) modal.querySelector('#' + action).onclick = () => { window.actions[action] += 1; modal.remove(); };
          modal.querySelector('form').onsubmit = event => { event.preventDefault(); window.actions.save += 1; modal.remove(); };
        };
        window.openFixtureModal();
      });
    };
    async function test(label, fn) {
      try { await reset(); await fn(); passed += 1; console.log(`  PASS ${name}: ${label}`); }
      catch (error) { failed += 1; console.error(`  FAIL ${name}: ${label}: ${error.message}`); }
      finally { await page.mouse.up().catch(() => {}); }
    }
    try {
      for (const action of ['cancel', 'save', 'close']) {
        await test(`${action} survives input blur between pointer-down and pointer-up`, async () => {
          await page.locator('#name').focus();
          await expect(page.locator('body')).toHaveClass(/keyboard-open/);
          const before = await page.locator('#' + action).boundingBox();
          await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
          await page.mouse.down();
          // Blur is the normal focus change caused by pressing a button; wait
          // for its actual asynchronous focusout handler before releasing.
          await expect(page.locator('body')).not.toHaveClass(/keyboard-open/);
          const after = await page.locator('#' + action).boundingBox();
          await page.mouse.up();
          assert.equal(await page.evaluate(action => window.actions[action], action), 1,
            `${action} missed: button moved from y=${before.y} to y=${after.y}`);
          assert.ok(Math.abs(before.y - after.y) <= 1, 'button moved during pointer activation');
          await expect(page.locator('#app-modal')).toHaveCount(0);
        });
      }
      await test('field-to-field focus retains keyboard tracking and modal position', async () => {
        await page.locator('#name').focus();
        const before = await page.locator('.app-dialog-panel').boundingBox();
        await page.locator('#phone').focus();
        await expect(page.locator('body')).toHaveClass(/keyboard-open/);
        const after = await page.locator('.app-dialog-panel').boundingBox();
        assert.ok(Math.abs(before.y - after.y) <= 1);
      });
      await test('new modal starts without a previous modal focus latch', async () => {
        const initial = await page.locator('.app-dialog-panel').boundingBox();
        await page.locator('#name').focus();
        await page.evaluate(() => { document.activeElement.blur(); window.openFixtureModal(); });
        await expect(page.locator('body')).not.toHaveClass(/keyboard-open/);
        const reopened = await page.locator('.app-dialog-panel').boundingBox();
        assert.ok(Math.abs(initial.y - reopened.y) <= 1);
        assert.equal(await page.locator('.app-dialog-panel').evaluate(el => el.classList.contains('app-dialog-input-engaged')), false);
      });
      await test('short visual viewport retains scroll access to the Cancel action', async () => {
        await page.setViewportSize({ width: 412, height: 430 });
        await page.locator('#name').focus();
        await page.evaluate(() => document.documentElement.style.setProperty('--app-visual-height', '300px'));
        await page.locator('#cancel').scrollIntoViewIfNeeded();
        const bounds = await page.locator('#cancel').boundingBox();
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 301);
        await page.locator('#cancel').click();
        await expect(page.locator('#app-modal')).toHaveCount(0);
      });
    } finally { await context.close(); await browser.close(); }
  }
  console.log(`Modal keyboard stability: ${passed} passed; ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
