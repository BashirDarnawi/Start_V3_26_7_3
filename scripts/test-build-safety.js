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
console.log('Build safety checks passed: isolated tests, bundles, styles, artifact coverage and private-data exclusions.');
