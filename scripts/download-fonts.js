/**
 * One-time (re-runnable) downloader for the Inter font files.
 *
 * Fetches the same Google Fonts stylesheet the app used to load from
 * fonts.googleapis.com, downloads every referenced .woff2 file into
 * assets/fonts/, and writes assets/fonts.css with local url() paths —
 * so the app no longer needs the internet for fonts.
 *
 * The Arabic font (IBM Plex Sans Arabic 1.101, SIL Open Font License 1.1) is
 * not downloaded: its four files and its licence text are committed in
 * assets/fonts/. This script only writes their @font-face rules after the
 * Inter ones. The unicode-range lists Arabic script only, so a browser fetches
 * an Arabic file when Arabic text is on the screen and not before.
 *
 * Usage:  node scripts/download-fonts.js
 */
const fs = require('fs');
const path = require('path');

const ARABIC_FONT_FILES = {
  400: 'ibm-plex-sans-arabic-400-6010e7fd.woff2',
  500: 'ibm-plex-sans-arabic-500-90aef64f.woff2',
  600: 'ibm-plex-sans-arabic-600-16734a5a.woff2',
  700: 'ibm-plex-sans-arabic-700-04c730b4.woff2',
};
const ARABIC_UNICODE_RANGE = 'U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFC';

function arabicFontCss() {
  return Object.entries(ARABIC_FONT_FILES).map(([weight, file]) => `/* arabic */
@font-face {
  font-family: 'IBM Plex Sans Arabic';
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  src: url(fonts/${file}) format('woff2');
  unicode-range: ${ARABIC_UNICODE_RANGE};
}
`).join('');
}

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
  for (const file of Object.values(ARABIC_FONT_FILES)) {
    if (!fs.existsSync(path.join(FONTS_DIR, file))) throw new Error(`Missing committed Arabic font file: assets/fonts/${file}`);
  }
  fs.writeFileSync(path.join(ROOT, 'assets', 'fonts.css'), css.replace(/\n*$/, '\n') + arabicFontCss());
  console.log('Wrote assets/fonts.css');
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { arabicFontCss, ARABIC_FONT_FILES };
