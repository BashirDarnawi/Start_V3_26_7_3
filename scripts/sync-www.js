#!/usr/bin/env node
/**
 * Sync the root frontend files into www/ (the folder Capacitor bundles
 * into the Android/iOS apps).
 *
 * Why this exists: the frontend is edited at the project root (index.html,
 * script.js, style.css) because the server serves those files directly.
 * Capacitor, however, packages the copies in www/. Without this script the
 * two drift apart and mobile silently ships old code — which is exactly
 * what had happened before this script was added.
 *
 * Usage:
 *   npm run sync:www      — copy root files into www/
 *   npm run sync:mobile   — copy + push into the native android/ios projects
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');

const FILES = ['index.html', 'script.js', 'style.css'];
// The assets/ folder (prebuilt tailwind.css, fonts, lucide) ships to mobile too.
const ASSET_DIRS = ['assets'];

if (!fs.existsSync(WWW)) {
  console.error('www/ folder not found — run this from the project root.');
  process.exit(1);
}

let changed = 0;

function copyIfChanged(src, dest, label) {
  const srcData = fs.readFileSync(src);
  const same = fs.existsSync(dest) && srcData.equals(fs.readFileSync(dest));
  if (same) {
    console.log(`  unchanged  ${label}`);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`  updated    www/${label} (${srcData.length.toLocaleString()} bytes)`);
    changed++;
  }
}

function copyDirRecursive(relDir) {
  const srcDir = path.join(ROOT, relDir);
  if (!fs.existsSync(srcDir)) {
    console.error(`Missing source folder: ${relDir} — run "npm run build:css" and "node scripts/download-fonts.js" first.`);
    process.exit(1);
  }
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) copyDirRecursive(rel);
    else copyIfChanged(path.join(ROOT, rel), path.join(WWW, rel), rel.replace(/\\/g, '/'));
  }
}

for (const name of FILES) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    console.error(`Missing source file: ${name}`);
    process.exit(1);
  }
  copyIfChanged(src, path.join(WWW, name), name);
}
for (const dir of ASSET_DIRS) copyDirRecursive(dir);

console.log(changed
  ? `Done: ${changed} file(s) updated in www/. Run "npx cap copy" (or npm run sync:mobile) to push into android/ios.`
  : 'Done: www/ already up to date.');
