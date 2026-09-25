#!/usr/bin/env node
/**
 * Prove the money race scenarios on a REAL PostgreSQL 16 before a release
 * (Albayan Studio plan, task P0-11). Production runs PostgreSQL; the ordinary
 * suite runs SQLite, which cannot show row locks or two writers racing.
 *
 * What it does, on a throwaway database only:
 *   1. starts postgres:16-alpine with Docker on a random loopback port and a
 *      random password (the container never sees the network outside 127.0.0.1);
 *   2. waits until it accepts connections;
 *   3. runs the same commands as CI's postgres-migration job:
 *      `alembic upgrade head`, `alembic current`, then
 *      `pytest server/test_postgres_financial_review.py server/test_postgres_studio_jobs.py`
 *      (the studio jobs loop's sweep and alert scenarios, plan tasks P1-19 and P1-21);
 *   4. ALWAYS removes the container: on success, on failure and on Ctrl-C.
 * A skipped scenario counts as a failure: a release must show they ran.
 * 36-40 s on the owner's PC (2026-09-25: start 2 s, migrations 1.5 s, scenarios 32-35 s);
 * about 43 s with the studio jobs scenarios (scenarios 38-39 s).
 *
 * Usage:
 *   npm run test:postgres                 (also run by npm run release:image:push)
 *   PYTHON=<path to python.exe> npm run test:postgres
 */
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { isolatedTestEnvironment } = require('./lib/test-environment');

const ROOT = path.join(__dirname, '..');
const IMAGE = 'postgres:16-alpine';
const DB_NAME = 'albayan_test_release'; // the name test_postgres_financial_review.py accepts
const DB_USER = 'albayan';
const LABEL = 'albayan.release-postgres.expires';
const LIFETIME_MS = 60 * 60 * 1000; // a run killed without cleanup is removed by the next run after this
const READY_TIMEOUT_MS = 120_000;
const TEST_FILES = ['server/test_postgres_financial_review.py', 'server/test_postgres_studio_jobs.py'];

const password = crypto.randomBytes(24).toString('hex'); // hex: nothing to escape in the URL
const container = `albayan-release-pg-${crypto.randomBytes(4).toString('hex')}`;
let started = false;
let removed = false;

function removeContainer() {
  if (!started || removed) return;
  removed = true;
  const result = spawnSync('docker', ['rm', '--force', '--volumes', container], { encoding: 'utf8' });
  if (result.status === 0) console.log(`Removed the throwaway PostgreSQL container ${container}.`);
  else if (!/no such container/i.test(result.stderr || '')) {
    console.error(`Could not remove ${container}; remove it by hand: docker rm -f ${container}`);
  }
}

process.on('exit', removeContainer);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    console.error(`\n${signal}: stopping the PostgreSQL release check.`);
    removeContainer();
    process.exit(130);
  });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

function docker(args, options = {}) {
  return spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', shell: false, ...options });
}

function redact(value) {
  return String(value || '').split(password).join('[redacted]');
}

/** Removes containers left by a run that was killed too hard to clean up (older than LIFETIME_MS). */
function removeExpiredContainers() {
  const listed = docker(['ps', '--all', '--filter', `label=${LABEL}`, '--format', `{{.ID}} {{.Label "${LABEL}"}}`]);
  if (listed.status !== 0) return;
  for (const line of listed.stdout.split(/\r?\n/)) {
    const [id, expires] = line.trim().split(/\s+/);
    if (id && Number(expires) > 0 && Number(expires) < Date.now()) {
      docker(['rm', '--force', '--volumes', id]);
      console.log(`Removed an expired release-check container (${id}).`);
    }
  }
}

function findPython() {
  const venvPython = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');
  const candidates = process.env.PYTHON
    ? [[process.env.PYTHON, []]]
    : process.platform === 'win32'
      ? [[venvPython, []], ['py', ['-3']], ['python', []], ['python3', []]]
      : [[venvPython, []], ['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '-c', 'import alembic, psycopg, pytest, sqlalchemy, fastapi'], {
      cwd: ROOT, stdio: 'ignore', shell: false,
    });
    if (!probe.error && probe.status === 0) return { command, prefix };
  }
  return null;
}

/** The ordinary isolated test environment, pointed at the throwaway database only. */
function postgresEnvironment(url) {
  const env = isolatedTestEnvironment(process.env, 'sqlite+pysqlite:///:memory:');
  for (const key of Object.keys(env)) {
    if (/^PG[A-Z]/.test(key)) delete env[key]; // libpq would honour PGHOST, PGSERVICE, PGOPTIONS...
  }
  delete env.ALBAYAN_ALLOW_SQLITE;
  delete env.PYTEST_ADDOPTS; // a leftover "-k ..." must not quietly deselect scenarios
  return { ...env, DATABASE_URL: url, ALBAYAN_TEST_POSTGRES_URL: url, PYTHONDONTWRITEBYTECODE: '1' };
}

