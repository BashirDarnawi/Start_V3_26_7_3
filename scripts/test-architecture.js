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
if (fs.statSync(generatedBundle).size > 2.35 * 1024 * 1024) {
  fail('script.js exceeded the 2.35 MiB startup budget; extract or lazy-load a feature.');
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
