// Performance budgets over the built site (architecture §7.6), measured as gzip (level 9) sizes from dist/.
//
//   npx tsx scripts/check-budgets.ts             table of every budget, worst pages first
//   npx tsx scripts/check-budgets.ts --json      machine-readable report
//   npx tsx scripts/check-budgets.ts --all       list every page (default: the 15 heaviest + every failure)
//   npx tsx scripts/check-budgets.ts --warn-only report but always exit 0
//   options: --dist <dir> (default dist) · --base <path> (default $BASE_PATH or "/")
//
// What is measured
//   • JS per page before scene activation: inline <script>s + <script src> + <link rel=modulepreload> + their static
//     import closure. Dynamic import() targets (three, scenes, search UI) are not counted. ≤ 20 KB (28 KB on
//     /companies/ and /models/compare/). three.js reachable statically from a page is reported as a failure.
//   • three shared chunk(s): chunks that contain three.js (`__THREE__` / file name three.*) plus three/addons chunks. ≤ 175 KB.
//   • per scene: the chunk behind the scene loader's import.meta.glob key ".../scenes/<id>/index.ts" plus its static
//     imports, minus three, minus runtime chunks shared by every scene, minus JSON data chunks. ≤ meta.budgetKB (60).
//     JSON data chunks (file names matching src/data/**/*.json) count against the 300 KB scene-asset budget instead.
//   • CSS per page: <link rel=stylesheet> + inline <style>. ≤ 35 KB (the site-wide CSS total is reported for reference).
//   • HTML per page: ≤ 120 KB, except the routes in HTML_EXCEPTIONS below (/companies/ ≤ 220 KB, /glossary/ ≤ 300 KB).
// Exit code: 0 within budget · 1 over budget · 2 setup error.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { globSync } from 'tinyglobby';
import { BASE_PATH, DIST, ROOT, normalizeBase, siteUrl } from '../tests/helpers/env';

process.chdir(ROOT);

const { values: args } = parseArgs({
  options: {
    dist: { type: 'string' },
    base: { type: 'string' },
    json: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    'warn-only': { type: 'boolean', default: false },
  },
});

const dist = args.dist ? resolve(ROOT, args.dist) : DIST;
const base = args.base ? normalizeBase(args.base) : BASE_PATH;
const KB = 1024;

const BUDGETS = {
  jsPerPage: 20 * KB,
  jsPerPageHeavy: 28 * KB,
  jsHeavyRoutes: ['/companies/', '/models/compare/'],
  three: 175 * KB,
  scene: 60 * KB,
  sceneAssets: 300 * KB,
  cssPerPage: 35 * KB,
  htmlPerPage: 120 * KB,
} as const;

// Documented per-route HTML exceptions (architecture §7.6, docs/QA.md §4.2). Only single-document pages
// whose deep links are in-page #anchors belong here; splitting them would break those links. Every other
// page keeps the 120 KB budget. Raise a limit only together with the docs, and with the measured size.
const HTML_EXCEPTIONS: Record<string, { budget: number; reason: string }> = {
  '/companies/': {
    budget: 220 * KB,
    reason: 'the whole company table is server-rendered, so filters, sorting and the no-JS view need no data fetch',
  },
  '/glossary/': {
    budget: 300 * KB,
    reason:
      'all ~300 terms on one page: <Term> popovers, their 「完整解釋」 links and Pagefind results deep-link to /glossary/#<term-id>; measured ≈ 268 KB (2026-10-20)',
  },
};
const htmlBudgetFor = (route: string): number => HTML_EXCEPTIONS[route]?.budget ?? BUDGETS.htmlPerPage;
const htmlExceptionNote = Object.entries(HTML_EXCEPTIONS)
  .map(([route, e]) => `${route.slice(1, -1)}: ${Math.round(e.budget / KB)} KB`)
  .join(', ');

// ───────────────────────── file helpers ─────────────────────────

const gzCache = new Map<string, number>();
const gz = (file: string): number => {
  let n = gzCache.get(file);
  if (n === undefined) {
    n = gzipSync(readFileSync(file), { level: 9 }).length;
    gzCache.set(file, n);
  }
  return n;
};
const gzText = (s: string) => (s.trim() ? gzipSync(Buffer.from(s), { level: 9 }).length : 0);
const relDist = (abs: string) => relative(dist, abs).replace(/\\/g, '/');
const kb = (n: number) => `${(n / KB).toFixed(1)} KB`;

