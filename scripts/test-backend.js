#!/usr/bin/env node
/**
 * Run the FastAPI test suite with a usable local Python installation, falling
 * back to Docker when Python or the required packages are not installed.
 *
 * Override automatic selection with:
 *   ALBAYAN_BACKEND_TEST_RUNNER=python npm run test:backend
 *   ALBAYAN_BACKEND_TEST_RUNNER=docker npm run test:backend
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PYTEST_ARGS = ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'];
const LOCAL_PYTEST_BASETEMP = '.pytest_tmp_backend';
const DOCKER_PYTEST_BASETEMP = '/tmp/albayan-pytest';

function run(command, args, options = {}) {
  const { quiet = false, ...spawnOptions } = options;
  return spawnSync(command, args, {
    cwd: ROOT,
    stdio: quiet ? 'ignore' : 'inherit',
    shell: false,
    ...spawnOptions,
  });
}

function available(command, args) {
  const result = run(command, args, { quiet: true });
  return !result.error && result.status === 0;
}

function findPython() {
  const configured = process.env.PYTHON;
  const projectVenvPython = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');
  const candidates = configured
    ? [[configured, []]]
    : process.platform === 'win32'
      ? [[projectVenvPython, []], ['py', ['-3']], ['python', []], ['python3', []]]
      : [[projectVenvPython, []], ['python3', []], ['python', []]];

  for (const [command, prefix] of candidates) {
    if (!available(command, [...prefix, '--version'])) continue;
    if (!available(command, [...prefix, '-c', 'import fastapi, httpx, pytest, sqlalchemy'])) continue;
    return { command, prefix };
  }
  return null;
}

function testWithPython() {
  const python = findPython();
  if (!python) return null;
  console.log(`Running backend tests with ${python.command}...`);
  // Some Windows installations deny access to the shared %TEMP% pytest
  // directory after another test process has used it. Keep pytest's scratch
  // files inside this workspace so the release check is deterministic.
  return run(python.command, [
    ...python.prefix,
    ...PYTEST_ARGS,
    '--basetemp', LOCAL_PYTEST_BASETEMP,
  ]).status;
}

function testWithDocker() {
  if (!available('docker', ['version'])) return null;

  const image = 'albayan-local-tests';
  console.log('No ready Python environment found; building an isolated Docker test image...');
  const build = run('docker', ['build', '--tag', image, '--file', 'server/Dockerfile', '.']);
  if (build.status !== 0) return build.status ?? 1;

  console.log('Running backend tests in Docker...');
  return run('docker', [
    'run', '--rm',
    '--env', 'ALBAYAN_COOKIE_SECURE=false',
    '--env', 'ALBAYAN_DB_PATH=/tmp/albayan-tests.db',
    image,
    'python', ...PYTEST_ARGS, '--basetemp', DOCKER_PYTEST_BASETEMP,
  ]).status;
}

const requested = String(process.env.ALBAYAN_BACKEND_TEST_RUNNER || 'auto').toLowerCase();
if (!['auto', 'python', 'docker'].includes(requested)) {
  console.error('ALBAYAN_BACKEND_TEST_RUNNER must be auto, python, or docker.');
  process.exit(2);
}

let status = null;
if (requested !== 'docker') status = testWithPython();
if (status === null && requested !== 'python') status = testWithDocker();

if (status === null) {
  console.error(
    'Backend tests could not start. Create .venv and install server/requirements.txt, ' +
    'or start Docker Desktop, then run npm run test:backend again.'
  );
  process.exit(1);
}
process.exit(status ?? 1);
