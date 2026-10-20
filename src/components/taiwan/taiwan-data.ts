// Build-time data for /taiwan/: Taiwan roster companies, the segment × company matrix, the monthly
// revenue YoY heatmap rows, headline stats and the AI-server division-of-labour stages.
// Owner: pages-trends-taiwan.
import {
  LAYERS,
  SEGMENTS,
  getRoster,
  getRosterCompany,
  safeCollection,
  segmentMeta,
  type LayerMeta,
  type RosterCompany,
  type SegmentMeta,
} from '../../lib/collections';
import { companyHref } from '../../lib/paths';
import {
  monthlyRevenue,
  monthlyYoyMatrix,
  ttmUsd,
  median,
  type FinancialsInput,
  type YoyMatrix,
} from '../../lib/financial-metrics';
import { toUsd } from '../../lib/fx';

export type Tier = 1 | 2 | 3;

/** Active Taiwan companies in the roster (region TW), roster order. */
export function getTaiwanCompanies(): RosterCompany[] {
  return getRoster().filter((c) => c.region === 'TW' && (c.status ?? 'active') === 'active');
}

// ───────────── segment × company matrix ─────────────
export interface MatrixRow {
  seg: SegmentMeta;
  tiers: Record<Tier, RosterCompany[]>;
  /** companies whose primary segment is elsewhere but list this one as secondary */
  secondary: RosterCompany[];
  total: number;
}

export function taiwanMatrix(companies: readonly RosterCompany[], size?: Map<string, number>): MatrixRow[] {
  const bySize = (a: RosterCompany, b: RosterCompany) =>
    (size?.get(b.id) ?? -1) - (size?.get(a.id) ?? -1) || a.nameZh.localeCompare(b.nameZh, 'zh-Hant-TW');
  return SEGMENTS.map((seg) => {
    const primary = companies.filter((c) => c.segment === seg.id);
    const tiers: Record<Tier, RosterCompany[]> = {
      1: primary.filter((c) => c.tier === 1).sort(bySize),
      2: primary.filter((c) => c.tier === 2).sort(bySize),
      3: primary.filter((c) => c.tier === 3).sort(bySize),
    };
    const secondary = companies
      .filter((c) => c.segment !== seg.id && (c.secondarySegments ?? []).includes(seg.id))
      .sort((a, b) => a.tier - b.tier || bySize(a, b));
    return { seg, tiers, secondary, total: primary.length };
  });
}

// ───────────── Taiwan share of the roster per segment ─────────────
export interface SegmentShare {
  seg: SegmentMeta;
  /** active Taiwan companies whose primary segment is this one */
  tw: number;
  /** all active roster companies whose primary segment is this one */
  all: number;
  /** tw / all (0–1); null when the segment has no companies yet */
  share: number | null;
}
export interface LayerShare {
  layer: LayerMeta;
  segments: SegmentShare[];
  tw: number;
  all: number;
}

/** Share of Taiwan companies among the roster's active companies, per segment, grouped by layer (top layer first). */
export function taiwanShareByLayer(roster: readonly RosterCompany[] = getRoster()): LayerShare[] {
  const active = roster.filter((c) => (c.status ?? 'active') === 'active');
  const segShare = (seg: SegmentMeta): SegmentShare => {
    const inSeg = active.filter((c) => c.segment === seg.id);
    const tw = inSeg.filter((c) => c.region === 'TW').length;
    return { seg, tw, all: inSeg.length, share: inSeg.length ? tw / inSeg.length : null };
  };
  return [...LAYERS]
    .sort((a, b) => b.order - a.order)
    .map((layer) => {
      const segments = SEGMENTS.filter((s) => s.layer === layer.id).map(segShare);
      return {
        layer,
        segments,
        tw: segments.reduce((n, s) => n + s.tw, 0),
        all: segments.reduce((n, s) => n + s.all, 0),
      };
    });
}

// ───────────── financials ─────────────
export interface TwFinancials {
  company: RosterCompany;
  fin: FinancialsInput;
  /** last 12 reported months of revenue in USD millions (null when not computable) */
  last12Usd: number | null;
  /** last 12 months in native currency (millions) */
  last12: number | null;
  currency: string;
  latestMonth: string | null;
}

