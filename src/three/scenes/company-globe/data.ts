/**
 * company-globe data: the page payload (`companies`, docs/SCENES.md), its type guard and
 * normalisation, zh-TW names for layers / segments / tiers, the city hubs used by the guided steps
 * and the hotspot list, the city grouping with collision spreading, and number formatting.
 * Nothing here hard-codes an industry figure: counts and revenue always come from the data.
 */
import { Vector3 } from 'three';
import { LAYER_IDS, SEGMENT_IDS, SEGMENT_LAYER } from '../../core/ids';
import type { LayerId, SegmentId } from '../../core/types';
import { latLonToVec3 } from '../../kit/Globe';

/* ───────────────────────── page data ───────────────────────── */

/** One HQ point (src/lib/scene-data/companies.ts → CompanyGlobePoint). */
export interface CompanyPoint {
  id: string;
  name: string;
  nameZh?: string;
  lat: number;
  lon: number;
  layer: LayerId;
  segment?: SegmentId;
  tier: 1 | 2 | 3;
  /** Trailing-four-quarter revenue in millions of USD; null when not disclosed. */
  revenueUsdM: number | null;
  /** Site-relative, without the base. */
  href?: string;
  city?: string;
}
/** The page passes the array; `{ companies }` is accepted too. */
export type CompanyData = readonly CompanyPoint[] | { companies: readonly CompanyPoint[] };

const listOf = (d: unknown): unknown[] | null =>
  Array.isArray(d)
    ? d
    : d && typeof d === 'object' && Array.isArray((d as { companies?: unknown }).companies)
      ? ((d as { companies: unknown[] }).companies)
      : null;

const isEntry = (c: unknown): boolean => {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return typeof o['id'] === 'string' && typeof o['name'] === 'string' && Number.isFinite(o['lat']) && Number.isFinite(o['lon']);
};

export function isCompanyData(d: unknown): d is CompanyData {
  const list = listOf(d);
  return !!list && list.length > 0 && list.every(isEntry);
}

/** A validated company with derived display fields. */
export interface Company {
  /** index in the normalised list (= instance id) */
  i: number;
  id: string;
  name: string;
  nameZh: string;
  /** 3D / card display name: Chinese name when there is one */
  label: string;
  lat: number;
  lon: number;
  layer: LayerId;
  segment: SegmentId | null;
  tier: 1 | 2 | 3;
  rev: number | null;
  href: string;
  city: string;
}

const isLayer = (v: unknown): v is LayerId => (LAYER_IDS as readonly unknown[]).includes(v);
const isSegment = (v: unknown): v is SegmentId => (SEGMENT_IDS as readonly unknown[]).includes(v);

export function normalise(d: CompanyData | null): Company[] {
  const out: Company[] = [];
  const seen = new Set<string>();
  for (const raw of (listOf(d) ?? []) as Partial<CompanyPoint>[]) {
    if (!isEntry(raw) || seen.has(raw.id!)) continue;
    const lat = raw.lat!;
    const lon = raw.lon!;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    const segment = isSegment(raw.segment) ? raw.segment : null;
    const layer = isLayer(raw.layer) ? raw.layer : segment ? SEGMENT_LAYER[segment] : null;
    if (!layer) continue;
    seen.add(raw.id!);
    const nameZh = typeof raw.nameZh === 'string' ? raw.nameZh.trim() : '';
    const rev = typeof raw.revenueUsdM === 'number' && Number.isFinite(raw.revenueUsdM) && raw.revenueUsdM > 0 ? raw.revenueUsdM : null;
    out.push({
      i: out.length,
      id: raw.id!,
      name: raw.name!,
      nameZh,
      label: nameZh || raw.name!,
      lat,
      lon,
      layer,
      segment,
      tier: raw.tier === 1 || raw.tier === 2 ? raw.tier : 3,
      rev,
      href: typeof raw.href === 'string' && raw.href ? raw.href : `/companies/${raw.id}/`,
      city: typeof raw.city === 'string' && raw.city.trim() ? raw.city.trim() : '',
    });
  }
  return out;
}

/* ───────────────────────── names ───────────────────────── */

export interface LayerInfo {
  title: string;
  /** filter-chip text */
  chip: string;
  hotspot: string;
  segments: readonly SegmentId[];
}
export const LAYER_INFO: Readonly<Record<LayerId, LayerInfo>> = {
  foundation: { title: '能源基礎', chip: '能源', hotspot: 'layer-foundation', segments: ['energy-power'] },
  silicon: {
    title: '晶片與半導體',
    chip: '晶片',
    hotspot: 'layer-silicon',
    segments: ['semi-equipment-materials', 'foundry-packaging', 'memory-storage', 'eda-ip-design', 'ai-accelerators'],
  },
  systems: { title: '系統與基礎設施', chip: '系統', hotspot: 'layer-systems', segments: ['networking-optics', 'servers-systems', 'datacenter-infra'] },
  'cloud-models': {
    title: '雲端與模型',
    chip: '雲端與模型',
    hotspot: 'layer-cloud-models',
    segments: ['cloud-neocloud', 'foundation-models', 'devtools-data-mlops'],
  },
  applications: { title: '應用', chip: '應用', hotspot: 'layer-applications', segments: ['apps-agents', 'physical-ai'] },
};
/** Bottom → top order inside a city column (the same order as the chain tower). */
export const LAYER_ORDER: Readonly<Record<LayerId, number>> = { foundation: 0, silicon: 1, systems: 2, 'cloud-models': 3, applications: 4 };