/** Runs a command, streaming its output, and resolves with its exit code and (redacted) stdout. */
function run(command, args, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: ROOT, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => {
      const textChunk = redact(chunk.toString('utf8'));
      stdout = (stdout + textChunk).slice(-65_536);
      process.stdout.write(textChunk);
    });
    child.stderr.on('data', chunk => process.stderr.write(redact(chunk.toString('utf8'))));
    child.on('error', error => resolve({ code: 1, stdout: `${stdout}\n${error.message}` }));
    child.on('close', code => resolve({ code: code ?? 1, stdout }));
  });
}

function fail(message) {
  console.error(`\nPostgreSQL release check FAILED: ${message}`);
  process.exit(1);
}

async function main() {
  const began = Date.now();
  const timings = [];
  const step = (name, since) => timings.push([name, Date.now() - since]);

  const version = docker(['version', '--format', '{{.Server.Version}}']);
  if (version.status !== 0) fail('Docker is not running. Start Docker Desktop and try again.');
  const python = findPython();
  if (!python) {
    fail('no Python with the server packages was found. Create .venv and install server/requirements.txt, or set PYTHON.');
  }
  removeExpiredContainers();

  let since = Date.now();
  console.log(`Starting a throwaway ${IMAGE} (${container}) on a random 127.0.0.1 port...`);
  // The password reaches Docker through the environment, never the command line.
  started = true; // from here on, every exit removes the container (a failed start can leave one)
  const startedRun = docker([
    'run', '--detach', '--rm', '--name', container,
    '--label', `${LABEL}=${Date.now() + LIFETIME_MS}`,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_DB=${DB_NAME}`, '--env', `POSTGRES_USER=${DB_USER}`, '--env', 'POSTGRES_PASSWORD',
    IMAGE,
  ], { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'inherit'] });
  if (startedRun.status !== 0) fail('Docker could not start the PostgreSQL container.');

  const mapped = docker(['port', container, '5432/tcp']);
  const port = Number((mapped.stdout.match(/127\.0\.0\.1:(\d+)/) || [])[1]);
  if (!port) fail('Docker did not report the loopback port of the PostgreSQL container.');

  // The image's first-start set-up listens on a socket only; TCP answers once the real server runs.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const ready = docker(['exec', container, 'pg_isready', '--quiet', '-h', '127.0.0.1', '-U', DB_USER, '-d', DB_NAME]);
    if (ready.status === 0) break;
    const running = docker(['inspect', '--format', '{{.State.Running}}', container]);
    if (running.status !== 0 || running.stdout.trim() !== 'true') {
      docker(['logs', container], { stdio: 'inherit' });
      fail('the PostgreSQL container stopped before it was ready.');
    }
    if (Date.now() > deadline) fail(`PostgreSQL was not ready after ${seconds(READY_TIMEOUT_MS)}.`);
    await sleep(500);
  }
  step('start PostgreSQL 16', since);
  console.log(`PostgreSQL 16 is ready on 127.0.0.1:${port}.`);

  const url = `postgresql+psycopg://${DB_USER}:${password}@127.0.0.1:${port}/${DB_NAME}`;
  const env = postgresEnvironment(url);
  const py = (...args) => run(python.command, [...python.prefix, ...args], env);

  since = Date.now();
  console.log('\n> python -m alembic upgrade head');
  if ((await py('-m', 'alembic', 'upgrade', 'head')).code !== 0) fail('the database migrations failed.');
  console.log('> python -m alembic current');
  if ((await py('-m', 'alembic', 'current')).code !== 0) fail('alembic could not read the migrated version.');
  step('alembic upgrade head', since);

  since = Date.now();
  console.log(`\n> python -m pytest -q -p no:cacheprovider -rs ${TEST_FILES.join(' ')}`);
  const tests = await py('-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-rs', ...TEST_FILES);
  step('PostgreSQL financial scenarios', since);
  if (tests.code !== 0) fail('a PostgreSQL financial scenario failed (see above).');
  if (/\b\d+ (?:skipped|deselected)\b/.test(tests.stdout)) {
    fail('scenarios were skipped; the release must prove they ran on PostgreSQL.');
  }
  if (!/\b\d+ passed\b/.test(tests.stdout)) fail('pytest reported no passed scenarios.');

  console.log('\nPostgreSQL release check passed:');
  for (const [name, ms] of timings) console.log(`  ${name.padEnd(32)} ${seconds(ms)}`);
  console.log(`  ${'total'.padEnd(32)} ${seconds(Date.now() - began)}`);
}

main().then(() => process.exit(0), error => fail(redact(error && error.stack ? error.stack : error)));
