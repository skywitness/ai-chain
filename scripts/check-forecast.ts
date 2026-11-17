// Validate the financial-model data: the memory topic sub-pages (src/data/memory/forecast/: market prices, Phison,
// Micron) and the /forecast/ pages (src/data/forecast/: <company>-inputs.yaml, -drivers.yaml, -model.json).
//   npx tsx scripts/check-forecast.ts [--dir <dir>] [--no-rerun]      (--dir: check every file in one folder, e.g. staging)
// Checks: schemas (src/schemas/forecast.ts); every `src` key exists in the file's `sources`; quarters are unique,
// sorted and contiguous (no gaps); start < end; gross profit ≤ revenue; placeholders. For each model output it also
// re-runs scripts/models/<company>.ts (export function buildModel(inputs, prices, drivers?): ModelOutput) and fails when
// the committed JSON differs from the recomputed one (generatedOn ignored), so every published number is reproducible.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { FORECAST_COMPANIES, companyDrivers, companyInputs, marketPrices, modelOutput } from '../src/schemas/forecast';

const argv = process.argv.slice(2);
const dirArg = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1]! : undefined;
const MEMORY_DIR = 'src/data/memory/forecast';
const FORECAST_DIR = 'src/data/forecast';
/** Phison and Micron live in the memory topic; the other companies under src/data/forecast/. */
const dirOf = (company?: string) => dirArg ?? (!company || company === 'phison' || company === 'micron' ? MEMORY_DIR : FORECAST_DIR);
const MEMORY_ONLY = new Set(['phison', 'micron']);
const rerun = !argv.includes('--no-rerun');
let errors = 0;
let warnings = 0;
const err = (f: string, m: string) => { errors++; console.log(`✗ ${f}: ${m}`); };
const warn = (f: string, m: string) => { warnings++; console.log(`⚠ ${f}: ${m}`); };

const read = (f: string, company?: string): unknown => {
  const p = join(dirOf(company), f);
  if (!existsSync(p)) return undefined;
  const txt = readFileSync(p, 'utf8');
  if (/(TODO|TBD|待查|待補|XXX)/.test(txt)) err(f, 'placeholder text found');
  try { return f.endsWith('.json') ? JSON.parse(txt) : parse(txt); } catch (e) { err(f, `parse error: ${(e as Error).message}`); return undefined; }
};

const srcKeys = (f: string, d: any) => {
  const keys = new Set(Object.keys(d.sources ?? {}));
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'src' && typeof x === 'string') { if (!keys.has(x)) err(f, `unknown src key "${x}"`); } else if (k !== 'sources') walk(x); }
  };
  walk(d);
};

const qIndex = (p: string) => { const m = p.match(/^(FY)?(\d{4})Q([1-4])$/); return m ? Number(m[2]) * 4 + Number(m[3]) - 1 : NaN; };

// market prices
const pricesRaw = dirArg && !existsSync(join(dirArg, 'market-prices.yaml')) ? null : read('market-prices.yaml');
let prices: any;
if (pricesRaw === null) { /* --dir without a market-prices copy: nothing to check */ } else if (pricesRaw === undefined) warn('market-prices.yaml', 'missing');
else {
  const r = marketPrices.safeParse(pricesRaw);
  if (!r.success) for (const i of r.error.issues) err('market-prices.yaml', `schema: ${i.path.join('.')}: ${i.message}`);
  else {
    prices = r.data;
    srcKeys('market-prices.yaml', prices);
    const ids = new Set<string>();
    for (const s of prices.series) {
      if (ids.has(s.id)) err('market-prices.yaml', `duplicate series id ${s.id}`);
      ids.add(s.id);
      const seen = new Set<string>();
      for (const p of s.points) { if (seen.has(p.period)) err('market-prices.yaml', `${s.id}: duplicate period ${p.period}`); seen.add(p.period); }
    }
    console.log(`✓ market-prices.yaml (${prices.series.length} series)`);
  }
}