const site = siteUrl();
/** Map a URL found in a page (absolute, root-relative or relative) to a file in dist, or null. */
function toDistFile(ref: string, fromFile: string): string | null {
  let url = ref.trim();
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return null;
  if (url.startsWith(site)) url = url.slice(site.length);
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return null; // external
  url = url.replace(/[?#].*$/, '');
  let path: string;
  if (url.startsWith('/')) {
    if (base !== '/' && !url.startsWith(base)) return null;
    path = url.slice(base.length);
  } else {
    path = posix.join(posix.dirname(relDist(fromFile)), url);
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep as is */
  }
  const abs = resolve(dist, path);
  return existsSync(abs) && statSync(abs).isFile() ? abs : null;
}

// ───────────────────────── JS graph ─────────────────────────

const STATIC_IMPORT = /(?:^|[^\w$.])(?:import|export)\s*(?:[\w$]+\s*,?\s*)?(?:\{[^}]*\}|\*(?:\s*as\s*[\w$]+)?)?\s*(?:from\s*)?["']([^"'\n]+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g;

interface JsNode {
  file: string;
  staticDeps: string[];
  dynamicDeps: string[];
}
const jsNodes = new Map<string, JsNode>();
function jsNode(file: string): JsNode {
  let n = jsNodes.get(file);
  if (n) return n;
  const src = readFileSync(file, 'utf8');
  const resolveSpec = (spec: string) => (spec.startsWith('.') || spec.startsWith('/') ? toDistFile(spec, file) : null);
  const staticDeps = new Set<string>();
  for (const m of src.matchAll(STATIC_IMPORT)) {
    const f = m[1] ? resolveSpec(m[1]) : null;
    if (f && f.endsWith('.js')) staticDeps.add(f);
  }
  const dynamicDeps = new Set<string>();
  for (const m of src.matchAll(DYNAMIC_IMPORT)) {
    const f = m[1] ? resolveSpec(m[1]) : null;
    if (f) dynamicDeps.add(f);
  }
  n = { file, staticDeps: [...staticDeps], dynamicDeps: [...dynamicDeps] };
  jsNodes.set(file, n);
  return n;
}
function staticClosure(entries: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of jsNode(f).staticDeps) stack.push(d);
  }
  return seen;
}
/** Static imports inside inline module scripts (Astro may inline small hoisted scripts). */
function inlineImports(code: string, fromFile: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(STATIC_IMPORT)) {
    const f = m[1] ? toDistFile(m[1], fromFile) : null;
    if (f) out.push(f);
  }
  return out;
}

// ───────────────────────── page parsing ─────────────────────────

interface PageAssets {
  route: string;
  file: string;
  html: number;
  jsEntries: string[];
  inlineJs: number;
  cssFiles: string[];
  inlineCss: number;
}

const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};
const NON_JS_TYPES = /^(application\/(ld\+)?json|importmap|speculationrules|text\/(template|html|x-template|plain))$/i;

function parsePage(file: string): PageAssets {
  const html = readFileSync(file, 'utf8');
  const rel = relDist(file);
  const route = '/' + rel.replace(/(^|\/)index\.html$/, '$1');
  const jsEntries: string[] = [];
  let inlineJsText = '';
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? '';
    const type = attr(attrs, 'type');
    if (type && NON_JS_TYPES.test(type)) continue;
    const src = attr(attrs, 'src');
    if (src) {
      const f = toDistFile(src, file);
      if (f) jsEntries.push(f);
    } else {
      inlineJsText += `${m[2] ?? ''}\n`;
      jsEntries.push(...inlineImports(m[2] ?? '', file));
    }
  }
  const cssFiles: string[] = [];
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    const relAttr = (attr(attrs, 'rel') ?? '').toLowerCase().split(/\s+/);
    const href = attr(attrs, 'href');
    if (!href) continue;
    const f = toDistFile(href, file);
    if (!f) continue;
    if (relAttr.includes('stylesheet')) cssFiles.push(f);
    else if (relAttr.includes('modulepreload') && f.endsWith('.js')) jsEntries.push(f);
  }
  let inlineCssText = '';
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) inlineCssText += `${m[1] ?? ''}\n`;
  return {
    route,
    file,
    html: gz(file),
    jsEntries: [...new Set(jsEntries)],
    inlineJs: gzText(inlineJsText),
    cssFiles: [...new Set(cssFiles)],
    inlineCss: gzText(inlineCssText),
  };
}

