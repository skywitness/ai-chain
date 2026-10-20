/**
 * Regenerates src/three/fixtures/company-globe.json, the development fixture of the company-globe
 * scene (the real /companies/ page passes the same `companies` shape, built by
 * src/lib/scene-data/companies.ts). Run from the repository root:
 *
 *   npx tsx src/three/scenes/company-globe/gen-fixture.ts
 *
 * HQ lat/lon, city, primary segment and tier come from src/data/roster/*.yaml; revenue is the
 * trailing-four-quarter USD value from src/content/financials (the page's own helper), rounded to
 * two significant figures because the fixture is only illustrative. Not bundled with the scene.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { SEGMENT_LAYER } from '../../core/ids';
import { ttmUsd, type FinancialsInput } from '../../../lib/financial-metrics';
import type { SegmentId } from '../../core/types';

interface RosterCompany {
  id: string;
  name: string;
  nameZh: string;
  tier: 1 | 2 | 3;
  hq: { city: string; cityZh?: string; country: string; lat: number; lon: number };
}

const ROOT = process.cwd();
const roster = join(ROOT, 'src/data/roster');
const finDir = join(ROOT, 'src/content/financials');

const sig2 = (n: number) => {
  const p = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
};

const seen = new Set<string>();
const out: unknown[] = [];
for (const file of readdirSync(roster).filter((f) => f.endsWith('.yaml')).sort()) {
  const doc = parse(readFileSync(join(roster, file), 'utf8')) as { segment: SegmentId; companies: RosterCompany[] };
  for (const c of doc.companies) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    let revenueUsdM: number | null = null;
    try {
      const fin = JSON.parse(readFileSync(join(finDir, `${c.id}.json`), 'utf8')) as FinancialsInput;
      const t = ttmUsd(fin);
      if (t && Number.isFinite(t.valueUsd) && t.valueUsd > 0) revenueUsdM = sig2(t.valueUsd);
    } catch {
      /* no financials file → null */
    }
    out.push({
      id: c.id,
      name: c.name,
      nameZh: c.nameZh,
      lat: Math.round(c.hq.lat * 1000) / 1000,
      lon: Math.round(c.hq.lon * 1000) / 1000,
      layer: SEGMENT_LAYER[doc.segment],
      segment: doc.segment,
      tier: c.tier,
      revenueUsdM,
      href: `/companies/${c.id}/`,
      city: c.hq.cityZh || c.hq.city,
    });
  }
}
const target = join(ROOT, 'src/three/fixtures/company-globe.json');
writeFileSync(target, `[\n${out.map((o) => JSON.stringify(o)).join(',\n')}\n]\n`);
console.log(`company-globe fixture: ${out.length} companies, ${out.filter((o) => (o as { revenueUsdM: number | null }).revenueUsdM != null).length} with revenue → ${target}`);
