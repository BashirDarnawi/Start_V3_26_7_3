const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isolatedTestEnvironment, sqliteTestUrl } = require('./lib/test-environment');
const { bundleManifest } = require('./lib/bundle-manifest');

const parent = {
  PATH: 'test-path', DATABASE_URL: 'postgresql://live.invalid/never-connect',
  ALBAYAN_DATABASE_URL: 'postgresql://live.invalid/other', ALBAYAN_DB_HOST: 'live.invalid',
  ALBAYAN_DB_PASSWORD: 'not-a-real-secret', REDIS_URL: 'redis://live.invalid',
  ALBAYAN_BACKUP_S3_BUCKET: 'live-bucket', ALBAYAN_ALERT_WEBHOOK_URL: 'https://live.invalid',
  ALBAYAN_META_ACCESS_TOKEN: 'never-send', ALBAYAN_TEST_POSTGRES_URL: 'postgresql://live.invalid',
  ALBAYAN_E2E_EXTERNAL_SERVER: 'true', ALBAYAN_E2E_BASE_URL: 'https://live.invalid',
  ALBAYAN_E2E_PYTHON: '/custom/python',
};
const clean = isolatedTestEnvironment(parent, 'sqlite+pysqlite:///:memory:');
assert.equal(clean.DATABASE_URL, 'sqlite+pysqlite:///:memory:');
assert.equal(clean.PATH, parent.PATH);
assert.equal(clean.ALBAYAN_E2E_PYTHON, parent.ALBAYAN_E2E_PYTHON);
for (const key of ['ALBAYAN_DATABASE_URL', 'ALBAYAN_DB_HOST', 'ALBAYAN_DB_PASSWORD', 'REDIS_URL',
  'ALBAYAN_BACKUP_S3_BUCKET', 'ALBAYAN_ALERT_WEBHOOK_URL', 'ALBAYAN_TEST_POSTGRES_URL',
  'ALBAYAN_E2E_EXTERNAL_SERVER', 'ALBAYAN_E2E_BASE_URL']) assert.equal(clean[key], undefined, key);
