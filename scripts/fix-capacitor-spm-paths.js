#!/usr/bin/env node
/**
 * Capacitor sync can write Windows backslashes into local Swift Package paths
 * when it runs on Windows. Package.swift requires forward slashes, and the
 * backslashes otherwise break the macOS/iOS build in CI.
 */
const fs = require('fs');
const path = require('path');

const packageFile = path.join(__dirname, '..', 'ios', 'App', 'CapApp-SPM', 'Package.swift');
if (!fs.existsSync(packageFile)) process.exit(0);

const before = fs.readFileSync(packageFile, 'utf8');
const after = before.replace(/(\.package\(name:\s*"[^"]+",\s*path:\s*")([^"]+)("\))/g,
  (_match, prefix, localPath, suffix) => prefix + localPath.replace(/\\/g, '/') + suffix);

if (after !== before) {
  fs.writeFileSync(packageFile, after, 'utf8');
  console.log('Normalized local Swift Package paths for macOS/iOS builds.');
} else {
  console.log('Swift Package paths already portable.');
}