function last12(fin: FinancialsInput): { native: number | null; usd: number | null; latest: string | null; currency: string } {
  const pts = monthlyRevenue(fin).filter((p) => !p.estimate);
  const series = fin.series.find((s) => s.metric === 'revenue' && s.periodType === 'month');
  const currency = series?.currency ?? fin.reportingCurrency;
  const latest = pts.at(-1)?.period ?? null;
  if (pts.length < 12) return { native: null, usd: null, latest, currency };
  const run = pts.slice(-12);
  let native = 0;
  let usd = 0;
  for (const p of run) {
    native += p.value;
    const u = toUsd(p.value, currency, { start: p.start, end: p.end });
    if (u == null) return { native, usd: null, latest, currency };
    usd += u;
  }
  return { native, usd, latest, currency };
}

/** Financials of the given Taiwan companies (those with a `financials` entry). */
export async function getTaiwanFinancials(companies: readonly RosterCompany[]): Promise<TwFinancials[]> {
  const ids = new Set(companies.map((c) => c.id));
  const entries = await safeCollection('financials');
  const out: TwFinancials[] = [];
  for (const e of entries) {
    const d = e.data as unknown as FinancialsInput;
    const cid = typeof d.company === 'string' ? d.company : d.company?.id;
    if (!cid || !ids.has(cid)) continue;
    const company = companies.find((c) => c.id === cid)!;
    const l = last12(d);
    let usd = l.usd;
    if (usd == null) {
      try {
        usd = ttmUsd(d)?.valueUsd ?? null;
      } catch {
        usd = null;
      }
    }
    out.push({ company, fin: d, last12Usd: usd, last12: l.native, currency: l.currency, latestMonth: l.latest });
  }
  return out;
}

/** Size (USD millions, last 12 months) per company id, for sorting. */
export function sizeMap(fins: readonly TwFinancials[]): Map<string, number> {
  return new Map(fins.filter((f) => f.last12Usd != null).map((f) => [f.company.id, f.last12Usd!]));
}

// ───────────── heatmap ─────────────
export interface HeatmapSet {
  columns: string[];
  main: YoyMatrix['rows'];
  rest: YoyMatrix['rows'];
  /** number of companies with monthly data */
  count: number;
  latestMonth: string | null;
  /** how many companies have reported the latest column */
  latestReported: number;
}

/**
 * Monthly revenue YoY matrix (up to `months` columns; leading columns without any YoY are dropped).
 * Rows are grouped by primary segment (chain order) and sorted by size. `main` holds tier 1–2 companies,
 * `rest` tier 3 (shown in a disclosure).
 */
export function taiwanHeatmap(fins: readonly TwFinancials[], months = 24): HeatmapSet {
  const withMonthly = fins.filter((f) => f.fin.series.some((s) => s.metric === 'revenue' && s.periodType === 'month'));
  const order = (f: TwFinancials) => segmentMeta(f.company.segment)?.order ?? 99;
  const sorted = [...withMonthly].sort(
    (a, b) => order(a) - order(b) || (b.last12Usd ?? -1) - (a.last12Usd ?? -1) || a.company.nameZh.localeCompare(b.company.nameZh, 'zh-Hant-TW'),
  );
  const matrix = monthlyYoyMatrix(
    sorted.map((f) => ({
      label: f.company.nameZh,
      group: segmentMeta(f.company.segment)?.title ?? '',
      href: companyHref(f.company.id),
      financials: f.fin,
    })),
    months,
  );
  // drop leading columns where no company has a YoY value
  let first = 0;
  while (first < matrix.columns.length && matrix.rows.every((r) => r.values[first] == null)) first++;
  const columns = matrix.columns.slice(first);
  const rows = matrix.rows
    .map((r) => ({ ...r, values: r.values.slice(first) }))
    .filter((r) => r.values.some((v) => v != null));
  const tierOf = new Map(sorted.map((f) => [companyHref(f.company.id), f.company.tier]));
  const last = columns.length - 1;
  return {
    columns,
    main: rows.filter((r) => (tierOf.get(r.href ?? '') ?? 3) <= 2),
    rest: rows.filter((r) => (tierOf.get(r.href ?? '') ?? 3) === 3),
    count: rows.length,
    latestMonth: columns.at(-1) ?? null,
    latestReported: last >= 0 ? rows.filter((r) => r.values[last] != null).length : 0,
  };
}

