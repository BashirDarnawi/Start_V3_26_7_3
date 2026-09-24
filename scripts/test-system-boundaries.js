#!/usr/bin/env node
'use strict';
// Smart Systems boundary guard for the screens (owner decision D36, docs/SMART_SYSTEMS.md).
// Each system's screen files live in src/systems/<name>/ and are built into that system's own lazy
// bundle. A system may call the platform (startup bundle) but never a function or global declared
// only by another system, and its files never go into the startup bundle.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
// Systems whose screens still live in the src/ root (moved by later tasks).
const NOT_YET_MOVED = { clothes: ['15b-clothes.js'] };

function declaredNames(source) {
  const names = new Set();
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm;
  let m;
  while ((m = re.exec(source))) names.add(m[1] || m[2]);
  return names;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function crossReferences(source, foreignNames) {
  const hits = [];
  const code = stripComments(source);
  for (const name of foreignNames) {
    if (name.length < 6) continue; // short helper names are too generic to attribute
    const escaped = name.replace(/\$/g, '\\$');
    if (new RegExp(`(^|[^\\w$.]|\\b(?:window|globalThis|self)\\.)${escaped}\\b`).test(code)) hits.push(name);
  }
  return hits;
}

function systems() {
  const out = {};
  const dir = path.join(SRC, 'systems');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const folder = path.join(dir, name);
    if (!fs.statSync(folder).isDirectory() || name.startsWith('_')) continue;
    out[name] = fs.readdirSync(folder, { recursive: true }).map(f => String(f).replace(/\\/g, '/'))
      .filter(f => f.endsWith('.js')).map(f => `systems/${name}/${f}`);
  }
  for (const [name, files] of Object.entries(NOT_YET_MOVED)) out[name] = (out[name] || []).concat(files);
  return out;
}

let checks = 0;
function check(label, fn) { fn(); checks += 1; console.log(`  PASS  ${label}`); }

const all = systems();
const startup = new Set(manifest.files);
const lazyFiles = new Set(Object.values(manifest.lazy || {}).flat());
const sources = {};
const declared = {};
for (const [name, files] of Object.entries(all)) {
  sources[name] = files.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  declared[name] = declaredNames(sources[name]);
}

check('every system screen file is in a lazy bundle, never in the startup bundle', () => {
  for (const [name, files] of Object.entries(all)) {
    for (const file of files) {
      assert.ok(!startup.has(file), `${name}: ${file} must not be in the startup bundle`);
      assert.ok(lazyFiles.has(file), `${name}: ${file} is not built into any lazy bundle`);
    }
  }
});

check('each system bundle holds only that system\'s files', () => {
  for (const [bundle, files] of Object.entries(manifest.lazy || {})) {
    const owners = new Set(files.map(f => Object.keys(all).find(name => all[name].includes(f))).filter(Boolean));
    assert.ok(owners.size <= 1, `${bundle} mixes systems: ${[...owners].join(', ')}`);
    // A system's bundle may not pick up a file from outside that system's folder.
    if (owners.size === 1) for (const f of files) assert.ok(all[[...owners][0]].includes(f), `${bundle}: ${f} is outside the system's folder`);
  }
});

check('no system declares a global name that the platform or another system also declares', () => {
  const platform = declaredNames(manifest.files.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n'));
  const problems = [];
  const names = Object.keys(all);
  for (const name of names) {
    for (const n of declared[name]) {
      if (platform.has(n)) problems.push(`${name} redeclares platform global ${n}`);
      for (const other of names) if (other > name && declared[other].has(n)) problems.push(`${name} and ${other} both declare ${n}`);
    }
  }
  assert.deepStrictEqual(problems, []);
});

check('no system calls another system\'s functions or globals', () => {
  const problems = [];
  for (const name of Object.keys(all)) {
    const foreign = new Set();
    for (const other of Object.keys(all)) if (other !== name) for (const n of declared[other]) if (!declared[name].has(n)) foreign.add(n);
    const hits = crossReferences(sources[name], foreign);
    if (hits.length) problems.push(`${name} uses ${hits.join(', ')}`);
  }
  assert.deepStrictEqual(problems, []);
});

check('the guard catches a cross-system call (self-test)', () => {
  assert.deepStrictEqual(crossReferences('function a(){ renderClothesSystemView(); }', new Set(['renderClothesSystemView'])), ['renderClothesSystemView']);
  assert.deepStrictEqual(crossReferences('obj.renderClothesSystemView();', new Set(['renderClothesSystemView'])), []);
  assert.deepStrictEqual(crossReferences('window.renderClothesSystemView();', new Set(['renderClothesSystemView'])), ['renderClothesSystemView']);
  assert.deepStrictEqual(crossReferences('// renderClothesSystemView() was here', new Set(['renderClothesSystemView'])), []);
});

console.log(`\nSmart Systems boundaries: ${checks} passed (${Object.keys(all).join(', ')}).`);
