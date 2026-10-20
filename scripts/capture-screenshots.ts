// Screenshot capture for visual review: every route × {desktop 1440×900, mobile 390×844} × {light, dark}.
//
//   npx tsx scripts/capture-screenshots.ts                         routes from dist/ (or "/" if there is no build)
//   npx tsx scripts/capture-screenshots.ts --routes "/ /chain/"    explicit routes (also: ROUTES env, "@file.txt")
//   npx tsx scripts/capture-screenshots.ts --templates             one URL per template + every segment page
//   npx tsx scripts/capture-screenshots.ts --serve                 serve dist/ locally instead of using --base
//   options: --base <url> (default $BASE_URL or http://127.0.0.1:4321) · --out <dir> (default artifacts/screens)
//            --viewports desktop,mobile · --themes light,dark · --concurrency <n> (default 3)
//            --viewport-only (default: full page, capped by --max-height 12000) · --dpr <n> (default 1)
//            --scene-wait <ms> (default 12000) · --clean (empty the output folder first)
//            --scene-shots (also scroll to every 3D scene, start it — tapping 「載入」 on phones — and save the
//            loaded scene as <route-slug>__scene-<id>__<viewport>__<theme>.png; shown under its route)
//
// Output: <out>/<route-slug>__<viewport>__<theme>.png, <out>/manifest.json and <out>/index.html (contact sheet).
// Exit code 0 unless the browser could not start; per-shot problems are recorded in the manifest and contact sheet.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import sharp from 'sharp';
import {
  CHROMIUM_CHANNEL, THEMES, VIEWPORTS, WEBGL_ARGS, applyTheme, freezeMotion, installEvalShim, nextFrames, prepareTheme, settle, waitForScenes,
  type Theme, type ViewportName,
} from '../tests/helpers/browser';
import { BASE_PATH, BASE_URL, DIST, ROOT, SITE_NAME, urlFor } from '../tests/helpers/env';
import { measureOverflow, trackProblems } from '../tests/helpers/page-checks';
import { SEGMENT_IDS } from '../src/schemas/common';
import {
  normalizeRoute, resolveTemplates, routeSlug, routesFromDist, routesFromEnv, sortRoutes,
} from '../tests/helpers/routes';
import { startStaticServer, type StaticServer } from '../tests/helpers/static-server';

process.chdir(ROOT);

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    routes: { type: 'string' },
    templates: { type: 'boolean', default: false },
    serve: { type: 'boolean', default: false },
    out: { type: 'string', default: 'artifacts/screens' },
    viewports: { type: 'string', default: 'desktop,mobile' },
    themes: { type: 'string', default: 'light,dark' },
    concurrency: { type: 'string', default: '3' },
    'viewport-only': { type: 'boolean', default: false },
    'max-height': { type: 'string', default: '12000' },
    dpr: { type: 'string', default: '1' },
    'scene-wait': { type: 'string', default: '12000' },
    'scene-shots': { type: 'boolean', default: false },
    clean: { type: 'boolean', default: false },
  },
});

const VP_LABEL: Record<ViewportName, string> = { desktop: '桌機', mobile: '手機' };
const THEME_LABEL: Record<Theme, string> = { light: '淺色', dark: '深色' };

interface Shot {
  route: string;
  url: string;
  viewport: ViewportName;
  theme: Theme;
  file: string | null;
  bytes: number;
  status: number | null;
  title: string;
  overflowPx: number;
  truncated: boolean;
  scenes: { id: string; state: string }[];
  /** --scene-shots: one capture per scene on the page, taken after it was scrolled into view and started */
  sceneShots: { id: string; state: string; file: string | null }[];
  problems: string[];
  error: string | null;
  ms: number;
}

/** Repo-relative path with forward slashes, for messages. */
const rel = (abs: string) => relative(ROOT, abs).split('\\').join('/') || '.';

