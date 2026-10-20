// Scene posters: render every scene in the dev sandbox and save the stage as a WebP poster per theme.
//
//   npx tsx scripts/capture-posters.ts                     all scene folders, light + dark
//   npx tsx scripts/capture-posters.ts --ids cowos,hbm      only these scenes
//   npx tsx scripts/capture-posters.ts --verify             no browser: check every scene has both posters (size, dimensions)
//   npx tsx scripts/capture-posters.ts --dry-run            print what would be captured
//
// Sandbox contract (docs/SCENES.md, docs/SCENE-CONTRACT.md — every selector is overridable):
//   URL        --url  "/dev/scenes/{id}/?poster=1&theme={theme}&quality=high"   ({id}, {theme} substituted; base path added)
//   stage      --stage "[data-poster-stage], ai-scene .scene-stage, ai-scene"   (first match is screenshotted)
//   ready      --ready "ai-scene[data-state=running], ai-scene[data-state=paused], ai-scene[data-state=ready]"
//              or window.__scene.ready resolving (whichever happens first)
//   failure    --fail  "ai-scene[data-state=error], ai-scene[data-state=fallback], ai-scene[data-state=contextlost]"
// Other options: --base <url> (default $BASE_URL or http://127.0.0.1:4321) · --themes light,dark
//   --out <dir> (default src/assets/scene-posters) · --width 1600 --height 900 · --quality 75 · --max-kb 120
//   --timeout <ms> (default 30000) · --settle <ms> after ready (default 500) · --reduced-motion
//
// Output: <out>/<id>-<theme>.webp, exactly width×height, WebP at --quality (lowered in steps of 5, down to 40,
// until the file is ≤ --max-kb). Exit code: 0 ok · 1 some poster failed/over budget · 2 setup error.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from '@playwright/test';
import sharp from 'sharp';
import { SCENE_IDS } from '../src/schemas/common';
import { CHROMIUM_CHANNEL, THEMES, WEBGL_ARGS, installEvalShim, nextFrames, prepareTheme, type Theme } from '../tests/helpers/browser';
import { BASE_URL, ROOT, urlFor } from '../tests/helpers/env';
import { trackProblems } from '../tests/helpers/page-checks';

process.chdir(ROOT);

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    ids: { type: 'string' },
    themes: { type: 'string', default: 'light,dark' },
    out: { type: 'string', default: 'src/assets/scene-posters' },
    url: { type: 'string', default: process.env['SCENE_POSTER_URL'] ?? '/dev/scenes/{id}/?poster=1&theme={theme}&quality=high' },
    stage: { type: 'string', default: '[data-poster-stage], ai-scene .scene-stage, ai-scene' },
    ready: { type: 'string', default: 'ai-scene[data-state="running"], ai-scene[data-state="paused"], ai-scene[data-state="ready"]' },
    fail: { type: 'string', default: 'ai-scene[data-state="error"], ai-scene[data-state="fallback"], ai-scene[data-state="contextlost"]' },
    width: { type: 'string', default: '1600' },
    height: { type: 'string', default: '900' },
    quality: { type: 'string', default: '75' },
    'max-kb': { type: 'string', default: '120' },
    timeout: { type: 'string', default: '30000' },
    'scenes-dir': { type: 'string', default: 'src/three/scenes' },
    settle: { type: 'string', default: '500' },
    'reduced-motion': { type: 'boolean', default: false },
    verify: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

const W = Number(args.width) || 1600;
const H = Number(args.height) || 900;
const MAX_BYTES = (Number(args['max-kb']) || 120) * 1024;
const QUALITY = Math.min(100, Math.max(1, Number(args.quality) || 75));
const MIN_QUALITY = 40;
const outDir = resolve(ROOT, args.out);
const scenesDir = resolve(ROOT, args['scenes-dir']);

/** Scene folders that are real scenes: they have an index.ts (the sandbox only routes those). */
function sceneFolders(): string[] {
  if (!existsSync(scenesDir)) return [];
  const dirs = readdirSync(scenesDir)
    .filter((d) => !d.startsWith('_') && !d.startsWith('.') && statSync(resolve(scenesDir, d)).isDirectory())
    .sort();
  const unfinished = dirs.filter((d) => !existsSync(resolve(scenesDir, d, 'index.ts')));
  if (unfinished.length) console.warn(`⚠ skipping scene folders without index.ts (not a scene yet): ${unfinished.join(', ')}`);
  return dirs.filter((d) => !unfinished.includes(d));
}

