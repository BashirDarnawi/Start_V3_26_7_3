/**
 * One-time (re-runnable) generator for the self-hosted web/PWA icons.
 *
 * Renders resources/icon.png (the Capacitor icon source) into the sizes the
 * browser shell needs, straight into assets/ where index.html links them:
 *   assets/icon-192.png         — manifest icon (Android homescreen, tabs)
 *   assets/icon-512.png         — manifest icon (splash/high-DPI)
 *   assets/apple-touch-icon.png — iOS home screen (180x180)
 *
 * Uses the repo's `sharp` devDependency. Fails loudly if any output is not
 * exactly the requested square size.
 *
 * Usage:  node scripts/generate-web-icons.js
 */
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'resources', 'icon.png');

const TARGETS = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 }
];

async function main() {
  for (const { file, size } of TARGETS) {
    const out = path.join(ROOT, 'assets', file);
    await sharp(SOURCE).resize(size, size, { fit: 'cover' }).png().toFile(out);
    const meta = await sharp(out).metadata();
    if (meta.width !== size || meta.height !== size) {
      throw new Error(`${file}: expected ${size}x${size}, got ${meta.width}x${meta.height}`);
    }
    console.log(`  assets/${file} (${meta.width}x${meta.height})`);
  }
  console.log('Web icons generated.');
}

main().catch(e => { console.error(e); process.exit(1); });
