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
// nothing is pushed before the gates and the smoke test pass.
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/publish-image.yml'), 'utf8');
assert.match(workflow, /^\s+tags:\n\s+- 'release-\*'/m, 'A release-* tag push must start the image build');
assert.ok(workflow.includes('ALBAYAN_BUILD_SHA=${{ steps.release.outputs.release }}'), 'The image must report the release name');
assert.ok(workflow.includes('--provenance=false') && workflow.includes('--sbom=false'), 'Jelastic needs a single manifest: no attestations');
assert.ok(workflow.includes('--platform linux/amd64'), 'The server runs Intel images');
const order = ['Run all fast safety tests', 'Prove the money race scenarios', 'Build immutable release image',
  'Smoke-test the exact image', 'Log in to Docker Hub', 'Publish immutable release image', 'Confirm Docker Hub holds a single linux/amd64 manifest'];
let cursor = -1;
for (const step of order) {
  const at = workflow.indexOf(step);
  assert.ok(at > cursor, `Release workflow step order: ${step} must come after the previous gate`);
  cursor = at;
}
assert.ok(!workflow.includes('publish_latest }}\n        run: docker push "$IMAGE:latest"\n') || workflow.includes("github.event_name == 'push' || inputs.publish_latest"),
  'A tag release always moves latest; a manual run honours its option');
const scripts = require('../package.json').scripts;
assert.equal(scripts['release:github'], 'node scripts/release-github.js', 'npm run release:github starts the GitHub build');
const releaseScript = fs.readFileSync(path.join(__dirname, 'release-github.js'), 'utf8');
assert.ok(releaseScript.includes("git(['status', '--porcelain'])") && releaseScript.includes('uncommitted changes'), 'Refuse to release uncommitted source');
assert.match(releaseScript, /release-\$\{sha\}-\$\{stamp\}/, 'Tag name must match the publisher release format');
assert.ok(!/--allow-dirty/.test(releaseScript), 'GitHub can only build committed source; no dirty override');
console.log('Build safety checks passed: isolated tests, bundles, styles, artifact coverage and private-data exclusions.');
