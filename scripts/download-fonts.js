/**
 * One-time (re-runnable) downloader for the Inter font files.
 *
 * Fetches the same Google Fonts stylesheet the app used to load from
 * fonts.googleapis.com, downloads every referenced .woff2 file into
 * assets/fonts/, and writes assets/fonts.css with local url() paths —
 * so the app no longer needs the internet for fonts.
 *
 * Usage:  node scripts/download-fonts.js
 */
const fs = require('fs');
const path = require('path');

const CSS_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap';
// A modern browser UA makes Google return woff2 sources.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const ROOT = path.join(__dirname, '..');
const FONTS_DIR = path.join(ROOT, 'assets', 'fonts');

async function main() {
  fs.mkdirSync(FONTS_DIR, { recursive: true });
  const res = await fetch(CSS_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`fonts.googleapis.com returned ${res.status}`);
  let css = await res.text();

  const urls = [...new Set([...css.matchAll(/url\((https:[^)]+\.woff2)\)/g)].map(m => m[1]))];
  console.log(`Found ${urls.length} font files`);
  let i = 0;
  for (const url of urls) {
    const name = `inter-${String(++i).padStart(2, '0')}-${url.split('/').pop()}`;
    const buf = Buffer.from(await (await fetch(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
    fs.writeFileSync(path.join(FONTS_DIR, name), buf);
    css = css.split(url).join(`fonts/${name}`);
    console.log(`  ${name} (${buf.length} bytes)`);
  }
  fs.writeFileSync(path.join(ROOT, 'assets', 'fonts.css'), css);
  console.log('Wrote assets/fonts.css');
}

main().catch(e => { console.error(e); process.exit(1); });
