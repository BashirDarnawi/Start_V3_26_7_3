#!/usr/bin/env node
/**
 * Build the app bundles from the ordered source files in src/.
 *
 * script.js (and every lazy bundle like studio.js) is a GENERATED file —
 * edit the files in src/ instead, then run:
 *   npm run build:js
 * (and `npm run sync:mobile` to push the result to the mobile apps).
 *
 * The build is a plain concatenation in manifest order. Because every file
 * is a classic (non-module) script fragment cut at top-level boundaries,
 * concatenating them reproduces the app exactly — all functions stay global,
 * which the ~250 inline onclick="..." handlers in the HTML depend on.
 * Lazy bundles (manifest.lazy) load later via a same-page <script> tag;
 * classic-script globals are shared, so cross-bundle calls behave exactly
 * as under one concatenation once the lazy bundle has executed.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

const bundles = [
  { out: 'script.js', files: manifest.files },
  ...Object.entries(manifest.lazy || {}).map(([out, files]) => ({ out, files })),
];

// A source file in two bundles would redeclare its top-level let/const at
// load time (SyntaxError) — refuse before writing anything.
const seen = new Map();
for (const bundle of bundles) {
  for (const name of bundle.files) {
    if (seen.has(name)) {
      console.error(`Source file src/${name} appears in both ${seen.get(name)} and ${bundle.out}.`);
      process.exit(1);
    }
    seen.set(name, bundle.out);
  }
}

for (const bundle of bundles) {
  const outPath = path.join(ROOT, bundle.out);
  let out = '';
  for (const name of bundle.files) {
    const p = path.join(SRC, name);
    if (!fs.existsSync(p)) {
      console.error(`Missing source file: src/${name}`);
      process.exit(1);
    }
    out += fs.readFileSync(p, 'utf8');
  }

  // Refuse to clobber manual edits made directly to the generated file: if it
  // is newer than every source file AND differs from the build output, someone
  // probably edited the generated file by mistake.
  if (fs.existsSync(outPath)) {
    const current = fs.readFileSync(outPath, 'utf8');
    if (current !== out) {
      const outMtime = fs.statSync(outPath).mtimeMs;
      // Include manifest.json itself: a manifest-only change (reorder/add/
      // remove) is a legitimate source change, not a hand-edit of the output.
      const newestSrc = Math.max(
        fs.statSync(path.join(SRC, 'manifest.json')).mtimeMs,
        ...bundle.files.map(f => fs.statSync(path.join(SRC, f)).mtimeMs)
      );
      if (outMtime > newestSrc + 2000) {
        console.error(
          `REFUSING TO BUILD: ${bundle.out} is newer than all its src/ files but has different content.\n` +
          `It looks like ${bundle.out} was edited directly. Port those edits into the right src/ file\n` +
          `first (it is generated), or delete ${bundle.out} and re-run to force a build.`
        );
        process.exit(1);
      }
    }
  }

  fs.writeFileSync(outPath, out);
  // Report BYTES (what the size budget measures), not JS string length —
  // Arabic text is 2 bytes per character in UTF-8.
  const bytes = Buffer.byteLength(out, 'utf8');
  console.log(`Built ${bundle.out} from ${bundle.files.length} source file(s) (${bytes.toLocaleString()} bytes).`);
}