function pickList<T extends string>(raw: string, allowed: readonly T[], what: string): T[] {
  const items = raw.split(/[\s,]+/).filter(Boolean);
  const bad = items.filter((i) => !(allowed as readonly string[]).includes(i));
  if (bad.length) throw new Error(`unknown ${what}: ${bad.join(', ')} (allowed: ${allowed.join(', ')})`);
  return items as T[];
}

function chooseRoutes(): { routes: string[]; source: string } {
  if (args.routes) return { routes: sortRoutes(args.routes.split(/[\s,]+/).filter(Boolean).map(normalizeRoute)), source: '--routes' };
  const env = routesFromEnv('ROUTES');
  if (env.length) return { routes: sortRoutes(env), source: 'ROUTES' };
  if (args.templates) {
    const picks = resolveTemplates()
      .filter((t) => t.resolved && !t.expectStatus)
      .map((t) => t.resolved as string);
    const segs = SEGMENT_IDS.map((s) => `/chain/${s}/`);
    const inDist = existsSync(DIST) ? new Set(routesFromDist()) : null;
    return {
      routes: sortRoutes([...picks, ...segs.filter((s) => !inDist || inDist.has(s))]),
      source: 'templates + segments',
    };
  }
  const fromDist = routesFromDist();
  if (fromDist.length) return { routes: fromDist, source: 'dist' };
  return { routes: ['/'], source: 'default' };
}

