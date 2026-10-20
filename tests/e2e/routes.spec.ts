// Route smoke test: one test per route, in both projects (desktop 1440×900, mobile 390×844).
//
// Routes: ROUTES_FROM=dist (every dist/**/index.html) or ROUTES="/ /chain/ …" (see tests/helpers/routes.ts).
// Per route: HTTP 200 · title ends with 「｜AI 產業鏈全景」 (home: starts with 「AI 產業鏈全景」) · exactly one <h1> ·
// <html lang="zh-TW"> · no console.error / pageerror / failed same-origin request · no horizontal overflow
// (mobile project: at 390 px and at 320 px; desktop project: at 1440 px).
// Shard-friendly: every route is its own test, so `--shard=i/n` splits routes evenly.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { settle, MIN_WIDTH, VIEWPORTS, waitForScenes } from '../helpers/browser';
import { BASE_URL, ROOT, SITE_NAME, TITLE_SUFFIX, envFlag, urlFor } from '../helpers/env';
import { describeOverflow, measureOverflow, trackProblems } from '../helpers/page-checks';
import { discoverRoutes } from '../helpers/routes';

const { routes, source, error } = discoverRoutes();

test.describe.configure({ mode: 'parallel' });

if (error || routes.length === 0) {
  test('route discovery', () => {
    throw new Error(error ?? `no routes found (source: ${source}); set ROUTES or ROUTES_FROM=dist`);
  });
}

for (const route of routes) {
  test(`route ${route}`, { tag: '@route' }, async ({ page }, testInfo) => {
    const url = urlFor(route);
    const tracker = trackProblems(page, { origin: BASE_URL });
    testInfo.annotations.push({ type: 'url', description: url }, { type: 'routes', description: source });

    const res = await page.goto(url, { waitUntil: 'load' });
    expect(res, `no response for ${url}`).not.toBeNull();
    expect(res?.status(), `HTTP status of ${url}`).toBe(200);

    await settle(page);
    // Let lazily activated scenes finish so their errors are caught here, not in a later test.
    if (!envFlag('QA_SKIP_SCENES')) await waitForScenes(page, { timeoutMs: 15000 });

    // ── document basics ──
    const title = (await page.title()).trim();
    if (route === '/') {
      expect.soft(title.startsWith(SITE_NAME), `home title "${title}" should start with 「${SITE_NAME}」`).toBe(true);
    } else {
      expect.soft(title.endsWith(TITLE_SUFFIX), `title "${title}" should end with 「${TITLE_SUFFIX}」`).toBe(true);
      expect.soft(title.length > TITLE_SUFFIX.length, `title "${title}" has no page name before the suffix`).toBe(true);
    }
    const h1s = await page.locator('h1').allInnerTexts();
    expect.soft(h1s.length, `expected exactly one <h1>, found ${h1s.length}: ${JSON.stringify(h1s)}`).toBe(1);
    const lang = await page.evaluate(() => document.documentElement.getAttribute('lang'));
    expect.soft(lang, '<html lang>').toBe('zh-TW');

    // ── horizontal overflow ──
    const vp = page.viewportSize() ?? VIEWPORTS.desktop;
    if (testInfo.project.use.isMobile || vp.width <= VIEWPORTS.mobile.width) {
      const at390 = await measureOverflow(page);
      expect
        .soft(at390.viewportWidth, `layout viewport is ${at390.viewportWidth}px at a ${vp.width}px screen — missing <meta name="viewport" content="width=device-width, initial-scale=1">?`)
        .toBeLessThanOrEqual(vp.width);
      expect.soft(at390.overflowPx, `at ${vp.width}px: ${describeOverflow(at390)}`).toBeLessThanOrEqual(0);

      await page.setViewportSize({ width: MIN_WIDTH, height: vp.height });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const at320 = await measureOverflow(page);
      expect.soft(at320.overflowPx, `at ${MIN_WIDTH}px: ${describeOverflow(at320)}`).toBeLessThanOrEqual(0);
    } else {
      const atDesktop = await measureOverflow(page);
      expect.soft(atDesktop.overflowPx, `at ${vp.width}px: ${describeOverflow(atDesktop)}`).toBeLessThanOrEqual(0);
    }

    // ── runtime health (collected over the whole visit, including the resize) ──
    tracker.dispose();
    const problems = tracker.all();
    if (problems.length) await testInfo.attach('problems.txt', { body: problems.join('\n'), contentType: 'text/plain' });
    expect(problems, `console errors / page errors / failed requests on ${route}:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
}

// The custom 404 page (only once src/pages/404.astro exists): status 404 plus the same document basics.
test('unknown route answers 404', { tag: '@route' }, async ({ page }) => {
  const url = urlFor('/qa-missing-page-404/');
  const tracker = trackProblems(page, { origin: BASE_URL, expectedErrorUrls: [url] });
  const res = await page.goto(url, { waitUntil: 'load' });
  expect(res?.status(), `HTTP status of ${url}`).toBe(404);
  if (!existsSync(resolve(ROOT, 'src/pages/404.astro'))) {
    test.info().annotations.push({ type: 'note', description: 'src/pages/404.astro 尚不存在：只檢查狀態碼' });
    return;
  }
  await settle(page);
  expect.soft(await page.locator('h1').count(), 'one <h1> on the 404 page').toBe(1);
  expect.soft(await page.evaluate(() => document.documentElement.lang), '<html lang>').toBe('zh-TW');
  expect.soft((await page.title()).endsWith(TITLE_SUFFIX), '404 title suffix').toBe(true);
  tracker.dispose();
  expect(tracker.all()).toEqual([]);
});
