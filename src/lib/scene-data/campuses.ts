// Scene data for `cloud-globe` (docs/SCENES.md → `custom`: { campuses: [{ name, lat, lon, operator, mw, status }] }).
// Owner: pages-home-chain. Build-time only (reads src/data/campuses.yaml with node:fs).
//
//   import { buildCampusesSceneData } from '../lib/scene-data/campuses';
//   const campuses = buildCampusesSceneData();          // undefined while the registry is missing
//   <Scene3D id="cloud-globe" variant="globe" data={campuses} />
//
// The registry is written by another agent and may not exist yet. The reader is tolerant: it accepts
// a top-level list or `{ campuses: [...] }`, `name` or `nameZh`, `mw` / `capacityMw` / `powerMw`,
// and an operator given as a roster id (mapped to the company's Chinese name) or as plain text.
// Rows without a finite lat/lon are dropped. When nothing usable remains it returns undefined, so
// the scene falls back to its own fixture and shows 「示意資料」 instead of an empty globe.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { getRosterCompany } from '../collections';

export interface CampusDatum {
  name: string;
  lat: number;
  lon: number;
  /** operator display name (Chinese name when the operator is a roster id) */
  operator: string;
  /** planned or operating power capacity in MW, null when not disclosed */
  mw: number | null;
  /** 'operating' | 'construction' | 'planned' | … as given by the registry */
  status: string;
}
export interface CampusSceneData {
  campuses: CampusDatum[];
}

const REL = 'src/data/campuses.yaml';

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v.replace(/[,_\s]/g, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

function operatorName(v: unknown): string {
  if (Array.isArray(v)) return v.map(operatorName).filter(Boolean).join('、');
  if (v && typeof v === 'object') {
    const o = v as Raw;
    return operatorName(o['id'] ?? o['company'] ?? o['name']);
  }
  const s = str(v);
  if (!s) return '';
  const r = getRosterCompany(s);
  return r ? r.nameZh : s;
}

function toCampus(raw: unknown): CampusDatum | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Raw;
  const loc = (r['location'] && typeof r['location'] === 'object' ? (r['location'] as Raw) : r) as Raw;
  const lat = num(loc['lat'] ?? loc['latitude']);
  const lon = num(loc['lon'] ?? loc['lng'] ?? loc['longitude']);
  const name = str(r['nameZh']) ?? str(r['name']) ?? str(r['id']);
  if (lat == null || lon == null || !name || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  let mw = num(r['mw'] ?? r['capacityMw'] ?? r['powerMw'] ?? r['plannedMw']);
  if (mw == null) {
    const gw = num(r['gw'] ?? r['capacityGw']);
    if (gw != null) mw = gw * 1000;
  }
  return {
    name,
    lat,
    lon,
    operator: operatorName(r['operator'] ?? r['operators'] ?? r['company'] ?? r['owner']),
    mw: mw != null && mw > 0 ? mw : null,
    status: str(r['status']) ?? 'unknown',
  };
}

function readRegistry(): { list: unknown[]; asOf: string | undefined } {
  const p = join(process.cwd(), REL);
  if (!existsSync(p)) return { list: [], asOf: undefined };
  let doc: unknown;
  try {
    doc = parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`[scene-data/campuses] could not parse ${REL}: ${(err as Error).message}`);
    return { list: [], asOf: undefined };
  }
  const list: unknown[] = Array.isArray(doc)
    ? doc
    : doc && typeof doc === 'object' && Array.isArray((doc as Raw)['campuses'])
      ? ((doc as Raw)['campuses'] as unknown[])
      : [];
  const asOf = doc && typeof doc === 'object' && !Array.isArray(doc) ? str((doc as Raw)['asOf']) : undefined;
  return { list, asOf };
}

/** Campus payload for the cloud-globe scene, or undefined when src/data/campuses.yaml is missing or empty. */
export function buildCampusesSceneData(): CampusSceneData | undefined {
  const campuses = readRegistry()
    .list.map(toCampus)
    .filter((c): c is CampusDatum => c !== null);
  return campuses.length ? { campuses } : undefined;
}

// ───────────── table rows for the cloud-neocloud page ─────────────
export interface CampusSource {
  title: string;
  publisher: string;
  url: string;
  type?: string | undefined;
  lang?: string | undefined;
  published?: string | undefined;
  accessed?: string | undefined;
  note?: string | undefined;
}
export interface CampusRow extends CampusDatum {
  id: string;
  /** roster id of the operator when it is a known company (for a link) */
  operatorId: string | undefined;
  /** IT capacity already online in MW (Epoch AI estimate), null when not given */
  mwNow: number | null;
  /** ISO 3166 alpha-2 */
  country: string | undefined;
  note: string | undefined;
  source: CampusSource | undefined;
}

function toSource(v: unknown): CampusSource | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Raw;
  const title = str(s['title']);
  const url = str(s['url']);
  if (!title || !url) return undefined;
  return {
    title,
    url,
    publisher: str(s['publisher']) ?? '',
    type: str(s['type']),
    lang: str(s['lang']),
    published: str(s['published']),
    accessed: str(s['accessed']),
    note: str(s['note']),
  };
}

/**
 * Every usable campus with its extra registry fields, sorted by planned capacity (largest first).
 * Returns an empty list while src/data/campuses.yaml is missing.
 */
export function getCampusRows(): { rows: CampusRow[]; asOf: string | undefined } {
  const { list, asOf } = readRegistry();
  const rows: CampusRow[] = [];
  list.forEach((raw, i) => {
    const base = toCampus(raw);
    if (!base) return;
    const r = raw as Raw;
    const op = r['operator'];
    const opId = typeof op === 'string' && getRosterCompany(op) ? op : undefined;
    const mwNow = num(r['mwNow'] ?? r['onlineMw']);
    rows.push({
      ...base,
      id: str(r['id']) ?? `campus-${i + 1}`,
      operatorId: opId,
      mwNow: mwNow != null && mwNow >= 0 ? mwNow : null,
      country: str(r['country']),
      note: str(r['note']),
      source: toSource(r['source']),
    });
  });
  rows.sort((a, b) => (b.mw ?? 0) - (a.mw ?? 0));
  return { rows, asOf };
}
