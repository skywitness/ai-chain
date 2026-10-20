// Coverage report: registries (roster, curriculum, models/trends/glossary indexes, SCENE_IDS) versus the files on disk,
// plus financials coverage and editorial-status counts.
//
//   npx tsx scripts/report-coverage.ts            tables
//   npx tsx scripts/report-coverage.ts --json     machine-readable report (for the orchestrator)
//   npx tsx scripts/report-coverage.ts --all      list every missing id (default: first 12 per section)
//   npx tsx scripts/report-coverage.ts --strict   exit 1 unless every registry id has a file
// Exit code: 0 (report only) unless --strict and something is missing.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { SCENE_IDS, SEGMENT_IDS } from '../src/schemas/common';
import { ROOT } from '../tests/helpers/env';
import { readEntry, registries, type RosterCo } from './lib/registry';

process.chdir(ROOT);

const { values: args } = parseArgs({
  options: {
    json: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
  },
});

const STATUSES = ['stub', 'draft', 'researched', 'fact-checked'] as const;
type Status = (typeof STATUSES)[number] | 'invalid';
const PAGE_SINGLETONS = ['home', 'chain', 'taiwan', 'methodology', 'about', 'models-intro', 'learn-intro'];
const SAMPLE = args.all ? Infinity : 12;

// ───────────────────────── loading ─────────────────────────

interface Entry {
  id: string;
  file: string;
  data: Record<string, unknown> | null;
  error?: string;
}

function listFiles(collection: string, ext: RegExp): Entry[] {
  const dir = `src/content/${collection}`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => ext.test(f) && !f.startsWith('_'))
    .sort()
    .map((f) => {
      const file = `${dir}/${f}`;
      const id = f.replace(ext, '');
      try {
        const { data } = readEntry(file);
        return { id, file, data: data && typeof data === 'object' ? (data as Record<string, unknown>) : null };
      } catch (e) {
        return { id, file, data: null, error: (e as Error).message };
      }
    });
}

const statusOf = (e: Entry): Status => {
  const ed = e.data?.['editorial'];
  const s = ed && typeof ed === 'object' ? (ed as Record<string, unknown>)['status'] : undefined;
  return typeof s === 'string' && (STATUSES as readonly string[]).includes(s) ? (s as Status) : 'invalid';
};

function statusCounts(entries: Entry[]): Record<Status, number> {
  const out: Record<Status, number> = { stub: 0, draft: 0, researched: 0, 'fact-checked': 0, invalid: 0 };
  for (const e of entries) out[statusOf(e)]++;
  return out;
}

// ───────────────────────── generic registry-vs-files section ─────────────────────────

interface Group {
  key: string;
  expected: number;
  present: number;
  missing: string[];
}
interface Section {
  name: string;
  expected: number;
  present: number;
  pct: number;
  missing: string[];
  extra: string[];
  groups: Group[];
  groupBy: string;
}

function section<T>(
  name: string,
  groupBy: string,
  registry: Map<string, T> | string[],
  files: Set<string>,
  groupOf: (id: string, item: T | undefined) => string,
  groupOrder?: readonly string[],
): Section {
  const ids = Array.isArray(registry) ? registry : [...registry.keys()];
  const get = (id: string) => (Array.isArray(registry) ? undefined : registry.get(id));
  const groups = new Map<string, Group>();
  for (const g of groupOrder ?? []) groups.set(g, { key: g, expected: 0, present: 0, missing: [] });
  for (const id of ids) {
    const key = groupOf(id, get(id));
    const g = groups.get(key) ?? groups.set(key, { key, expected: 0, present: 0, missing: [] }).get(key)!;
    g.expected++;
    if (files.has(id)) g.present++;
    else g.missing.push(id);
  }
  const idSet = new Set(ids);
  const missing = ids.filter((id) => !files.has(id));
  const present = ids.length - missing.length;
  return {
    name,
    groupBy,
    expected: ids.length,
    present,
    pct: ids.length ? Math.round((present / ids.length) * 1000) / 10 : 0,
    missing,
    extra: [...files].filter((f) => !idSet.has(f)).sort(),
    groups: [...groups.values()].filter((g) => g.expected > 0 || (groupOrder ?? []).includes(g.key)),
  };
}

