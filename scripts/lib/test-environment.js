const path = require('path');

/** A test process must never inherit a live database or outbound integration. */
function isolatedTestEnvironment(parent, databaseUrl) {
  if (!/^sqlite\+pysqlite:\/\/\//.test(databaseUrl)) {
    throw new Error('Default tests require an explicitly isolated SQLite database.');
  }
  const env = { ...parent };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'ALBAYAN_E2E_PYTHON') continue;
    if (/^(DATABASE_URL|ALBAYAN_DATABASE_URL|ALBAYAN_DB_.*|REDIS_URL|ALBAYAN_META_.*|ALBAYAN_BACKUP_.*|ALBAYAN_ALERT_WEBHOOK_URL|ALBAYAN_E2E_.*|ALBAYAN_TEST_POSTGRES_URL)$/i.test(key)) {
      delete env[key];
    }
  }
  return {
    ...env,
    DATABASE_URL: databaseUrl,
    PYTHONIOENCODING: 'utf-8',
    ALBAYAN_META_ACCESS_TOKEN: '',
    ALBAYAN_META_APP_SECRET: '',
    ALBAYAN_META_BACKGROUND_SYNC: 'false',
    ALBAYAN_META_AUTO_IMPORT: 'false',
    ALBAYAN_COOKIE_SECURE: 'false',
    ALBAYAN_DEBUG_MODE: 'false',
    ALBAYAN_ENABLE_ONLINE_IMPORT: 'false',
  };
}

function sqliteTestUrl(file) {
  return `sqlite+pysqlite:///${path.resolve(file).replace(/\\/g, '/')}`;
}

module.exports = { isolatedTestEnvironment, sqliteTestUrl };