function chooseIds(): string[] {
  const folders = sceneFolders();
  if (!args.ids) return folders;
  const wanted = args.ids.split(/[\s,]+/).filter(Boolean);
  const missing = wanted.filter((w) => !folders.includes(w));
  if (missing.length) console.warn(`⚠ no scene (folder with index.ts) for: ${missing.join(', ')}`);
  return wanted.filter((w) => folders.includes(w));
}

const posterPath = (id: string, theme: Theme) => resolve(outDir, `${id}-${theme}.webp`);
/** Repo-relative path with forward slashes, for messages. */
const rel = (abs: string) => relative(ROOT, abs).split('\\').join('/') || '.';

async function verify(ids: string[], themes: Theme[]): Promise<number> {
  let bad = 0;
  for (const id of ids)
    for (const theme of themes) {
      const p = posterPath(id, theme);
      const name = rel(p);
      if (!existsSync(p)) {
        console.log(`✗ ${name}: missing`);
        bad++;
        continue;
      }
      const meta = await sharp(p).metadata();
      const size = statSync(p).size;
      const issues = [
        meta.format !== 'webp' ? `format ${meta.format}` : '',
        meta.width !== W || meta.height !== H ? `${meta.width}×${meta.height} (want ${W}×${H})` : '',
        size > MAX_BYTES ? `${(size / 1024).toFixed(1)} KB > ${MAX_BYTES / 1024} KB` : '',
      ].filter(Boolean);
      if (issues.length) bad++;
      console.log(`${issues.length ? '✗' : '✓'} ${name}: ${(size / 1024).toFixed(1)} KB${issues.length ? ` — ${issues.join('; ')}` : ''}`);
    }
  const known = new Set<string>(SCENE_IDS);
  for (const id of ids) if (!known.has(id)) console.log(`⚠ src/three/scenes/${id}/ is not one of SCENE_IDS`);
  console.log(`\n${ids.length} scenes · ${ids.length * themes.length} posters expected · ${bad} problems`);
  return bad ? 1 : 0;
}

type WaitResult = 'ready' | 'failed' | 'timeout';
type ShotResult =
  | { error: string }
  | { png: Buffer; box: { width: number; height: number }; problems: string[] };

async function waitForReady(page: Page, timeout: number): Promise<WaitResult> {
  try {
    const handle = await page.waitForFunction(
      ({ ready, fail }) => {
        if (fail && document.querySelector(fail)) return 'failed';
        if (ready && document.querySelector(ready)) return 'ready';
        const w = window as unknown as { __scene?: { ready?: Promise<unknown>; __qaReady?: boolean; __qaHooked?: boolean } };
        const s = w.__scene;
        if (s?.ready && !s.__qaHooked) {
          s.__qaHooked = true;
          s.ready.then(
            () => (s.__qaReady = true),
            () => undefined,
          );
        }
        return s?.__qaReady ? 'ready' : false;
      },
      { ready: args.ready, fail: args.fail },
      { timeout, polling: 100 },
    );
    return (await handle.jsonValue()) as WaitResult;
  } catch {
    return 'timeout';
  }
}

async function encode(png: Buffer): Promise<{ buf: Buffer; quality: number }> {
  const resized = await sharp(png).resize(W, H, { fit: 'cover', position: 'centre' }).toBuffer();
  let quality = QUALITY;
  for (;;) {
    const buf = await sharp(resized).webp({ quality, effort: 6, smartSubsample: true }).toBuffer();
    if (buf.length <= MAX_BYTES || quality <= MIN_QUALITY) return { buf, quality };
    quality = Math.max(MIN_QUALITY, quality - 5);
  }
}