// ───────────────────────── build the report ─────────────────────────

const R = registries();
const files = {
  companies: listFiles('companies', /\.mdx$/),
  financials: listFiles('financials', /\.json$/),
  learn: listFiles('learn', /\.mdx$/),
  segments: listFiles('segments', /\.mdx$/),
  models: listFiles('models', /\.mdx$/),
  trends: listFiles('trends', /\.mdx$/),
  glossary: listFiles('glossary', /\.ya?ml$/),
  sources: listFiles('sources', /\.ya?ml$/),
  pages: listFiles('pages', /\.mdx$/),
};
const idsOf = (es: Entry[]) => new Set(es.map((e) => e.id));

const roster = R.roster as Map<string, RosterCo>;
const companyIds = idsOf(files.companies);
const rosterBySegment = section('companies × roster (by primary segment)', 'segment', roster, companyIds, (_id, c) => c?.segment ?? '?', SEGMENT_IDS);
const rosterByTier = section('companies × roster (by tier)', 'tier', roster, companyIds, (_id, c) => `tier ${c?.tier ?? '?'}`, ['tier 1', 'tier 2', 'tier 3']);
const rosterByProfile = section('companies × roster (by profile)', 'profile', roster, companyIds, (_id, c) => c?.profile ?? '?', ['full', 'compact']);

// Segment sufficiency: ≥ 8 company files per segment (architecture §8.2).
const thinSegments = rosterBySegment.groups.filter((g) => g.present < 8).map((g) => `${g.key} (${g.present})`);

// Financials
const finIds = idsOf(files.financials);
const companiesClaiming = files.companies.filter((e) => e.data?.['hasFinancials'] === true).map((e) => e.id);
const listed = [...roster.values()].filter((c) => c.ownership === 'listed');
const finByTier = section('financials × listed roster companies (by tier)', 'tier', new Map(listed.map((c) => [c.id, c])), finIds, (_id, c) => `tier ${c?.tier ?? '?'}`, ['tier 1', 'tier 2', 'tier 3']);
const fullListed = listed.filter((c) => c.profile === 'full');
const twMonthlyIds = [...roster.values()].filter((c) => c.twMonthly).map((c) => c.id);
const withMonthly = new Set(
  files.financials
    .filter((e) => Array.isArray(e.data?.['series']) && (e.data['series'] as { periodType?: string }[]).some((s) => s.periodType === 'month'))
    .map((e) => e.id),
);
const financials = {
  files: finIds.size,
  claimedByCompanies: companiesClaiming.length,
  hasFinancialsMismatch: [
    ...companiesClaiming.filter((id) => !finIds.has(id)).map((id) => `${id}: hasFinancials=true, file missing`),
    ...files.companies.filter((e) => e.data?.['hasFinancials'] === false && finIds.has(e.id)).map((e) => `${e.id}: file exists, hasFinancials=false`),
  ],
  orphanFiles: [...finIds].filter((id) => !companyIds.has(id)).sort(),
  fullListedMissing: fullListed.filter((c) => !finIds.has(c.id)).map((c) => c.id),
  fullListedExpected: fullListed.length,
  twMonthlyExpected: twMonthlyIds.length,
  twMonthlyPresent: twMonthlyIds.filter((id) => withMonthly.has(id)).length,
  twMonthlyMissing: twMonthlyIds.filter((id) => !withMonthly.has(id)),
  byTier: finByTier,
};

const learn = section('learn × curriculum.yaml (by level)', 'level', R.curriculum, idsOf(files.learn), (_id, a) => `L${(a as { level?: number } | undefined)?.level ?? '?'}`, ['L1', 'L2', 'L3']);
const segments = section('segments × SEGMENT_IDS', 'layer', [...SEGMENT_IDS], idsOf(files.segments), () => 'all');
const models = section('models × models-index.yaml (by kind)', 'kind', R.models, idsOf(files.models), (_id, m) => String((m as { kind?: string } | undefined)?.kind ?? 'llm'));
const trends = section('trends × trends-index.yaml (by category)', 'category', R.trends, idsOf(files.trends), (_id, t) => String((t as { category?: string } | undefined)?.category ?? '?'), ['hardware', 'software', 'market', 'policy']);
// glossary-index/<category>.yaml: the category is the file name (registry.ts does not keep it).
const glossaryCategory = new Map<string, string>();
if (existsSync('src/data/glossary-index'))
  for (const f of readdirSync('src/data/glossary-index').filter((x) => /\.ya?ml$/.test(x))) {
    const doc = parseYaml(readFileSync(`src/data/glossary-index/${f}`, 'utf8')) as { terms?: { id: string; category?: string }[] } | null;
    for (const t of doc?.terms ?? []) glossaryCategory.set(t.id, t.category ?? f.replace(/\.ya?ml$/, ''));
  }
