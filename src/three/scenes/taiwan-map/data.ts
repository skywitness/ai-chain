/**
 * taiwan-map data: the page payload (docs/SCENES.md shape `taiwan`), its type guard, and the
 * derived per-site model (projected position, region, company slices sorted upstream → downstream,
 * dominant segment) plus a small collision relaxation so close towers never overlap.
 * No industry numbers live here: counts are computed from the data (本站名冊), places are real
 * coordinates.
 */
import { SEGMENT_IDS } from '../../core/ids';
import type { SegmentId } from '../../core/types';
import { projectTw } from '../../kit/projectTw';

/* ───────────────────────── payload ───────────────────────── */

export interface TwSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind?: string;
  companies: string[];
}
export interface TwCompany {
  id: string;
  nameZh?: string;
  site?: string;
  segment: string;
}
export interface TaiwanData {
  sites: TwSite[];
  companies: TwCompany[];
}

export function isTaiwanData(d: unknown): d is TaiwanData {
  if (!d || typeof d !== 'object') return false;
  const o = d as TaiwanData;
  return (
    Array.isArray(o.sites) &&
    o.sites.length > 0 &&
    Array.isArray(o.companies) &&
    o.sites.every(
      (s) =>
        !!s &&
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        Number.isFinite(s.lat) &&
        Number.isFinite(s.lon) &&
        Array.isArray(s.companies) &&
        (s.kind === undefined || typeof s.kind === 'string'),
    ) &&
    o.companies.every((c) => !!c && typeof c.id === 'string' && typeof c.segment === 'string')
  );
}

/* ───────────────────────── vocabulary ───────────────────────── */

const SEG_SET: ReadonlySet<string> = new Set(SEGMENT_IDS);
export const isSegment = (s: string): s is SegmentId => SEG_SET.has(s);

/** Full segment titles (cards, legend). */
export const SEG_TITLE: Record<SegmentId, string> = {
  'energy-power': '能源與電力',
  'semi-equipment-materials': '半導體設備與材料',
  'foundry-packaging': '晶圓代工與先進封裝',
  'memory-storage': '記憶體與儲存',
  'eda-ip-design': '設計工具與矽智財',
  'ai-accelerators': 'AI 晶片與加速器',
  'networking-optics': '網通與光通訊',
  'servers-systems': '伺服器與系統',
  'datacenter-infra': '資料中心',
  'cloud-neocloud': '雲端與新雲',
  'foundation-models': '基礎模型',
  'devtools-data-mlops': '開發工具與資料',
  'apps-agents': '應用與 Agent',
  'physical-ai': '實體 AI',
};
/** Short segment names (legend chips, card metadata). */
export const SEG_SHORT: Record<SegmentId, string> = {
  'energy-power': '能源電力',
  'semi-equipment-materials': '設備材料',
  'foundry-packaging': '代工封裝',
  'memory-storage': '記憶體',
  'eda-ip-design': 'EDA・矽智財',
  'ai-accelerators': 'AI 晶片',
  'networking-optics': '網通光通訊',
  'servers-systems': '伺服器',
  'datacenter-infra': '資料中心',
  'cloud-neocloud': '雲端',
  'foundation-models': '基礎模型',
  'devtools-data-mlops': '開發工具',
  'apps-agents': '應用與 Agent',
  'physical-ai': '實體 AI',
};

/** Site kinds that stand for an area (round base) rather than one plant (square base). */
const AREA_KINDS: ReadonlySet<string> = new Set(['science-park', 'server-cluster', 'industrial-park', 'park', 'cluster', 'hub', 'hq-cluster']);

export function kindLabel(kind: string, name: string): string {
  switch (kind) {
    case 'science-park':
      return '科學園區';
    case 'fab':
      return '晶圓廠';
    case 'packaging':
      return '封裝測試廠區';
    case 'server-cluster':
      return '伺服器與系統聚落';
    case 'research':
      return '研究機構';
    case 'port':
      return name.includes('機場') ? '國際機場' : '國際港口';
    case 'hq-cluster':
      return '企業總部聚落';
    case 'industrial-park':
      return '工業區';
    case 'cluster':
      return '產業聚落';
    default:
      return '產業據點';
  }
}

