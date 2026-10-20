// Company rows for /companies/ (directory cards) and the `company-globe` scene data.
// Build-time only. Registry-driven: every roster id yields a row; the `companies` content entry
// (when it exists) overrides names, HQ, aliases and listings; `financials` adds TTM revenue.
// Owner: pages-companies.
import type { CollectionEntry } from 'astro:content';
import {
  getRoster,
  isSegmentId,
  safeCollection,
  segmentMeta,
  type LayerId,
  type RosterCompany,
  type SegmentId,
} from '../collections';
import { enrichPoints, findSeries, sparkline, ttmUsd, type FinancialsInput } from '../financial-metrics';
import { toUsd } from '../fx';

export interface CompanyListing {
  exchange: string;
  ticker: string;
  adr?: boolean | undefined;
}

export interface CompanyRow {
  id: string;
  name: string;
  nameZh: string;
  /** primary segment */
  segment: SegmentId;
  /** primary first, then secondary segments (deduplicated) */
  segments: SegmentId[];
  layer: LayerId;
  tier: 1 | 2 | 3;
  profile: 'full' | 'compact';
  ownership: string;
  status: string;
  region: string;
  country: string;
  city: string;
  cityZh: string;
  lat: number;
  lon: number;
  founded: number | null;
  listings: CompanyListing[];
  aliases: string[];
  role: string;
  hasEntry: boolean;
  hasFinancials: boolean;
  /** TTM (else latest fiscal year) revenue in millions of USD, converted per period; null when unavailable */
  revenueUsdM: number | null;
  /** 「近四季」「近兩個半年度」「最近財年」 */
  revenueLabel: string | null;
  /** reporting currency of the revenue series (USD → no conversion) */
  revenueCurrency: string | null;
  /** YoY % of that TTM window vs the previous one */
  yoy: number | null;
  /** latest disclosed annualised run-rate (private companies without reported revenue), USD millions */
  arr: { valueUsdM: number; period: string; estimate: boolean } | null;
  /** last 8 revenue periods (tier 1 only, for card sparklines) */
  spark: number[] | null;
  sparkEstimate: boolean[];
}

/** One HQ point for the company-globe scene (shape: docs/SCENES.md → companies). */
export interface CompanyGlobePoint {
  id: string;
  name: string;
  nameZh: string;
  lat: number;
  lon: number;
  layer: LayerId;
  segment: SegmentId;
  tier: 1 | 2 | 3;
  revenueUsdM: number | null;
  /** site-relative, without the base (the scene host adds it) */
  href: string;
  city: string;
}

type CompanyData = CollectionEntry<'companies'>['data'];

const refId = (r: unknown): string | undefined =>
  typeof r === 'string' ? r : r && typeof r === 'object' && 'id' in r ? String((r as { id: unknown }).id) : undefined;

