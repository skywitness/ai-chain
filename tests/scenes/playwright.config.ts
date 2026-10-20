/**
 * Scene test suite (headless WebGL through SwiftShader) against the dev sandbox /dev/scenes/<id>/.
 *
 *   npx playwright test tests/scenes --config tests/scenes/playwright.config.ts
 *   SCENE=neural-net npx playwright test tests/scenes --config tests/scenes/playwright.config.ts
 *   SCENE_BASE_URL=http://127.0.0.1:4401 …   (default http://127.0.0.1:4321, a running `astro dev`)
 *
 * Projects: `light` and `dark` (colour scheme + html[data-theme] via ?theme=).
 */
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env['SCENE_BASE_URL'] ?? process.env['BASE_URL'] ?? 'http://127.0.0.1:4321';
const launchOptions = {
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
};

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: '../../test-results/scenes',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env['CI'] ? 1 : 2,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'light',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light', launchOptions },
    },
    {
      name: 'dark',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark', launchOptions },
    },
  ],
});
