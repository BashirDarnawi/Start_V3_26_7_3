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
const { isolatedTestEnvironment } = require('./lib/test-environment');

const IMAGE = 'bashird/albayan:latest';
const ROOT = path.join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

const git = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
if (git.status !== 0 || !/^[a-f0-9]{7,40}$/.test(git.stdout.trim())) {
  console.error('Cannot identify the source revision; publishing is stopped.');
  process.exit(1);
}
const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
if (status.status !== 0) throw new Error('Cannot verify working-tree state');
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const release = `release-${git.stdout.trim()}-${stamp}${status.stdout.trim() ? '-dirty' : ''}`;
const versionedImage = `bashird/albayan:${release}`;

const args = [
  'buildx', 'build',
  '--platform', 'linux/amd64',
  '--provenance=false',
  '--sbom=false',
  '--build-arg', `ALBAYAN_BUILD_SHA=${release}`,
  '--tag', IMAGE,
  '--tag', versionedImage,
  '--output', 'type=image,push=true,oci-mediatypes=false',
  '-f', 'server/Dockerfile',
  '.',
];

console.log(`\nRelease: ${release}`);
console.log(`Command: docker ${args.join(' ')}\n`);

if (dryRun) {
  console.log('--dry-run: publishing would first require release:quality; nothing was built or pushed.');
  process.exit(0);
}

// Direct invocation is gated too, not just the npm shortcut. Browser tests
// cannot inherit an external-server override and write to a live site.
console.log('Checking build, isolated tests, generated assets, dependencies, and browser flows...');
const checked = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'release:quality'], {
  cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
  env: isolatedTestEnvironment(process.env, 'sqlite+pysqlite:///:memory:'),
});
if (checked.status !== 0) {
  console.error('Release checks failed. No image build or push was attempted.');
  process.exit(1);
}

// A slow link drops part-way through pip's downloads. The Dockerfile's pip
// cache mount means every attempt KEEPS what it already fetched, so retrying
// finishes the job instead of starting over.
const MAX = 3;
for (let attempt = 1; attempt <= MAX; attempt++) {
  console.log(`--- attempt ${attempt}/${MAX} ---`);
  const built = spawnSync('docker', args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (built.status === 0) {
    console.log(`\nPushed ${IMAGE} and rollback tag ${versionedImage}\n`);
    spawnSync('docker', ['buildx', 'imagetools', 'inspect', IMAGE], { stdio: 'inherit', shell: false });
    console.log('\nNext: redeploy in Libyan Spider, then confirm the live site reports');
    console.log(`this release at https://albayanhub.com/api/health/ready`);
    process.exit(0);
  }
  console.error(`attempt ${attempt} failed (exit ${built.status}).`);
  if (attempt < MAX) console.error('retrying — cached downloads are kept, so this resumes.\n');
}

console.error('\nPublishing failed. Registry state may be partial; inspect the release tag before retrying.');
console.error('No Jelastic redeployment was requested by this command.');
console.error('If the error mentions "DO NOT MATCH THE HASHES", a dropped download was');
console.error('cached. Clear it and retry:');
console.error('  docker builder prune -f --filter type=exec.cachemount');
process.exit(1);
