const { defineConfig, devices } = require('@playwright/test');

const baseURL = process.env.ALBAYAN_E2E_BASE_URL || 'http://127.0.0.1:18081';

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'en-US',
    timezoneId: 'Africa/Tripoli'
  },
  webServer: process.env.ALBAYAN_E2E_EXTERNAL_SERVER
    ? undefined
    : {
        command: 'node scripts/start-e2e-server.js',
        url: `${baseURL}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000
      },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] }
    },
    {
      name: 'mobile-webkit',
      use: { ...devices['iPhone 15'] }
    }
  ]
});
