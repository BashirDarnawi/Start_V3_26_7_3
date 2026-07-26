/**
 * Start an isolated Albayan server for Playwright.
 *
 * The database lives only under .tmp/e2e and is recreated for each run. This
 * makes the browser suite deterministic and prevents it from ever touching a
 * developer or production database.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, '.tmp', 'e2e');
const DB_PATH = path.join(TMP_DIR, 'albayan-e2e.db');

fs.mkdirSync(TMP_DIR, { recursive: true });
for (const suffix of ['', '-shm', '-wal']) {
  fs.rmSync(`${DB_PATH}${suffix}`, { force: true });
}

function findPython() {
  const configured = String(process.env.ALBAYAN_E2E_PYTHON || '').trim();
  const candidates = configured
    ? [configured]
    : process.platform === 'win32'
      ? [path.join(ROOT, '.venv', 'Scripts', 'python.exe'), 'python']
      : [path.join(ROOT, '.venv', 'bin', 'python'), 'python3', 'python'];

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error('Python was not found. Set ALBAYAN_E2E_PYTHON to the Python executable.');
}

const child = spawn(findPython(), [
  '-m', 'uvicorn', 'server.main:app',
  '--host', '127.0.0.1',
  '--port', '18081'
], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    ALBAYAN_DB_PATH: DB_PATH,
    ALBAYAN_COOKIE_SECURE: 'false',
    ALBAYAN_DEBUG_MODE: 'false',
    ALBAYAN_ENABLE_ONLINE_IMPORT: 'false',
    ALBAYAN_META_ACCESS_TOKEN: '',
    ALBAYAN_META_APP_SECRET: '',
    ALBAYAN_META_BACKGROUND_SYNC: 'false',
    ALBAYAN_BOOTSTRAP_ADMIN_EMAIL: 'e2e.admin@albayan.example.com',
    ALBAYAN_BOOTSTRAP_ADMIN_PASSWORD: 'E2eAdminPassword123!',
    ALBAYAN_BOOTSTRAP_ADMIN_NAME: 'E2E Administrator'
  }
});

let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill(signal);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('exit', () => stop());

child.on('exit', code => {
  process.exitCode = Number.isInteger(code) ? code : 1;
});
