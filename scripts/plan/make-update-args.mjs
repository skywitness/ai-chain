// Build the args JSON for an update run of research/plan/workflows/content-wf.js.
// See docs/UPDATING.md for the full procedure.
//
// Examples:
//   node scripts/plan/make-update-args.mjs --type financials-update --as-of 2027-01-31 --tier 1 --listed
//   node scripts/plan/make-update-args.mjs --type refresh --collection models --all --as-of 2027-01-31
//   node scripts/plan/make-update-args.mjs --type refresh --collection companies --ids openai,anthropic --as-of 2027-01-31 --focus "funding, valuation, latest models"
//   node scripts/plan/make-update-args.mjs --type company-compact --ids new-co-1,new-co-2 --as-of 2027-01-31      (new companies already added to the roster)
//   node scripts/plan/make-update-args.mjs --type refresh --collection trends --all --check-only --as-of 2027-01-31  (fact-check only)
//
// Options:
//   --type        financials-update | refresh | company-full | company-compact | model | trend | learn | segment | glossary
//   --collection  for refresh: companies | models | trends | learn | segments | glossary | pages
//   --ids a,b,c   explicit ids;  --all  every id of the collection;  filters for companies: --tier 1 --listed --segment <id> --region TW
//   --batch N     ids per batch (defaults: financials-update 3, refresh 3, company-compact 10, company-full 3, model 3, trend 3, learn 2)
//   --as-of       data date YYYY-MM-DD (required for updates)
//   --check-only  only run the fact-check stage (skipWrite)
//   --focus "…"   extra instructions for refresh batches
//   --limit N     concurrency (default 1 — the user prefers one agent at a time)
//   --out path    default research/plan/update-args.json
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const type = opt('type');
const asOf = opt('as-of');
if (!type) throw new Error('--type is required (see the header of this file)');
if (!asOf && ['financials-update', 'refresh'].includes(type)) throw new Error('--as-of YYYY-MM-DD is required for updates');

const roster = [];
for (const f of readdirSync('src/data/roster').filter((f) => f.endsWith('.yaml'))) {
  const d = parse(readFileSync(`src/data/roster/${f}`, 'utf8'));
  for (const c of d.companies) roster.push({ ...c, segment: d.segment });
}
const yamlIds = (p, key) => parse(readFileSync(p, 'utf8'))[key].map((x) => x.id ?? x.slug);
const allIds = {
  companies: () => roster.map((c) => c.id),
  models: () => yamlIds('src/data/models-index.yaml', 'families'),
  trends: () => yamlIds('src/data/trends-index.yaml', 'trends'),
  learn: () => yamlIds('src/data/curriculum.yaml', 'articles'),
  segments: () => readdirSync('src/content/segments').map((f) => f.replace('.mdx', '')),
  glossary: () => readdirSync('src/data/glossary-index').map((f) => f.replace('.yaml', '')), // categories
  pages: () => ['pages'],
};
const collection = opt('collection') ?? ({
  'financials-update': 'companies', 'company-full': 'companies', 'company-compact': 'companies',
  model: 'models', trend: 'trends', learn: 'learn', segment: 'segments', glossary: 'glossary',
}[type]);
if (!collection) throw new Error('--collection is required for --type refresh');

let ids = opt('ids') ? opt('ids').split(',').map((s) => s.trim()).filter(Boolean) : flag('all') || opt('tier') || opt('segment') || opt('region') || flag('listed') ? allIds[collection]() : [];
if (collection === 'companies') {
  const by = new Map(roster.map((c) => [c.id, c]));
  const unknown = ids.filter((i) => !by.has(i));
  if (unknown.length) throw new Error(`not in roster (add them to src/data/roster/*.yaml first): ${unknown.join(', ')}`);
  if (opt('tier')) ids = ids.filter((i) => String(by.get(i).tier) === opt('tier'));
  if (flag('listed')) ids = ids.filter((i) => by.get(i).ownership === 'listed');
  if (opt('segment')) ids = ids.filter((i) => by.get(i).segment === opt('segment'));
  if (opt('region')) ids = ids.filter((i) => by.get(i).region === opt('region'));
  if (type === 'financials-update') ids = ids.filter((i) => existsSync(`src/content/financials/${i}.json`));
}
if (!ids.length) throw new Error('no ids selected');

const filesFor = (id) => {
  switch (collection) {
    case 'companies': return [`src/content/companies/${id}.mdx`, `src/content/financials/${id}.json`].filter(existsSync);
    case 'models': return [`src/content/models/${id}.mdx`];
    case 'trends': return [`src/content/trends/${id}.mdx`];
    case 'learn': return [`src/content/learn/${id}.mdx`];
    case 'segments': return [`src/content/segments/${id}.mdx`];
    case 'glossary': return [`the src/content/glossary/<id>.yaml file for every id in src/data/glossary-index/${id}.yaml`];
    case 'pages': return ['src/content/pages/*.mdx', 'src/content/sources/*.yaml', 'src/data/taiwan/sites.yaml', 'src/data/campuses.yaml'];
  }
};
const defaultBatch = { 'financials-update': 3, refresh: 3, 'company-compact': 10, 'company-full': 3, model: 3, trend: 3, learn: 2, segment: 1, glossary: 1 };
const n = Number(opt('batch', defaultBatch[type] ?? 3));
const segOf = (id) => roster.find((c) => c.id === id)?.segment;
const items = [];
for (let i = 0; i < ids.length; i += n) {
  const chunk = ids.slice(i, i + n);
  const label = `${type}-${String(i / n + 1).padStart(2, '0')}`;
  const item = { type, label, ids: chunk };
  if (type === 'refresh' || flag('check-only')) item.files = chunk.flatMap(filesFor);
  if (opt('focus')) item.focus = opt('focus');
  if (flag('check-only')) item.skipWrite = true;
  if (collection === 'companies' && ['company-full', 'company-compact'].includes(type)) item.note = `Primary segment: ${segOf(chunk[0])}.`;
  items.push(item);
}
const out = opt('out', 'research/plan/update-args.json');
const run = `${type}-${asOf ?? 'new'}`;
writeFileSync(out, JSON.stringify({ run, asOf, searchBudget: 2, limit: Number(opt('limit', 1)), items }));
console.log(`${out}: ${items.length} batch(es), ${ids.length} id(s), type ${type}${flag('check-only') ? ' (check only)' : ''}, asOf ${asOf ?? '(default)'}`);
