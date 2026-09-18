// Exercise the real shared submit handler with delayed save boundaries, not
// a live server. An authorized old save may finish; a replacement form must
// never be closed by that old completion.
const assert = require('node:assert/strict');
const loadBrowserSource = require('./helpers/load-browser-source');
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  PASS ${name}`); }
  catch (error) { failed += 1; console.error(`  FAIL ${name}: ${error.message}`); }
}
async function main() {
  for (const [modal, save] of [
    ['clothes-product', 'saveClothesProductFromModal'],
    ['clothes-shipment', 'saveClothesShipmentFromModal'],
    ['clothes-order', 'saveClothesOrderFromModal']
  ]) {
    for (const change of ['none', 'invalid', 'other-modal', 'same-type-new-form', 'same-record-reopened', 'canceled', 'new-session', 'other-user', 'revoked']) {
      await test(`${modal}: ${change}`, async () => {
        const f = loadBrowserSource(); let finish, closed = 0, rendered = 0;
        let form = { id: 'modal-form', instance: 1 };
        f.sandbox.document.getElementById = id => id === 'modal-form' ? form : null;
        f.sandbox.closeModal = () => { closed += 1; f.state.activeModal = null; };
        f.sandbox.render = () => { rendered += 1; };
        f.sandbox[save] = () => new Promise(resolve => { finish = resolve; });
        f.state.activeModal = modal;
        f.state.modalData = change === 'same-record-reopened' ? { id: 'old_record' } : null;
        const running = f.sandbox.handleModalSubmit();
        assert.equal(typeof finish, 'function');
        if (change === 'other-modal') { f.state.activeModal = 'receipt'; form = { instance: 2 }; }
        if (change === 'same-type-new-form' || change === 'same-record-reopened') form = { instance: 2 };
        if (change === 'canceled') { f.state.activeModal = null; form = null; }
        if (change === 'new-session') f.run('_serverLiveSync.sessionEpoch += 1');
        if (change === 'other-user') f.state.currentUser = { id: 'new_admin', role: 'Admin', permissions: {} };
        if (change === 'revoked') f.state.currentUser.role = 'Employee';
        const expectedModal = f.state.activeModal;
        finish(change !== 'invalid'); await running;
        assert.equal(closed, change === 'none' ? 1 : 0);
        assert.equal(rendered, change === 'none' ? 1 : 0);
        assert.equal(f.state.activeModal, change === 'none' ? null : expectedModal);
      });
    }
  }
  console.log(`Clothes submit boundaries: ${passed} passed; ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