// company inputs + model outputs
for (const company of FORECAST_COMPANIES) {
  const fi = `${company}-inputs.yaml`;
  const raw = read(fi, company);
  let inputs: any;
  if (raw === undefined) { if (MEMORY_ONLY.has(company) && !dirArg) warn(fi, 'missing'); continue; }
  const r = companyInputs.safeParse(raw);
  if (!r.success) { for (const i of r.error.issues) err(fi, `schema: ${i.path.join('.')}: ${i.message}`); continue; }
  inputs = r.data;
  if (inputs.company !== company) err(fi, `company "${inputs.company}" must be "${company}"`);
  srcKeys(fi, inputs);
  const qs = inputs.quarters;
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    if (q.start >= q.end) err(fi, `${q.period}: start ${q.start} ≥ end ${q.end}`);
    if (q.grossProfit !== undefined && q.grossProfit > q.revenue) err(fi, `${q.period}: grossProfit > revenue`);
    if (i > 0) {
      const d = qIndex(q.period) - qIndex(qs[i - 1].period);
      if (d <= 0) err(fi, `${q.period}: quarters must be sorted and unique`);
      else if (d > 1) err(fi, `gap between ${qs[i - 1].period} and ${q.period}`);
      if (q.start <= qs[i - 1].start) err(fi, `${q.period}: start date not after the previous quarter`);
    }
  }
  const ms = inputs.monthly.map((m: any) => m.period);
  if (new Set(ms).size !== ms.length) err(fi, 'duplicate monthly periods');
  console.log(`✓ ${fi} (${qs.length} quarters ${qs[0]?.period}–${qs.at(-1)?.period}, ${inputs.monthly.length} months, ${inputs.annual.length} years)`);

  // company drivers (the /forecast/ companies)
  const fd = `${company}-drivers.yaml`;
  const draw = read(fd, company);
  let drivers: any;
  if (draw !== undefined) {
    const dr = companyDrivers.safeParse(draw);
    if (!dr.success) for (const i of dr.error.issues) err(fd, `schema: ${i.path.join('.')}: ${i.message}`);
    else {
      drivers = dr.data;
      if (drivers.company !== company) err(fd, `company "${drivers.company}" must be "${company}"`);
      srcKeys(fd, drivers);
      const ids = new Set<string>();
      for (const s of drivers.series) {
        if (ids.has(s.id)) err(fd, `duplicate series id ${s.id}`);
        ids.add(s.id);
        const seen = new Set<string>();
        for (const p of s.points) { if (seen.has(p.period)) err(fd, `${s.id}: duplicate period ${p.period}`); seen.add(p.period); }
      }
      console.log(`✓ ${fd} (${drivers.series.length} series)`);
    }
  }

  const fo = `${company}-model.json`;
  const out = read(fo, company);
  if (out === undefined) { warn(fo, 'missing'); continue; }
  const o = modelOutput.safeParse(out);
  if (!o.success) { for (const i of o.error.issues) err(fo, `schema: ${i.path.join('.')}: ${i.message}`); continue; }
  const model = o.data;
  if (model.candidates.filter((c) => c.selected).length !== 1) err(fo, 'exactly one candidate must be selected');
  const cand = new Set(model.candidates.map((c) => c.id));
  for (const b of model.backtest) if (!cand.has(b.candidate)) err(fo, `backtest ${b.period}: unknown candidate ${b.candidate}`);
  if (model.company !== company) err(fo, `company "${model.company}" must be "${company}"`);
  const allKeys = new Set([...Object.keys(inputs.sources), ...Object.keys(prices?.sources ?? {}), ...Object.keys(drivers?.sources ?? {})]);
  for (const k of model.sourceKeys) if (!allKeys.has(k)) err(fo, `sourceKeys: "${k}" not in ${fi}, ${fd} or market-prices.yaml`);
  for (const s of model.scenarios) for (const a of s.assumptions) if (a.src && !allKeys.has(a.src)) err(fo, `scenario ${s.id}: unknown src "${a.src}"`);

  const script = resolve(`scripts/models/${company}.ts`);
  if (rerun && existsSync(script)) {
    try {
      const mod = await import(pathToFileURL(script).href);
      if (typeof mod.buildModel !== 'function') err(fo, `${script} must export buildModel(inputs, prices, drivers?)`);
      else {
        const fresh = mod.buildModel(inputs, prices, drivers);
        const strip = (x: any) => JSON.stringify({ ...x, generatedOn: undefined });
        if (strip(modelOutput.parse(fresh)) !== strip(model)) err(fo, `differs from a fresh run of scripts/models/${company}.ts — regenerate it`);
        else console.log(`✓ ${fo} (reproducible)`);
      }
    } catch (e) { err(fo, `re-run failed: ${(e as Error).message}`); }
  } else console.log(`✓ ${fo}${rerun ? ' (no model script to re-run)' : ''}`);
}

console.log(`\n${errors} errors · ${warnings} warnings`);
process.exit(errors ? 1 : 0);
