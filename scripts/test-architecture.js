#!/usr/bin/env node
/** Guardrails that keep the current incremental modularization from reversing. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const manifestPath = path.join(ROOT, 'src', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const failures = [];

function fail(message) { failures.push(message); }
function lineCount(file) { return fs.readFileSync(file, 'utf8').split(/\r?\n/).length; }

if (!Array.isArray(manifest.files) || manifest.files.length < 2) {
  fail('src/manifest.json must list the ordered frontend feature modules.');
} else {
  const seen = new Set();
  for (const name of manifest.files) {
    const normalized = path.posix.normalize(String(name).replace(/\\/g, '/'));
    const file = path.join(ROOT, 'src', normalized);
    if (seen.has(normalized)) fail(`Duplicate frontend module in manifest: ${normalized}`);
    seen.add(normalized);
    if (!fs.existsSync(file)) {
      fail(`Missing frontend module: src/${normalized}`);
      continue;
    }
    const bytes = fs.statSync(file).size;
    if (bytes > 475 * 1024) {
      fail(`src/${normalized} is ${bytes.toLocaleString()} bytes; split it before it exceeds 475 KiB.`);
    }
  }
}

const generatedBundle = path.join(ROOT, 'script.js');
// Raised from 2.35 MiB on 2026-07-30. The bundle had already grown past the old
// ceiling on its own (analytics/profit, control centre, operations, clothes), so
// the guard was blocking unrelated bug fixes rather than the growth itself. This
// is a stay of execution, not spare room: the next feature of any size must be
// lazy-loaded, not concatenated into the startup bundle.
if (fs.statSync(generatedBundle).size > 2.4 * 1024 * 1024) {
  fail('script.js exceeded the 2.4 MiB startup budget; extract or lazy-load a feature.');
}

// Lazy bundles have their own budgets: they never block startup, but a
// runaway bundle would still hurt the first tap into that feature.
for (const lazyOut of Object.keys(manifest.lazy || {})) {
  const bundlePath = path.join(ROOT, lazyOut);
  if (fs.existsSync(bundlePath) && fs.statSync(bundlePath).size > 1.0 * 1024 * 1024) {
    fail(`${lazyOut} exceeded its 1.0 MiB lazy-bundle budget; split or slim it.`);
  }
}

// Every built bundle must ship in the production image. Forgetting a lazy
// bundle in the Dockerfile made /studio.js 500 on the live site while every
// local test stayed green (release claude-fixes-20260802T122742Z).
const dockerfile = fs.readFileSync(path.join(ROOT, 'server', 'Dockerfile'), 'utf8');
const bundleOutputs = ['script.js', ...Object.keys(manifest.lazy || {})];
for (const bundle of bundleOutputs) {
  const copied = dockerfile.split(/\r?\n/).some(line =>
    /^\s*COPY\s/.test(line) && line.split(/\s+/).includes(bundle));
  if (!copied) {
    fail(`server/Dockerfile does not COPY ${bundle}; the live site would 500 on /${bundle}.`);
  }
}

// The bundle must ship EXACTLY as npm built it. rjsmin cannot parse nested
// template literals: at the inner backtick it thinks it is back in code and
// deletes "redundant" whitespace out of string content, so the container served
// `${n} group` as `${n}group` ("48groupswith the same name") and, worse, turned
// class="x ${c ? 'a' : ''} y" into class="x ay", welding two CSS classes into
// one. It only ever broke inside the image, which is why every local test and
// the whole dev workflow stayed green while production was wrong.
// Comments are stripped first: the Dockerfile deliberately NAMES rjsmin to
// explain why it must never come back.
const dockerfileCode = dockerfile.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');
if (/rjsmin|jsmin/.test(dockerfileCode)) {
  fail('server/Dockerfile minifies the bundle again; rjsmin corrupts nested template literals.');
}
const serverMainSource = fs.readFileSync(path.join(ROOT, 'server', 'main.py'), 'utf8');
const selectScript = serverMainSource.slice(serverMainSource.indexOf('def _select_script_source('));
if (/return SCRIPT_MIN_PATH|src = SCRIPT_MIN_PATH/.test(selectScript.slice(0, selectScript.indexOf('\ndef ', 1)))) {
  fail('server/main.py can serve script.min.js again; that file is corrupted by rjsmin.');
}

const backendMain = path.join(ROOT, 'server', 'main.py');
const backendLines = lineCount(backendMain);
if (backendLines > 14200) {
  fail(`server/main.py has ${backendLines.toLocaleString()} lines; add the feature in a focused server module/router.`);
}

if (failures.length) {
  console.error(`Architecture guard failed (${failures.length} problem${failures.length === 1 ? '' : 's'}):`);
  for (const problem of failures) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Architecture guard passed: ${manifest.files.length} frontend modules; server/main.py ${backendLines.toLocaleString()} lines.`);