/** Short 3D label names for the known sites (src/data/taiwan/sites.yaml ids); others fall back to rules. */
const SHORT: Record<string, string> = {
  'hsinchu-science-park': '竹科',
  'tsmc-fab20-hsinchu': 'Fab 20 寶山',
  'itri-chunghsing': '工研院',
  'nchc-hsinchu': '國網中心',
  'hsinchu-industrial-park': '湖口',
  'tsmc-ap6-zhunan': 'AP6 竹南',
  'zhunan-science-park': '竹南園區',
  'tongluo-science-park': '銅鑼園區',
  'tsmc-ap3-longtan': 'AP3 龍潭',
  'hwaya-technology-park': '華亞園區',
  'neihu-technology-park': '內湖',
  'taipei-north': '士林・北投',
  'new-taipei-wugu': '五股・泰山',
  'taoyuan-cluster': '桃園電路板',
  'zhubei': '竹北',
  'foxconn-tucheng': '土城',
  'nanya-taishan': '泰山',
  'taoyuan-international-airport': '桃園機場',
  'central-taiwan-science-park': '中科',
  'micron-taichung': '后里',
  'port-of-taichung': '台中港',
  'google-changhua': '彰化',
  'southern-taiwan-science-park': '南科',
  'tsmc-ap7-chiayi': 'AP7 嘉義',
  'kaohsiung-science-park-luzhu': '路竹',
  'tsmc-fab22-kaohsiung': 'Fab 22 楠梓',
  'ase-kaohsiung': '日月光楠梓',
  'port-of-kaohsiung': '高雄港',
};

export function shortName(id: string, name: string, kind = ''): string {
  if (SHORT[id]) return SHORT[id]!;
  let base = name.replace(/（[^）]*）|\([^)]*\)/g, '').trim() || name;
  // 「桃園（企業總部）」 → 「桃園總部」, so it never repeats a region label word for word.
  if (kind === 'hq-cluster' && !base.includes('總部')) base += '總部';
  return base.length > 8 ? `${base.slice(0, 7)}…` : base;
}

/* ───────────────────────── regions (hotspots) ───────────────────────── */

export interface Region {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** label anchor (a point at sea next to the cluster) and the side the label box extends to */
  label: { lat: number; lon: number; side: 'left' | 'right' };
}

/** North → south along the western corridor. Sites join the nearest region (by km). */
export const REGIONS: readonly Region[] = [
  { id: 'taipei', name: '台北・新北', lat: 25.05, lon: 121.5, label: { lat: 25.2, lon: 121.74, side: 'right' } },
  // 桃園 sits inland to the south-east of its sites: on the sea side it would read as the label of
  // the tall 竹科 stack, whose top projects northward over that spot. Kept well south of the 台北・新北
  // label so both fit in the smaller 4:3 page stage.
  { id: 'taoyuan', name: '桃園', lat: 25.0, lon: 121.3, label: { lat: 24.8, lon: 121.4, side: 'right' } },
  { id: 'hsinchu', name: '新竹', lat: 24.8, lon: 121.01, label: { lat: 24.76, lon: 120.86, side: 'left' } },
  { id: 'miaoli', name: '竹南・苗栗', lat: 24.62, lon: 120.85, label: { lat: 24.53, lon: 120.66, side: 'left' } },
  { id: 'taichung', name: '台中・彰化', lat: 24.2, lon: 120.6, label: { lat: 24.2, lon: 120.4, side: 'left' } },
  { id: 'chiayi', name: '雲林・嘉義', lat: 23.55, lon: 120.4, label: { lat: 23.5, lon: 120.08, side: 'left' } },
  { id: 'tainan', name: '台南', lat: 23.08, lon: 120.27, label: { lat: 23.08, lon: 120.06, side: 'left' } },
  { id: 'kaohsiung', name: '高雄', lat: 22.7, lon: 120.3, label: { lat: 22.62, lon: 120.13, side: 'left' } },
];

