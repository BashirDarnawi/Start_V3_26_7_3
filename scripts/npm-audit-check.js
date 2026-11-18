#!/usr/bin/env node
/**
 * The release gate's library check: `npm audit --audit-level=high` with a short, dated list of
 * advisories the owner has explicitly accepted.
 *
 * Every high or critical advisory blocks, exactly as before, unless it is listed in ACCEPTED below
 * AND its acceptance has not expired AND every package it reaches is a build-time tool (dev
 * dependency): an advisory that also reaches something that ships (server, web app, phone plugins)
 * always blocks. An expired entry blocks again, so the exemption cannot be forgotten.
 *
 * Usage: node scripts/npm-audit-check.js            (exit 0 = release may go on)
 *        node scripts/npm-audit-check.js --self-test
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ACCEPTED = {
  // picomatch ReDoS (published 2026-10-19). No fixed picomatch release exists (every version up to
  // 4.0.7 is affected). It is reached only through tailwindcss 3, which builds assets/tailwind.css on
  // the developer machine and in CI; it is not in the server image, the web bundles or the phone app.
  // The only way out today is Tailwind 4, which needs iOS/Safari 16.4 while the iPhone app supports
  // iOS 15. Owner decision 2026-11-18: accept until a fix ships. Remove this entry then.
  'GHSA-fc5q-39xc-vjpf': { until: '2027-02-18', reason: 'build-only (tailwindcss 3), no fixed picomatch release' },
};
const BLOCKING = new Set(['high', 'critical']);

function advisoryId(via) {
  const url = String(via && via.url || '');
  const match = url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i);
  return match ? match[0] : String(via && (via.source || via.title) || 'unknown');
}

/** Pure decision on an `npm audit --json` report. Returns { blocking: [...], accepted: [...] }. */
function evaluate(report, devOnly, today) {
  const vulnerabilities = (report && report.vulnerabilities) || {};
  const advisories = new Map();  // id -> { severity, title, packages:Set }
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    for (const via of entry.via || []) {
      if (typeof via !== 'object' || !via) continue;
      const id = advisoryId(via);
      const record = advisories.get(id) || { severity: via.severity, title: via.title, packages: new Set() };
      record.packages.add(name);
      advisories.set(id, record);
    }
  }
  // A package that only reaches the advisory through another package (anymatch -> picomatch) is
  // affected too: follow the names in `via` back to every package that depends on the flawed one.
  for (const record of advisories.values()) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const [name, entry] of Object.entries(vulnerabilities)) {
        if (record.packages.has(name)) continue;
        if ((entry.via || []).some(via => typeof via === 'string' && record.packages.has(via))) {
          record.packages.add(name);
          grew = true;
        }
      }
    }
  }
  const blocking = [];
  const accepted = [];
  for (const [id, record] of advisories) {
    if (!BLOCKING.has(String(record.severity))) continue;
    const rule = ACCEPTED[id];
    const shipped = [...record.packages].filter(name => !devOnly(name));
    const line = `${id} (${record.severity}) ${record.title} - ${[...record.packages].sort().join(', ')}`;
    if (!rule) blocking.push(line);
    else if (today > rule.until) blocking.push(`${line}  [accepted until ${rule.until}: EXPIRED, check for a fix]`);
    else if (shipped.length) blocking.push(`${line}  [accepted only for build tools, but it reaches shipped package(s): ${shipped.join(', ')}]`);
    else accepted.push(`${line}  [accepted until ${rule.until}: ${rule.reason}]`);
  }
  return { blocking, accepted };
}

function devOnlyFromLockfile(root) {
  let lock = {};
  try { lock = require(path.join(root, 'package-lock.json')); } catch (_) { return () => false; }
  const packages = lock.packages || {};
  const flags = new Map();
  for (const [key, value] of Object.entries(packages)) {
    if (!key.startsWith('node_modules/')) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const dev = value && value.dev === true;
    flags.set(name, flags.has(name) ? flags.get(name) && dev : dev);  // shipped anywhere = shipped
  }
  return name => flags.get(name) === true;
}

function selfTest() {
  const assert = require('assert');
  const report = { vulnerabilities: {
    picomatch: { via: [{ url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf', severity: 'high', title: 'ReDoS' }] },
    anymatch: { via: ['picomatch'] },
    tailwindcss: { via: ['anymatch'] },
    other: { via: [{ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 'New problem' }] },
    lowonly: { via: [{ url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'moderate', title: 'Minor' }] },
  } };
  const dev = name => ['picomatch', 'anymatch', 'tailwindcss', 'other'].includes(name);
  let result = evaluate(report, dev, '2026-11-18');
  assert.equal(result.accepted.length, 1);
  assert.equal(result.blocking.length, 1);
  assert.ok(result.blocking[0].startsWith('GHSA-aaaa-bbbb-cccc'), 'an advisory nobody accepted still blocks');
  result = evaluate(report, dev, '2027-02-19');
  assert.ok(result.blocking.some(line => line.includes('EXPIRED')), 'an expired acceptance blocks again');
  result = evaluate(report, name => name !== 'anymatch' && name !== 'tailwindcss' ? dev(name) : name === 'tailwindcss', '2026-11-18');
  assert.ok(result.blocking.some(line => line.includes('reaches shipped package(s): anymatch')), 'an accepted advisory that reaches a shipped package blocks');
  assert.deepEqual(evaluate({ vulnerabilities: {} }, dev, '2026-11-18'), { blocking: [], accepted: [] });
  console.log('npm audit check self-test: 4 cases passed');
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const root = path.join(__dirname, '..');
  const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let report;
  try { report = JSON.parse(run.stdout || ''); } catch (_) {
    console.error('npm audit did not return a report; refusing to continue.');
    console.error((run.stderr || run.stdout || '').slice(0, 2000));
    process.exit(1);
  }
  if (report.error) {
    console.error(`npm audit failed: ${JSON.stringify(report.error).slice(0, 500)}`);
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const { blocking, accepted } = evaluate(report, devOnlyFromLockfile(root), today);
  for (const line of accepted) console.log(`accepted: ${line}`);
  if (blocking.length) {
    console.error('Dependencies have known high-severity vulnerabilities:');
    for (const line of blocking) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`npm audit check passed: no blocking high or critical advisory (${accepted.length} accepted, see scripts/npm-audit-check.js).`);
}

main();