assert.equal(clean.ALBAYAN_META_ACCESS_TOKEN, '');
assert.equal(clean.ALBAYAN_META_AUTO_IMPORT, 'false');
assert.equal(parent.DATABASE_URL, 'postgresql://live.invalid/never-connect');
assert.throws(() => isolatedTestEnvironment({}, 'postgresql://anything'), /isolated/);
assert.match(sqliteTestUrl('.tmp/e2e/test.db'), /^sqlite\+pysqlite:\/\/\//);
assert.ok(!sqliteTestUrl('.tmp/e2e/test.db').includes('\\'));

const manifest = { files: ['main.js'], lazy: { 'studio.js': ['studio-src.js'], 'clothes.js': ['clothes-src.js'] } };
assert.deepEqual(bundleManifest(manifest).map(b => b.out), ['script.js', 'studio.js', 'clothes.js']);
for (const bad of [
  { files: [] }, { files: ['../escape.js'] }, { files: ['..'] }, { files: ['C:/escape.js'] },
  { files: ['main.js'], lazy: { 'script.js': ['extra.js'] } },
  { files: ['main.js'], lazy: { '../escape.js': ['extra.js'] } },
  { files: ['main.js'], lazy: { 'extra.js': ['main.js'] } },
]) assert.throws(() => bundleManifest(bad));

const config = require('../tailwind.config');
assert.ok(config.content.includes('./src/**/*.js'), 'CSS must scan lazy source modules');
const verify = fs.readFileSync(path.join(__dirname, 'verify-artifacts.js'), 'utf8');
assert.ok(verify.includes('for (const bundle of bundles)'), 'Verify every source bundle');
assert.equal((verify.match(/\.\.\.bundleOutputs/g) || []).length, 2, 'Check lazy assets in web and native copies');
const dockerIgnore = fs.readFileSync(path.join(__dirname, '../.dockerignore'), 'utf8').split(/\r?\n/).map(line => line.trim());
for (const pattern of ['server/data/', '**/backups/', '**/*.db', '**/*.db-*', '**/*.sqlite3',
  '**/*.aesgcm', '**/*.key', '**/*.pem', '**/.env', '**/.env.*', '.tmp/', '.venv/']) {
  assert.ok(dockerIgnore.includes(pattern), `Image build must exclude ${pattern}`);
}
assert.ok(!dockerIgnore.some(line => line.startsWith('!')), 'Review any Docker re-inclusion rule for private data');
const dockerfile = fs.readFileSync(path.join(__dirname, '../server/Dockerfile'), 'utf8');
assert.ok(dockerfile.includes('RUN python /app/server/image_safety.py /app'), 'Validate actual copied image content before publishing');
// The GitHub release path must keep the laptop publisher's guarantees: a
// release-* tag starts the build, the tag name becomes the release the health
// page reports, only a single linux/amd64 manifest reaches Docker Hub, and
// nothing is pushed before a green CI run for the exact commit and a smoke
// test of the exact image. These guards catch accidental drift; a reviewer
// still reads any change to the workflows.
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/publish-image.yml'), 'utf8');
assert.match(workflow, /^\s+tags:\n\s+- 'release-\*'/m, 'A release-* tag push must start the image build');
assert.ok(workflow.includes('ALBAYAN_BUILD_SHA=${{ needs.release.outputs.release }}'), 'The image must report the release name');
assert.ok(workflow.includes('--provenance=false') && workflow.includes('--sbom=false'), 'Jelastic needs a single manifest: no attestations');
assert.ok(workflow.includes('--platform linux/amd64'), 'The server runs Intel images');
assert.ok(workflow.includes('scripts/ci-status-for-sha.js') && workflow.includes('--require-passed'), 'The gate must reuse the commit\'s CI run through the shared checker, exit code deciding');
assert.match(workflow, /\|\| status=\$\?\n(?:.*\n)*?\s+exit "\$status"\n/, 'The gate step must end with the checker\'s exit code');
assert.ok(!/continue-on-error/.test(workflow), 'No step of the release may be allowed to fail silently');
assert.match(workflow, /needs: \[release, ci-gate, image\]/, 'Publishing needs the CI gate and the smoke-tested image');
const publishJob = workflow.slice(workflow.indexOf('\n  publish:\n'));
assert.ok(!/^\s{4}if:/m.test(publishJob.split('\n    steps:')[0]), 'The publish job must have no job-level if: a failed gate or smoke test skips it');
assert.equal((workflow.match(/environment: production/g) || []).length, 1, 'Only the publish job runs under the production environment');
assert.ok(publishJob.includes('environment: production'), 'The production environment belongs to the publish job');
assert.ok(workflow.includes('docker save "$IMAGE:${{ needs.release.outputs.release }}"') && workflow.includes('docker load <'), 'The published image is the smoke-tested one, handed over as an artifact');
assert.ok(workflow.includes('overwrite: true'), 'A re-run of all jobs must be able to replace the image artifact');
assert.ok(workflow.includes('actions: read'), 'The gate needs permission to read CI runs');
assert.ok(workflow.includes('npm audit --audit-level=high') && workflow.includes('pip_audit --no-deps'), 'Advisories published after the CI run must still block a release');
assert.ok(workflow.includes('"${GITHUB_EVENT_NAME}" == "workflow_dispatch" && "${GITHUB_REF_TYPE}" == "tag"'), 'A manual run must never rebuild an existing rollback tag');
const order = ['Load the smoke-tested image', 'Log in to Docker Hub', 'Publish immutable release image', 'Confirm Docker Hub holds a single linux/amd64 manifest', 'Publish latest image'];
let cursor = -1;
for (const step of order) {
  const at = publishJob.indexOf(step);
  assert.ok(at > cursor, `Publish step order: ${step} must come after the previous step (latest moves only after the manifest check)`);
  cursor = at;
}
assert.ok(workflow.includes("github.event_name == 'push' || inputs.publish_latest"), 'A tag release always moves latest; a manual run honours its option');

// CI is the proof the release reuses, so CI must cover everything the local
// gate covers and stay in the shape the checker expects.
const ci = fs.readFileSync(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8');
const scripts = require('../package.json').scripts;
for (const step of scripts.test.split('&&').map(part => part.trim())) {
  if (step === 'npm run test:backend') continue; // its own CI jobs run pytest directly
  assert.ok(ci.includes(step), `CI must run ${step} (every npm test suite is release proof)`);
}
assert.ok(ci.includes('python -m pytest -q -p no:cacheprovider $files'), 'CI must run the sharded backend suite');
assert.match(ci, /shard: \[1, 2, 3\]/, 'The backend suite runs as three whole-file shards on separate runners');
assert.ok(ci.includes("files = sorted(glob.glob('server/test_*.py'))") && ci.includes('n, i = 3, ${{ matrix.shard }} - 1'), 'Shards must cover every test file exactly once');
assert.ok(ci.includes("DATABASE_URL: 'sqlite+pysqlite:///:memory:'") && ci.includes("ALBAYAN_ALLOW_SQLITE: 'true'"), 'Backend shards must use the isolated in-memory database');
assert.ok(!/pytest-xdist|-n auto/.test(ci), 'No same-runner pytest parallelism: test_setup_admin.py uses a fixed temp file');
assert.ok(!/continue-on-error/.test(ci), 'No CI job may be allowed to fail silently: CI is the release proof');
assert.match(ci, /^\s+branches:\n\s+- '\*\*'/m, 'CI runs on branch pushes only; a release tag reuses its commit\'s run');
const legs = [...ci.matchAll(/^\s+- leg: ([\w-]+)$/gm)].map(m => m[1]);
assert.deepEqual(legs, ['desktop-chromium', 'mobile-webkit', 'mobile-chromium-1', 'mobile-chromium-2', 'mobile-chromium-3'], 'Browser legs: every project runs, the heavy Android-size suite is sharded');
assert.ok(ci.includes('name: Real browser critical flows (${{ matrix.leg }})'), 'Browser leg job names must keep the prefix the checker matches');
assert.ok(ci.includes('playwright-failure-report-${{ matrix.leg }}'), 'Each browser leg uploads its own failure report');
assert.ok(ci.includes('npm run test:modal-presentation && npm run test:modal-keyboard-stability && npm run test:indexeddb-snapshot'), 'The modal/keyboard/snapshot checks still run on a browser leg');
assert.match(fs.readFileSync(path.join(__dirname, '../playwright.config.js'), 'utf8'), /workers:\s*1,/, 'Browser specs share one admin account: exactly one worker per machine');
assert.ok(ci.includes('PostgreSQL scenarios were skipped'), 'CI must fail when the PostgreSQL money scenarios are skipped');

const { evaluate, REQUIRED, IGNORED } = require('./ci-status-for-sha');
assert.deepEqual(REQUIRED.map(r => r.name), ['Frontend tests and generated files', 'FastAPI tests', 'Real browser critical flows', 'PostgreSQL migration smoke test', 'Docker production smoke test'], 'Every server-relevant CI job gates a release');
const ciJobNames = [...ci.matchAll(/^    name: (.+)$/gm)].map(m => m[1].trim());
assert.ok(ciJobNames.length >= 7, `Expected the CI job names, found ${ciJobNames.length}`);
for (const name of ciJobNames) {
  const printed = name.replace(/ \(\$\{\{ matrix\.\w+ \}\}.*\)$/, ' (');
  const required = REQUIRED.some(r => r.prefix ? printed.startsWith(`${r.name} (`) || name === r.name : name === r.name);
  assert.ok(required || IGNORED.includes(name), `CI job "${name}" must be REQUIRED for releases or listed in IGNORED (a decision, never an accident)`);
}
for (const req of REQUIRED) {
  const printed = req.prefix ? `name: ${req.name} (` : `name: ${req.name}\n`;
  assert.ok(ci.includes(printed), `The checker requires a CI job named "${req.name}" that ci.yml no longer defines`);
}
const job = (name, conclusion = 'success', status = 'completed') => ({ name, conclusion, status });
const green = [job('Frontend tests and generated files'), job('FastAPI tests (1 of 3)'), job('FastAPI tests (2 of 3)'), job('Real browser critical flows (desktop-chromium)'),
  job('Real browser critical flows (mobile-webkit)'), job('PostgreSQL migration smoke test'), job('Docker production smoke test'),
  job('iOS simulator build', 'failure')];
const REPO = 'owner/name';
const run = (id, status, conclusion, updated_at, extra = {}) => ({ id, status, conclusion, updated_at, event: 'push', head_repository: { full_name: REPO }, html_url: `https://example.invalid/${id}`, ...extra });
const withJob = (name, conclusion, status = 'completed') => green.map(j => j.name === name ? job(name, conclusion, status) : j);
assert.equal(evaluate([run(1, 'completed', 'failure', '2026-01-01')], { 1: green }, REPO).state, 'passed', 'A red phone-app job must not block a server release');
assert.equal(evaluate([run(1, 'in_progress', null, '2026-01-01')], { 1: green.map(j => j.name === 'iOS simulator build' ? job(j.name, null, 'in_progress') : j) }, REPO).state, 'passed', 'A phone-app job still running must not delay a server release');
assert.equal(evaluate([run(1, 'completed', 'success', '2026-01-01')], { 1: withJob('FastAPI tests (2 of 3)', 'failure') }, REPO).state, 'failed', 'One red backend shard is a red release');
assert.equal(evaluate([run(1, 'in_progress', null, '2026-01-01')], { 1: withJob('FastAPI tests (2 of 3)', 'failure') }, REPO).state, 'failed', 'A red required job is final before the run ends');
assert.equal(evaluate([run(1, 'completed', 'success', '2026-01-01')], { 1: withJob('Real browser critical flows (mobile-webkit)', 'cancelled') }, REPO).state, 'failed', 'Every browser leg must be green');
assert.equal(evaluate([run(1, 'in_progress', null, '2026-01-01')], { 1: withJob('PostgreSQL migration smoke test', null, 'queued') }, REPO).state, 'running', 'A required job still queued means wait');
assert.equal(evaluate([run(1, 'completed', 'success', '2026-01-01'), run(2, 'in_progress', null, '2026-01-02')], { 1: green, 2: withJob('FastAPI tests (1 of 3)', null, 'in_progress') }, REPO).state, 'passed', 'An older green run proves the commit while a newer run is still going');
assert.equal(evaluate([run(1, 'completed', 'success', '2026-01-01'), run(2, 'completed', 'failure', '2026-01-02')], { 1: green, 2: withJob('Frontend tests and generated files', 'failure') }, REPO).state, 'failed', 'A newer red run wins over an older green one (newer advisories, real flakiness)');
assert.equal(evaluate([run(1, 'completed', 'failure', '2026-01-02'), run(2, 'completed', 'success', '2026-01-01')], { 1: green, 2: green }, REPO).state, 'passed', 'Run order comes from the last update, so a re-run counts');
assert.equal(evaluate([run(1, 'completed', 'cancelled', '2026-01-01')], {}, REPO).state, 'cancelled', 'A cancelled run is reported as such');
assert.equal(evaluate([], {}, REPO).state, 'missing');
assert.equal(evaluate([run(1, 'completed', 'success', '2026-01-01', { event: 'pull_request' })], { 1: green }, REPO).state, 'missing', 'A pull-request run tests a merge, not the commit: it never counts');
assert.equal(evaluate([run(1, 'completed', 'success', '2026-01-01', { head_repository: { full_name: 'someone/fork' } })], { 1: green }, REPO).state, 'missing', 'A run from another repository never counts');
assert.equal(evaluate([run(1, 'completed', 'success', '2026-01-01')], { 1: green.filter(j => !j.name.startsWith('FastAPI tests')) }, REPO).state, 'missing', 'A missing required job proves nothing');
assert.equal(scripts['release:github'], 'node scripts/release-github.js', 'npm run release:github starts the GitHub build');
const releaseScript = fs.readFileSync(path.join(__dirname, 'release-github.js'), 'utf8');
assert.ok(releaseScript.includes("git(['status', '--porcelain'])") && releaseScript.includes('uncommitted changes'), 'Refuse to release uncommitted source');
assert.match(releaseScript, /release-\$\{sha\}-\$\{stamp\}/, 'Tag name must match the publisher release format');
assert.ok(!/--allow-dirty/.test(releaseScript), 'GitHub can only build committed source; no dirty override');
assert.ok(releaseScript.includes("ciState === 'failed'") && releaseScript.includes("ciState === 'cancelled'") && releaseScript.includes('ci-status-for-sha.js'), 'The laptop refuses to tag a commit CI rejected or cancelled');
console.log('Build safety checks passed: isolated tests, bundles, styles, artifact coverage and private-data exclusions.');
