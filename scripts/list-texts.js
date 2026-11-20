#!/usr/bin/env node
// One list of every English/Arabic text the app shows (redesign round 4, finding B-14).
//
// The app's words are written where they are used, in more than 4,000 places of src/. This script reads the
// source files named in src/manifest.json, finds every text that has an Arabic side, and writes
//   docs/app-texts.csv   every pair once: English, Arabic, how often, in which files
//   docs/APP_TEXTS.md    the numbers, the same English written with different Arabic, and the Arabic texts
//                        that have no English beside them in the code
// so wording can be read and reviewed in one place. Nothing in the app reads these two files.
//
//   node scripts/list-texts.js           writes the two files            (npm run texts)
//   node scripts/list-texts.js --check   fails when they are out of date (npm run test:texts; `npm test` checks
//                                        the same thing inside scripts/test-review-regressions.js)
//
// How a text is recognised (no parser is installed; the reader below knows strings, templates, comments and
// regular expressions, which is enough to walk this code base):
//   1. cond ? 'عربي' : 'English'            either order; one side with Arabic letters, the other without
//   2. someText('English', 'عربي')          two neighbouring texts in a call or a list, the second one Arabic
//   3. { label: 'English', labelAr: 'عربي' }  a property and its ...Ar partner, or en: / ar:
//   4. { 'English': 'عربي' }                a table whose values are Arabic (the key is the English)
//   5. translations = { en: {...}, ar: {...} }  joined by key
//   6. the permission texts: Arabic in src/12b1-permission-text-ar.js, English in src/04-permissions.js, same keys
// An Arabic text none of these explains is listed on its own, and so is one whose English side is empty
// (isAr ? 'نص' : ''), so the list leaves nothing out and counts no empty text as English.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CSV_FILE = path.join(ROOT, 'docs', 'app-texts.csv');
const MD_FILE = path.join(ROOT, 'docs', 'APP_TEXTS.md');
const ARABIC = /[\u0600-\u06FF]/;
const LATIN = /[A-Za-z]/;

// ------------------------------------------------------------------ reading JavaScript

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
// After one of these a "/" starts a regular expression, not a division.
const BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '&&', '||', '??', '===', '!==', '==', '!=',
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const PUNCT3 = ['===', '!==', '...', '**=', '<<=', '>>=', '&&=', '||=', '??='];
const PUNCT2 = ['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '&=', '|=', '^='];

function unescapeText(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g, (_, seq) => {
    if (seq[0] === 'u' && seq[1] === '{') return String.fromCodePoint(parseInt(seq.slice(2, -1), 16));
    if (seq[0] === 'u' && seq.length === 5) return String.fromCharCode(parseInt(seq.slice(1), 16));
    if (seq[0] === 'x' && seq.length === 3) return String.fromCharCode(parseInt(seq.slice(1), 16));
    if (seq === 'n') return '\n';
    if (seq === 't') return '\t';
    if (seq === 'r') return '';
    if (seq[0] === '\n' || seq[0] === '\r') return '';
    return seq;
  });
}

