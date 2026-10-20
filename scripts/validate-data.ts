// Content validator.
//   npx tsx scripts/validate-data.ts                 → every content file; refs checked against files on disk + registries
//   npx tsx scripts/validate-data.ts --only a b c    → only the given files; refs checked against registries
//   add --json for a machine-readable report
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { z } from 'astro/zod';
import { makeSchemas, type CollectionName } from '../src/schemas/index';
import { sceneMeta } from '../src/schemas/scene';
import {
  collectionOf, componentUses, idOf, listContentFiles, readEntry, registries, type Coll,
} from './lib/registry';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const onlyMode = argv.includes('--only');
const files = onlyMode ? argv.filter((a) => !a.startsWith('--')).map((p) => p.replace(/\\/g, '/')) : listContentFiles();
const R = registries();

type Issue = { file: string; level: 'error' | 'warn'; msg: string };
const issues: Issue[] = [];
const err = (file: string, msg: string) => issues.push({ file, level: 'error', msg });
const warn = (file: string, msg: string) => issues.push({ file, level: 'warn', msg });

// ── reference resolution ──────────────────────────────────────────────
const onDisk = (c: string) => {
  const dir = `src/content/${c}`;
  return new Set(existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.(mdx|md|json|ya?ml)$/, '')) : []);
};
const disk: Record<string, Set<string>> = {};
const known = (c: CollectionName, id: string): boolean => {
  switch (c) {
    case 'segments': return R.segments.has(id);
    case 'companies': return R.roster.has(id) || (!onlyMode && (disk[c] ??= onDisk(c)).has(id));
    case 'learn': return R.curriculum.has(id);
    case 'models': return R.models.has(id);
    case 'trends': return R.trends.has(id);
    case 'glossary': return R.glossary.has(id) || (disk[c] ??= onDisk(c)).has(id);
    default: return (disk[c] ??= onDisk(c)).has(id);
  }
};
const S = makeSchemas((c) => z.string().transform((id) => ({ collection: c, id })) as any);
const schemaFor: Record<Coll, z.ZodTypeAny> = {
  learn: S.learn, segments: S.segment, companies: S.company, financials: S.financials, models: S.model,
  trends: S.trend, glossary: S.glossary, sources: S.sourceRegistry, pages: S.page,
};
function walkRefs(v: unknown, path: string, out: { path: string; c: string; id: string }[]) {
  if (Array.isArray(v)) v.forEach((x, i) => walkRefs(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.collection === 'string' && typeof o.id === 'string' && Object.keys(o).length === 2) out.push({ path, c: o.collection, id: o.id });
    else for (const [k, x] of Object.entries(o)) walkRefs(x, path ? `${path}.${k}` : k, out);
  }
}

const PLACEHOLDER = /(TODO|TBD|待查|待補|XXX|lorem ipsum|placeholder)/i;
const DAY = 86400000;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

