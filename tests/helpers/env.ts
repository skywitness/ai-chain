// Shared environment for QA tests and scripts (Playwright specs, scripts/check-*.ts, scripts/capture-*.ts).
// Every path here is resolved from the repo root, so callers work from any cwd.
//
//   BASE_URL    origin of the server under test            (default http://127.0.0.1:4321)
//   BASE_PATH   Astro `base` the site was built/served with (default "/"), e.g. "/ai-chain-atlas/"
//   SITE_URL    production origin used for canonical/OG URLs (default: the value in astro.config.mjs)
//   DIST_DIR    build output directory                       (default dist)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute path of the build output directory. */
export const DIST = resolve(ROOT, process.env['DIST_DIR'] ?? 'dist');

/** The suffix every page title except the home page must end with. */
export const SITE_NAME = 'AI 產業鏈全景';
export const TITLE_SUFFIX = `｜${SITE_NAME}`;

/** Normalise an Astro base path so it always starts and ends with "/" ("" and undefined → "/"). */
export function normalizeBase(base: string | undefined): string {
  if (base && /^[A-Za-z]:[\\/]/.test(base.trim()))
    throw new Error(
      `base path "${base}" looks like a Windows path — Git Bash converted "/…" for you. ` +
        'Write it without the leading slash (BASE_PATH=repo/ or --base repo) or set MSYS_NO_PATHCONV=1.',
    );
  const trimmed = (base ?? '/').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

export const BASE_PATH = normalizeBase(process.env['BASE_PATH']);
export const BASE_URL = (process.env['BASE_URL'] ?? 'http://127.0.0.1:4321').trim().replace(/\/+$/, '');

/**
 * Build the absolute URL of a site route.
 * `route` is site-relative and base-less ("/", "/chain/foundry-packaging/").
 * BASE_PATH is added unless `baseUrl` already ends with it.
 */
export function urlFor(route: string, baseUrl: string = BASE_URL, basePath: string = BASE_PATH): string {
  const origin = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  let prefix = origin.pathname.endsWith('/') ? origin.pathname : `${origin.pathname}/`;
  if (!prefix.endsWith(basePath)) prefix = prefix.replace(/\/$/, '') + basePath;
  const [path = '', rest = ''] = splitSuffix(route);
  return new URL(prefix + path.replace(/^\/+/, '') + rest, origin).href;
}

/** Strip BASE_PATH from an absolute pathname ("/repo/chain/" → "/chain/"); null if outside the base. */
export function stripBase(pathname: string, basePath: string = BASE_PATH): string | null {
  if (basePath === '/') return pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (pathname === basePath.slice(0, -1)) return '/';
  return pathname.startsWith(basePath) ? `/${pathname.slice(basePath.length)}` : null;
}

/** Production origin (SITE_URL env, else the default written in astro.config.mjs). */
export function siteUrl(): string {
  const env = process.env['SITE_URL'];
  if (env) return env.replace(/\/+$/, '');
  const cfg = resolve(ROOT, 'astro.config.mjs');
  if (existsSync(cfg)) {
    const m = readFileSync(cfg, 'utf8').match(/site:\s*process\.env\.SITE_URL\s*\?\?\s*['"]([^'"]+)['"]/);
    if (m?.[1]) return m[1].replace(/\/+$/, '');
  }
  return 'https://example.org';
}

/** Comma/space/newline separated list from an env var (empty entries dropped). */
export function envList(name: string): string[] {
  return (process.env[name] ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** True when the env var is set to 1/true/yes. */
export function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? '');
}

function splitSuffix(route: string): [string, string] {
  const i = route.search(/[?#]/);
  return i < 0 ? [route, ''] : [route.slice(0, i), route.slice(i)];
}
