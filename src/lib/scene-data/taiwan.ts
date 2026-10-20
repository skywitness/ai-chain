// Scene data builder for `taiwan-map` (docs/SCENES.md, data shape `taiwan`):
//   { sites: [{ id, name, lat, lon, kind, companies: string[] }], companies: [{ id, nameZh, site, segment }] }
// Sites come from src/data/taiwan/sites.yaml (science parks, fabs, packaging plants, server clusters, research
// institutes, ports). Companies are the roster entries with region TW. Each company is attached to
//   1. the first site that lists it in sites.yaml (verified membership), else
//   2. the nearest park or cluster site within `nearKm` of its headquarters, else
//   3. a synthetic 「企業總部」 cluster for its HQ city (kind 'hq-cluster', placed at the mean HQ position).
// Companies headquartered outside Taiwan are left out. When sites.yaml does not exist yet the builder returns
// undefined and <Scene3D> falls back to the scene's illustrative fixture.
// Build-time only (node:fs). Owner: pages-trends-taiwan.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { SourceType, type SourceT } from '../../schemas/common';

export interface TaiwanSceneSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind: string;
  companies: string[];
}
export interface TaiwanSceneCompany {
  id: string;
  nameZh: string;
  site: string;
  segment: string;
}
export interface TaiwanSceneData {
  sites: TaiwanSceneSite[];
  companies: TaiwanSceneCompany[];
}

/** A site as read from sites.yaml, with the optional extras pages may show. */
export interface TaiwanSiteRecord extends TaiwanSceneSite {
  nameEn?: string | undefined;
  city?: string | undefined;
  note?: string | undefined;
  /** the site's sources (only entries with title, publisher, url and accessed are kept) */
  sources?: SourceT[] | undefined;
}

const SOURCE_TYPES: ReadonlySet<string> = new Set(SourceType.options);
const SOURCE_LANGS: ReadonlySet<string> = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'de', 'fr', 'other']);
const isoDate = (v: unknown): string | undefined =>
  v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;

/** Lenient reader for a site's `sources` list (sites.yaml is not schema-validated). */
function readSources(raw: unknown): SourceT[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SourceT[] = [];
  for (const r of raw) {
    const s = r as Record<string, unknown>;
    const accessed = isoDate(s?.accessed);
    if (!s || typeof s.title !== 'string' || typeof s.publisher !== 'string' || typeof s.url !== 'string' || !accessed) continue;
    if (!/^https?:\/\//.test(s.url)) continue;
    const published = isoDate(s.published);
    out.push({
      title: s.title,
      publisher: s.publisher,
      url: s.url,
      type: (typeof s.type === 'string' && SOURCE_TYPES.has(s.type) ? s.type : 'other') as SourceT['type'],
      lang: (typeof s.lang === 'string' && SOURCE_LANGS.has(s.lang) ? s.lang : 'en') as SourceT['lang'],
      accessed,
      ...(published ? { published } : {}),
      ...(typeof s.note === 'string' ? { note: s.note } : {}),
    });
  }
  return out.length ? out : undefined;
}

const SITES_FILE = 'src/data/taiwan/sites.yaml';

/** Site kinds that stand for an area (not one company's plant), so nearby HQs can be grouped into them. */
export const AREA_KINDS: ReadonlySet<string> = new Set(['science-park', 'server-cluster', 'industrial-park', 'park', 'cluster', 'hub']);

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Read src/data/taiwan/sites.yaml. Accepts `sites: [...]`, `clusters: [...]` or a top-level list; each item
 * needs an id and lat/lon (also `location: { lat, lon }`). Returns null when the file is missing, unreadable
 * or empty.
 */
export function readTaiwanSites(root = process.cwd()): TaiwanSiteRecord[] | null {
  const p = join(root, SITES_FILE);
  if (!existsSync(p)) return null;
  let doc: unknown;
  try {
    doc = parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`[scene-data/taiwan] could not parse ${SITES_FILE}: ${(err as Error).message}`);
    return null;
  }
  const list: unknown[] = Array.isArray(doc)
    ? doc
    : Array.isArray((doc as { sites?: unknown })?.sites)
      ? (doc as { sites: unknown[] }).sites
      : Array.isArray((doc as { clusters?: unknown })?.clusters)
        ? (doc as { clusters: unknown[] }).clusters
        : [];
  const out: TaiwanSiteRecord[] = [];
  for (const raw of list) {
    const s = raw as Record<string, unknown>;
    if (!s || typeof s.id !== 'string') continue;
    const loc = (s.location ?? s) as Record<string, unknown>;
    const lat = num(loc.lat ?? s.lat);
    const lon = num(loc.lon ?? loc.lng ?? s.lon ?? s.lng);
    if (lat == null || lon == null) continue;
    const companies = Array.isArray(s.companies)
      ? (s.companies as unknown[])
          .map((c) => (typeof c === 'string' ? c : typeof (c as { id?: unknown })?.id === 'string' ? (c as { id: string }).id : null))
          .filter((c): c is string => !!c)
      : [];
    out.push({
      id: s.id,
      name: String(s.nameZh ?? s.name ?? s.id),
      nameEn: typeof s.nameEn === 'string' ? s.nameEn : undefined,
      lat,
      lon,
      kind: String(s.kind ?? s.type ?? 'cluster'),
      companies,
      city: typeof s.city === 'string' ? s.city : typeof s.cityZh === 'string' ? s.cityZh : undefined,
      note: typeof s.note === 'string' ? s.note : typeof s.description === 'string' ? s.description : undefined,
      sources: readSources(s.sources),
    });
  }
  return out.length ? out : null;
}