function buildRow(r: RosterCompany, d: CompanyData | undefined, fin: FinancialsInput | undefined): CompanyRow {
  const primary = (() => {
    const p = d ? refId(d.primarySegment) : undefined;
    return p && isSegmentId(p) ? p : r.segment;
  })();
  const segs: SegmentId[] = [primary];
  const extra = d ? d.segments.map(refId) : r.secondarySegments;
  for (const s of [...(extra ?? []), ...r.secondarySegments]) if (s && isSegmentId(s) && !segs.includes(s)) segs.push(s);
  const hq = d?.hq ?? r.hq;
  const listings: CompanyListing[] = (d?.listings.length ? d.listings : r.listings).map((l) => ({
    exchange: l.exchange,
    ticker: String(l.ticker),
    adr: 'adr' in l ? Boolean(l.adr) : undefined,
  }));

  let revenueUsdM: number | null = null;
  let revenueLabel: string | null = null;
  let revenueCurrency: string | null = null;
  let yoy: number | null = null;
  let spark: number[] | null = null;
  let sparkEstimate: boolean[] = [];
  let arr: CompanyRow['arr'] = null;
  if (fin) {
    try {
      const t = ttmUsd(fin);
      if (t && Number.isFinite(t.valueUsd) && t.valueUsd > 0) {
        revenueUsdM = t.valueUsd;
        revenueLabel = t.label;
        revenueCurrency = t.currency;
        yoy = t.yoy != null && Number.isFinite(t.yoy) ? t.yoy : null;
      }
      if (r.tier === 1) {
        const s = sparkline(fin, 8);
        if (s.values.length >= 3) {
          spark = s.values;
          sparkEstimate = s.estimate;
        }
      }
      if (revenueUsdM == null) {
        const s = findSeries(fin, 'arr');
        const last = s ? enrichPoints(s).at(-1) : undefined;
        const cur = s?.currency ?? fin.reportingCurrency;
        const usd = last ? (cur === 'USD' ? last.value : toUsd(last.value, cur, { start: last.start, end: last.end })) : null;
        if (last && usd != null && usd > 0) arr = { valueUsdM: usd, period: last.period, estimate: last.estimate };
      }
    } catch (err) {
      console.warn(`[companies] financial summary failed for ${r.id}: ${(err as Error).message}`);
    }
  }

  return {
    id: r.id,
    name: d?.name ?? r.name,
    nameZh: d?.nameZh ?? r.nameZh,
    segment: primary,
    segments: segs,
    layer: segmentMeta(primary)?.layer ?? 'silicon',
    tier: r.tier,
    profile: r.profile,
    ownership: d?.ownership ?? r.ownership,
    status: d?.status ?? r.status ?? 'active',
    region: d?.region ?? r.region,
    country: hq.country,
    city: hq.city,
    cityZh: hq.cityZh,
    lat: hq.lat,
    lon: hq.lon,
    founded: d?.founded ?? r.founded ?? null,
    listings,
    aliases: d?.aliases ?? [],
    role: r.role,
    hasEntry: !!d,
    hasFinancials: !!fin,
    revenueUsdM,
    revenueLabel,
    revenueCurrency,
    yoy,
    arr,
    spark,
    sparkEstimate,
  };
}

let cache: { at: number; rows: Promise<CompanyRow[]> } | null = null;

/** Every roster company as a display row (cached; re-read after a few seconds in dev). */
export function getCompanyRows(): Promise<CompanyRow[]> {
  const now = Date.now();
  if (cache && (!import.meta.env.DEV || now - cache.at < 4000)) return cache.rows;
  const rows = (async () => {
    const [entries, fins] = await Promise.all([safeCollection('companies'), safeCollection('financials')]);
    const byId = new Map(entries.map((e) => [e.id, e.data]));
    const finById = new Map<string, FinancialsInput>();
    for (const f of fins) finById.set(refId(f.data.company) ?? f.id, f.data as unknown as FinancialsInput);
    return getRoster().map((r) => buildRow(r, byId.get(r.id), finById.get(r.id)));
  })();
  cache = { at: now, rows };
  return rows;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** company-globe page data: one HQ point per company. */
export function companyGlobePoints(rows: readonly CompanyRow[]): CompanyGlobePoint[] {
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    nameZh: c.nameZh,
    lat: round(c.lat, 3),
    lon: round(c.lon, 3),
    layer: c.layer,
    segment: c.segment,
    tier: c.tier,
    revenueUsdM: c.revenueUsdM == null ? null : Math.round(c.revenueUsdM),
    href: `/companies/${c.id}/`,
    city: c.cityZh || c.city,
  }));
}

/** Convenience: rows → globe data in one call. */
export async function buildCompanyGlobeData(): Promise<CompanyGlobePoint[]> {
  return companyGlobePoints(await getCompanyRows());
}

// ───────────────────────── HQ clusters (city agglomerations) ─────────────────────────

export interface HqMember {
  id: string;
  layer: LayerId;
  tier: 1 | 2 | 3;
}

/** Companies whose headquarters sit in one metro area (e.g. 舊金山灣區, 北台灣). */
export interface HqCluster {
  id: string;
  /** zh-TW display name (metro alias, or the main city) */
  name: string;
  /** weighted centre */
  lat: number;
  lon: number;
  count: number;
  /** member cities, largest first */
  cities: Array<{ name: string; count: number }>;
  country: string;
  layers: Record<LayerId, number>;
  members: HqMember[];
}

