// Usage: npx tsx scripts/check-roster.ts [src/data/roster/<segment>.yaml ...]
// Validates roster files and reports duplicate ids / names across all roster files.
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { RosterFile } from '../src/schemas/roster';

const dir = 'src/data/roster';
const all = readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => `${dir}/${f}`);
const targets = process.argv.slice(2).length ? process.argv.slice(2) : all;
let errors = 0;
const seen = new Map<string, string>();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const names = new Map<string, string>();
for (const f of all) {
  let data: unknown;
  try {
    data = parse(readFileSync(f, 'utf8'));
  } catch (e) {
    if (targets.includes(f)) { console.error(`✗ ${f}: YAML parse error: ${(e as Error).message}`); errors++; }
    continue;
  }
  const r = RosterFile.safeParse(data);
  if (!r.success) {
    if (targets.includes(f)) {
      for (const i of r.error.issues) console.error(`✗ ${f}: ${i.path.join('.')}: ${i.message}`);
      errors += r.error.issues.length;
    }
    continue;
  }
  const seg = f.split('/').pop()!.replace('.yaml', '');
  if (r.data.segment !== seg) { console.error(`✗ ${f}: segment field "${r.data.segment}" must equal file name`); errors++; }
  for (const c of r.data.companies) {
    if (seen.has(c.id)) { if (targets.includes(f)) { console.error(`✗ duplicate id "${c.id}" in ${f} and ${seen.get(c.id)}`); errors++; } }
    else seen.set(c.id, f);
    const n = norm(c.name);
    if (names.has(n) && names.get(n) !== c.id && targets.includes(f)) { console.error(`⚠ similar name "${c.name}" (${c.id}) vs ${names.get(n)}`); }
    names.set(n, c.id);
    if (c.ownership === 'listed' && c.listings.length === 0 && targets.includes(f)) { console.error(`✗ ${f}: ${c.id} listed but no listings`); errors++; }
  }
  if (targets.includes(f)) console.log(`✓ ${f}: ${r.data.companies.length} companies (${r.data.companies.filter((c) => c.profile === 'full').length} full)`);
}
console.log(`total ids: ${seen.size}`);
process.exit(errors ? 1 : 0);