const glossary = section('glossary × glossary-index (by category)', 'category', R.glossary, idsOf(files.glossary), (id) => glossaryCategory.get(id) ?? '?');
const pages = section('pages × singleton list', 'page', PAGE_SINGLETONS, idsOf(files.pages), () => 'all');

// Scenes: SCENE_IDS × src/three/scenes/<id>/{index.ts, meta.json} × posters
const scenesDir = 'src/three/scenes';
const folders = existsSync(scenesDir) ? readdirSync(scenesDir).filter((d) => !d.startsWith('_') && !d.startsWith('.') && statSync(`${scenesDir}/${d}`).isDirectory()) : [];
const posterDir = 'src/assets/scene-posters';
const scenes = {
  ...section('scenes × SCENE_IDS (folders)', 'scene', [...SCENE_IDS], new Set(folders), () => 'all'),
  rows: SCENE_IDS.map((id) => ({
    id,
    folder: folders.includes(id),
    index: existsSync(`${scenesDir}/${id}/index.ts`),
    meta: existsSync(`${scenesDir}/${id}/meta.json`),
    posters: (['light', 'dark'] as const).filter((t) => existsSync(resolve(posterDir, `${id}-${t}.webp`))),
  })),
};

// `sources` (the publisher registry, schema `sourceRegistry`) has no `editorial` block by design,
// so it is left out of the status table instead of being counted as 60 "invalid" entries.
const NO_EDITORIAL = new Set<string>(['sources']);
const editorial = Object.fromEntries(
  (Object.keys(files) as (keyof typeof files)[])
    .filter((k) => !NO_EDITORIAL.has(k) && (k !== 'pages' || files.pages.length))
    .map((k) => [k, statusCounts(files[k])]),
) as Record<string, Record<Status, number>>;
const tier1 = files.companies.filter((e) => roster.get(e.id)?.tier === 1);
const tier1Status = statusCounts(tier1);
const parseErrors = Object.values(files).flat().filter((e) => e.error).map((e) => `${e.file}: ${e.error}`);

const sections = [rosterBySegment, rosterByTier, rosterByProfile, learn, segments, models, trends, glossary, pages, scenes];
const report = {
  generated: new Date().toISOString(),
  totals: {
    roster: roster.size,
    companies: files.companies.length,
    financials: finIds.size,
    learn: files.learn.length,
    segments: files.segments.length,
    models: files.models.length,
    trends: files.trends.length,
    glossary: files.glossary.length,
    sources: files.sources.length,
    pages: files.pages.length,
    sceneFolders: folders.length,
  },
  companies: { bySegment: rosterBySegment, byTier: rosterByTier, byProfile: rosterByProfile, thinSegments },
  financials,
  learn,
  segments,
  models,
  trends,
  glossary,
  pages,
  scenes,
  editorial,
  tier1Editorial: tier1Status,
  parseErrors,
};

// ───────────────────────── output ─────────────────────────