/** Great-circle distance in km. */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rough bounding box of Taiwan's main island and nearby islets. */
export function inTaiwan(lat: number, lon: number): boolean {
  return lat > 21.7 && lat < 25.5 && lon > 119.2 && lon < 122.2;
}

export interface TaiwanCompanyInput {
  id: string;
  nameZh: string;
  segment: string;
  lat: number;
  lon: number;
  /** HQ city in Chinese (「桃園」), used to name the synthetic HQ cluster */
  city?: string | undefined;
  /** HQ city in English (「Taoyuan」), used for the synthetic cluster id */
  cityEn?: string | undefined;
}

export interface AssignOptions {
  /** Join an area site (AREA_KINDS) when the HQ lies within this many km (default 12). */
  nearKm?: number | undefined;
}

export interface Assignment {
  /** company id → site id */
  site: Map<string, string>;
  /** synthetic 「企業總部」 clusters created for companies far from any area site */
  extraSites: TaiwanSceneSite[];
}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Map each company to a site id (see the module comment for the rules). */
export function assignSites(
  companies: readonly TaiwanCompanyInput[],
  sites: readonly TaiwanSceneSite[],
  opts: AssignOptions = {},
): Assignment {
  const nearKm = opts.nearKm ?? 12;
  const site = new Map<string, string>();
  const listed = new Map<string, string>();
  for (const s of sites) for (const c of s.companies) if (!listed.has(c)) listed.set(c, s.id);
  const areas = sites.filter((s) => AREA_KINDS.has(s.kind));
  const pending = new Map<string, { name: string; members: TaiwanCompanyInput[] }>();

  for (const c of companies) {
    const hit = listed.get(c.id);
    if (hit) {
      site.set(c.id, hit);
      continue;
    }
    if (!inTaiwan(c.lat, c.lon)) continue;
    let best: TaiwanSceneSite | undefined;
    let bestD = Infinity;
    for (const s of areas) {
      const d = distanceKm(c.lat, c.lon, s.lat, s.lon);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best && bestD <= nearKm) {
      site.set(c.id, best.id);
      continue;
    }
    const cityZh = c.city ?? '其他';
    const key = `hq-${slug(c.cityEn ?? '') || slug(cityZh) || 'other'}`;
    if (!pending.has(key)) pending.set(key, { name: `${cityZh}（企業總部）`, members: [] });
    pending.get(key)!.members.push(c);
  }

  const extraSites: TaiwanSceneSite[] = [];
  for (const [id, g] of pending) {
    const lat = g.members.reduce((n, c) => n + c.lat, 0) / g.members.length;
    const lon = g.members.reduce((n, c) => n + c.lon, 0) / g.members.length;
    extraSites.push({ id, name: g.name, lat: +lat.toFixed(4), lon: +lon.toFixed(4), kind: 'hq-cluster', companies: [] });
    for (const c of g.members) site.set(c.id, id);
  }
  return { site, extraSites };
}

/**
 * Build the taiwan-map payload. `sites` defaults to readTaiwanSites(); returns undefined when there are no
 * sites yet, so <Scene3D> falls back to the scene's illustrative fixture.
 * Every site's `companies` list is completed with the companies assigned to it. Ids a site lists that are not
 * in `companies` (e.g. a foreign company's Taiwan fab) are added through `lookup` when it knows them.
 */
export function buildTaiwanSceneData(
  companies: readonly TaiwanCompanyInput[],
  sites: readonly TaiwanSiteRecord[] | null = readTaiwanSites(),
  lookup?: (id: string) => TaiwanCompanyInput | undefined,
  opts: AssignOptions = {},
): TaiwanSceneData | undefined {
  if (!sites || !sites.length) return undefined;
  const all = [...companies];
  const known = new Set(all.map((c) => c.id));
  if (lookup) {
    for (const s of sites)
      for (const id of s.companies) {
        if (known.has(id)) continue;
        const c = lookup(id);
        if (c) {
          all.push(c);
          known.add(id);
        }
      }
  }
  const { site: assigned, extraSites } = assignSites(all, sites, opts);
  const allSites: TaiwanSceneSite[] = [...sites, ...extraSites];
  const members = new Map<string, Set<string>>(allSites.map((s) => [s.id, new Set(s.companies.filter((id) => known.has(id)))]));
  for (const [cid, sid] of assigned) members.get(sid)?.add(cid);
  return {
    sites: allSites.map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      kind: s.kind,
      companies: [...(members.get(s.id) ?? [])],
    })),
    companies: all
      .filter((c) => assigned.has(c.id))
      .map((c) => ({
        id: c.id,
        nameZh: c.nameZh,
        site: assigned.get(c.id)!,
        segment: c.segment,
      })),
  };
}
