// URL helpers. Every internal URL in .astro/.ts goes through withBase() so the site works under a
// sub-path (GitHub Pages: BASE_PATH=/<repo>/). Routes use trailing slashes (trailingSlash: 'always').
// Owner: design-system agent.

/** Anything with an id: a plain id string or a content reference `{ collection, id }`. */
export type IdLike = string | { id: string };

const rawBase: string = import.meta.env.BASE_URL ?? '/';
/** The configured base path, always with leading and trailing slash ('/' or '/repo/'). */
export const BASE: string = `/${rawBase.replace(/^\/+|\/+$/g, '')}/`.replace(/\/{2,}/g, '/');

const EXTERNAL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

/** Normalise an IdLike to its id string. */
export function idOf(x: IdLike): string {
  return typeof x === 'string' ? x : x.id;
}

/**
 * Prefix a site-relative path with the base path.
 * - External URLs (https:, mailto:, //host) and pure fragments (#id) are returned unchanged.
 * - Paths already starting with the base are not prefixed twice.
 *   withBase('/learn/') → '/learn/' (base '/') or '/repo/learn/' (base '/repo/')
 */
export function withBase(path = '/'): string {
  if (EXTERNAL.test(path) || path.startsWith('#') || path.startsWith('?')) return path;
  if (BASE !== '/' && (path === BASE.slice(0, -1) || path.startsWith(BASE))) return path;
  return BASE + path.replace(/^\.?\/+/, '');
}

/** Remove the base path from a pathname, returning a path with a leading slash ('/repo/learn/' → '/learn/'). */
export function stripBase(pathname: string): string {
  if (BASE !== '/' && pathname.startsWith(BASE)) return `/${pathname.slice(BASE.length)}`;
  if (BASE !== '/' && pathname === BASE.slice(0, -1)) return '/';
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

/** Ensure a trailing slash on a path without query or hash ('/learn' → '/learn/'). */
export function withTrailingSlash(path: string): string {
  const m = path.match(/^([^?#]*)(.*)$/);
  const p = m?.[1] ?? path;
  const rest = m?.[2] ?? '';
  if (p === '' || p.endsWith('/') || /\.[a-z\d]+$/i.test(p)) return path;
  return `${p}/${rest}`;
}

/** Absolute URL for canonical / OG tags. `site` comes from Astro.site (astro.config `site`). */
export function absoluteUrl(path: string, site: URL | string | undefined): string {
  if (EXTERNAL.test(path)) return path;
  const based = withBase(path);
  if (!site) return based;
  return new URL(based, site).href;
}

// ───────────── Section routes ─────────────
export const ROUTES = {
  home: '/',
  learn: '/learn/',
  chain: '/chain/',
  companies: '/companies/',
  models: '/models/',
  modelsCompare: '/models/compare/',
  trends: '/trends/',
  taiwan: '/taiwan/',
  memory: '/memory/',
  glossary: '/glossary/',
  sources: '/sources/',
  about: '/about/',
} as const;
export type RouteKey = keyof typeof ROUTES;

/** Based href of a top-level section: sectionHref('companies') → '/companies/'. */
export function sectionHref(key: RouteKey): string {
  return withBase(ROUTES[key]);
}

// ───────────── Entity routes ─────────────
export const learnHref = (slug: IdLike): string => withBase(`/learn/${idOf(slug)}/`);
export const companyHref = (id: IdLike): string => withBase(`/companies/${idOf(id)}/`);
export const modelHref = (id: IdLike): string => withBase(`/models/${idOf(id)}/`);
export const segmentHref = (id: IdLike): string => withBase(`/chain/${idOf(id)}/`);
export const trendHref = (slug: IdLike): string => withBase(`/trends/${idOf(slug)}/`);
/** '/glossary/' or '/glossary/#hbm' */
export const glossaryHref = (termId?: IdLike): string =>
  withBase(termId ? `/glossary/#${encodeURIComponent(idOf(termId))}` : '/glossary/');
/** '/models/compare/?m=a,b' */
export const modelsCompareHref = (versionIds: readonly string[] = []): string =>
  withBase(versionIds.length ? `/models/compare/?m=${versionIds.map(encodeURIComponent).join(',')}` : '/models/compare/');

// ───────────── Primary navigation ─────────────
export interface NavItem {
  key: RouteKey;
  label: string;
  path: string;
}
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'learn', label: '學習路徑', path: ROUTES.learn },
  { key: 'chain', label: '產業鏈', path: ROUTES.chain },
  { key: 'companies', label: '公司資料庫', path: ROUTES.companies },
  { key: 'models', label: '大模型', path: ROUTES.models },
  { key: 'trends', label: '未來趨勢', path: ROUTES.trends },
  { key: 'taiwan', label: '台灣供應鏈', path: ROUTES.taiwan },
  { key: 'memory', label: '記憶體', path: ROUTES.memory },
  { key: 'glossary', label: '名詞', path: ROUTES.glossary },
];

/** Which primary section a pathname belongs to ('/repo/companies/tsmc/' → 'companies'). */
export function sectionOf(pathname: string): RouteKey | null {
  const p = stripBase(pathname);
  if (p === '/' || p === '') return 'home';
  for (const item of NAV_ITEMS) if (p === item.path || p.startsWith(item.path)) return item.key;
  if (p.startsWith(ROUTES.sources)) return 'sources';
  if (p.startsWith(ROUTES.about)) return 'about';
  return null;
}
