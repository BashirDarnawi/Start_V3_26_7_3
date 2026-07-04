#!/usr/bin/env node
/**
 * Build script.js from the ordered source files in src/.
 *
 * script.js is a GENERATED file — edit the files in src/ instead, then run:
 *   npm run build:js
 * (and `npm run sync:mobile` to push the result to the mobile apps).
 *
 * The build is a plain concatenation in manifest order. Because every file
 * is a classic (non-module) script fragment cut at top-level boundaries,
 * concatenating them reproduces the app exactly — all functions stay global,
 * which the ~250 inline onclick="..." handlers in the HTML depend on.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'script.js');

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

let out = '';
for (const name of manifest.files) {
  const p = path.join(SRC, name);
  if (!fs.existsSync(p)) {
    console.error(`Missing source file: src/${name}`);
    process.exit(1);
  }
  out += fs.readFileSync(p, 'utf8');
}

// Refuse to clobber manual edits made directly to script.js: if script.js is
// newer than every source file AND differs from the build output, someone
// probably edited the generated file by mistake.
if (fs.existsSync(OUT)) {
  const current = fs.readFileSync(OUT, 'utf8');
  if (current !== out) {
    const outMtime = fs.statSync(OUT).mtimeMs;
    // Include manifest.json itself: a manifest-only change (reorder/add/
    // remove) is a legitimate source change, not a hand-edit of script.js.
    const newestSrc = Math.max(
      fs.statSync(path.join(SRC, 'manifest.json')).mtimeMs,
      ...manifest.files.map(f => fs.statSync(path.join(SRC, f)).mtimeMs)
    );
    if (outMtime > newestSrc + 2000) {
      console.error(
        'REFUSING TO BUILD: script.js is newer than all src/ files but has different content.\n' +
        'It looks like script.js was edited directly. Port those edits into the right src/ file\n' +
        'first (script.js is generated), or delete script.js and re-run to force a build.'
      );
      process.exit(1);
    }
  }
}

fs.writeFileSync(OUT, out);
console.log(`Built script.js from ${manifest.files.length} source files (${out.length.toLocaleString()} bytes).`);
