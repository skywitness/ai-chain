// Internal link checker for the built site.
//
//   npx tsx scripts/check-links.ts                 serve dist/ (respecting BASE_PATH) and crawl it
//   npx tsx scripts/check-links.ts --json          machine-readable report on stdout
//   npx tsx scripts/check-links.ts --url http://127.0.0.1:4321   crawl an already running server (preview) instead
//   npx tsx scripts/check-links.ts --external      also check external links (failures are warnings, never fatal)
//   npx tsx scripts/check-links.ts --no-fragments  skip #fragment validation
//   options: --dist <dir> (default dist) · --base <path> (default $BASE_PATH or "/") · --concurrency <n> · --timeout <ms>
//
// Every HTML page in dist/ is a crawl start point, so orphan pages are checked too, and the report lists pages that
// no other page links to. Canonical/OG links to SITE_URL are rewritten to the local server and checked as internal.
// Exit code: 0 = no broken internal links or fragments · 1 = broken internal links/fragments · 2 = setup error.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LinkChecker, LinkState, type LinkResult } from 'linkinator';
import { globSync } from 'tinyglobby';
import { BASE_PATH, DIST, ROOT, normalizeBase, siteUrl } from '../tests/helpers/env';
import { startStaticServer, type StaticServer } from '../tests/helpers/static-server';

process.chdir(ROOT);

const { values: args } = parseArgs({
  options: {
    dist: { type: 'string' },
    base: { type: 'string' },
    url: { type: 'string' },
    json: { type: 'boolean', default: false },
    external: { type: 'boolean', default: false },
    'no-fragments': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '50' },
    timeout: { type: 'string', default: '15000' },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
  allowPositionals: false,
});

const dist = args.dist ? resolve(ROOT, args.dist) : DIST;
const base = args.base ? normalizeBase(args.base) : BASE_PATH;
const log = (...a: unknown[]) => {
  if (!args.json) console.log(...a);
};

interface Broken {
  url: string;
  status: number | null;
  reason: string;
  parents: string[];
}
interface Report {
  target: string;
  basePath: string;
  pages: number;
  linksChecked: number;
  internalOk: number;
  externalChecked: number;
  skipped: number;
  broken: Broken[];
  brokenFragments: Broken[];
  externalBroken: Broken[];
  redirects: { url: string; target: string | null; status: number }[];
  orphans: string[];
  passed: boolean;
}

function htmlPages(): string[] {
  return globSync('**/*.html', { cwd: dist, ignore: ['_astro/**', 'pagefind/**', 'dev/**'], expandDirectories: false })
    .map((f) => f.replace(/\\/g, '/'))
    .sort();
}
function pageUrl(prefix: string, file: string): string {
  return prefix + file.replace(/(^|\/)index\.html$/, '$1');
}
/**
 * Static link graph over dist/: page URL → pages that link to it with <a>/<area href>.
 * (linkinator only reports a parent for the first occurrence of an OK link, so orphans are computed here.)
 */
function inboundLinks(files: string[], prefix: string): Map<string, Set<string>> {
  const inbound = new Map<string, Set<string>>();
  const re = /<(?:a|area)\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
  for (const f of files) {
    const from = pageUrl(prefix, f);
    const html = readFileSync(resolve(dist, f), 'utf8');
    for (const m of html.matchAll(re)) {
      const raw = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').trim();
      if (!raw || raw.startsWith('#') || (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw))) continue;
      let to: string;
      try {
        const u = new URL(raw, from);
        u.hash = '';
        u.search = '';
        to = u.href;
      } catch {
        continue;
      }
      if (to === from) continue;
      (inbound.get(to) ?? inbound.set(to, new Set()).get(to)!).add(from);
    }
  }
  return inbound;
}

const reasonOf = (r: LinkResult): string => {
  for (const d of r.failureDetails ?? []) {
    if (d instanceof Error) return d.message;
    if (d && typeof d === 'object' && 'status' in d) return `HTTP ${(d as { status: number }).status}`;
  }
  return r.status ? `HTTP ${r.status}` : 'unreachable';
};