export const SEG_SHORT: Readonly<Record<SegmentId, string>> = {
  'energy-power': '能源與電力',
  'semi-equipment-materials': '設備材料',
  'foundry-packaging': '代工封裝',
  'memory-storage': '記憶體',
  'eda-ip-design': '設計工具／IP',
  'ai-accelerators': 'AI 晶片',
  'networking-optics': '網通光通訊',
  'servers-systems': '伺服器',
  'datacenter-infra': '資料中心',
  'cloud-neocloud': '雲端',
  'foundation-models': '基礎模型',
  'devtools-data-mlops': '工具與 MLOps',
  'apps-agents': '應用與 Agent',
  'physical-ai': '實體 AI',
};

export const TIER_LABEL: Readonly<Record<1 | 2 | 3, string>> = { 1: '一線龍頭', 2: '二線', 3: '三線與新創' };

/* ───────────────────────── hubs ───────────────────────── */

export interface Hub {
  /** hotspot id */
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** membership radius in degrees (longitude scaled by cos latitude) */
  radius: number;
  /** oblique camera: distance from the surface point and azimuth from the south (deg, + = east) */
  dist: number;
  az: number;
}
export const HUBS: readonly Hub[] = [
  { id: 'hub-hsinchu', name: '新竹・竹北', lat: 24.8, lon: 121.01, radius: 0.16, dist: 0.62, az: -18 },
  { id: 'hub-taipei', name: '台北・新北・桃園', lat: 25.0, lon: 121.43, radius: 0.32, dist: 0.7, az: 12 },
  { id: 'hub-bay-area', name: '矽谷與舊金山', lat: 37.55, lon: -122.1, radius: 0.72, dist: 0.95, az: 0 },
  { id: 'hub-shenzhen', name: '深圳・香港', lat: 22.6, lon: 114.05, radius: 0.55, dist: 0.62, az: 0 },
  { id: 'hub-tokyo', name: '東京', lat: 35.6, lon: 139.65, radius: 0.5, dist: 0.7, az: 0 },
  { id: 'hub-seoul', name: '首爾一帶', lat: 37.42, lon: 127.1, radius: 0.6, dist: 0.62, az: 0 },
  { id: 'hub-beijing', name: '北京', lat: 39.95, lon: 116.4, radius: 0.45, dist: 0.66, az: 0 },
];

const degDist = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  let dLon = Math.abs(aLon - bLon);
  if (dLon > 180) dLon = 360 - dLon;
  return Math.hypot(aLat - bLat, dLon * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180)));
};
export const hubOf = (lat: number, lon: number): Hub | null => HUBS.find((h) => degDist(lat, lon, h.lat, h.lon) <= h.radius) ?? null;

/* ───────────────────────── cities (columns) ───────────────────────── */

export interface City {
  key: string;
  /** column name: the city, or its metro area (台北・新北, 矽谷, 東京一帶) */
  name: string;
  /** member cities, largest first */
  places: { name: string; count: number }[];
  /** true position (unit normal) */
  n0: Vector3;
  /** spread position (unit normal) — the column stands here */
  n: Vector3;
  /** members bottom → top (layer order, then larger first) */
  members: Company[];
  /** footprint radius used by the spreading (world units on a unit globe) */
  radius: number;
  hub: Hub | null;
}

/** Places within this distance (degrees) of a larger place join its column: a metro area. */
const MERGE_DEG = 0.25;
/** Metro names for merged columns, keyed by a member city (the largest one that has an entry). */
const METRO: Readonly<Record<string, string>> = {
  聖荷西: '矽谷',
  聖塔克拉拉: '矽谷',
  '劍橋（麻州）': '波士頓一帶',
  波士頓: '波士頓一帶',
  華盛頓特區: '華府一帶',
  爾灣: '橘郡',
  芳泉谷: '橘郡',
};

/**
 * Group companies by city name, merge cities of one metro area (e.g. 台北・新北, the South Bay
 * towns → 矽谷) into one column, then push overlapping columns apart on the sphere. Bigger
 * columns move less; a weak spring keeps every column near its true position.
 */
