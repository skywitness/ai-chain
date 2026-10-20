// Accessibility: axe-core on one URL per page template, in light and dark, in both projects.
// Gate: zero serious or critical violations of WCAG 2.0/2.1/2.2 A + AA rules.
// axe "best-practice" findings are reported as annotations/attachments but do not fail the test.
//
//   A11Y_ROUTES="home=/ company-profile=/companies/tsmc/ /extra/route/"   override or extend the URL picks
//   QA_STRICT=1   a template whose route is missing (404) fails instead of being skipped
// Templates and the representative pick live in tests/helpers/routes.ts (TEMPLATES / resolveTemplates).
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { THEMES, applyTheme, freezeMotion, prepareTheme, settle, waitForScenes } from '../helpers/browser';
import { envFlag, urlFor } from '../helpers/env';
import { resolveTemplates } from '../helpers/routes';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const GATING_IMPACTS = new Set(['serious', 'critical']);
const STRICT = envFlag('QA_STRICT');

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type Violation = AxeResults['violations'][number];

function formatViolations(vs: Violation[]): string {
  return vs
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 5)
        .map((n) => `      - ${n.target.join(' ')}${n.failureSummary ? `\n        ${n.failureSummary.replace(/\n/g, '\n        ')}` : ''}`)
        .join('\n');
      const more = v.nodes.length > 5 ? `\n      … ${v.nodes.length - 5} more` : '';
      return `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${nodes}${more}`;
    })
    .join('\n');
}

const templates = resolveTemplates();

test.describe.configure({ mode: 'parallel' });

for (const t of templates) {
  for (const theme of THEMES) {
    test(`axe ${t.id} ${t.resolved ?? '(none)'} [${theme}]`, { tag: '@a11y' }, async ({ page }, testInfo) => {
      if (!t.resolved) {
        test.skip(!STRICT, `${t.label}：${t.reason ?? '尚無可測頁面'}`);
        throw new Error(`${t.id}: ${t.reason ?? 'no representative route'}`);
      }
      const url = urlFor(t.resolved);
      testInfo.annotations.push({ type: 'url', description: url });

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await prepareTheme(page, theme);
      const res = await page.goto(url, { waitUntil: 'load' });
      const status = res?.status() ?? 0;
      const expected = t.expectStatus ?? 200;
      if (status !== expected) {
        test.skip(!STRICT && status === 404, `${t.label} ${t.resolved} 尚未實作（HTTP 404）`);
        throw new Error(`${url} answered HTTP ${status}, expected ${expected}`);
      }

      await settle(page);
      await waitForScenes(page, { timeoutMs: 15000 });
      await applyTheme(page, theme);
      await freezeMotion(page);

      const results = await new AxeBuilder({ page })
        .withTags([...WCAG_TAGS, 'best-practice'])
        .analyze();
      await testInfo.attach(`axe-${t.id}-${theme}.json`, {
        body: JSON.stringify({ url, theme, violations: results.violations, incomplete: results.incomplete }, null, 1),
        contentType: 'application/json',
      });

      const isWcag = (v: Violation) => v.tags.some((tag) => WCAG_TAGS.includes(tag));
      const gating = results.violations.filter((v) => isWcag(v) && GATING_IMPACTS.has(v.impact ?? ''));
      const advisory = results.violations.filter((v) => !gating.includes(v));
      for (const v of advisory)
        testInfo.annotations.push({ type: `axe ${v.impact ?? 'n/a'}`, description: `${v.id} (${v.nodes.length}) — ${v.help}` });

      expect(
        gating.map((v) => `${v.impact} ${v.id} ×${v.nodes.length}`),
        `${gating.length} serious/critical WCAG violation(s) on ${url} [${theme}]:\n${formatViolations(gating)}`,
      ).toEqual([]);
    });
  }
}
