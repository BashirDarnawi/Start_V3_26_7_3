#!/usr/bin/env node
/**
 * Build the production image from the CURRENT source, start it once, and only
 * then push it to Docker Hub.
 *
 * Why this exists instead of `docker build` + `docker push`:
 *
 *  - A plain `docker push` only uploads whatever image the laptop already has.
 *    If the source changed but no build ran, it silently re-publishes the OLD
 *    image and the live site never changes.
 *  - Libyan Spider (Jelastic) needs a SINGLE linux/amd64 Docker manifest.
 *    Attestations (provenance/SBOM) turn the result into a manifest LIST, and
 *    OCI media types are not accepted either — hence the explicit flags below.
 *  - The tests run on the laptop's Python; the image runs its own (3.12) with
 *    its own system libraries. Like the GitHub workflow's smoke test, the image
 *    is started before the push: it must report this release, run as a
 *    non-root user and serve every page and bundle, so an image that cannot
 *    start never becomes latest.
 *
 * Usage:
 *   npm run release:image:push     (runs the full test suite, then the
 *                                   PostgreSQL backup and money scenarios, first)
 *   node scripts/publish-image.js --dry-run
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { isolatedTestEnvironment } = require('./lib/test-environment');

const IMAGE = 'bashird/albayan:latest';
const ROOT = path.join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
// Every page and bundle the browser asks for: the same list as the smoke test
// in .github/workflows/publish-image.yml (scripts/test-build-safety.js keeps
// them equal; a bundle missing from the Dockerfile once 500ed on the live site).
const SMOKE_ROUTES = ['/', '/script.js', '/studio.js', '/studio-staff.js', '/studio-pages.js', '/clothes.js',
  '/admin-tools.js', '/meta-tools.js', '/style.css', '/privacy', '/delete-account'];
const SMOKE_CONTAINER = `albayan-release-check-${process.pid}`;
const SMOKE_READY_MS = 180_000; // an Intel image on an Apple Silicon Mac starts translated, slower than on GitHub

const git = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
if (git.status !== 0 || !/^[a-f0-9]{7,40}$/.test(git.stdout.trim())) {
  console.error('Cannot identify the source revision; publishing is stopped.');
  process.exit(1);
}
const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
if (status.status !== 0) throw new Error('Cannot verify working-tree state');
if (status.stdout.trim() && !process.argv.includes('--allow-dirty')) {
  console.error('Working tree has uncommitted changes; commit them (or pass --allow-dirty for a deliberate hotfix image).');
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const release = `release-${git.stdout.trim()}-${stamp}${status.stdout.trim() ? '-dirty' : ''}`;
const versionedImage = `bashird/albayan:${release}`;

const buildArgs = [
  'buildx', 'build',
  '--platform', 'linux/amd64',
  '--provenance=false',
  '--sbom=false',
  '--build-arg', `ALBAYAN_BUILD_SHA=${release}`,
];
// First into the local image store, so the exact image can be started...
const loadArgs = [...buildArgs, '--tag', versionedImage, '--load', '-f', 'server/Dockerfile', '.'];
// ...then the same build again (every layer cached by then) pushes both tags.
const args = [
  ...buildArgs,
  '--tag', IMAGE,
  '--tag', versionedImage,
  '--output', 'type=image,push=true,oci-mediatypes=false',
  '-f', 'server/Dockerfile',
  '.',
];

console.log(`\nRelease: ${release}`);
console.log(`Build:   docker ${loadArgs.join(' ')}`);
console.log(`Start:   docker run ${versionedImage} on a loopback port; /api/health/ready must report the release,`);
console.log(`         id -u must not be 0, and ${SMOKE_ROUTES.join(' ')} must answer`);
console.log(`Push:    docker ${args.join(' ')}\n`);

if (dryRun) {
  console.log('--dry-run: publishing would first require release:quality and test:postgres; nothing was built or pushed.');
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

// Production runs PostgreSQL, the suite above SQLite: the backup export and the
// money race scenarios must also pass on a real PostgreSQL 16 (a throwaway
// Docker container that the script always removes) before anything is built.
console.log('Proving the backup and money race scenarios on a throwaway PostgreSQL 16...');
const postgres = spawnSync(process.execPath, [path.join(__dirname, 'test-postgres-release.js')], {
  cwd: ROOT, stdio: 'inherit', shell: false,
});
if (postgres.status !== 0) {
  console.error('PostgreSQL release checks failed. No image build or push was attempted.');
  process.exit(1);
}

// A slow link drops part-way through pip's downloads. The Dockerfile's pip
// cache mount means every attempt KEEPS what it already fetched, so retrying
// finishes the job instead of starting over.
const MAX = 3;
function dockerWithRetries(dockerArgs) {
  for (let attempt = 1; attempt <= MAX; attempt++) {
    console.log(`--- attempt ${attempt}/${MAX} ---`);
    const built = spawnSync('docker', dockerArgs, { cwd: ROOT, stdio: 'inherit', shell: false });
    if (built.status === 0) return true;
    console.error(`attempt ${attempt} failed (exit ${built.status}).`);
    if (attempt < MAX) console.error('retrying — cached downloads are kept, so this resumes.\n');
  }
  return false;
}

function printHashHint() {
  console.error('If the error mentions "DO NOT MATCH THE HASHES", a dropped download was');
  console.error('cached. Clear it and retry:');
  console.error('  docker builder prune -f --filter type=exec.cachemount');
}

let smokeRunning = false;
function removeSmokeContainer() {
  if (!smokeRunning) return;
  smokeRunning = false;
  const removed = spawnSync('docker', ['rm', '--force', SMOKE_CONTAINER], { encoding: 'utf8' });
  if (removed.status !== 0 && !/no such container/i.test(removed.stderr || '')) {
    console.error(`Could not remove ${SMOKE_CONTAINER}; remove it by hand: docker rm -f ${SMOKE_CONTAINER}`);
  }
}

/** The GitHub workflow's smoke test, on the laptop: throws when the image is not fit to push. */
async function smokeTest() {
  // Only while the container exists: Ctrl-C during the later push must still stop at once.
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = () => { removeSmokeContainer(); process.exit(130); };
  process.on('exit', removeSmokeContainer);
  for (const signal of SIGNALS) process.on(signal, onSignal);
  smokeRunning = true; // from here on every exit removes the container (a failed start can leave one)
  try {
    const started = spawnSync('docker', [
      'run', '--detach', '--name', SMOKE_CONTAINER, '--platform', 'linux/amd64',
      '--publish', '127.0.0.1::8000',
      '--env', 'ALBAYAN_COOKIE_SECURE=false',
      '--env', 'ALBAYAN_ALLOW_SQLITE=true',
      '--env', 'ALBAYAN_DB_PATH=/tmp/albayan-release-check.db',
      versionedImage,
    ], { encoding: 'utf8' });
    if (started.status !== 0) throw new Error(`Docker could not start the image. ${(started.stderr || '').trim()}`);
    const mapped = spawnSync('docker', ['port', SMOKE_CONTAINER, '8000/tcp'], { encoding: 'utf8' });
    const port = Number(((mapped.stdout || '').match(/127\.0\.0\.1:(\d+)/) || [])[1]);
    if (!port) throw new Error('Docker did not report the loopback port of the image.');
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + SMOKE_READY_MS;
    let ready = '';
    for (;;) {
      const response = await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (response && response.ok) {
        ready = await response.text();
        break;
      }
      const running = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', SMOKE_CONTAINER], { encoding: 'utf8' });
      const stopped = (running.stdout || '').trim() !== 'true';
      if (stopped || Date.now() > deadline) {
        spawnSync('docker', ['logs', '--tail', '60', SMOKE_CONTAINER], { stdio: 'inherit' });
        throw new Error(stopped ? 'the image stopped before it was ready (its log is above).'
          : `the image was not ready after ${SMOKE_READY_MS / 1000} s (its log is above).`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    // The running image must report the release name Jelastic will show.
    if (!ready.includes(`"${release}"`)) throw new Error(`the image does not report release ${release}: ${ready}`);
    const user = spawnSync('docker', ['exec', SMOKE_CONTAINER, 'id', '-u'], { encoding: 'utf8' });
    if (user.status !== 0 || !/^\d+$/.test((user.stdout || '').trim()) || user.stdout.trim() === '0') {
      throw new Error('the image must run as its non-root user.');
    }
    for (const route of SMOKE_ROUTES) {
      // Like curl --fail without -L: any answer below 400 counts.
      const response = await fetch(base + route, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (response) await response.arrayBuffer().catch(() => null);
      if (!response || response.status >= 400) {
        spawnSync('docker', ['logs', '--tail', '40', SMOKE_CONTAINER], { stdio: 'inherit' });
        throw new Error(`the image does not serve ${route}${response ? ` (HTTP ${response.status})` : ''}.`);
      }
    }
    console.log(`The image started, reports ${release}, runs as user ${user.stdout.trim()} and serves every page and bundle.`);
  } finally {
    removeSmokeContainer();
    for (const signal of SIGNALS) process.off(signal, onSignal);
    process.off('exit', removeSmokeContainer);
  }
}

async function main() {
  console.log('Building the image into the local image store...');
  if (!dockerWithRetries(loadArgs)) {
    console.error('\nBuilding the image failed. Nothing was pushed.');
    printHashHint();
    process.exit(1);
  }

  console.log(`\nStarting ${versionedImage} once before anything is pushed...`);
  try {
    await smokeTest();
  } catch (error) {
    console.error(`\nThe image failed its start check: ${error && error.message ? error.message : error}`);
    console.error('Nothing was pushed; latest still holds the previous release.');
    process.exit(1);
  }

  console.log('\nPushing the checked image (the build is cached, so only the upload runs)...');
  if (!dockerWithRetries(args)) {
    console.error('\nPublishing failed. Registry state may be partial; inspect the release tag before retrying.');
    console.error('No Jelastic redeployment was requested by this command.');
    printHashHint();
    process.exit(1);
  }

  // Jelastic pulls only a single Docker v2 manifest: anything else must stop the redeploy.
  const raw = spawnSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', versionedImage], { encoding: 'utf8' });
  let mediaType = '';
  try { mediaType = JSON.parse(raw.stdout).mediaType || ''; } catch { /* reported below */ }
  if (raw.status !== 0 || mediaType !== DOCKER_MANIFEST) {
    console.error(`\nDocker Hub holds ${mediaType || 'an unreadable manifest'} for ${versionedImage}, not a single ${DOCKER_MANIFEST}.`);
    console.error('Do NOT redeploy in Libyan Spider: Jelastic cannot pull it. Publish again with npm run release:github.');
    process.exit(1);
  }
  console.log(`\nPushed ${IMAGE} and rollback tag ${versionedImage} (a single Docker v2 manifest)\n`);
  spawnSync('docker', ['buildx', 'imagetools', 'inspect', IMAGE], { stdio: 'inherit', shell: false });
  console.log('\nNext: redeploy in Libyan Spider, then confirm the live site reports');
  console.log(`this release at https://albayanhub.com/api/health/ready`);
}

main().then(() => process.exit(0), error => {
  console.error(`\nPublishing stopped: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