// ───────────────────────── main ─────────────────────────

interface Row {
  name: string;
  size: number;
  budget: number;
  ok: boolean;
  note?: string;
}

function main(): number {
  if (!existsSync(resolve(dist, 'index.html'))) {
    console.error(`✗ ${resolve(dist, 'index.html')} not found — build the site first (npm run build).`);
    return 2;
  }
  const htmlFiles = globSync('**/*.html', { cwd: dist, ignore: ['_astro/**', 'pagefind/**', 'dev/**'], expandDirectories: false })
    .map((f) => resolve(dist, f))
    .sort();
  const allJs = globSync('**/*.js', { cwd: dist, ignore: ['pagefind/**'], expandDirectories: false }).map((f) => resolve(dist, f));
  const allCss = globSync('**/*.css', { cwd: dist, ignore: ['pagefind/**'], expandDirectories: false }).map((f) => resolve(dist, f));

  // three.js chunks
  const ADDON = /^(OrbitControls|TrackballControls|MapControls|RoundedBoxGeometry|RoomEnvironment|BufferGeometryUtils|CSS2DRenderer|CSS3DRenderer|EffectComposer|RenderPass|ShaderPass|UnrealBloomPass|OutputPass|Pass|Line2|LineMaterial|LineSegments2|LineSegmentsGeometry|LineGeometry|ConvexGeometry|TextGeometry|FontLoader|GLTFLoader|DRACOLoader|MeshoptDecoder|SimplexNoise|ImprovedNoise)[.-]/;
  const threeSet = new Set(
    allJs.filter((f) => {
      const name = f.split(/[\\/]/).pop() ?? '';
      if (/^three([.-]|$)/i.test(name) || ADDON.test(name)) return true;
      const src = readFileSync(f, 'utf8');
      return src.includes('__THREE__') || src.includes('THREE.WebGLRenderer:');
    }),
  );
  const threeSize = [...threeSet].reduce((a, f) => a + gz(f), 0);

  // Pages
  const pages = htmlFiles.map(parsePage);
  const pageRows: {
    route: string;
    js: number;
    css: number;
    html: number;
    jsBudget: number;
    htmlBudget: number;
    threeEager: boolean;
    jsFiles: string[];
  }[] = [];
  for (const p of pages) {
    const closure = staticClosure(p.jsEntries);
    const threeEager = [...closure].some((f) => threeSet.has(f));
    const js = p.inlineJs + [...closure].reduce((a, f) => a + gz(f), 0);
    const css = p.inlineCss + p.cssFiles.reduce((a, f) => a + gz(f), 0);
    pageRows.push({
      route: p.route,
      js,
      css,
      html: p.html,
      jsBudget: (BUDGETS.jsHeavyRoutes as readonly string[]).includes(p.route) ? BUDGETS.jsPerPageHeavy : BUDGETS.jsPerPage,
      htmlBudget: htmlBudgetFor(p.route),
      threeEager,
      jsFiles: [...closure].map(relDist).sort(),
    });
  }
  const initialJs = new Set(pages.flatMap((p) => [...staticClosure(p.jsEntries)]));

  // Scenes: find the import.meta.glob map in any chunk.
  const sceneChunk = new Map<string, string>();
  const KEY = /["'`]((?:[^"'`\n]*\/)?scenes\/([a-z0-9-]+)\/index\.[jt]s)["'`]\s*:/g;
  for (const f of allJs) {
    if (threeSet.has(f)) continue;
    const src = readFileSync(f, 'utf8');
    if (!src.includes('scenes/')) continue;
    const keys = [...src.matchAll(KEY)];
    keys.forEach((m, i) => {
      const id = m[2];
      if (!id || sceneChunk.has(id)) return;
      const start = (m.index ?? 0) + m[0].length;
      const end = keys[i + 1]?.index ?? Math.min(src.length, start + 600);
      const imp = src.slice(start, end).match(/import\(\s*["'`]([^"'`]+)["'`]\s*\)/);
      const target = imp?.[1] ? toDistFile(imp[1], f) : null;
      if (target) sceneChunk.set(id, target);
    });
  }
  const dataNames = new Set(
    existsSync('src/data')
      ? globSync('src/data/**/*.json', { expandDirectories: false }).map((p) => (p.split('/').pop() ?? '').replace(/\.json$/, ''))
      : [],
  );
  const isDataChunk = (f: string) => {
    const name = (f.split(/[\\/]/).pop() ?? '').replace(/[.-][A-Za-z0-9_-]{6,12}\.js$/, '');
    return dataNames.has(name);
  };
  const sceneClosures = new Map([...sceneChunk].map(([id, f]) => [id, staticClosure([f])]));
  let sharedRuntime = new Set<string>();
  if (sceneClosures.size >= 2) {
    const sets = [...sceneClosures.values()];
    sharedRuntime = new Set([...sets[0]!].filter((f) => sets.every((s) => s.has(f)) && ![...sceneChunk.values()].includes(f)));
  }
  const sceneRows = [...sceneClosures].sort(([a], [b]) => a.localeCompare(b)).map(([id, closure]) => {
    const own = [...closure].filter((f) => !threeSet.has(f) && !sharedRuntime.has(f) && !initialJs.has(f));
    const code = own.filter((f) => !isDataChunk(f));
    const data = own.filter(isDataChunk);
    const metaPath = `src/three/scenes/${id}/meta.json`;
    let budget: number = BUDGETS.scene;
    if (existsSync(metaPath)) {
      try {
        const b = (JSON.parse(readFileSync(metaPath, 'utf8')) as { budgetKB?: number }).budgetKB;
        if (typeof b === 'number' && b > 0) budget = Math.min(b, 60) * KB;
      } catch {
        /* invalid meta.json is validate-data's job */
      }
    }
    return {
      id,
      chunk: relDist(sceneChunk.get(id)!),
      code: code.reduce((a, f) => a + gz(f), 0),
      data: data.reduce((a, f) => a + gz(f), 0),
      budget,
      files: code.map(relDist),
      dataFiles: data.map(relDist),
    };
  });
  const sharedRuntimeFiles = [...sharedRuntime].filter((f) => !threeSet.has(f) && !initialJs.has(f));
  const sharedRuntimeSize = sharedRuntimeFiles.reduce((a, f) => a + gz(f), 0);
  const scenesOnDisk = existsSync('src/three/scenes') ? readdirSync('src/three/scenes').filter((d) => !d.startsWith('_') && !d.startsWith('.')) : [];
  const unmappedScenes = scenesOnDisk.filter((id) => !sceneChunk.has(id));

  const cssTotal = allCss.reduce((a, f) => a + gz(f), 0);

  // ── verdicts ──
  const failures: string[] = [];
  for (const r of pageRows) {
    if (r.js > r.jsBudget) failures.push(`JS ${r.route}: ${kb(r.js)} > ${kb(r.jsBudget)}`);
    if (r.threeEager) failures.push(`JS ${r.route}: three.js is in the page's static import graph (must be a dynamic import)`);
    if (r.css > BUDGETS.cssPerPage) failures.push(`CSS ${r.route}: ${kb(r.css)} > ${kb(BUDGETS.cssPerPage)}`);
    if (r.html > r.htmlBudget) failures.push(`HTML ${r.route}: ${kb(r.html)} > ${kb(r.htmlBudget)}`);
  }
  if (threeSize > BUDGETS.three) failures.push(`three: ${kb(threeSize)} > ${kb(BUDGETS.three)}`);
  for (const s of sceneRows) {
    if (s.code > s.budget) failures.push(`scene ${s.id}: ${kb(s.code)} > ${kb(s.budget)}`);
    if (s.data > BUDGETS.sceneAssets) failures.push(`scene ${s.id} data: ${kb(s.data)} > ${kb(BUDGETS.sceneAssets)}`);
  }

  const report = {
    dist: relative(ROOT, dist).replace(/\\/g, '/') || '.',
    basePath: base,
    budgets: { ...BUDGETS, htmlExceptions: HTML_EXCEPTIONS },
    pages: pageRows.map(({ jsFiles, ...r }) => ({ ...r, jsFiles })),
    three: { size: threeSize, budget: BUDGETS.three, files: [...threeSet].map((f) => ({ file: relDist(f), size: gz(f) })) },
    scenes: sceneRows,
    sceneSharedRuntime: { size: sharedRuntimeSize, files: sharedRuntimeFiles.map(relDist) },
    unmappedScenes,
    css: { total: cssTotal, files: allCss.length },
    failures,
    passed: failures.length === 0,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 1));
  } else {
    const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
    console.log(`Budgets · ${report.dist} · ${pageRows.length} pages · gzip -9 sizes (BASE_PATH ${base})\n`);
    const summary: Row[] = [
      { name: 'JS per page (max)', size: max(pageRows.map((r) => r.js)), budget: BUDGETS.jsPerPage, ok: pageRows.every((r) => r.js <= r.jsBudget && !r.threeEager), note: 'companies, models/compare: 28 KB' },
      { name: 'CSS per page (max)', size: max(pageRows.map((r) => r.css)), budget: BUDGETS.cssPerPage, ok: pageRows.every((r) => r.css <= BUDGETS.cssPerPage), note: `all CSS files together: ${kb(cssTotal)}` },
      { name: 'HTML per page (max)', size: max(pageRows.filter((r) => !(r.route in HTML_EXCEPTIONS)).map((r) => r.html)), budget: BUDGETS.htmlPerPage, ok: pageRows.every((r) => r.html <= r.htmlBudget), note: `except ${htmlExceptionNote}` },
      ...Object.entries(HTML_EXCEPTIONS).map(([route, e]) => {
        const row = pageRows.find((r) => r.route === route);
        return { name: `HTML ${route}`, size: row?.html ?? 0, budget: e.budget, ok: !row || row.html <= e.budget, note: row ? 'documented exception (HTML_EXCEPTIONS)' : 'page not built' };
      }),
      { name: 'three chunk(s)', size: threeSize, budget: BUDGETS.three, ok: threeSize <= BUDGETS.three, note: threeSet.size ? `${threeSet.size} file(s)` : 'not built yet' },
      ...sceneRows.map((s) => ({ name: `scene ${s.id}`, size: s.code, budget: s.budget, ok: s.code <= s.budget && s.data <= BUDGETS.sceneAssets, note: s.data ? `+ data ${kb(s.data)}` : '' })),
    ];
    const w = Math.max(...summary.map((r) => r.name.length));
    for (const r of summary)
      console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(w)}  ${kb(r.size).padStart(9)} / ${kb(r.budget).padStart(8)}${r.note ? `   ${r.note}` : ''}`);
    if (sharedRuntimeSize) console.log(`  scene runtime shared by every scene (not counted per scene): ${kb(sharedRuntimeSize)}`);
    if (unmappedScenes.length) console.log(`  ⚠ scene folders with no chunk found in the build: ${unmappedScenes.join(', ')}`);

    const sorted = [...pageRows].sort((a, b) => b.js - a.js || b.html - a.html);
    const over = (r: (typeof pageRows)[number]) => r.js > r.jsBudget || r.threeEager || r.css > BUDGETS.cssPerPage || r.html > r.htmlBudget;
    const shown = args.all ? sorted : sorted.filter((r, i) => i < 15 || over(r));
    console.log(`\n${'route'.padEnd(40)} ${'JS'.padStart(9)} ${'CSS'.padStart(9)} ${'HTML'.padStart(9)}`);
    for (const r of shown)
      console.log(
        `${over(r) ? '✗' : ' '} ${r.route.padEnd(38)} ${kb(r.js).padStart(9)} ${kb(r.css).padStart(9)} ${kb(r.html).padStart(9)}${r.threeEager ? '  three loaded eagerly!' : ''}`,
      );
    if (shown.length < sorted.length) console.log(`  … ${sorted.length - shown.length} more pages within budget (--all to list)`);
    console.log(`\n${failures.length ? `✗ ${failures.length} budget failure(s)` : '✓ all budgets met'}`);
    for (const f of failures.slice(0, 40)) console.log(`  ${f}`);
  }
  return failures.length && !args['warn-only'] ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`✗ check-budgets crashed: ${(e as Error).stack ?? String(e)}`);
  process.exitCode = 2;
}
