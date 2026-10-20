/**
 * Parameterised scene spec. Runs every scene folder in src/three/scenes (or SCENE=a,b) against the
 * dev sandbox /dev/scenes/<id>/ in the `light` and `dark` projects. Checks:
 *  1. ready (data-state running/paused) within 20 s, frames ≥ 3, drawCalls > 0, within budget;
 *  2. a non-blank canvas (luminance standard deviation > 4, computed with sharp; DOM overlays hidden);
 *  3. every variant and every guided step switch (state, aria-current, variant follow-through);
 *  4. reduced motion: demand loop, frames stop increasing;
 *  5. WebGL disabled: data-state="fallback", poster visible, toolbar steps still work;
 *  6. no horizontal page scroll at 320 px;
 *  7. no console errors / page errors (and no THREE.* warnings) in any of the above.
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

interface Meta {
  id: string;
  variants: string[];
  defaultVariant: string;
  steps?: { id: string; title: string; variant?: string }[];
}
interface Stats {
  frames: number;
  drawCalls: number;
  triangles: number;
  quality: string | null;
  state: string;
  variant: string;
  step: number;
  animate: boolean;
  loop: string;
  budget: { calls: number; tris: number } | null;
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCENES = join(ROOT, 'src/three/scenes');
const ids = (process.env['SCENE'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const sceneIds = ids.length
  ? ids
  : readdirSync(SCENES).filter((d) => existsSync(join(SCENES, d, 'index.ts')) && existsSync(join(SCENES, d, 'meta.json')));

const READY_MS = 20_000;
const OVERLAYS = '.scene-labels,.scene-badge,.scene-card,.scene-status,.scene-hint,.scene-poster,.sandbox-stats{visibility:hidden!important}';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push(`console.error: ${t}`);
    else if (m.type() === 'warning' && /THREE\./.test(t)) errors.push(`THREE warning: ${t}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const stats = (page: Page): Promise<Stats> =>
  page.evaluate(() => (document.querySelector('ai-scene') as unknown as { stats: Stats }).stats);

async function open(page: Page, id: string, query: string): Promise<void> {
  // Vite may reload the page once while it optimises dependencies on first visit: retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(`/dev/scenes/${id}/${query}`, { waitUntil: 'load' });
      await page.waitForSelector('ai-scene', { state: 'attached', timeout: 15_000 });
      return;
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
}

async function waitReady(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.waitForFunction(
        () => {
          const s = (document.querySelector('ai-scene') as unknown as { stats?: Stats } | null)?.stats;
          if (s?.state === 'error') throw new Error('scene entered the error state');
          return s && (s.state === 'running' || s.state === 'paused');
        },
        null,
        { timeout: READY_MS },
      );
      return;
    } catch (e) {
      if (attempt === 1 || !/context was destroyed|navigation/i.test(String(e))) throw e;
      await page.waitForLoadState('load');
    }
  }
}

async function canvasStdev(page: Page): Promise<number> {
  const style = await page.addStyleTag({ content: OVERLAYS });
  const png = await page.locator('.scene-stage').first().screenshot();
  await style.evaluate((n) => (n as unknown as HTMLElement).remove());
  const st = await sharp(png).greyscale().stats();
  return st.channels[0]?.stdev ?? 0;
}

async function framesAdvance(page: Page): Promise<void> {
  const f0 = (await stats(page)).frames;
  await expect.poll(async () => (await stats(page)).frames, { timeout: 10_000 }).toBeGreaterThan(f0);
}

for (const id of sceneIds) {
  const meta = JSON.parse(readFileSync(join(SCENES, id, 'meta.json'), 'utf8')) as Meta;
  const steps = meta.steps ?? [];

  test.describe(`scene ${id}`, () => {
    test('renders, switches every variant and step without errors', async ({ page }, info) => {
      const theme = info.project.name.includes('dark') ? 'dark' : 'light';
      const errors = watchErrors(page);
      await open(page, id, `?theme=${theme}&quality=high`);
      await waitReady(page);
      await expect.poll(async () => (await stats(page)).frames, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

      const s = await stats(page);
      expect(s.drawCalls, 'draw calls').toBeGreaterThan(0);
      expect(s.quality).toBe('high');
      if (s.budget) {
        expect(s.drawCalls, 'draw calls within meta.budget').toBeLessThanOrEqual(s.budget.calls);
        expect(s.triangles, 'triangles within meta.budget').toBeLessThanOrEqual(s.budget.tris);
      }
      const sd = await canvasStdev(page);
      expect(sd, `canvas luminance stdev (${theme})`).toBeGreaterThan(4);
      // Evidence screenshot for human review (sandbox overlay hidden).
      const hide = await page.addStyleTag({ content: '.sandbox-stats{display:none!important}' });
      await page
        .locator('.scene-stage')
        .first()
        .screenshot({ path: info.outputPath(`${id}-${theme}.png`) });
      await hide.evaluate((n) => (n as unknown as HTMLElement).remove());

      for (const v of meta.variants) {
        await page.evaluate(
          (variant) =>
            document.querySelector('ai-scene')?.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'variant', variant } })),
          v,
        );
        await expect.poll(async () => (await stats(page)).variant, { timeout: 15_000 }).toBe(v);
        await expect.poll(async () => ['running', 'paused'].includes((await stats(page)).state)).toBe(true);
        await framesAdvance(page);
        expect(await canvasStdev(page), `variant ${v} not blank`).toBeGreaterThan(4);
      }

      for (let i = 0; i < steps.length; i++) {
        await page.locator(`ai-scene [data-cmd="step"][data-index="${i}"]`).click();
        await expect.poll(async () => (await stats(page)).step, { timeout: 10_000 }).toBe(i);
        await expect(page.locator(`ai-scene [data-cmd="step"][data-index="${i}"]`)).toHaveAttribute('aria-current', 'step');
        const want = steps[i]?.variant;
        if (want) await expect.poll(async () => (await stats(page)).variant, { timeout: 15_000 }).toBe(want);
        await framesAdvance(page);
      }
      // Toolbar: next / prev buttons move through the steps too.
      if (steps.length > 1) {
        await page.locator('ai-scene [data-cmd="step"][data-index="0"]').click();
        await page.locator('ai-scene [data-cmd="next"]').click();
        await expect.poll(async () => (await stats(page)).step).toBe(1);
        await page.locator('ai-scene [data-cmd="prev"]').click();
        await expect.poll(async () => (await stats(page)).step).toBe(0);
      }
      expect(errors, errors.join('\n')).toEqual([]);
    });

    test('reduced motion renders a static frame', async ({ page }, info) => {
      const theme = info.project.name.includes('dark') ? 'dark' : 'light';
      const errors = watchErrors(page);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page, id, `?theme=${theme}&quality=high`);
      await waitReady(page);
      const s = await stats(page);
      expect(s.animate).toBe(false);
      expect(s.loop).toBe('demand');
      await page.waitForTimeout(1500); // let any damping / cut settle
      const f1 = (await stats(page)).frames;
      await page.waitForTimeout(1200);
      const f2 = (await stats(page)).frames;
      expect(f2, 'frames must stop increasing under reduced motion').toBe(f1);
      expect(f1).toBeGreaterThanOrEqual(1);
      expect(await canvasStdev(page)).toBeGreaterThan(4);
      expect(errors, errors.join('\n')).toEqual([]);
    });

    test('WebGL disabled shows the poster fallback', async ({ page }, info) => {
      const theme = info.project.name.includes('dark') ? 'dark' : 'light';
      const errors = watchErrors(page);
      await page.addInitScript(() => {
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
          if (/webgl/i.test(type)) return null;
          return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
        } as typeof orig;
      });
      await open(page, id, `?theme=${theme}`);
      const el = page.locator('ai-scene').first();
      await expect(el).toHaveAttribute('data-state', 'fallback');
      await expect(el.locator('.scene-poster')).toBeVisible();
      await expect(el.locator('.scene-status')).toContainText('WebGL');
      await expect(el.locator('canvas')).toHaveCount(0);
      if (steps.length > 1) {
        await el.locator('[data-cmd="next"]').click();
        await expect(el).toHaveAttribute('data-step', '1');
        await expect(el.locator('.scene-stepcap')).not.toBeEmpty();
      }
      expect(errors, errors.join('\n')).toEqual([]);
    });

    test('no horizontal page scroll at 320 px', async ({ page }) => {
      const errors = watchErrors(page);
      await page.setViewportSize({ width: 320, height: 720 });
      await open(page, id, '?quality=low');
      await waitReady(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
      expect(errors, errors.join('\n')).toEqual([]);
    });
  });
}