async function main(): Promise<number> {
  const viewports = pickList(args.viewports, Object.keys(VIEWPORTS) as ViewportName[], 'viewport');
  const themes = pickList(args.themes, THEMES, 'theme');
  const outDir = resolve(ROOT, args.out);
  const { routes, source } = chooseRoutes();
  const concurrency = Math.max(1, Number(args.concurrency) || 3);
  const maxHeight = Math.max(900, Number(args['max-height']) || 12000);
  const dpr = Math.max(1, Number(args.dpr) || 1);
  const sceneWait = Math.max(0, Number(args['scene-wait']) || 0);

  if (args.clean && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let server: StaticServer | null = null;
  let baseUrl = args.base ?? BASE_URL;
  if (args.serve) {
    server = await startStaticServer({ root: DIST, basePath: BASE_PATH });
    baseUrl = server.origin;
  }

  console.log(`Screenshots · ${routes.length} routes (${source}) × ${viewports.join('/')} × ${themes.join('/')} → ${rel(outDir)}`);
  console.log(`  server ${baseUrl}${BASE_PATH !== '/' ? ` (BASE_PATH ${BASE_PATH})` : ''} · concurrency ${concurrency}`);

  let browser: Browser;
  try {
    browser = await chromium.launch({ args: WEBGL_ARGS, ...(CHROMIUM_CHANNEL ? { channel: CHROMIUM_CHANNEL } : {}) });
  } catch (e) {
    await server?.close();
    console.error(`✗ cannot launch Chromium: ${(e as Error).message}`);
    return 2;
  }

  const contexts = new Map<string, BrowserContext>();
  const contextFor = async (vp: ViewportName, theme: Theme) => {
    const key = `${vp}/${theme}`;
    let ctx = contexts.get(key);
    if (!ctx) {
      const size = VIEWPORTS[vp];
      ctx = await browser.newContext({
        viewport: { ...size },
        screen: { ...size },
        deviceScaleFactor: dpr,
        isMobile: vp === 'mobile',
        hasTouch: vp === 'mobile',
        colorScheme: theme,
        reducedMotion: 'reduce',
        locale: 'zh-TW',
        timezoneId: 'Asia/Taipei',
      });
      await installEvalShim(ctx);
      contexts.set(key, ctx);
    }
    return ctx;
  };

  const jobs = routes.flatMap((route) => viewports.flatMap((viewport) => themes.map((theme) => ({ route, viewport, theme }))));
  const shots: Shot[] = [];
  let done = 0;

  const capture = async (job: { route: string; viewport: ViewportName; theme: Theme }): Promise<Shot> => {
    const t0 = Date.now();
    const url = urlFor(job.route, baseUrl);
    const shot: Shot = {
      ...job, url, file: null, bytes: 0, status: null, title: '', overflowPx: 0, truncated: false,
      scenes: [], sceneShots: [], problems: [], error: null, ms: 0,
    };
    const ctx = await contextFor(job.viewport, job.theme);
    const page = await ctx.newPage();
    const tracker = trackProblems(page, { origin: url, expectedErrorUrls: [url] });
    try {
      await prepareTheme(page, job.theme);
      const res = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      shot.status = res?.status() ?? null;
      await settle(page);
      if (sceneWait > 0) shot.scenes = await waitForScenes(page, { timeoutMs: sceneWait });
      await applyTheme(page, job.theme);
      await freezeMotion(page);
      // Lazy images below the fold would be blank in a full-page capture.
      await page.evaluate(async () => {
        const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]'));
        imgs.forEach((img) => (img.loading = 'eager'));
        await Promise.race([
          Promise.all(
            imgs.map((img) =>
              // decode() also covers decoding="async" images that have loaded but not painted yet.
              img.decode().catch(() => undefined),
            ),
          ),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      });
      shot.title = (await page.title()).trim();
      shot.overflowPx = Math.max(0, (await measureOverflow(page)).overflowPx);

      const file = `${routeSlug(job.route)}__${job.viewport}__${job.theme}.png`;
      const path = resolve(outDir, file);
      const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
      const size = VIEWPORTS[job.viewport];
      if (args['viewport-only']) await page.screenshot({ path, animations: 'disabled' });
      else {
        shot.truncated = height > maxHeight;
        await captureTall(page, path, size.width, Math.min(height, maxHeight), dpr);
      }
      shot.file = file;
      shot.bytes = statSync(path).size;
      if (args['scene-shots']) shot.sceneShots = await captureScenes(page, job, outDir, Math.max(sceneWait, 15000));
    } catch (e) {
      shot.error = (e as Error).message.split('\n')[0] ?? String(e);
    } finally {
      tracker.dispose();
      shot.problems = tracker.all();
      shot.ms = Date.now() - t0;
      await page.close().catch(() => undefined);
    }
    return shot;
  };

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (!job) break;
      const shot = await capture(job);
      shots.push(shot);
      done++;
      const flags = [
        shot.error ? `✗ ${shot.error}` : '',
        shot.status !== null && shot.status !== 200 ? `HTTP ${shot.status}` : '',
        shot.overflowPx > 0 ? `overflow +${shot.overflowPx}px` : '',
        shot.problems.length ? `${shot.problems.length} console/network problems` : '',
      ].filter(Boolean);
      console.log(`  [${String(done).padStart(String(jobs.length).length)}/${jobs.length}] ${shot.file ?? '—'}${flags.length ? `  ⚠ ${flags.join(' · ')}` : ''}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  } finally {
    for (const ctx of contexts.values()) await ctx.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await server?.close();
  }

  const order = (s: Shot) => `${routes.indexOf(s.route).toString().padStart(5, '0')}|${viewports.indexOf(s.viewport)}|${themes.indexOf(s.theme)}`;
  shots.sort((a, b) => order(a).localeCompare(order(b)));
  const manifest = {
    generated: new Date().toISOString(),
    server: baseUrl,
    basePath: BASE_PATH,
    routeSource: source,
    viewports: viewports.map((v) => ({ name: v, ...VIEWPORTS[v] })),
    themes,
    shots,
  };
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  writeFileSync(resolve(outDir, 'index.html'), contactSheet(manifest, routes));

  // PNGs from earlier runs that this run did not produce are kept (and counted) unless --clean was given.
  const stale = readdirSync(outDir).filter(
    (f) => f.endsWith('.png') && !shots.some((s) => s.file === f || s.sceneShots.some((x) => x.file === f)),
  );
  const failed = shots.filter((s) => s.error).length;
  const flagged = shots.filter((s) => !s.error && (s.overflowPx > 0 || s.problems.length || (s.status ?? 200) !== 200)).length;
  console.log(
    `\n${failed ? '⚠' : '✓'} ${shots.length - failed}/${shots.length} screenshots · ${flagged} flagged · contact sheet: ${rel(resolve(outDir, 'index.html'))}` +
      (stale.length ? ` · ${stale.length} older PNGs kept (use --clean)` : ''),
  );
  return 0;
}

/**
 * --scene-shots: bring each <figure class="scene"> into view, start its scene (scenes autoload when visible;
 * on phones they wait for a tap on 「載入 3D 場景」), wait until it runs and capture the whole figure (stage,
 * toolbar, hotspot chips). Scenes start one at a time, so the two-live-contexts limit never applies.
 */
async function captureScenes(
  page: Page,
  job: { route: string; viewport: ViewportName; theme: Theme },
  outDir: string,
  timeoutMs: number,
): Promise<Shot['sceneShots']> {
  const out: Shot['sceneShots'] = [];
  const figures = page.locator('figure.scene:has(ai-scene)');
  const count = await figures.count();
  const seen = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const fig = figures.nth(i);
    const scene = fig.locator('ai-scene');
    const id = (await scene.getAttribute('data-id')) ?? `scene-${i + 1}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    const name = n > 1 ? `${id}-${n}` : id;
    let state = '';
    let file: string | null = null;
    try {
      await fig.scrollIntoViewIfNeeded();
      const load = fig.locator('.scene-load');
      if (await load.isVisible().catch(() => false)) await load.click();
      await page
        .waitForFunction(
          (el) => /^(running|paused|ready|error|fallback|contextlost)$/.test(el?.getAttribute('data-state') ?? ''),
          await scene.elementHandle(),
          { timeout: timeoutMs, polling: 250 },
        )
        .catch(() => undefined);
      await page.waitForTimeout(800);
      await nextFrames(page, 3);
      state = (await scene.getAttribute('data-state')) ?? '';
      file = `${routeSlug(job.route)}__scene-${name}__${job.viewport}__${job.theme}.png`;
      await fig.screenshot({ path: resolve(outDir, file), animations: 'disabled' });
    } catch (e) {
      state = state || `error: ${(e as Error).message.split('\n')[0]}`;
    }
    out.push({ id: name, state, file });
  }
  return out;
}

/**
 * Full-page capture that stays correct on tall pages. Chromium (SwiftShader, which the WebGL flags select)
 * cannot composite one capture taller than its 8,192 px texture limit: past that the page repeats from the
 * top. So tall pages are captured in strips (each well under the limit) and stitched with sharp.
 */
const STRIP_PX = 4000;
async function captureTall(page: Page, path: string, width: number, height: number, dpr: number): Promise<void> {
  if (height <= STRIP_PX) {
    await page.screenshot({ path, fullPage: true, animations: 'disabled', clip: { x: 0, y: 0, width, height } });
    return;
  }
  const strips: { input: Buffer; top: number; left: number }[] = [];
  for (let y = 0; y < height; y += STRIP_PX) {
    const h = Math.min(STRIP_PX, height - y);
    const input = await page.screenshot({ fullPage: true, animations: 'disabled', clip: { x: 0, y, width, height: h } });
    strips.push({ input, top: Math.round(y * dpr), left: 0 });
  }
  await sharp({
    create: { width: Math.round(width * dpr), height: Math.round(height * dpr), channels: 3, background: '#ffffff' },
  })
    .composite(strips)
    .png()
    .toFile(path);
}

// ───────────────────────── contact sheet ─────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function contactSheet(m: { generated: string; server: string; shots: Shot[]; viewports: { name: ViewportName; width: number; height: number }[]; themes: Theme[] }, routes: string[]): string {
  const byRoute = new Map<string, Shot[]>();
  for (const s of m.shots) (byRoute.get(s.route) ?? byRoute.set(s.route, []).get(s.route)!).push(s);
  const flaggedRoutes = routes.filter((r) => (byRoute.get(r) ?? []).some((s) => s.error || s.overflowPx > 0 || s.problems.length || (s.status ?? 200) !== 200));

  const badge = (cls: string, text: string) => `<li class="badge ${cls}">${esc(text)}</li>`;
  const section = (route: string) => {
    const shots = byRoute.get(route) ?? [];
    const title = shots.find((s) => s.title)?.title ?? '';
    const flagged = flaggedRoutes.includes(route);
    const figs = shots
      .map((s) => {
        const vp = m.viewports.find((v) => v.name === s.viewport);
        const caption = `${VP_LABEL[s.viewport]} ${vp ? `${vp.width}×${vp.height}` : ''} · ${THEME_LABEL[s.theme]}`;
        const badges = [
          s.error ? badge('bad', `擷取失敗：${s.error}`) : '',
          s.status !== null && s.status !== 200 ? badge('bad', `HTTP ${s.status}`) : '',
          s.overflowPx > 0 ? badge('warn', `水平溢出 ${s.overflowPx}px`) : '',
          s.problems.length ? badge('bad', `錯誤 ${s.problems.length} 則`) : '',
          s.truncated ? badge('info', '已截斷') : '',
          ...s.scenes.filter((x) => /error|fallback|contextlost/.test(x.state)).map((x) => badge('warn', `場景 ${x.id || '?'}：${x.state}`)),
        ].join('');
        const img = s.file
          ? `<a class="thumb ${s.viewport}" href="${esc(encodeURI(s.file))}"><img src="${esc(encodeURI(s.file))}" alt="${esc(`${route} ${caption}`)}" loading="lazy" decoding="async"></a>`
          : `<div class="thumb ${s.viewport} missing" role="img" aria-label="${esc(`${route} ${caption}：沒有截圖`)}">沒有截圖</div>`;
        const details = s.problems.length
          ? `<details><summary>錯誤明細</summary><ul class="problems">${s.problems.map((p) => `<li><code>${esc(p)}</code></li>`).join('')}</ul></details>`
          : '';
        return `<figure>${img}<figcaption><span>${esc(caption)}</span>${badges ? `<ul class="badges">${badges}</ul>` : ''}${details}</figcaption></figure>`;
      })
      .join('\n');
    const sceneFigs = shots
      .flatMap((s) => s.sceneShots.map((x) => ({ ...x, s })))
      .map(({ id, state, file, s }) => {
        const caption = `3D 場景 ${id} · ${VP_LABEL[s.viewport]} · ${THEME_LABEL[s.theme]}`;
        const bad = !/^(running|paused|ready)$/.test(state);
        const img = file
          ? `<a class="thumb scene" href="${esc(encodeURI(file))}"><img src="${esc(encodeURI(file))}" alt="${esc(`${route} ${caption}`)}" loading="lazy" decoding="async"></a>`
          : `<div class="thumb scene missing">沒有截圖</div>`;
        return `<figure>${img}<figcaption><span>${esc(caption)}</span>${bad ? `<ul class="badges">${badge('warn', `狀態：${state || '未知'}`)}</ul>` : ''}</figcaption></figure>`;
      })
      .join('\n');
    const url = shots[0]?.url ?? '#';
    return `<section class="route" data-route="${esc(route)}" data-flagged="${flagged ? '1' : '0'}" aria-labelledby="r-${esc(routeSlug(route))}">
<h2 id="r-${esc(routeSlug(route))}"><a href="${esc(url)}"><code>${esc(route)}</code></a>${title ? ` <span class="page-title">${esc(title)}</span>` : ''}</h2>
<div class="shots">${figs}</div>${sceneFigs ? `
<h3 class="scenes-title">載入後的 3D 場景</h3>
<div class="shots">${sceneFigs}</div>` : ''}
</section>`;
  };

  const generated = new Date(m.generated).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>截圖總覽｜${esc(SITE_NAME)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#16181d;--muted:#5a6270;--card:#fff;--line:#d9dde3;--bad:#b42318;--bad-bg:#fde8e7;--warn:#8a5a00;--warn-bg:#fff3d6;--info:#1d4ed8;--info-bg:#e6eeff;--focus:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--fg:#e8eaee;--muted:#a3abb8;--card:#1a1d24;--line:#323844;--bad:#ffb4ab;--bad-bg:#4a1512;--warn:#ffd27a;--warn-bg:#3d2c05;--info:#a9c4ff;--info-bg:#15264d;--focus:#8ab4ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif}
header,main{max-width:1600px;margin:0 auto;padding:16px}
h1{font-size:1.6rem;margin:.2em 0}
.meta{color:var(--muted);margin:0 0 12px}
form{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center}
label{display:inline-flex;gap:8px;align-items:center}
input[type=search]{min-height:44px;min-width:min(320px,100%);padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
input[type=checkbox]{width:20px;height:20px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.routes{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(min(100%,calc(var(--n,4) * 252px + 34px)),1fr))}
.route{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;min-width:0}
.route h2{font-size:1.05rem;margin:0 0 10px;display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline}
.route h2 a{color:inherit}
.page-title{color:var(--muted);font-weight:normal}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:12px}
figure{margin:0;min-width:0}
.thumb{display:block;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg)}
.thumb img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
.thumb.desktop{aspect-ratio:16/10}
.thumb.mobile{aspect-ratio:3/4}
.thumb.scene img{height:auto;object-fit:contain}
.scenes-title{font-size:.95rem;margin:14px 0 8px;color:var(--muted);font-weight:600}
.thumb.missing{display:grid;place-items:center;color:var(--muted)}
figcaption{font-size:.9rem;margin-top:6px;overflow-wrap:anywhere}
.badges{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:4px}
.badge{border-radius:999px;padding:0 8px;font-size:.8rem}
.badge.bad{background:var(--bad-bg);color:var(--bad)}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.badge.info{background:var(--info-bg);color:var(--info)}
details{margin-top:4px}
summary{cursor:pointer;min-height:24px}
.problems{margin:4px 0 0;padding-left:1.2em;font-size:.8rem}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
[hidden]{display:none!important}
</style>
</head>
<body>
<header>
<h1>截圖總覽</h1>
<p class="meta">產生時間 ${esc(generated)}（台北時間）· 伺服器 <code>${esc(m.server)}</code> · ${routes.length} 個路由 × ${m.viewports.length * m.themes.length} 種組合 · ${flaggedRoutes.length} 個路由有待檢查項目</p>
<form role="search" onsubmit="return false">
<label for="q">篩選路由</label>
<input id="q" type="search" placeholder="例如 /chain/" autocomplete="off">
<label><input id="only-flagged" type="checkbox">只顯示有問題的路由</label>
</form>
<p id="count" class="meta" aria-live="polite">顯示 ${routes.length}／${routes.length} 個路由</p>
</header>
<main class="routes" style="--n:${m.viewports.length * m.themes.length}">
${routes.map(section).join('\n')}
</main>
<script>
(function(){
  var q=document.getElementById('q'),f=document.getElementById('only-flagged'),c=document.getElementById('count');
  var rows=[].slice.call(document.querySelectorAll('.route'));
  function apply(){
    var t=(q.value||'').trim().toLowerCase(),n=0;
    rows.forEach(function(r){var ok=(!t||r.dataset.route.toLowerCase().indexOf(t)>=0)&&(!f.checked||r.dataset.flagged==='1');r.hidden=!ok;if(ok)n++;});
    c.textContent='顯示 '+n+'／'+rows.length+' 個路由';
  }
  q.addEventListener('input',apply);f.addEventListener('change',apply);
})();
</script>
</body>
</html>
`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`✗ capture-screenshots crashed: ${(e as Error).stack ?? String(e)}`);
    process.exitCode = 2;
  },
);
