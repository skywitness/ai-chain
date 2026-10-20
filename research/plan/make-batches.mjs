// Generate batch args for content runs C2 (full companies + learn) and C3a/C3b (compact companies + pages).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const SEG_ORDER = [
  'energy-power', 'semi-equipment-materials', 'foundry-packaging', 'memory-storage', 'eda-ip-design',
  'ai-accelerators', 'networking-optics', 'servers-systems', 'datacenter-infra', 'cloud-neocloud',
  'foundation-models', 'devtools-data-mlops', 'apps-agents', 'physical-ai',
];
const roster = {};
for (const f of readdirSync('src/data/roster').filter((f) => f.endsWith('.yaml'))) {
  const d = parse(readFileSync(`src/data/roster/${f}`, 'utf8'));
  roster[d.segment] = d.companies;
}
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// C2: full profiles (3 per batch) + learn (2 per batch)
const c2 = [];
let k = 0;
for (const s of SEG_ORDER) {
  const full = (roster[s] ?? []).filter((c) => c.profile === 'full').map((c) => c.id);
  for (const b of chunk(full, 3)) c2.push({ type: 'company-full', label: `full-${String(++k).padStart(2, '0')}-${s}`, ids: b, note: `Primary segment: ${s}.` });
}
const cur = parse(readFileSync('src/data/curriculum.yaml', 'utf8')).articles.sort((a, b) => a.order - b.order).map((a) => a.slug);
chunk(cur, 2).forEach((b, i) => c2.push({ type: 'learn', label: `learn-${String(i + 1).padStart(2, '0')}`, ids: b }));
writeFileSync('research/plan/c2-args.json', JSON.stringify({ run: 'c2', searchBudget: 2, items: c2 }, null, 1));

// C3: compact profiles (10 per batch), split into two runs; pages batch goes in C3a
const compact = [];
k = 0;
for (const s of SEG_ORDER) {
  const ids = (roster[s] ?? []).filter((c) => c.profile === 'compact').map((c) => c.id);
  for (const b of chunk(ids, 10)) compact.push({ type: 'company-compact', label: `compact-${String(++k).padStart(2, '0')}-${s}`, ids: b, note: `Primary segment: ${s}.` });
}
const half = Math.ceil(compact.length / 2);
const c3a = [{ type: 'pages', label: 'pages', ids: ['pages'] }, ...compact.slice(0, half)];
const c3b = compact.slice(half);
writeFileSync('research/plan/c3a-args.json', JSON.stringify({ run: 'c3a', searchBudget: 1, items: c3a }, null, 1));
writeFileSync('research/plan/c3b-args.json', JSON.stringify({ run: 'c3b', searchBudget: 1, items: c3b }, null, 1));
console.log({ c2: c2.length, c2full: c2.filter((x) => x.type === 'company-full').length, c3a: c3a.length, c3b: c3b.length, compactCompanies: compact.flatMap((x) => x.ids).length });