// source[from..] up to `until` (a closing "}" of a template expression, or the end): a flat list of tokens.
//   { t: 'str', text, line }                      a quoted text
//   { t: 'tpl', text, parts: [tokens...], line }  a template; text keeps each ${...} (shortened when long)
//   { t: 'id', v, line }  { t: 'num', v }  { t: 'p', v, line }  { t: 're' }
function readTokens(source, from, lineAt, untilBrace) {
  const tokens = [];
  let i = from;
  let depth = 0;
  const n = source.length;
  const last = () => tokens[tokens.length - 1];
  const regexAllowed = () => {
    const prev = last();
    if (!prev) return true;
    if (prev.t === 'p') return BEFORE_REGEX.has(prev.v) && prev.v !== '}' ? true : prev.v === '}' ? false : BEFORE_REGEX.has(prev.v);
    if (prev.t === 'id') return BEFORE_REGEX.has(prev.v);
    return false;
  };
  while (i < n) {
    const ch = source[i];
    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); i = end < 0 ? n : end; continue; }
    if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && source[j] !== ch) { if (source[j] === '\\') j++; if (source[j] === '\n') break; j++; }
      tokens.push({ t: 'str', text: unescapeText(source.slice(i + 1, j)), line: lineAt(i) });
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      const start = i;
      let text = '';
      const parts = [];
      let j = i + 1;
      while (j < n && source[j] !== '`') {
        if (source[j] === '\\') { text += source.slice(j, j + 2); j += 2; continue; }
        if (source[j] === '$' && source[j + 1] === '{') {
          const inner = readTokens(source, j + 2, lineAt, true);
          parts.push(inner.tokens);
          const expr = source.slice(j + 2, inner.end).replace(/\s+/g, ' ').trim();
          text += expr.length <= 28 && !/[`'"]/.test(expr) ? `\${${expr}}` : '${…}';
          j = inner.end + 1;
          continue;
        }
        text += source[j];
        j++;
      }
      tokens.push({ t: 'tpl', text: unescapeText(text), parts, line: lineAt(start) });
      i = j + 1;
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        j++;
      }
      j++;
      const bodyEnd = j;
      while (j < n && /[a-z]/i.test(source[j])) j++;
      tokens.push({ t: 're', v: source.slice(i, bodyEnd), line: lineAt(i) });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(source[j])) j++;
      tokens.push({ t: 'id', v: source.slice(i, j), line: lineAt(i) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(source[j])) j++;
      tokens.push({ t: 'num', v: source.slice(i, j), line: lineAt(i) });
      i = j;
      continue;
    }
    if (untilBrace && ch === '}' && depth === 0) return { tokens, end: i };
    if (OPENERS.has(ch)) depth++;
    else if (CLOSERS.has(ch)) depth--;
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    // "?." is optional chaining only when no digit follows ("a ?.5 : b" is a ternary).
    const v = PUNCT3.includes(three) ? three : (PUNCT2.includes(two) && !(two === '?.' && /[0-9]/.test(source[i + 2] || '')) ? two : ch);
    tokens.push({ t: 'p', v, line: lineAt(i) });
    i += v.length;
  }
  return { tokens, end: n };
}

// ------------------------------------------------------------------ finding the texts

const isText = token => !!token && (token.t === 'str' || token.t === 'tpl');
const hasArabic = token => isText(token) && ARABIC.test(token.text);
const isPunct = (token, v) => !!token && token.t === 'p' && token.v === v;

// A branch of a ternary, or one argument: its texts in order and its shape with the texts taken out.
function describe(tokens) {
  const texts = tokens.filter(isText);
  const shape = tokens.map(token => (isText(token) ? '"' : token.t === 'id' || token.t === 'num' ? token.v : token.t === 'p' ? token.v : '/')).join(' ');
  return { texts, shape };
}

// The end (exclusive) of the expression that starts at `start`: the first ",", ";", ":" or closing bracket at
// depth 0. `stopAtColon`: a ternary's first branch ends at its own ":" (nested ternaries are counted).
function expressionEnd(tokens, start, stopAtColon) {
  let depth = 0;
  let questions = 0;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.t !== 'p') continue;
    if (OPENERS.has(token.v)) depth++;
    else if (CLOSERS.has(token.v)) { if (depth === 0) return i; depth--; }
    else if (depth === 0) {
      if (token.v === '?') questions++;
      else if (token.v === ':') { if (questions === 0) return i; questions--; if (stopAtColon && questions < 0) return i; }
      else if (token.v === ',' || token.v === ';') return i;
    }
  }
  return tokens.length;
}

function collect(tokens, file, found, used = new Set()) {
  const add = (en, ar, kind) => {
    // An empty English side ("isAr ? 'نص' : ''") is no English: the Arabic is listed on its own.
    if (!en.some(token => token.text.trim())) { for (const token of en) used.add(token); return; }
    for (const token of [...en, ...ar]) used.add(token);
    found.pairs.push({ en: en.map(token => token.text).join(' … '), ar: ar.map(token => token.text).join(' … '), file, line: (ar[0] || en[0]).line, kind });
    if (en.length === 1 && ar.length === 1) zipParts(en[0], ar[0], kind);
  };
  // Two paired templates: the choices written inside them (`${late ? 'متأخر' : 'في وقته'}`) pair up part by part
  // when both sides are built the same way.
  const zipParts = (en, ar, kind) => {
    if (en.t !== 'tpl' || ar.t !== 'tpl' || en.parts.length !== ar.parts.length) return;
    en.parts.forEach((part, index) => {
      const a = describe(part);
      const b = describe(ar.parts[index]);
      if (a.shape !== b.shape || a.texts.length !== b.texts.length) return;
      a.texts.forEach((token, at) => {
        const other = b.texts[at];
        if (used.has(token) || used.has(other) || hasArabic(token)) return;
        if (hasArabic(other)) add([token], [other], kind);
        else { used.add(token); used.add(other); zipParts(token, other, kind); }
      });
    });
  };
  const pairBranches = (first, second, kind) => {
    const a = describe(first);
    const b = describe(second);
    if (!a.texts.length || !b.texts.length) return false;
    const aArabic = a.texts.some(hasArabic);
    const bArabic = b.texts.some(hasArabic);
    if (aArabic === bArabic) return false;
    const [ar, en] = aArabic ? [a, b] : [b, a];
    // An "Arabic" side that also holds a text in Latin letters is two languages in one branch (a text function
    // inside a choice): it is not a language choice, unless both sides are built the same way.
    const latinOnly = token => !hasArabic(token) && LATIN.test(token.text.replace(/\$\{[^}]*\}/g, '').replace(/<[^>]*>/g, ''));
    if (ar.texts.some(latinOnly) && !(ar.shape === en.shape && ar.texts.length === en.texts.length)) return false;
    // The same shape on both sides (a nested choice, a text joined to a value): text by text.
    if (ar.shape === en.shape && ar.texts.length === en.texts.length && ar.texts.length > 1) {
      ar.texts.forEach((token, index) => { if (hasArabic(token)) add([en.texts[index]], [token], kind); else { used.add(token); used.add(en.texts[index]); } });
    } else add(en.texts, ar.texts, kind);
    return true;
  };

  // 3. { label: 'English', labelAr: 'عربي' } and { en: '…', ar: '…' }  (first: a property is not an argument)
  const property = index => (tokens[index] && (tokens[index].t === 'id' || tokens[index].t === 'str') && isPunct(tokens[index + 1], ':') && isText(tokens[index + 2])
    && (isPunct(tokens[index + 3], ',') || isPunct(tokens[index + 3], '}')) ? { name: tokens[index].t === 'id' ? tokens[index].v : tokens[index].text, value: tokens[index + 2] } : null);
  for (let i = 0; i < tokens.length; i++) {
    const prop = property(i);
    if (!prop || !hasArabic(prop.value) || used.has(prop.value)) continue;
    const base = prop.name === 'ar' ? 'en' : /Ar$/.test(prop.name) ? prop.name.slice(0, -2) : /_ar$/.test(prop.name) ? prop.name.slice(0, -3) : '';
    if (!base) continue;
    // its partner: the nearest property of that name in the same object (searching both ways, inside the braces)
    let partner = null;
    for (const step of [-1, 1]) {
      let depth = 0;
      for (let j = i + step; j >= 0 && j < tokens.length && !partner; j += step) {
        const token = tokens[j];
        if (token.t === 'p') {
          if ((step < 0 && CLOSERS.has(token.v)) || (step > 0 && OPENERS.has(token.v))) depth++;
          else if ((step < 0 && OPENERS.has(token.v)) || (step > 0 && CLOSERS.has(token.v))) { if (depth === 0) break; depth--; }
        }
        if (depth !== 0) continue;
        const other = property(j);
        if (other && (other.name === base || other.name === `${base}En` || other.name === `${base}_en`) && !hasArabic(other.value) && !used.has(other.value)) partner = other;
      }
      if (partner) break;
    }
    if (partner) add([partner.value], [prop.value], 'property');
  }

  // 2. two neighbouring texts, the second one Arabic: someText('English', 'عربي'), ['English', 'عربي']
  // (before the choices: a text function inside a choice is read as itself, not as a branch)
  for (let i = 0; i + 2 < tokens.length; i++) {
    const en = tokens[i];
    const ar = tokens[i + 2];
    if (!isText(en) || !isPunct(tokens[i + 1], ',') || !hasArabic(ar) || hasArabic(en) || used.has(en) || used.has(ar)) continue;
    const before = tokens[i - 1];
    const after = tokens[i + 3];
    if (!(isPunct(before, '(') || isPunct(before, ',') || isPunct(before, '[')) || !(isPunct(after, ')') || isPunct(after, ',') || isPunct(after, ']'))) continue;
    add([en], [ar], 'pair');
  }
  // 1. cond ? A : B   (from the last one back, so a choice inside another choice is read first)
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!isPunct(tokens[i], '?')) continue;
    const colon = expressionEnd(tokens, i + 1, true);
    if (!isPunct(tokens[colon], ':')) continue;
    const end = expressionEnd(tokens, colon + 1, false);
    const first = tokens.slice(i + 1, colon);
    const second = tokens.slice(colon + 1, end);
    if (first.some(token => used.has(token)) || second.some(token => used.has(token))) continue;
    pairBranches(first, second, 'choice');
  }

  // …and the same with each side a joined expression: text(`a ${x}` + more, `ع ${x}` + more), kept simple: a call
  // with exactly two arguments, each holding texts, one side Arabic.
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i].t !== 'id' || !isPunct(tokens[i + 1], '(')) continue;
    const firstEnd = expressionEnd(tokens, i + 2, false);
    if (!isPunct(tokens[firstEnd], ',')) continue;
    const secondEnd = expressionEnd(tokens, firstEnd + 1, false);
    if (!isPunct(tokens[secondEnd], ')')) continue;
    const first = tokens.slice(i + 2, firstEnd);
    const second = tokens.slice(firstEnd + 1, secondEnd);
    if (first.some(token => used.has(token)) || second.some(token => used.has(token))) continue;
    if (describe(first).texts.some(hasArabic)) continue;  // the English comes first in such a call
    pairBranches(first, second, 'pair');
  }

  // 2b. a row that starts with a pattern for the server's own words: [/^pattern/, 'عربي', …, 'English shown instead'].
  // The English is the last text of the row without Arabic, or the pattern itself when the row has none.
  for (let i = 0; i + 3 < tokens.length; i++) {
    if (!isPunct(tokens[i], '[') || tokens[i + 1].t !== 're' || !isPunct(tokens[i + 2], ',') || !hasArabic(tokens[i + 3]) || used.has(tokens[i + 3])) continue;
    const end = expressionEnd(tokens, i + 1, false) < tokens.length ? (() => { let depth = 0; for (let j = i + 1; j < tokens.length; j++) { const token = tokens[j]; if (token.t !== 'p') continue; if (OPENERS.has(token.v)) depth++; else if (CLOSERS.has(token.v)) { if (depth === 0) return j; depth--; } } return tokens.length; })() : tokens.length;
    const rest = tokens.slice(i + 4, end).filter(token => isText(token) && !hasArabic(token) && token.text.trim() && !used.has(token));
    const english = rest[rest.length - 1];
    used.add(tokens[i + 3]);
    if (english) used.add(english);
    found.pairs.push({ en: english ? english.text : `(the server's words: ${tokens[i + 1].v})`, ar: tokens[i + 3].text, file, line: tokens[i + 3].line, kind: 'server words' });
    if (english) zipParts(english, tokens[i + 3], 'server words');
  }

  // 4. a table of translations: { 'English': 'عربي', Other: 'آخر' } (at least two such lines in one object)
  const tableLines = [];
  for (let i = 0; i < tokens.length; i++) {
    const prop = property(i);
    if (prop && hasArabic(prop.value) && !used.has(prop.value) && !ARABIC.test(prop.name)) tableLines.push({ index: i, prop });
  }
  for (const line of tableLines) {
    const neighbours = tableLines.filter(other => Math.abs(other.index - line.index) <= 40).length;
    if (neighbours >= 2 && LATIN.test(line.prop.name)) {
      used.add(line.prop.value);
      found.pairs.push({ en: line.prop.name, ar: line.prop.value.text, file, line: line.prop.value.line, kind: 'table' });
    }
  }

  // Templates hold code of their own.
  for (const token of tokens) {
    if (token.t !== 'tpl') continue;
    for (const part of token.parts) collect(part, file, found, used);
  }
  for (const token of tokens) {
    if (!hasArabic(token)) continue;
    found.arabic++;
    found.seen.push(token.text);
    if (used.has(token)) continue;
    found.alone.push({ ar: token.text, file, line: token.line });
  }
}

// 5. translations = { en: { key: '…' }, ar: { key: '…' } }: joined by key.
function collectDictionary(tokens, file, found) {
  const start = tokens.findIndex((token, index) => token.t === 'id' && token.v === 'translations' && isPunct(tokens[index + 1], '=') && isPunct(tokens[index + 2], '{'));
  if (start < 0) return new Set();
  const maps = {};
  const taken = new Set();
  let depth = 0;
  let language = '';
  for (let i = start + 2; i < tokens.length; i++) {
    const token = tokens[i];
    if (isPunct(token, '{')) { depth++; continue; }
    if (isPunct(token, '}')) { depth--; if (depth === 1) language = ''; if (depth === 0) break; continue; }
    if (depth === 1 && token.t === 'id' && isPunct(tokens[i + 1], ':') && isPunct(tokens[i + 2], '{')) { language = token.v; maps[language] = maps[language] || new Map(); continue; }
    if (depth === 2 && language && (token.t === 'id' || token.t === 'str') && isPunct(tokens[i + 1], ':') && isText(tokens[i + 2])) {
      maps[language].set(token.t === 'id' ? token.v : token.text, tokens[i + 2]);
    }
  }
  if (!maps.en || !maps.ar) return taken;
  for (const [key, arabic] of maps.ar) {
    const english = maps.en.get(key);
    taken.add(arabic);
    if (english) taken.add(english);
    found.pairs.push({ en: english && english.text.trim() ? english.text : `(${key})`, ar: arabic.text, file, line: arabic.line, kind: 'dictionary' });
    found.arabic++;
    found.seen.push(arabic.text);
  }
  return taken;
}

// 6. The permission texts live in two tables with the same keys: English in PERMISSION_MODULES and
// PERMISSION_TEMPLATES (04-permissions.js), Arabic in PERMISSION_TEXT_AR (12b1-permission-text-ar.js, loaded
// later to keep the start-up file small). Both are plain data, so they are read as data and joined by key.
const PERMISSION_AR_FILE = '12b1-permission-text-ar.js';
function collectPermissions(found) {
  const literalOf = (source, name) => {
    const at = source.indexOf(`const ${name} = {`);
    if (at < 0) return null;
    const open = source.indexOf('{', at);
    return source.slice(open, readTokens(source, open + 1, () => 0, true).end + 1);
  };
  let english;
  let arabic;
  try {
    const source = fs.readFileSync(path.join(ROOT, 'src', '04-permissions.js'), 'utf8');
    english = vm.runInNewContext(`var PERMISSION_MODULES = ${literalOf(source, 'PERMISSION_MODULES')}; var PERMISSION_TEMPLATES = ${literalOf(source, 'PERMISSION_TEMPLATES')}; ({ modules: PERMISSION_MODULES, templates: PERMISSION_TEMPLATES })`);
    arabic = vm.runInNewContext(`${fs.readFileSync(path.join(ROOT, 'src', PERMISSION_AR_FILE), 'utf8')}\n;PERMISSION_TEXT_AR`);
  } catch (_) { return false; }
  if (!english || !arabic) return false;
  const push = (en, ar) => { if (typeof ar === 'string' && ARABIC.test(ar)) { found.arabic++; found.seen.push(ar); if (typeof en === 'string' && en) found.pairs.push({ en, ar, file: PERMISSION_AR_FILE, line: 0, kind: 'permissions' }); else found.alone.push({ ar, file: PERMISSION_AR_FILE, line: 0 }); } };
  for (const [key, pair] of Object.entries(arabic.modules || {})) { const module = english.modules[key] || {}; push(module.name, pair[0]); push(module.description, pair[1]); }
  for (const [key, pair] of Object.entries(arabic.perms || {})) {
    const [moduleKey, permKey] = key.split('.');
    const perm = ((english.modules[moduleKey] || {}).permissions || {})[permKey] || {};
    push(perm.label, pair[0]); push(perm.description, pair[1]);
  }
  for (const [key, pair] of Object.entries(arabic.templates || {})) { const template = english.templates[key] || {}; push(template.name, pair[0]); push(template.description, pair[1]); }
  for (const [group, entries] of Object.entries(arabic)) {
    if (['modules', 'perms', 'templates'].includes(group)) continue;
    // a group this script does not know yet: its Arabic is listed on its own rather than left out
    JSON.stringify(entries, (_, value) => { if (typeof value === 'string' && ARABIC.test(value)) { found.arabic++; found.seen.push(value); found.alone.push({ ar: value, file: PERMISSION_AR_FILE, line: 0 }); } return value; });
  }
  return true;
}

// One source text: its pairs and its Arabic texts on their own are added to `found`.
function scanSource(source, file = '(text)', found = { pairs: [], alone: [], seen: [], arabic: 0, files: 1 }) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const lineAt = offset => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; } return lo + 1; };
  const { tokens } = readTokens(source, 0, lineAt, false);
  const taken = collectDictionary(tokens, file, found);
  collect(tokens.filter(token => !taken.has(token)), file, found);
  return found;
}

