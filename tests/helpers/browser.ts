// Browser-side helpers shared by specs and capture scripts: launch flags, viewports, theme forcing,
// settling (network, fonts, scenes) and motion freezing.
import type { BrowserContext, Page } from '@playwright/test';

/** Headless Chromium no longer falls back to SwiftShader on its own; these flags enable WebGL2 in CI. */
export const WEBGL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/**
 * Chromium channel: "chromium" = full Chromium in new headless mode (what the scene tests are specified against).
 * Set PW_CHANNEL="" (empty) to use the lighter chromium-headless-shell instead.
 */
export const CHROMIUM_CHANNEL: string | undefined =
  process.env['PW_CHANNEL'] === undefined ? 'chromium' : process.env['PW_CHANNEL'] || undefined;

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

/** Narrowest width the layout must support without horizontal page scroll (architecture §7.5). */
export const MIN_WIDTH = 320;

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** CSS that removes transitions/animations so contrast checks and screenshots see final colours. */
export const NO_MOTION_CSS =
  '*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';

/**
 * tsx/esbuild compile scripts with keepNames, which wraps named inner functions in `__name(fn, "name")`.
 * Functions serialised into the page by page.evaluate()/addInitScript() then throw "__name is not defined".
 * Scripts run with tsx install this shim on every BrowserContext they create (the Playwright test runner
 * does not need it).
 */
export const EVAL_SHIM = 'globalThis.__name = globalThis.__name || function (fn) { return fn; };';

/** Install EVAL_SHIM on a context (before any page is opened). */
export async function installEvalShim(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript({ content: EVAL_SHIM });
}

/** Scene element states (architecture §4.2 and scenes3d §A5 use slightly different names; both are accepted). */
const SCENE_BUSY = ['loading', 'mounting'];
const SCENE_DONE = ['ready', 'running', 'paused', 'fallback', 'error', 'contextlost', 'disposed'];

/**
 * Make the next navigation render in `theme`: emulates prefers-color-scheme (so a "system" default resolves
 * to it) and pins html[data-theme] as early as the document allows.
 * Call before page.goto(); call applyTheme() after load to re-assert it.
 */
export async function prepareTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((t: string) => {
    const pin = () => {
      const html = document.documentElement;
      if (html && html.getAttribute('data-theme') !== t) html.setAttribute('data-theme', t);
    };
    pin();
    document.addEventListener('DOMContentLoaded', pin, { once: true });
  }, theme);
}

/** Force html[data-theme] (and prefers-color-scheme) on a loaded page and wait for the restyle. */
export async function applyTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await nextFrames(page, 2);
}

/** Wait for n animation frames in the page. */
export async function nextFrames(page: Page, n = 2): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((done) => {
        let left = count;
        const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}

/** Freeze CSS motion (transitions, animations, smooth scroll). */
export async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({ content: NO_MOTION_CSS });
}

/**
 * Let a freshly loaded page settle: network idle (bounded), web fonts, two frames.
 * Never throws on timeout — a page that keeps a connection open must not hang the run.
 */
export async function settle(page: Page, opts: { networkIdleMs?: number } = {}): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: opts.networkIdleMs ?? 5000 }).catch(() => undefined);
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => undefined) : undefined)).catch(() => undefined);
  await nextFrames(page, 2).catch(() => undefined);
}

export interface SceneStatus {
  id: string;
  state: string;
}

/**
 * Wait until no <ai-scene> is still loading. Scenes that never started (lazy, off-screen, click-to-load)
 * count as settled once `graceMs` has passed, which covers the idle autoload (requestIdleCallback ≤ 2 s).
 * Returns the final state of every scene; never throws.
 */
export async function waitForScenes(page: Page, opts: { timeoutMs?: number; graceMs?: number } = {}): Promise<SceneStatus[]> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const graceMs = opts.graceMs ?? 2500;
  const count = await page.locator('ai-scene').count().catch(() => 0);
  if (count > 0) {
    await page
      .waitForFunction(
        ({ busy, done, grace, start }) => {
          const els = Array.from(document.querySelectorAll('ai-scene'));
          const elapsed = Date.now() - start;
          return els.every((el) => {
            const s = el.getAttribute('data-state') ?? '';
            if (done.includes(s)) return true;
            if (busy.includes(s)) return false;
            return elapsed > grace;
          });
        },
        { busy: SCENE_BUSY, done: SCENE_DONE, grace: graceMs, start: Date.now() },
        { timeout: timeoutMs, polling: 250 },
      )
      .catch(() => undefined);
  }
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('ai-scene')).map((el) => ({
        id: el.getAttribute('data-id') ?? el.getAttribute('scene') ?? '',
        state: el.getAttribute('data-state') ?? '',
      })),
    )
    .catch(() => []);
}