// ───────────── stats ─────────────
export interface TaiwanStats {
  companies: number;
  tiers: Record<Tier, number>;
  listed: number;
  segmentsCovered: number;
  withMonthly: number;
  /** most recent month that at least half of the reporting companies have published */
  refMonth: string | null;
  refReported: number;
  refUp: number;
  refMedianYoy: number | null;
  /** companies whose reference-month revenue is the highest of the months on file */
  refRecord: number;
}

export function taiwanStats(companies: readonly RosterCompany[], fins: readonly TwFinancials[]): TaiwanStats {
  const tiers: Record<Tier, number> = { 1: 0, 2: 0, 3: 0 };
  for (const c of companies) tiers[c.tier as Tier]++;
  const monthly = fins
    .map((f) => ({ f, pts: monthlyRevenue(f.fin).filter((p) => !p.estimate) }))
    .filter((x) => x.pts.length > 0);
  // reference month: the latest month reported by at least half of the companies with monthly data
  const counts = new Map<string, number>();
  for (const x of monthly) for (const p of x.pts) counts.set(p.period, (counts.get(p.period) ?? 0) + 1);
  const months = [...counts.keys()].sort();
  const refMonth = [...months].reverse().find((m) => (counts.get(m) ?? 0) >= monthly.length / 2) ?? months.at(-1) ?? null;
  const yoys: number[] = [];
  let record = 0;
  for (const x of monthly) {
    const p = x.pts.find((q) => q.period === refMonth);
    if (!p) continue;
    if (p.yoy != null) yoys.push(p.yoy);
    const upto = x.pts.filter((q) => q.period <= (refMonth ?? ''));
    if (upto.length >= 12 && upto.every((q) => q.value <= p.value)) record++;
  }
  return {
    companies: companies.length,
    tiers,
    listed: companies.filter((c) => c.ownership === 'listed' || (c.listings ?? []).length > 0).length,
    segmentsCovered: new Set(companies.flatMap((c) => [c.segment, ...(c.secondarySegments ?? [])])).size,
    withMonthly: monthly.length,
    refMonth,
    refReported: refMonth ? (counts.get(refMonth) ?? 0) : 0,
    refUp: yoys.filter((v) => v > 0).length,
    refMedianYoy: median(yoys),
    refRecord: record,
  };
}

// ───────────── map sites and HQ distribution ─────────────
export type Region = '北部' | '中部' | '南部' | '東部';
export const REGION_ORDER: readonly Region[] = ['北部', '中部', '南部', '東部'];
const REGION_PREFIX: ReadonlyArray<[Region, RegExp]> = [
  ['北部', /^(台北|臺北|新北|基隆|桃園|新竹|竹北|宜蘭)/],
  ['中部', /^(苗栗|竹南|台中|臺中|彰化|南投|雲林)/],
  ['南部', /^(嘉義|台南|臺南|高雄|屏東)/],
  ['東部', /^(花蓮|台東|臺東)/],
];
/** 北部／中部／南部／東部 from a Chinese city name, else from the latitude. */
export function regionOf(city: string | undefined, lat: number): Region {
  for (const [r, re] of REGION_PREFIX) if (city && re.test(city)) return r;
  return lat >= 24.6 ? '北部' : lat >= 23.5 ? '中部' : '南部';
}

export interface SiteKindMeta {
  label: string;
  color: string;
}
/** Labels and colours for the `kind` values used in src/data/taiwan/sites.yaml. */
export const SITE_KIND_META: Record<string, SiteKindMeta> = {
  'science-park': { label: '科學園區', color: 'var(--scene-tw-accent)' },
  fab: { label: '晶圓廠', color: 'var(--seg-foundry-packaging)' },
  packaging: { label: '封測廠', color: 'var(--seg-memory-storage)' },
  'server-cluster': { label: '伺服器與算力聚落', color: 'var(--seg-servers-systems)' },
  research: { label: '研究機構', color: 'var(--seg-eda-ip-design)' },
  port: { label: '港口與機場', color: 'var(--seg-datacenter-infra)' },
  datacenter: { label: '資料中心', color: 'var(--seg-datacenter-infra)' },
  'hq-cluster': { label: '企業總部', color: 'var(--c-fg-muted)' },
};
export function siteKindMeta(kind: string): SiteKindMeta {
  return SITE_KIND_META[kind] ?? { label: '產業聚落', color: 'var(--c-fg-muted)' };
}