// Nothing is left out: every Arabic text read from the source is in a pair or listed on its own.
function proveComplete(found) {
  const listed = new Set(found.alone.map(item => item.ar));
  for (const pair of found.pairs) for (const part of pair.ar.split(' … ')) listed.add(part);
  const missing = found.seen.filter(text => !listed.has(text));
  if (missing.length) throw new Error(`list-texts.js left out ${missing.length} Arabic text(s), for example: ${missing[0].slice(0, 80)}`);
  return found;
}

function scan() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'manifest.json'), 'utf8'));
  const files = [...manifest.files, ...Object.values(manifest.lazy).flat()];
  const found = { pairs: [], alone: [], seen: [], arabic: 0, files: files.length };
  const permissionsJoined = collectPermissions(found);
  for (const file of files) {
    if (file === PERMISSION_AR_FILE && permissionsJoined) continue;
    scanSource(fs.readFileSync(path.join(ROOT, 'src', file), 'utf8'), file, found);
  }
  return proveComplete(found);
}

// ------------------------------------------------------------------ writing the list

const clean = text => String(text).replace(/[\u2066-\u2069\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();
const cell = text => `"${String(text).replace(/"/g, '""')}"`;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function build() {
  const found = scan();
  const pairs = new Map();
  for (const pair of found.pairs) {
    const en = clean(pair.en);
    const ar = clean(pair.ar);
    if (!ar) continue;
    const key = `${en}\u0000${ar}`;
    if (!pairs.has(key)) pairs.set(key, { en, ar, count: 0, files: new Set() });
    const entry = pairs.get(key);
    entry.count++;
    entry.files.add(pair.file);
  }
  const rows = [...pairs.values()].sort((a, b) => byText(a.en.toLowerCase(), b.en.toLowerCase()) || byText(a.en, b.en) || byText(a.ar, b.ar));
  const alone = new Map();
  for (const item of found.alone) {
    const ar = clean(item.ar);
    if (!ar) continue;
    if (!alone.has(ar)) alone.set(ar, { ar, count: 0, files: new Set() });
    alone.get(ar).count++;
    alone.get(ar).files.add(item.file);
  }
  const aloneRows = [...alone.values()].sort((a, b) => byText(a.ar, b.ar));

  const csvLines = ['\uFEFFEnglish,Arabic,Times used,Files'];
  for (const row of rows) csvLines.push([cell(row.en), cell(row.ar), row.count, cell([...row.files].sort().join(' '))].join(','));
  for (const row of aloneRows) csvLines.push([cell(''), cell(row.ar), row.count, cell([...row.files].sort().join(' '))].join(','));
  const csv = `${csvLines.join('\r\n')}\r\n`;

  // The same English with more than one Arabic: where wording drifted (or where one English word has two meanings).
  const byEnglish = new Map();
  for (const row of rows) {
    if (!LATIN.test(row.en) || /\$\{|…/.test(row.en)) continue;
    const key = row.en.toLowerCase();
    if (!byEnglish.has(key)) byEnglish.set(key, []);
    byEnglish.get(key).push(row);
  }
  const drift = [...byEnglish.values()].filter(list => new Set(list.map(row => row.ar)).size > 1)
    .sort((a, b) => b.reduce((sum, row) => sum + row.count, 0) - a.reduce((sum, row) => sum + row.count, 0) || byText(a[0].en.toLowerCase(), b[0].en.toLowerCase()));
  const md = [];
  const used = found.pairs.length;
  md.push('# The app\'s texts in one list');
  md.push('');
  md.push('This file and `app-texts.csv` are written by `scripts/list-texts.js` from the source files in `src/`. Do not edit them by hand: change the text where it is used, then run `npm run texts`. `npm test` fails when the list is out of date. Nothing in the app reads these two files.');
  md.push('');
  md.push('- **`app-texts.csv`** opens in Excel, Numbers or Google Sheets: every English/Arabic pair once, how often it is used, and in which source files.');
  md.push('- The words themselves stay where they are used in the code. This list is for reading and reviewing them in one place.');
  md.push('');
  md.push('## Numbers');
  md.push('');
  md.push('| | |');
  md.push('|---|---|');
  md.push(`| Source files read | ${found.files} |`);
  md.push(`| Places where a text with an Arabic side is written | ${used + found.alone.length} |`);
  md.push(`| …of which have their English beside them | ${used} |`);
  md.push(`| Different English/Arabic pairs | ${rows.length} |`);
  md.push(`| Arabic texts with no English beside them in the code | ${aloneRows.length} (in ${found.alone.length} places) |`);
  md.push(`| English texts written with more than one Arabic | ${drift.length} |`);
  md.push('');
  md.push('## The same English, more than one Arabic');
  md.push('');
  md.push('Some of these are right as they are (one English word with two meanings, a verb and a noun, a short form for a narrow place). The others are wording that drifted. The number is how often each form is used.');
  md.push('');
  md.push('| English | Arabic forms |');
  md.push('|---|---|');
  const mdCell = text => String(text).replace(/\|/g, '\\|').replace(/</g, '&lt;');
  for (const list of drift) {
    const forms = new Map();
    for (const row of list) forms.set(row.ar, (forms.get(row.ar) || 0) + row.count);
    md.push(`| ${mdCell(list[0].en)} | ${[...forms].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).map(([ar, count]) => `${mdCell(ar)} (${count})`).join(' · ')} |`);
  }
  md.push('');
  md.push('## Arabic texts with no English beside them');
  md.push('');
  md.push('Arabic that the code writes on its own: counted words ("يومان"), parts joined into a sentence, names. Their English is written a few lines away, not next to them, so the script cannot pair them. They are in `app-texts.csv` with an empty English cell.');
  md.push('');
  md.push('| Arabic | Times | Files |');
  md.push('|---|---|---|');
  for (const row of aloneRows) md.push(`| ${mdCell(row.ar)} | ${row.count} | ${[...row.files].sort().join(' ')} |`);
  md.push('');
  return { csv, md: `${md.join('\n')}`, found, rows, aloneRows, drift };
}

// Returns the exit code: 0, or 1 when --check finds the two files out of date.
function main(argv = process.argv.slice(2), files = { csv: CSV_FILE, md: MD_FILE }, say = console) {
  const check = argv.includes('--check');
  const { csv, md, found, rows, aloneRows, drift } = build();
  const summary = `${found.pairs.length + found.alone.length} places, ${rows.length} different pairs, ${aloneRows.length} Arabic texts on their own, ${drift.length} English texts with more than one Arabic`;
  if (check) {
    const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
    if (read(files.csv) !== csv || read(files.md) !== md) {
      say.error('The list of the app\'s texts is out of date: a text was added, changed or removed in src/.');
      say.error('Run:  npm run texts   (it rewrites docs/app-texts.csv and docs/APP_TEXTS.md), then commit the two files.');
      return 1;
    }
    say.log(`App texts list is up to date: ${summary}.`);
    return 0;
  }
  fs.writeFileSync(files.csv, csv);
  fs.writeFileSync(files.md, md);
  say.log(`Wrote docs/app-texts.csv and docs/APP_TEXTS.md: ${summary}.`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { build, scan, scanSource, proveComplete, readTokens, main };
