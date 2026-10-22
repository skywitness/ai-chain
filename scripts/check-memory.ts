// Validate the memory & storage topic data (src/data/memory/*.yaml, or given paths, e.g. staging copies).
//   npx tsx scripts/check-memory.ts [files…]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'yaml';
import { memoryFabs, memoryMarket } from '../src/schemas/memory';
import { loadRoster } from './lib/registry';

const roster = loadRoster();
const dir = 'src/data/memory';
const args = process.argv.slice(2);
const files = args.length ? args : existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => `${dir}/${f}`) : [];
let errors = 0;
const err = (f: string, m: string) => { errors++; console.log(`✗ ${f}: ${m}`); };
const okCompany = (c: string) => c === 'other' || roster.has(c);

for (const f of files) {
  let data: any;
  try { data = parse(readFileSync(f, 'utf8')); } catch (e) { err(f, `YAML parse error: ${(e as Error).message}`); continue; }
  const isFabs = basename(f) === 'fabs.yaml';
  const r = (isFabs ? memoryFabs : memoryMarket).safeParse(data);
  if (!r.success) { for (const i of r.error.issues) err(f, `schema: ${i.path.join('.')}: ${i.message}`); continue; }
  const d: any = r.data;
  const keys = new Set(Object.keys(d.sources));
  const used: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'src' && typeof x === 'string') used.push(x); else if (k !== 'sources') walk(x); }
  };
  walk(d);
  for (const k of used) if (!keys.has(k)) err(f, `unknown src key "${k}"`);
  if (isFabs) {
    const ids = new Set<string>();
    for (const fab of d.fabs) {
      if (ids.has(fab.id)) err(f, `duplicate fab id ${fab.id}`);
      ids.add(fab.id);
      if (!okCompany(fab.company)) err(f, `fab ${fab.id}: company "${fab.company}" not in roster`);
    }
  } else {
    if (basename(f) !== `${d.category}.yaml`) err(f, `category "${d.category}" must match the file name`);
    for (const ms of d.marketShare) {
      for (const it of ms.items) if (!okCompany(it.company)) err(f, `marketShare ${ms.period}: company "${it.company}" not in roster (use a roster id or "other")`);
      const sum = ms.items.reduce((a: number, b: any) => a + b.share, 0);
      if (sum > 101) err(f, `marketShare ${ms.period} (${ms.basis}) sums to ${sum.toFixed(1)}% (> 100)`);
    }
    for (const dm of d.demandMix) { const s = dm.items.reduce((a: number, b: any) => a + b.share, 0); if (s < 98 || s > 102) err(f, `demandMix ${dm.period} sums to ${s.toFixed(1)}%`); }
    for (const c of [...d.capacity, ...d.expansions]) if (!okCompany(c.company)) err(f, `company "${c.company}" not in roster`);
  }
  if (/(TODO|TBD|待查|待補|XXX)/.test(readFileSync(f, 'utf8'))) err(f, 'placeholder text found');
  if (!errors) console.log(`✓ ${f}`);
}
console.log(`\n${files.length} files · ${errors} errors`);
process.exit(errors ? 1 : 0);