/** Display width: East Asian wide/fullwidth characters take two columns. */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}
const pad = (s: string, n: number, right = false) => (right ? ' '.repeat(Math.max(0, n - width(s))) + s : s + ' '.repeat(Math.max(0, n - width(s))));
function table(headers: string[], rows: string[][], numeric: boolean[] = []): string {
  const ws = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
  const line = (r: string[]) => r.map((c, i) => pad(c, ws[i] ?? 0, numeric[i])).join('  ').trimEnd();
  return [line(headers), ws.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const bar = (a: number, b: number) => {
  const n = b ? Math.round((a / b) * 12) : 0;
  return '█'.repeat(n) + '░'.repeat(12 - n);
};
const sample = (xs: string[]) => (xs.length > SAMPLE ? `${xs.slice(0, SAMPLE).join(', ')} … +${xs.length - SAMPLE}` : xs.join(', '));

function printSection(s: Section) {
  console.log(`\n■ ${s.name}: ${s.present}/${s.expected} (${pct(s.present, s.expected)})`);
  if (s.groups.length > 1)
    console.log(
      table(
        [s.groupBy, 'files', 'registry', 'cover', ''],
        s.groups.map((g) => [g.key, String(g.present), String(g.expected), pct(g.present, g.expected), bar(g.present, g.expected)]),
        [false, true, true, true, false],
      ),
    );
  if (s.missing.length) console.log(`  missing (${s.missing.length}): ${sample(s.missing)}`);
  if (s.extra.length) console.log(`  ⚠ files not in the registry (${s.extra.length}): ${sample(s.extra)}`);
}

if (args.json) console.log(JSON.stringify(report, null, 1));
else {
  console.log(`Coverage report · ${new Date(report.generated).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' })}`);
  console.log(
    table(
      ['collection', 'files'],
      Object.entries(report.totals).map(([k, v]) => [k, String(v)]),
      [false, true],
    ),
  );
  printSection(rosterBySegment);
  if (thinSegments.length && rosterBySegment.present) console.log(`  ⚠ segments with fewer than 8 company files: ${sample(thinSegments)}`);
  printSection(rosterByTier);
  printSection(rosterByProfile);

  console.log(`\n■ financials: ${financials.files} files · ${financials.claimedByCompanies} companies declare hasFinancials`);
  console.log(
    table(
      ['tier (listed)', 'with file', 'listed', 'cover'],
      finByTier.groups.map((g) => [g.key, String(g.present), String(g.expected), pct(g.present, g.expected)]),
      [false, true, true, true],
    ),
  );
  console.log(`  full-profile listed companies with financials: ${financials.fullListedExpected - financials.fullListedMissing.length}/${financials.fullListedExpected}`);
  console.log(`  Taiwan monthly revenue series: ${financials.twMonthlyPresent}/${financials.twMonthlyExpected}`);
  if (financials.hasFinancialsMismatch.length) console.log(`  ✗ hasFinancials mismatches: ${sample(financials.hasFinancialsMismatch)}`);
  if (financials.orphanFiles.length) console.log(`  ⚠ financials without a company file: ${sample(financials.orphanFiles)}`);

  for (const s of [learn, segments, models, trends, glossary, pages]) printSection(s);
  if (!R.glossary.size) console.log('  (glossary-index is empty — src/data/glossary-index/*.yaml)');

  console.log(`\n■ scenes: ${scenes.present}/${scenes.expected} folders`);
  console.log(
    table(
      ['scene', 'folder', 'index.ts', 'meta.json', 'posters'],
      scenes.rows.map((r) => [r.id, r.folder ? '✓' : '·', r.index ? '✓' : '·', r.meta ? '✓' : '·', r.posters.join('+') || '·']),
    ),
  );
  if (scenes.extra.length) console.log(`  ⚠ folders not in SCENE_IDS: ${scenes.extra.join(', ')}`);

  console.log('\n■ editorial status');
  console.log(
    table(
      ['collection', ...STATUSES, 'invalid', 'total'],
      [
        ...Object.entries(editorial).map(([k, c]) => [k, ...STATUSES.map((s) => String(c[s])), String(c.invalid), String(Object.values(c).reduce((a, b) => a + b, 0))]),
        ['tier-1 companies', ...STATUSES.map((s) => String(tier1Status[s])), String(tier1Status.invalid), String(tier1.length)],
      ],
      [false, true, true, true, true, true, true],
    ),
  );
  if (parseErrors.length) {
    console.log(`\n✗ files that could not be parsed (${parseErrors.length}):`);
    for (const e of parseErrors.slice(0, SAMPLE)) console.log(`  ${e}`);
  }
}

const incomplete = sections.some((s) => s.missing.length > 0) || financials.hasFinancialsMismatch.length > 0;
process.exitCode = args.strict && (incomplete || parseErrors.length) ? 1 : 0;