for (const file of files) {
  const coll = collectionOf(file);
  if (!coll) { err(file, 'not inside src/content/<collection>/'); continue; }
  if (!existsSync(file)) { err(file, 'file does not exist'); continue; }
  const id = idOf(file);
  let entry: { data: any; body: string | null };
  try { entry = readEntry(file); } catch (e) { err(file, `parse error: ${(e as Error).message}`); continue; }
  const parsed = schemaFor[coll].safeParse(entry.data);
  if (!parsed.success) {
    for (const i of parsed.error.issues) err(file, `schema: ${i.path.join('.') || '(root)'}: ${i.message}`);
    continue;
  }
  const d: any = parsed.data;
  const raw = readFileSync(file, 'utf8');
  if (PLACEHOLDER.test(raw.replace(/https?:\/\/\S+/g, ''))) err(file, `placeholder text found: ${raw.match(PLACEHOLDER)?.[0]}`);

  // refs
  const refs: { path: string; c: string; id: string }[] = [];
  walkRefs(d, '', refs);
  for (const r of refs) if (!known(r.c as CollectionName, r.id)) err(file, `unknown ${r.c} id "${r.id}" at ${r.path}`);

  // per-collection rules
  if (coll === 'companies') {
    const ro = R.roster.get(id);
    if (!ro) err(file, `company id "${id}" is not in src/data/roster/*.yaml`);
    else {
      if (ro.tier !== d.tier) err(file, `tier ${d.tier} ≠ roster tier ${ro.tier}`);
      if (ro.profile !== d.profile) err(file, `profile ${d.profile} ≠ roster profile ${ro.profile}`);
      if (ro.segment !== d.primarySegment.id) warn(file, `primarySegment ${d.primarySegment.id} ≠ roster file segment ${ro.segment}`);
    }
    const finExists = existsSync(`src/content/financials/${id}.json`);
    if (d.hasFinancials !== finExists) err(file, `hasFinancials=${d.hasFinancials} but financials/${id}.json ${finExists ? 'exists' : 'is missing'}`);
    if (d.profile === 'full') {
      for (const h of ['## 公司概況', '## 產品與技術', '## 營收表現解讀', '## 競爭格局', '## 風險與觀察重點'])
        if (!entry.body?.includes(h)) err(file, `full profile body missing heading "${h}"`);
    } else if (!entry.body?.includes('## 公司概況')) err(file, 'compact profile body missing "## 公司概況"');
  }
  if (coll === 'financials') {
    if (d.company.id !== id) err(file, `company "${d.company.id}" must equal file name "${id}"`);
    const ro = R.roster.get(id);
    for (const s of d.series) {
      const seen = new Set<string>();
      const pts = [...s.points].sort((a: any, b: any) => a.start.localeCompare(b.start));
      const [lo, hi] = s.periodType === 'quarter' ? [84, 98] : s.periodType === 'half' ? [175, 190] : s.periodType === 'year' ? [350, 380] : [27, 30];
      pts.forEach((p: any, i: number) => {
        if (seen.has(p.period)) err(file, `${s.metric}/${s.periodType}: duplicate period ${p.period}`);
        seen.add(p.period);
        const len = days(p.start, p.end);
        if (len < lo || len > hi) err(file, `${s.metric}/${s.periodType} ${p.period}: length ${len + 1} days outside expected range`);
        if (i > 0 && pts[i - 1].end >= p.start) err(file, `${s.metric}/${s.periodType} ${p.period}: overlaps previous period`);
        if (s.metric === 'revenue' && p.value < 0) err(file, `negative revenue at ${p.period}`);
        if (i > 0 && s.unit !== 'percent' && s.metric === 'revenue' && pts[i - 1].value > 0) {
          const ch = p.value / pts[i - 1].value - 1;
          if (Math.abs(ch) > 0.6 && !p.note && s.periodType !== 'month') warn(file, `${s.metric} ${p.period}: change ${(ch * 100).toFixed(0)}% vs previous without note`);
        }
      });
      if (s.currency && s.currency !== d.reportingCurrency && !s.label) warn(file, `${s.metric} currency ${s.currency} ≠ reportingCurrency`);
    }
    for (const m of d.mix) if (m.basis === 'share') {
      const sum = m.items.reduce((a: number, b: any) => a + b.value, 0);
      if (sum < 98 || sum > 102) err(file, `mix ${m.group} ${m.period}: shares sum to ${sum.toFixed(1)}%`);
    }
    if (ro && ro.tier === 1 && ro.ownership === 'listed') {
      const q = d.series.find((s: any) => s.metric === 'revenue' && (s.periodType === 'quarter' || s.periodType === 'half'));
      if (!q) err(file, 'tier-1 listed company needs quarterly (or half-yearly) revenue');
      else if (q.periodType === 'quarter' && q.points.length < 8) warn(file, `tier-1 listed: only ${q.points.length} quarters (≥ 8 expected unless recently listed — explain in a note)`);
    }
    if (ro?.twMonthly && !d.series.some((s: any) => s.periodType === 'month')) warn(file, 'Taiwan-listed company without monthly revenue');
    if (d.editorial.status === 'draft' && d.editorial.author === 'harvest-script') warn(file, 'financials still an unverified harvest draft');
  }
  if (coll === 'learn') {
    const c = R.curriculum.get(id);
    if (!c) err(file, `slug "${id}" not in src/data/curriculum.yaml`);
    else {
      if (c.order !== d.order) err(file, `order ${d.order} ≠ curriculum ${c.order}`);
      if (c.level !== d.level) err(file, `level ${d.level} ≠ curriculum ${c.level}`);
      for (const p of d.prerequisites) { const po = R.curriculum.get(p.id); if (po && po.order >= d.order) err(file, `prerequisite ${p.id} has order ≥ this article`); }
    }
  }
  if (coll === 'models') {
    if (!R.models.has(id)) err(file, `model family "${id}" not in src/data/models-index.yaml`);
    for (const v of d.versions) for (const b of v.benchmarks) if (!R.benchmarks.has(b.benchmark)) err(file, `unknown benchmark id "${b.benchmark}" (see src/data/benchmarks.yaml)`);
  }
  if (coll === 'trends' && !R.trends.has(id)) err(file, `trend "${id}" not in src/data/trends-index.yaml`);
  if (coll === 'glossary' && R.glossary.size && !R.glossary.has(id)) err(file, `term "${id}" not in src/data/glossary-index/*.yaml`);
  if (coll === 'segments' && !R.segments.has(id)) err(file, `segment "${id}" is not one of SEGMENT_IDS`);

  // MDX body rules
  if (entry.body != null) {
    const body = entry.body;
    const lines = body.split('\n');
    lines.forEach((l, i) => { if (/^#\s/.test(l)) err(file, `body line ${i + 1}: H1 not allowed (start at ##)`); });
    if (/\]\(\/(?!\/)/.test(body)) err(file, 'raw internal markdown link "](/…" — use CompanyChip/LearnLink/… components');
    if (/<(div|style|script|img)\b/i.test(body)) err(file, 'raw <div>/<style>/<script>/<img> not allowed in MDX');
    const glossaryDeclared = new Set((d.glossary ?? []).map((g: any) => g.id));
    for (const t of componentUses(body, 'Term', 'id')) {
      if (!R.glossary.has(t) && !known('glossary', t)) err(file, `<Term id="${t}"> unknown glossary id`);
      if (!glossaryDeclared.has(t)) err(file, `<Term id="${t}"> not listed in frontmatter glossary`);
    }
    const keys = new Set((d.sources ?? []).map((s: any) => s.key).filter(Boolean));
    for (const k of componentUses(body, 'Cite', 'k')) if (!keys.has(k)) err(file, `<Cite k="${k}"> has no matching sources[].key`);
    for (const s of componentUses(body, 'Scene3D', 'id')) if (!R.scenes.has(s)) err(file, `<Scene3D id="${s}"> unknown scene id`);
    for (const c of componentUses(body, 'CompanyChip', 'id')) if (!R.roster.has(c)) err(file, `<CompanyChip id="${c}"> not in roster`);
    for (const c of componentUses(body, 'ModelChip', 'id')) if (!R.models.has(c)) err(file, `<ModelChip id="${c}"> not in models-index`);
    for (const c of componentUses(body, 'SegmentChip', 'id')) if (!R.segments.has(c)) err(file, `<SegmentChip id="${c}"> unknown segment`);
    for (const c of componentUses(body, 'LearnLink', 'id')) if (!R.curriculum.has(c)) err(file, `<LearnLink id="${c}"> not in curriculum`);
    for (const c of componentUses(body, 'TrendLink', 'id')) if (!R.trends.has(c)) err(file, `<TrendLink id="${c}"> not in trends-index`);
    const opens = (body.match(/<(Callout|DeepDive|LevelSection|Term|CompanyChip|LearnLink|TrendLink|ModelChip|SegmentChip)\b[^>]*[^/]>/g) ?? []).length;
    const closes = (body.match(/<\/(Callout|DeepDive|LevelSection|Term|CompanyChip|LearnLink|TrendLink|ModelChip|SegmentChip)>/g) ?? []).length;
    if (opens !== closes) err(file, `unbalanced component tags (${opens} opening vs ${closes} closing)`);
    if (/(^|[^\\])[{}]/.test(body.replace(/\{\{[\s\S]*?\}\}|=\{[\s\S]*?\}(?=[\s/>])/g, '').replace(/`[^`]*`/g, '')))
      warn(file, 'stray { or } in MDX body text (MDX treats braces as JS expressions; escape as \\{ \\})');
    if (/(^|\s)<(?![A-Za-z/!])/.test(body.replace(/`[^`]*`/g, ''))) warn(file, 'bare "<" in body text — MDX may parse it as JSX; write &lt; or use 「小於」');
  }
}

// scene meta files (full mode only)
if (!onlyMode && existsSync('src/three/scenes')) {
  for (const id of readdirSync('src/three/scenes')) {
    const p = `src/three/scenes/${id}/meta.json`;
    if (!existsSync(p)) { warn(p, 'missing meta.json'); continue; }
    const r = sceneMeta.safeParse(JSON.parse(readFileSync(p, 'utf8')));
    if (!r.success) for (const i of r.error.issues) err(p, `scene meta: ${i.path.join('.')}: ${i.message}`);
    else if (r.data.id !== id) err(p, `meta.id "${r.data.id}" ≠ folder "${id}"`);
  }
}

const errors = issues.filter((i) => i.level === 'error');
const warns = issues.filter((i) => i.level === 'warn');
if (json) console.log(JSON.stringify({ files: files.length, errors, warnings: warns }, null, 1));
else {
  for (const i of issues) console.log(`${i.level === 'error' ? '✗' : '⚠'} ${i.file}: ${i.msg}`);
  console.log(`\n${files.length} files checked · ${errors.length} errors · ${warns.length} warnings`);
}
process.exit(errors.length ? 1 : 0);