export function buildCities(list: readonly Company[], radiusOf: (c: Company) => number, sizeOf: (c: Company) => number): City[] {
  // 1. places: same city name within 2° (homonyms far apart stay separate)
  interface Place {
    name: string;
    lat: number;
    lon: number;
    members: Company[];
  }
  const byName = new Map<string, Place[]>();
  for (const c of list) {
    const name = c.city || `${c.lat.toFixed(2)},${c.lon.toFixed(2)}`;
    const group = byName.get(name) ?? [];
    let place = group.find((g) => degDist(g.lat, g.lon, c.lat, c.lon) <= 2);
    if (!place) {
      place = { name: c.city, lat: c.lat, lon: c.lon, members: [] };
      group.push(place);
      byName.set(name, group);
    }
    place.members.push(c);
  }
  const places = [...byName.values()].flat();
  for (const p of places) {
    p.lat = p.members.reduce((a, m) => a + m.lat, 0) / p.members.length;
    p.lon = p.members.reduce((a, m) => a + m.lon, 0) / p.members.length;
  }
  places.sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
  // 2. metro areas: the largest unassigned place absorbs every unassigned place within MERGE_DEG
  const taken = new Array<boolean>(places.length).fill(false);
  const groups: Place[][] = [];
  for (let i = 0; i < places.length; i++) {
    if (taken[i]) continue;
    const a = places[i]!;
    const g: Place[] = [];
    for (let j = i; j < places.length; j++) {
      if (taken[j] || degDist(a.lat, a.lon, places[j]!.lat, places[j]!.lon) > MERGE_DEG) continue;
      taken[j] = true;
      g.push(places[j]!);
    }
    groups.push(g);
  }
  const cities: City[] = groups.map((g, gi) => {
    g.sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
    const named = g.filter((p) => p.name);
    const members = g.flatMap((p) => p.members);
    const anchor = named[0]?.name ?? '';
    const share = (k: number) => named.slice(0, k).reduce((a, p) => a + p.members.length, 0) / members.length;
    const metro = named.map((p) => METRO[p.name]).find((m) => !!m);
    const name =
      named.length < 2
        ? anchor
        : (metro ??
          (share(1) >= 0.8
            ? anchor
            : share(2) >= 0.75 && anchor.length + named[1]!.name.length <= 6
              ? `${anchor}・${named[1]!.name}`
              : `${anchor}一帶`));
    const lat = members.reduce((a, m) => a + m.lat, 0) / members.length;
    const lon = members.reduce((a, m) => a + m.lon, 0) / members.length;
    const n0 = latLonToVec3(lat, lon, 1);
    return {
      key: `${name || 'city'}#${gi}`,
      name,
      places: named.map((p) => ({ name: p.name, count: p.members.length })),
      n0,
      n: n0.clone(),
      members,
      radius: 0,
      hub: hubOf(lat, lon),
    };
  });
  for (const city of cities) {
    city.members.sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer] || sizeOf(b) - sizeOf(a) || a.id.localeCompare(b.id));
    city.radius = Math.max(...city.members.map(radiusOf));
  }
  cities.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
  spread(cities);
  return cities;
}

const tmpA = new Vector3();
function spread(cities: City[]): void {
  const pairs: [number, number][] = [];
  const near = Math.cos((9 * Math.PI) / 180);
  for (let i = 0; i < cities.length; i++)
    for (let j = i + 1; j < cities.length; j++) if (cities[i]!.n0.dot(cities[j]!.n0) > near) pairs.push([i, j]);
  const gap = 0.0016;
  for (let it = 0; it < 140; it++) {
    let moved = false;
    for (const [i, j] of pairs) {
      const a = cities[i]!;
      const b = cities[j]!;
      const need = (a.radius + b.radius) * 1.08 + gap;
      const d = a.n.angleTo(b.n);
      if (d >= need) continue;
      moved = true;
      tmpA.subVectors(a.n, b.n);
      if (tmpA.lengthSq() < 1e-12) tmpA.set(Math.sin(i * 2.4), Math.cos(j * 1.7), Math.sin(i + j)).cross(a.n);
      tmpA.normalize();
      const ma = a.members.length + 1;
      const mb = b.members.length + 1;
      const push = need - d;
      a.n.addScaledVector(tmpA, (push * mb) / (ma + mb)).normalize();
      b.n.addScaledVector(tmpA, (-push * ma) / (ma + mb)).normalize();
    }
    for (const c of cities) c.n.lerp(c.n0, 0.015).normalize();
    if (!moved && it > 10) break;
  }
}

/* ───────────────────────── formatting ───────────────────────── */

const nf = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 1 });
/** Millions of USD → 「7,800 億美元」「3.2 億美元」「500 萬美元」. */
export function fmtRevenue(m: number): string {
  if (m >= 100) {
    const yi = m / 100;
    return `${nf.format(yi >= 10 ? Math.round(yi) : Math.round(yi * 10) / 10)} 億美元`;
  }
  return `${nf.format(Math.max(1, Math.round(m * 100)))} 萬美元`;
}
