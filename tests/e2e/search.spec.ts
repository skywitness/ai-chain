// Site search (architecture §7.1): through the real UI — header 搜尋 button → <pagefind-modal> — each
// query must list the expected page among the first three results. Pagefind only exists after
// `npm run build`, so run this against the preview server (or any server for dist/); on the dev
// server the test is skipped. Desktop project only (the search UI is the same on phones).
//
//   npx astro preview --port 4321 --host 127.0.0.1
//   npx playwright test tests/e2e/search.spec.ts --project=desktop
import { expect, test } from '@playwright/test';
import { stripBase, urlFor } from '../helpers/env';
import { trackProblems } from '../helpers/page-checks';

/** query → acceptable result paths (base-less; a glossary hit may land on its #anchor). */
const CASES: [string, RegExp][] = [
  ['先進封裝', /^\/(learn\/advanced-packaging-(intro|deep)|chain\/foundry-packaging|glossary)\//],
  ['高頻寬記憶體', /^\/(learn\/(memory-and-hbm|hbm-deep)|chain\/memory-storage|glossary)\//],
  ['TSMC', /^\/companies\/tsmc\/$/],
  ['台積電', /^\/companies\/tsmc\/$/],
  ['輝達', /^\/companies\/nvidia\/$/],
  // Retried by the client-side fallback in src/client/search-loader.ts (no direct hit in Pagefind).
  ['三星電子', /^\/companies\/samsung-electronics\/$/],
  ['艾司摩爾', /^\/companies\/asml\/$/],
];

test.describe('site search', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'desktop only');
    const res = await request.get(urlFor('/pagefind/pagefind.js'));
    test.skip(!res.ok(), 'no Pagefind bundle on this server (dev server?) — run against a build');
  });

  test('Chinese and English queries find the expected pages', async ({ page }) => {
    const tracker = trackProblems(page, { origin: urlFor('/') });
    await page.goto(urlFor('/'), { waitUntil: 'load' });
    await page.locator('[data-search-trigger]').first().click();
    const input = page.locator('pagefind-modal input').first();
    await expect(input).toBeVisible({ timeout: 15_000 });

    for (const [query, want] of CASES) {
      await input.fill(query);
      await expect
        .poll(
          async () => {
            const hrefs = await page.$$eval('pagefind-modal a[href]', (as) =>
              as.map((a) => a.getAttribute('href') ?? ''),
            );
            const pages = [...new Set(hrefs.map((h) => h.split('#')[0] ?? ''))].filter(Boolean).slice(0, 3);
            return pages.map((p) => stripBase(new URL(p, 'http://x').pathname) ?? p);
          },
          { message: `「${query}」 top 3`, timeout: 10_000 },
        )
        .toEqual(expect.arrayContaining([expect.stringMatching(want)]));
    }
    expect(tracker.all(), 'console / network problems').toEqual([]);
    tracker.dispose();
  });
});
