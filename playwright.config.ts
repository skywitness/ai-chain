// Playwright configuration for every browser test in the repo:
//   tests/e2e     route smoke tests        (npm run test:e2e)
//   tests/a11y    axe per template          (npx playwright test tests/a11y)
//   tests/scenes  WebGL scene tests         (npm run test:scene — owned by the 3D agent)
//
// Environment:
//   BASE_URL       server under test (default http://127.0.0.1:4321; the shared dev server)
//   BASE_PATH      Astro base path the server uses (default "/")
//   PW_WEBSERVER   unset (default) → you run the server yourself; "dev" → astro dev; "preview" → astro preview (needs dist/)
//   PW_WORKERS     worker count or percentage (default 50%, 2 in CI)
//   PW_CHANNEL     Chromium channel (default "chromium" = new headless; "" = headless shell)
//   CI             forbids test.only, enables 1 retry and the JSON report
// See docs/QA.md for the full verify sequence.
import { defineConfig, devices } from '@playwright/test';
import { CHROMIUM_CHANNEL, VIEWPORTS, WEBGL_ARGS } from './tests/helpers/browser';
import { BASE_URL } from './tests/helpers/env';

const CI = !!process.env['CI'];
const webServerMode = process.env['PW_WEBSERVER'];
const port = Number(new URL(BASE_URL).port || 80);

function workers(): number | string {
  const w = process.env['PW_WORKERS'];
  if (w) return /%$/.test(w) ? w : Number(w);
  return CI ? 2 : '50%';
}

const webServer =
  webServerMode === 'dev' || webServerMode === 'preview'
    ? {
        webServer: {
          command: `npx astro ${webServerMode} --port ${port} --host 127.0.0.1`,
          url: BASE_URL + (process.env['BASE_PATH'] ?? '/').replace(/^\/?/, '/'),
          reuseExistingServer: true,
          timeout: 180_000,
          stdout: 'ignore' as const,
          stderr: 'pipe' as const,
        },
      }
    : {};

// Mobile project: a 390×844 phone (task spec) with a current Android Chrome user agent.
const MOBILE_UA = devices['Pixel 7'].userAgent;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: workers(),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  reporter: CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['json', { outputFile: 'test-results/results.json' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ...(CHROMIUM_CHANNEL ? { channel: CHROMIUM_CHANNEL } : {}),
    launchOptions: { args: WEBGL_ARGS },
  },
  projects: [
    {
      name: 'desktop',
      use: {
        browserName: 'chromium',
        viewport: { ...VIEWPORTS.desktop },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      },
    },
    {
      name: 'mobile',
      use: {
        browserName: 'chromium',
        userAgent: MOBILE_UA,
        viewport: { ...VIEWPORTS.mobile },
        // 1× keeps SwiftShader fast; layout is measured in CSS pixels either way.
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  ...webServer,
});