/** zh-TW names for metro areas, keyed by the English name of the cluster's largest city. */
const METRO_NAMES: Record<string, string> = {
  'San Francisco': '舊金山灣區',
  'Santa Clara': '舊金山灣區',
  'San Jose': '舊金山灣區',
  Taipei: '北台灣',
  'New Taipei': '北台灣',
  Hsinchu: '北台灣',
  Tokyo: '東京圈',
  Seoul: '首爾都會區',
  Seongnam: '首爾都會區',
  Shanghai: '上海一帶',
  Shenzhen: '深圳與香港',
  'Hong Kong': '深圳與香港',
  'New York': '紐約都會區',
  Boston: '波士頓一帶',
  Cambridge: '波士頓一帶',
  London: '倫敦',
  'Los Angeles': '洛杉磯一帶',
  Seattle: '西雅圖一帶',
  Redmond: '西雅圖一帶',
  Osaka: '關西',
  Kyoto: '關西',
};

const LAYER_IDS: readonly LayerId[] = ['foundation', 'silicon', 'systems', 'cloud-models', 'applications'];

/**
 * Group HQs into metro clusters: cities (largest first) join the nearest existing cluster whose
 * anchor city lies within `radiusDeg` (longitude scaled by cos(latitude)), else start a new one.
 */
export function hqClusters(rows: readonly CompanyRow[], radiusDeg = 0.8): HqCluster[] {
  type City = { key: string; name: string; nameEn: string; country: string; lat: number; lon: number; rows: CompanyRow[] };
  const cities = new Map<string, City>();
  for (const r of rows) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || (r.lat === 0 && r.lon === 0)) continue;
    const key = `${r.country}|${r.city || `${r.lat.toFixed(1)},${r.lon.toFixed(1)}`}`;
    const c = cities.get(key) ?? { key, name: r.cityZh || r.city, nameEn: r.city, country: r.country, lat: r.lat, lon: r.lon, rows: [] };
    c.rows.push(r);
    cities.set(key, c);
  }
  const sorted = [...cities.values()].sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
  const groups: Array<{ anchor: City; cities: City[] }> = [];
  const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
    const dLat = a.lat - b.lat;
    const dLon = (a.lon - b.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
    return Math.hypot(dLat, dLon);
  };
  for (const c of sorted) {
    let best: (typeof groups)[number] | undefined;
    let bestD = radiusDeg;
    for (const g of groups) {
      const d = dist(g.anchor, c);
      if (d <= bestD) {
        best = g;
        bestD = d;
      }
    }
    if (best) best.cities.push(c);
    else groups.push({ anchor: c, cities: [c] });
  }
  return groups
    .map((g) => {
      const members = g.cities.flatMap((c) => c.rows);
      const n = members.length;
      const layers = Object.fromEntries(LAYER_IDS.map((l) => [l, 0])) as Record<LayerId, number>;
      for (const m of members) layers[m.layer] = (layers[m.layer] ?? 0) + 1;
      const multi = g.cities.length > 1;
      const name = METRO_NAMES[g.anchor.nameEn] ?? (multi ? `${g.anchor.name}一帶` : g.anchor.name);
      return {
        id: g.anchor.key.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase(),
        name,
        lat: members.reduce((a, m) => a + m.lat, 0) / n,
        lon: members.reduce((a, m) => a + m.lon, 0) / n,
        count: n,
        cities: g.cities.map((c) => ({ name: c.name, count: c.rows.length })),
        country: g.anchor.country,
        layers,
        members: members
          .map((m) => ({ id: m.id, layer: m.layer, tier: m.tier }))
          .sort((a, b) => LAYER_IDS.indexOf(a.layer) - LAYER_IDS.indexOf(b.layer) || a.tier - b.tier || a.id.localeCompare(b.id)),
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant'));
}
