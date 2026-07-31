#!/usr/bin/env node
/**
 * Build the production image from the CURRENT source and push it to Docker Hub.
 *
 * Why this exists instead of `docker build` + `docker push`:
 *
 *  - A plain `docker push` only uploads whatever image the laptop already has.
 *    If the source changed but no build ran, it silently re-publishes the OLD
 *    image and the live site never changes.
 *  - Libyan Spider (Jelastic) needs a SINGLE linux/amd64 Docker manifest.
 *    Attestations (provenance/SBOM) turn the result into a manifest LIST, and
 *    OCI media types are not accepted either — hence the explicit flags below.
 *
 * Usage:
 *   npm run release:image:push     (runs the full test suite first)
 *   node scripts/publish-image.js --dry-run
 */
const { spawnSync } = require('child_process');
const path = require('path');

const IMAGE = 'bashird/albayan:latest';
const ROOT = path.join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

const release = `claude-fixes-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;

const args = [
  'buildx', 'build',
  '--platform', 'linux/amd64',
  '--provenance=false',
  '--sbom=false',
  '--build-arg', `ALBAYAN_BUILD_SHA=${release}`,
  '--output', `type=image,name=${IMAGE},push=true,oci-mediatypes=false`,
  '-f', 'server/Dockerfile',
  '.',
];

console.log(`\nRelease: ${release}`);
console.log(`Command: docker ${args.join(' ')}\n`);

if (dryRun) {
  console.log('--dry-run: nothing was built or pushed.');
  process.exit(0);
}

// A slow link drops part-way through pip's downloads. The Dockerfile's pip
// cache mount means every attempt KEEPS what it already fetched, so retrying
// finishes the job instead of starting over.
const MAX = 3;
for (let attempt = 1; attempt <= MAX; attempt++) {
  console.log(`--- attempt ${attempt}/${MAX} ---`);
  const built = spawnSync('docker', args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (built.status === 0) {
    console.log(`\nPushed ${IMAGE}  (release ${release})\n`);
    spawnSync('docker', ['buildx', 'imagetools', 'inspect', IMAGE], { stdio: 'inherit', shell: false });
    console.log('\nNext: redeploy in Libyan Spider, then confirm the live site reports');
    console.log(`this release at https://albayanhub.com/api/health/ready`);
    process.exit(0);
  }
  console.error(`attempt ${attempt} failed (exit ${built.status}).`);
  if (attempt < MAX) console.error('retrying — cached downloads are kept, so this resumes.\n');
}

console.error('\nAll attempts failed. Nothing was published; the live site is unchanged.');
console.error('If the error mentions "DO NOT MATCH THE HASHES", a dropped download was');
console.error('cached. Clear it and retry:');
console.error('  docker builder prune -f --filter type=exec.cachemount');
process.exit(1);