export interface CityGroup {
  city: string;
  /** smaller towns folded into this group (「竹北、新埔」) */
  includes: string[];
  companies: RosterCompany[];
}
/** HQ city label: Hsinchu city and county merge into 「新竹」; towns in Yunlin (「雲林…」) → 「雲林」; 「竹南」 → 「苗栗」. */
function hqCity(cityZh: string): string {
  if (/^(新竹|竹北)/.test(cityZh)) return '新竹';
  if (cityZh === '竹南') return '苗栗';
  return cityZh.replace(/^雲林.+$/, '雲林');
}
/** Companies grouped by HQ city, largest group first; tier 1 first inside a group. */
export function cityGroups(companies: readonly RosterCompany[]): CityGroup[] {
  const map = new Map<string, { companies: RosterCompany[]; includes: Set<string> }>();
  for (const c of companies) {
    const raw = c.hq?.cityZh ?? '其他';
    const k = hqCity(raw);
    if (!map.has(k)) map.set(k, { companies: [], includes: new Set() });
    const g = map.get(k)!;
    g.companies.push(c);
    if (raw !== k) g.includes.add(raw.replace(/^新竹(.+)/, '$1'));
  }
  return [...map.entries()]
    .map(([city, g]) => ({ city, includes: [...g.includes], companies: g.companies.sort((a, b) => a.tier - b.tier) }))
    .sort((a, b) => b.companies.length - a.companies.length);
}

// ───────────── AI server division of labour ─────────────
export interface ServerStage {
  id: string;
  step: string; // 「晶片」「L6」
  title: string;
  summary: string;
  detail: string;
  companies: string[];
}

/** Stages from chip to rack. Company ids are filtered against the roster at render time. */
export const SERVER_STAGES: readonly ServerStage[] = [
  {
    id: 'chip',
    step: '晶片',
    title: 'GPU／ASIC 晶片',
    summary: '設計、晶圓製造、先進封裝與測試',
    detail: 'IC 設計公司與設計服務廠完成晶片設計，交給晶圓代工廠製造，再用 CoWoS 等先進封裝把運算晶粒與 HBM 放上載板，最後完成測試。',
    companies: ['tsmc', 'ase', 'kyec', 'alchip', 'guc', 'mediatek', 'unimicron'],
  },
  {
    id: 'board',
    step: '板卡',
    title: '電路板與關鍵零組件',
    summary: 'PCB、銅箔基板、電源、散熱、連接器',
    detail: '承載晶片的伺服器主機板與 GPU 基板需要高層數 PCB 與高速銅箔基板，再加上電源供應器、散熱模組、連接器、滑軌、機殼與管理晶片（BMC）。',
    companies: ['gce', 'emc', 'tuc', 'delta-electronics', 'lite-on', 'avc', 'auras', 'lotes', 'king-slide', 'aspeed', 'chenbro'],
  },
  {
    id: 'l6',
    step: 'L6',
    title: '主機板組裝',
    summary: '把晶片與零件組裝成板卡（PCBA）',
    detail: '把 CPU、GPU 模組、記憶體插槽與各種零件組裝到主機板或 GPU 基板上，完成板階功能測試。這一段需要大規模的表面黏著（SMT）產線。',
    companies: ['wistron', 'foxconn', 'inventec'],
  },
  {
    id: 'l10',
    step: 'L10',
    title: '整機系統',
    summary: '一台可以開機測試的完整伺服器',
    detail: '把主機板、GPU 模組、記憶體、儲存、電源與散熱裝進機殼，燒機測試後成為完整伺服器。代工廠（ODM）直接替雲端業者設計，品牌廠則以自有品牌銷售。',
    companies: ['quanta', 'wiwynn', 'inventec', 'gigabyte', 'asus', 'mitac'],
  },
  {
    id: 'l11',
    step: 'L11',
    title: '整櫃交付',
    summary: '運算、交換、電源與液冷整合成一個機櫃',
    detail: '把多個運算托盤、交換器托盤、電源層與液冷管路裝進同一個機櫃，完成整櫃測試後直接運到資料中心上架。機櫃級 AI 系統讓這一段的價值與門檻大幅提高。',
    companies: ['foxconn', 'quanta', 'wiwynn', 'wistron'],
  },
];

/** Resolve stage company ids against the roster (unknown ids are dropped). */
export function stageCompanies(stage: ServerStage): RosterCompany[] {
  return stage.companies.map((id) => getRosterCompany(id)).filter((c): c is RosterCompany => !!c);
}
