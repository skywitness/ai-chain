// Route discovery shared by the e2e/a11y specs and the capture scripts.
//
//   ROUTES_FROM=dist        every dist/**/index.html (minus /dev/, /_astro/, /pagefind/)
//   ROUTES="/ /chain/ …"    explicit list (comma, space or newline separated); "@file.txt" reads a file
//   ROUTES_FILTER=<regex>   keep only matching routes (e.g. "^/chain/")
//   ROUTES_LIMIT=<n>        keep the first n routes (after sorting)
// With neither ROUTES_FROM nor ROUTES, the route list is just "/".
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globSync } from 'tinyglobby';
import { DIST, ROOT, envList } from './env';

export type RouteSource = 'dist' | 'env' | 'default';
export interface RouteList {
  routes: string[];
  source: RouteSource;
  /** Set when discovery could not run (e.g. ROUTES_FROM=dist without a dist/ folder). */
  error?: string;
}

/** Directories inside dist/ that never hold site pages. */
const NON_PAGE_DIRS = ['_astro', 'pagefind', 'dev', 'data'];

/** Normalise a route to "/a/b/" form (query and hash kept). */
export function normalizeRoute(route: string): string {
  if (/^[A-Za-z]:[\\/]|^(Files|Program)\b/.test(route.trim()))
    throw new Error(
      `route "${route}" looks like a Windows path — Git Bash converted "/…" arguments. ` +
        'Write routes without the leading slash ("chain/,learn/what-is-ai/") or set MSYS_NO_PATHCONV=1.',
    );
  const m = route.trim().match(/^([^?#]*)(.*)$/);
  let path = (m?.[1] ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const rest = m?.[2] ?? '';
  if (!path.startsWith('/')) path = `/${path}`;
  if (!path.endsWith('/') && !/\.[a-z0-9]+$/i.test(path)) path = `${path}/`;
  return path + rest;
}

/** Every page route in a build output folder, sorted (home first). */
export function routesFromDist(dist: string = DIST): string[] {
  if (!existsSync(dist)) return [];
  const files = globSync('**/index.html', {
    cwd: dist,
    ignore: NON_PAGE_DIRS.map((d) => `${d}/**`),
    expandDirectories: false,
  });
  return sortRoutes(files.map((f) => normalizeRoute(f.replace(/\\/g, '/').replace(/index\.html$/, ''))));
}

/** Routes from an env var value ("/a/ /b/", "a,b", or "@path/to/list.txt"). */
export function routesFromEnv(name = 'ROUTES'): string[] {
  const out: string[] = [];
  for (const item of envList(name)) {
    if (item.startsWith('@')) {
      const file = resolve(ROOT, item.slice(1));
      if (!existsSync(file)) throw new Error(`${name}: route list file not found: ${file}`);
      out.push(...readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean));
    } else out.push(item);
  }
  return [...new Set(out.map(normalizeRoute))];
}

export function sortRoutes(routes: string[]): string[] {
  return [...new Set(routes)].sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
}

function applyFilters(routes: string[]): string[] {
  let out = routes;
  const filter = process.env['ROUTES_FILTER'];
  if (filter) {
    const re = new RegExp(filter);
    out = out.filter((r) => re.test(r));
  }
  const limit = Number(process.env['ROUTES_LIMIT'] ?? '');
  if (Number.isInteger(limit) && limit > 0) out = out.slice(0, limit);
  return out;
}

/** Resolve the route list from the environment (see the header comment). */
export function discoverRoutes(): RouteList {
  const from = (process.env['ROUTES_FROM'] ?? '').toLowerCase();
  if (from === 'dist') {
    if (!existsSync(resolve(DIST, 'index.html')))
      return { routes: [], source: 'dist', error: `ROUTES_FROM=dist but ${resolve(DIST, 'index.html')} does not exist — build first (npm run build)` };
    return { routes: applyFilters(routesFromDist()), source: 'dist' };
  }
  const fromEnv = routesFromEnv('ROUTES');
  if (fromEnv.length) return { routes: applyFilters(fromEnv), source: 'env' };
  return { routes: applyFilters(['/']), source: 'default' };
}

/**
 * File-name–safe slug of a route: "/" → "home", "/chain/foundry-packaging/" → "chain_foundry-packaging".
 * Query strings are folded in ("/models/compare/?m=a,b" → "models_compare_m-a-b").
 */
export function routeSlug(route: string): string {
  const s = route
    .replace(/^\/+|\/+$/g, '')
    .replace(/[?#=&,]+/g, '-')
    .replace(/\//g, '_')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/_-|-_/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '');
  return s || 'home';
}

// ───────────────────────── templates (one URL per template) ─────────────────────────

export interface TemplateDef {
  /** Stable id used in test titles and reports. */
  id: string;
  /** zh-TW label for reports. */
  label: string;
  /** Fixed route for singleton templates. */
  route?: string;
  /** Detail templates: route prefix + content collection the slug comes from. */
  prefix?: string;
  collection?: string;
  /** Preferred representative entity (used if its file exists). */
  prefer?: string[];
  /** HTTP status the template is expected to answer with (404 page). */
  expectStatus?: number;
  /** Only test the template when this repo file exists (e.g. src/pages/404.astro). */
  requiresFile?: string;
}

export interface ResolvedTemplate extends TemplateDef {
  /** Route to test, or null when no representative exists yet. */
  resolved: string | null;
  reason?: string;
}

/** Page templates, per architecture §4.1. */
export const TEMPLATES: TemplateDef[] = [
  { id: 'home', label: '首頁', route: '/' },
  { id: 'learn-index', label: '學習路徑', route: '/learn/' },
  { id: 'learn-article', label: '學習文章', prefix: '/learn/', collection: 'learn', prefer: ['what-is-llm', 'what-is-ai'] },
  { id: 'chain-index', label: '產業鏈總覽', route: '/chain/' },
  { id: 'chain-segment', label: '環節頁', prefix: '/chain/', collection: 'segments', prefer: ['foundry-packaging'] },
  { id: 'companies-index', label: '公司資料庫', route: '/companies/' },
  { id: 'company-profile', label: '公司檔案', prefix: '/companies/', collection: 'companies', prefer: ['tsmc', 'nvidia'] },
  { id: 'models-index', label: '大模型總覽', route: '/models/' },
  { id: 'model-family', label: '模型系列', prefix: '/models/', collection: 'models', prefer: ['anthropic-claude'] },
  { id: 'models-compare', label: '模型比較', route: '/models/compare/' },
  { id: 'trends-index', label: '未來趨勢', route: '/trends/' },
  { id: 'trend-article', label: '趨勢文章', prefix: '/trends/', collection: 'trends' },
  { id: 'taiwan', label: '台灣供應鏈', route: '/taiwan/' },
  { id: 'glossary', label: '名詞解釋', route: '/glossary/' },
  { id: 'sources', label: '資料來源', route: '/sources/' },
  { id: 'about', label: '關於本站', route: '/about/' },
  { id: 'not-found', label: '找不到頁面', route: '/qa-missing-page-404/', expectStatus: 404, requiresFile: 'src/pages/404.astro' },
];

function collectionIds(collection: string): string[] {
  const dir = resolve(ROOT, 'src/content', collection);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(mdx|md|json|ya?ml)$/.test(f) && !f.startsWith('_'))
    .map((f) => f.replace(/\.(mdx|md|json|ya?ml)$/, ''))
    .sort();
}

/**
 * Pick one URL per template.
 *   A11Y_ROUTES="id=/route/ …" or "/route/ …" overrides (ids are matched by prefix/route otherwise).
 *   With ROUTES_FROM=dist the representative must exist in dist/.
 */
export function resolveTemplates(defs: TemplateDef[] = TEMPLATES): ResolvedTemplate[] {
  const overrides = new Map<string, string>();
  const extra: string[] = [];
  for (const item of envList('A11Y_ROUTES')) {
    const m = item.match(/^([a-z0-9-]+)=(.+)$/);
    if (m?.[1] && m[2]) overrides.set(m[1], normalizeRoute(m[2]));
    else extra.push(normalizeRoute(item));
  }
  const distRoutes = (process.env['ROUTES_FROM'] ?? '').toLowerCase() === 'dist' ? new Set(routesFromDist()) : null;

  const out: ResolvedTemplate[] = defs.map((t) => {
    const ov = overrides.get(t.id);
    if (ov) return { ...t, resolved: ov };
    if (t.requiresFile && !existsSync(resolve(ROOT, t.requiresFile)))
      return { ...t, resolved: null, reason: `${t.requiresFile} 尚不存在` };
    if (t.route) {
      if (distRoutes && !t.expectStatus && !distRoutes.has(t.route)) return { ...t, resolved: null, reason: `dist/ 中沒有 ${t.route}` };
      return { ...t, resolved: t.route };
    }
    if (t.prefix && t.collection) {
      let ids = collectionIds(t.collection);
      if (distRoutes) ids = ids.filter((id) => distRoutes.has(`${t.prefix}${id}/`));
      const pick = (t.prefer ?? []).find((p) => ids.includes(p)) ?? ids[0];
      return pick
        ? { ...t, resolved: `${t.prefix}${pick}/` }
        : { ...t, resolved: null, reason: `src/content/${t.collection}/ 還沒有內容` };
    }
    return { ...t, resolved: null, reason: 'template has neither route nor collection' };
  });
  extra.forEach((r, i) => out.push({ id: `extra-${i + 1}`, label: r, route: r, resolved: r }));
  return out;
}