async function capture(browser: Browser, baseUrl: string, id: string, theme: Theme): Promise<{ ok: boolean; msg: string }> {
  const route = args.url.replace(/\{id\}/g, encodeURIComponent(id)).replace(/\{theme\}/g, theme);
  const url = urlFor(route, baseUrl);
  const timeout = Number(args.timeout) || 30000;

  const shoot = async (dpr: number): Promise<ShotResult> => {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: dpr,
      colorScheme: theme,
      reducedMotion: args['reduced-motion'] ? 'reduce' : 'no-preference',
      locale: 'zh-TW',
      timezoneId: 'Asia/Taipei',
    });
    await installEvalShim(ctx);
    const page = await ctx.newPage();
    const tracker = trackProblems(page, { origin: url });
    try {
      await prepareTheme(page, theme);
      const res = await page.goto(url, { waitUntil: 'load', timeout });
      if (!res || res.status() !== 200) return { error: `HTTP ${res?.status() ?? 'no response'} for ${url}` };
      const state = await waitForReady(page, timeout);
      if (state !== 'ready') {
        const states = await page.$$eval('ai-scene', (els) => els.map((e) => e.getAttribute('data-state') ?? '?')).catch(() => []);
        return { error: `scene ${state} (data-state: ${states.join(', ') || 'no <ai-scene>'})${tracker.all().length ? `; ${tracker.all()[0]}` : ''}` };
      }
      await nextFrames(page, 3);
      await page.waitForTimeout(Number(args.settle) || 0);
      const stage = page.locator(args.stage).first();
      if (!(await stage.count())) return { error: `stage selector matched nothing: ${args.stage}` };
      const box = await stage.boundingBox();
      if (!box || box.width < 10 || box.height < 10) return { error: 'stage has no size' };
      const png = await stage.screenshot({ animations: 'allow', timeout });
      return { png, box, problems: tracker.all() };
    } finally {
      tracker.dispose();
      await ctx.close().catch(() => undefined);
    }
  };

  let r = await shoot(1);
  if (!('error' in r) && r.box.width < W - 1) {
    // Stage narrower than the poster: re-render at a higher DPR instead of upscaling.
    const dpr = Math.min(3, Math.ceil((W / r.box.width) * 100) / 100);
    r = await shoot(dpr);
  }
  if ('error' in r) return { ok: false, msg: r.error };
  const { buf, quality } = await encode(r.png);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(posterPath(id, theme), buf);
  const kb = (buf.length / 1024).toFixed(1);
  const over = buf.length > MAX_BYTES;
  const warn = r.problems.length ? ` · ${r.problems.length} console/network problems (first: ${r.problems[0]})` : '';
  return { ok: !over, msg: `${kb} KB @ q${quality}${over ? ` — over ${MAX_BYTES / 1024} KB` : ''}${warn}` };
}

async function main(): Promise<number> {
  const themes = args.themes.split(/[\s,]+/).filter(Boolean) as Theme[];
  const badTheme = themes.find((t) => !(THEMES as readonly string[]).includes(t));
  if (badTheme) {
    console.error(`✗ unknown theme "${badTheme}" (use light,dark)`);
    return 2;
  }
  const ids = chooseIds();
  if (!ids.length) {
    if (args.ids) {
      console.error(`✗ none of the requested scenes (--ids ${args.ids}) exists as ${rel(scenesDir)}/<id>/index.ts`);
      return 1;
    }
    console.log(`No scenes (folders with index.ts) under ${rel(scenesDir)}/ yet — nothing to ${args.verify ? 'verify' : 'capture'}.`);
    return 0;
  }
  if (args.verify) return verify(ids, themes);

  const baseUrl = args.base ?? BASE_URL;
  if (args['dry-run']) {
    for (const id of ids)
      for (const theme of themes)
        console.log(`${urlFor(args.url.replace(/\{id\}/g, id).replace(/\{theme\}/g, theme), baseUrl)}  →  ${rel(posterPath(id, theme))}`);
    return 0;
  }

  try {
    await fetch(urlFor('/', baseUrl), { method: 'HEAD', signal: AbortSignal.timeout(5000) });
  } catch {
    console.error(`✗ server not reachable at ${baseUrl} — start it with: npx astro dev --port 4321 --host 127.0.0.1`);
    return 2;
  }

  console.log(`Posters · ${ids.length} scenes × ${themes.join('/')} · ${W}×${H} WebP ≤ ${MAX_BYTES / 1024} KB → ${rel(outDir)}`);
  const browser = await chromium.launch({ args: WEBGL_ARGS, ...(CHROMIUM_CHANNEL ? { channel: CHROMIUM_CHANNEL } : {}) });
  let failed = 0;
  try {
    for (const id of ids)
      for (const theme of themes) {
        const t0 = Date.now();
        const r = await capture(browser, baseUrl, id, theme).catch((e: unknown) => ({ ok: false, msg: (e as Error).message.split('\n')[0] ?? String(e) }));
        if (!r.ok) failed++;
        console.log(`  ${r.ok ? '✓' : '✗'} ${id}-${theme}.webp  ${r.msg}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      }
  } finally {
    await browser.close();
  }
  console.log(`\n${failed ? '✗' : '✓'} ${ids.length * themes.length - failed}/${ids.length * themes.length} posters written`);
  return failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`✗ capture-posters crashed: ${(e as Error).stack ?? String(e)}`);
    process.exitCode = 2;
  },
);