export function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function regionOf(lat: number, lon: number): Region {
  let best = REGIONS[0]!;
  let bestD = Infinity;
  for (const r of REGIONS) {
    const d = km(lat, lon, r.lat, r.lon);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

/* ───────────────────────── site model ───────────────────────── */

export interface Slice {
  /** company id */
  id: string;
  name: string;
  segment: SegmentId | null;
  /** position in the site's own company list (the data lists the anchor companies first) */
  order: number;
}

export interface SiteModel {
  index: number;
  id: string;
  name: string;
  short: string;
  kind: string;
  kindLabel: string;
  area: boolean;
  region: Region;
  lat: number;
  lon: number;
  /** true projected position (world x, z) */
  x: number;
  z: number;
  /** placed position after relaxation */
  px: number;
  pz: number;
  slices: Slice[];
  dominant: SegmentId | null;
  /** company count per segment */
  counts: Map<SegmentId, number>;
}

const SEG_ORDER = new Map<string, number>(SEGMENT_IDS.map((s, i) => [s, i]));

export function buildSites(data: TaiwanData): SiteModel[] {
  const byId = new Map(data.companies.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: SiteModel[] = [];
  for (const s of data.sites) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const kind = s.kind ?? 'cluster';
    const [x, y] = projectTw(s.lon, s.lat);
    const slices: Slice[] = [...new Set(s.companies)].map((id, order) => {
      const c = byId.get(id);
      const seg = c && isSegment(c.segment) ? c.segment : null;
      return { id, name: c?.nameZh || id, segment: seg, order };
    });
    // Upstream at the bottom (chain order), so composition bands read like the chain tower.
    slices.sort((a, b) => (SEG_ORDER.get(a.segment ?? '') ?? 99) - (SEG_ORDER.get(b.segment ?? '') ?? 99));
    const counts = new Map<SegmentId, number>();
    for (const sl of slices) if (sl.segment) counts.set(sl.segment, (counts.get(sl.segment) ?? 0) + 1);
    let dominant: SegmentId | null = null;
    let best = 0;
    for (const seg of SEGMENT_IDS) {
      const n = counts.get(seg) ?? 0;
      if (n > best) {
        best = n;
        dominant = seg;
      }
    }
    out.push({
      index: out.length,
      id: s.id,
      name: s.name,
      short: shortName(s.id, s.name, kind),
      kind,
      kindLabel: kindLabel(kind, s.name),
      area: AREA_KINDS.has(kind),
      region: regionOf(s.lat, s.lon),
      lat: s.lat,
      lon: s.lon,
      x,
      z: -y,
      px: x,
      pz: -y,
      slices,
      dominant,
      counts,
    });
  }
  return out;
}

/**
 * Push overlapping towers apart (heavier towers move less) with a weak spring back to the true
 * position. Deterministic: plain iteration in index order.
 */
export function relax(sites: SiteModel[], radius: (s: SiteModel) => number, gap: number, iterations = 120): void {
  for (let it = 0; it < iterations; it++) {
    // Spring first, separation last: the final state never overlaps.
    for (const s of sites) {
      s.px += (s.x - s.px) * 0.02;
      s.pz += (s.z - s.pz) * 0.02;
    }
    let moved = false;
    for (let i = 0; i < sites.length; i++) {
      const a = sites[i]!;
      for (let j = i + 1; j < sites.length; j++) {
        const b = sites[j]!;
        let dx = b.px - a.px;
        let dz = b.pz - a.pz;
        let d = Math.hypot(dx, dz);
        const min = radius(a) + radius(b) + gap;
        if (d >= min) continue;
        if (d < 1e-6) {
          // Identical points: separate along a fixed, index-dependent direction.
          const ang = (j * 2.399) % (Math.PI * 2);
          dx = Math.cos(ang);
          dz = Math.sin(ang);
          d = 1;
        }
        const wa = 1 / (1 + a.slices.length);
        const wb = 1 / (1 + b.slices.length);
        const push = (min - d) / (wa + wb);
        a.px -= (dx / d) * push * wa;
        a.pz -= (dz / d) * push * wa;
        b.px += (dx / d) * push * wb;
        b.pz += (dz / d) * push * wb;
        moved = true;
      }
    }
    if (!moved && it > 4) break;
  }
}

/** Nearest site to (lat, lon) within `maxKm`, else null. */
export function nearestSite(sites: readonly SiteModel[], lat: number, lon: number, maxKm: number): SiteModel | null {
  let best: SiteModel | null = null;
  let bestD = maxKm;
  for (const s of sites) {
    const d = km(lat, lon, s.lat, s.lon);
    if (d <= bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
