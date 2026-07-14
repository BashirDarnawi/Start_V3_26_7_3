#!/usr/bin/env node
/**
 * Read-only release artifact verification.
 *
 * Default: verify src -> script.js and root frontend -> www.
 * --include-native: additionally verify www -> Android/iOS copied assets.
 *
 * This script intentionally never copies or rewrites a file. If it fails, run
 * `npm run release:prepare`, inspect the diff, and run the check again.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INCLUDE_NATIVE = process.argv.includes('--include-native');
const errors = [];

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
}

function read(file) {
  if (!fs.existsSync(file)) {
    errors.push(`Missing ${rel(file)}`);
    return null;
  }
  return fs.readFileSync(file);
}

function compare(source, target) {
  const sourceData = read(source);
  const targetData = read(target);
  if (!sourceData || !targetData) return;
  if (!sourceData.equals(targetData)) {
    errors.push(
      `${rel(target)} is stale (expected ${digest(sourceData)}, found ${digest(targetData)})`
    );
  }
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) {
    errors.push(`Missing ${rel(dir)}/`);
    return [];
  }
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function compareTree(sourceDir, targetDir) {
  const sourceFiles = listFiles(sourceDir);
  const expected = new Set();
  for (const source of sourceFiles) {
    const name = path.relative(sourceDir, source);
    expected.add(name.replace(/\\/g, '/'));
    compare(source, path.join(targetDir, name));
  }
  if (!fs.existsSync(targetDir)) return;
  for (const target of listFiles(targetDir)) {
    const name = path.relative(targetDir, target).replace(/\\/g, '/');
    if (!expected.has(name)) errors.push(`Unexpected stale artifact ${rel(target)}`);
  }
}

// Verify that the generated root bundle is exactly the ordered source bundle.
const manifestPath = path.join(ROOT, 'src', 'manifest.json');
const manifestData = read(manifestPath);
if (manifestData) {
  let manifest;
  try {
    manifest = JSON.parse(manifestData.toString('utf8'));
  } catch (error) {
    errors.push(`Invalid src/manifest.json: ${error.message}`);
  }
  if (manifest) {
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      errors.push('src/manifest.json must contain a non-empty files array');
    } else {
      const parts = [];
      for (const name of manifest.files) {
        if (typeof name !== 'string') {
          errors.push(`Source manifest entries must be strings: ${JSON.stringify(name)}`);
          continue;
        }
        const normalized = path.posix.normalize(String(name).replace(/\\/g, '/'));
        if (path.isAbsolute(name) || normalized.startsWith('../') || normalized === '..') {
          errors.push(`Unsafe source path in manifest: ${name}`);
          continue;
        }
        const part = read(path.join(ROOT, 'src', normalized));
        if (part) parts.push(part);
      }
      const generated = Buffer.concat(parts);
      const rootBundle = read(path.join(ROOT, 'script.js'));
      if (rootBundle && !generated.equals(rootBundle)) {
        errors.push(
          `script.js is not the current src bundle (expected ${digest(generated)}, found ${digest(rootBundle)})`
        );
      }
    }
  }
}

// Rebuild Tailwind into the operating system's temporary folder so this check
// catches stale CSS without modifying the working tree.
const tailwindCli = path.join(ROOT, 'node_modules', 'tailwindcss', 'lib', 'cli.js');
if (!fs.existsSync(tailwindCli)) {
  errors.push('Missing Tailwind CLI; run npm ci before artifact verification');
} else {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'albayan-css-'));
  const tempCss = path.join(tempDir, 'tailwind.css');
  try {
    const result = spawnSync(process.execPath, [
      tailwindCli,
      '-c', path.join(ROOT, 'tailwind.config.js'),
      '-i', path.join(ROOT, 'tailwind-input.css'),
      '-o', tempCss,
      '--minify',
    ], { cwd: ROOT, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message || result.stderr?.trim() || `exit code ${result.status}`;
      errors.push(`Tailwind verification build failed: ${detail}`);
    } else {
      const generatedCss = read(tempCss);
      const committedCss = read(path.join(ROOT, 'assets', 'tailwind.css'));
      if (generatedCss && committedCss && !generatedCss.equals(committedCss)) {
        errors.push(
          `assets/tailwind.css is stale (expected ${digest(generatedCss)}, found ${digest(committedCss)})`
        );
      }
    }
  } finally {
    if (fs.existsSync(tempCss)) fs.unlinkSync(tempCss);
    fs.rmdirSync(tempDir);
  }
}

const www = path.join(ROOT, 'www');
for (const name of ['index.html', 'script.js', 'style.css']) {
  compare(path.join(ROOT, name), path.join(www, name));
}
compareTree(path.join(ROOT, 'assets'), path.join(www, 'assets'));

if (INCLUDE_NATIVE) {
  const nativeRoots = [
    path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public'),
    path.join(ROOT, 'ios', 'App', 'App', 'public'),
  ];
  for (const nativeRoot of nativeRoots) {
    for (const name of ['index.html', 'script.js', 'style.css']) {
      compare(path.join(www, name), path.join(nativeRoot, name));
    }
    compareTree(path.join(www, 'assets'), path.join(nativeRoot, 'assets'));
  }
}

if (errors.length) {
  console.error(`Artifact verification failed (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error('\nRun npm run release:prepare to rebuild, test, and copy the mobile assets.');
  process.exit(1);
}

console.log(
  INCLUDE_NATIVE
    ? 'Verified source, root, www, Android, and iOS web artifacts.'
    : 'Verified source, root, and www web artifacts.'
);