async function main(): Promise<number> {
  if (!existsSync(resolve(dist, 'index.html'))) {
    console.error(`✗ ${resolve(dist, 'index.html')} not found — build the site first (npm run build).`);
    return 2;
  }
  const files = htmlPages();

  let server: StaticServer | null = null;
  let prefix: string;
  if (args.url) {
    const u = new URL(args.url);
    prefix = u.origin + (u.pathname.endsWith(base) ? u.pathname : u.pathname.replace(/\/$/, '') + base);
  } else {
    server = await startStaticServer({ root: dist, basePath: base });
    prefix = server.url;
  }
  const localOrigin = new URL(prefix).origin;
  const site = siteUrl();
  const isInternal = (href: string) => {
    try {
      return new URL(href).origin === localOrigin;
    } catch {
      return false;
    }
  };

  const starts = files.map((f) => pageUrl(prefix, f));
  log(`Link check · ${args.url ? args.url : `serving ${dist}`} → ${prefix} (BASE_PATH ${base})`);
  log(`  ${starts.length} HTML pages as start points · fragments ${args['no-fragments'] ? 'off' : 'on'} · external ${args.external ? 'on (non-blocking)' : 'skipped'}`);

  const checker = new LinkChecker();
  const redirects: Report['redirects'] = [];
  checker.on('redirect', (d) => {
    if (isInternal(d.url)) redirects.push({ url: d.url, target: d.targetUrl ?? null, status: d.status });
  });
  if (args.verbose) checker.on('pagestart', (u) => log(`  · ${u}`));

  const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let result: { links: LinkResult[]; passed: boolean };
  try {
    result = await checker.check({
      path: starts,
      recurse: true,
      checkFragments: !args['no-fragments'],
      concurrency: Number(args.concurrency) || 50,
      timeout: Number(args.timeout) || 15000,
      redirects: 'warn',
      retryErrors: true,
      retryErrorsCount: 2,
      retryErrorsJitter: 500,
      // Production-absolute URLs (canonical, og:url, sitemap) point at this build: check them locally.
      urlRewriteExpressions: [{ pattern: new RegExp(`^${escaped}(?=/|$)`), replacement: localOrigin }],
      linksToSkip: async (link: string) => !args.external && !isInternal(link),
    });
  } finally {
    await server?.close();
  }

  // ── classify ──
  const byKey = new Map<string, Broken>();
  const add = (bucket: Map<string, Broken>, r: LinkResult) => {
    const key = r.url;
    const b = bucket.get(key) ?? { url: r.url, status: r.status ?? null, reason: reasonOf(r), parents: [] };
    if (r.parent && !b.parents.includes(r.parent)) b.parents.push(r.parent);
    bucket.set(key, b);
  };
  const fragBucket = new Map<string, Broken>();
  const extBucket = new Map<string, Broken>();
  let internalOk = 0;
  let externalChecked = 0;
  let skipped = 0;

  for (const r of result.links) {
    const internal = isInternal(r.url);
    if (r.state === LinkState.SKIPPED) {
      skipped++;
      continue;
    }
    if (!internal) externalChecked++;
    if (r.state === LinkState.BROKEN) {
      const isFragment = (r.failureDetails ?? []).some((d) => d instanceof Error && /Fragment identifier/.test(d.message));
      if (!internal) add(extBucket, r);
      else if (isFragment) add(fragBucket, r);
      else add(byKey, r);
    } else if (internal) internalOk++;
  }

  // Report URLs as site paths *including* the base, so a link that forgot BASE_PATH is visibly different.
  const rel = (u: string) => (u.startsWith(localOrigin) ? decodeURI(u.slice(localOrigin.length)) || '/' : u);
  const relBroken = (b: Broken): Broken => ({ ...b, url: rel(b.url), parents: b.parents.map(rel).sort() });
  const sortBroken = (m: Map<string, Broken>) => [...m.values()].map(relBroken).sort((a, b) => a.url.localeCompare(b.url));

  const homeUrl = prefix;
  const inbound = inboundLinks(files, prefix);
  const orphans = starts
    .filter((u) => u !== homeUrl && !/404\.html$/.test(u) && !(inbound.get(u)?.size))
    .map(rel);

  const report: Report = {
    target: prefix,
    basePath: base,
    pages: starts.length,
    linksChecked: result.links.length,
    internalOk,
    externalChecked,
    skipped,
    broken: sortBroken(byKey),
    brokenFragments: sortBroken(fragBucket),
    externalBroken: sortBroken(extBucket),
    redirects: redirects.map((r) => ({ ...r, url: rel(r.url), target: r.target ? rel(r.target) : null })),
    orphans,
    passed: byKey.size === 0 && fragBucket.size === 0,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 1));
  } else {
    const list = (title: string, items: Broken[], mark: string) => {
      if (!items.length) return;
      log(`\n${mark} ${title} (${items.length})`);
      for (const b of items) {
        log(`  ${b.reason.padEnd(14)} ${b.url}`);
        for (const p of b.parents.slice(0, 5)) log(`      ← ${p}`);
        if (b.parents.length > 5) log(`      ← … ${b.parents.length - 5} more pages`);
      }
    };
    list('broken internal links', report.broken, '✗');
    list('missing #fragment targets', report.brokenFragments, '✗');
    list('broken external links (non-blocking)', report.externalBroken, '⚠');
    if (report.redirects.length) {
      log(`\n⚠ internal links that redirect (${report.redirects.length}) — link to the final URL (trailing slash?)`);
      for (const r of report.redirects.slice(0, 30)) log(`  ${r.status} ${r.url} → ${r.target ?? '?'}`);
    }
    if (report.orphans.length) {
      log(`\n⚠ pages no other page links to (${report.orphans.length})`);
      for (const o of report.orphans.slice(0, 50)) log(`  ${o}`);
      if (report.orphans.length > 50) log(`  … ${report.orphans.length - 50} more`);
    }
    log(
      `\n${report.passed ? '✓' : '✗'} ${report.pages} pages · ${report.linksChecked} links · ${report.internalOk} internal OK · ` +
        `${report.broken.length} broken · ${report.brokenFragments.length} bad fragments · ${report.redirects.length} redirects · ` +
        `${report.orphans.length} orphans · ${report.skipped} skipped${args.external ? ` · ${report.externalBroken.length}/${report.externalChecked} external broken` : ''}`,
    );
  }
  return report.passed ? 0 : 1;
}

// Set exitCode instead of calling process.exit(): on Windows, exiting while undici's fetch handles are still
// closing trips a libuv assertion (src\win\async.c). The loop drains once the local server has closed.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`✗ link check crashed: ${(e as Error).stack ?? String(e)}`);
    process.exitCode = 2;
  },
);
