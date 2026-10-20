// Scene data for `chain-panorama` (docs/SCENES.md → 頁面資料形狀 `segments`) plus the shared
// segment/company aggregation used by the home page, /chain/ and /chain/[segment]/.
// Owner: pages-home-chain. Build-time only.
//
//   import { buildSegmentsSceneData } from '../lib/scene-data/segments';
//   <Scene3D id="chain-panorama" variant="hero" data={await buildSegmentsSceneData()} />
//
// Every segment always gets a datum: the title/layer/order come from the static taxonomy in
// lib/collections.ts, the tagline from the `segments` entry (or a built-in fallback while the entry
// is missing), and the companies from the roster (registry), tier 1 first, the entry's
// featuredCompanies (editorial picks) before the rest, then TTM revenue in USD (estimates never count).
import type { CollectionEntry } from 'astro:content';
import { SEGMENTS, getRoster, safeCollection, type RosterCompany, type SegmentId, type SegmentMeta } from '../collections';
import { ttmUsd, type FinancialsData, type TtmUsdResult } from '../financial-metrics';

// ───────────── tiny async memo (re-read after 1.5 s in dev so new content shows up) ─────────────
const DEV = import.meta.env.DEV;
const memoStore = new Map<string, { at: number; value: Promise<unknown> }>();
function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = memoStore.get(key);
  // In dev the entry stays fresh for 4 s after it *resolved* (a pending load is always reused), so a
  // single page render never recomputes, while edits to content still show up on the next request.
  if (hit && (!DEV || hit.at === 0 || Date.now() - hit.at < 4000)) return hit.value as Promise<T>;
  const entry = { at: 0, value: undefined as unknown as Promise<unknown> };
  const value = load().then(
    (v) => {
      entry.at = Date.now();
      return v;
    },
    (err) => {
      memoStore.delete(key);
      throw err;
    },
  );
  entry.value = value;
  memoStore.set(key, entry);
  return value;
}

// ───────────── content lookups ─────────────
export type SegmentEntry = CollectionEntry<'segments'>;
export type SegmentData = SegmentEntry['data'];

/** All `segments` entries by id (missing entries are simply absent). */
export function getSegmentEntries(): Promise<Map<string, SegmentEntry>> {
  return memo('segment-entries', async () => {
    const list = await safeCollection('segments');
    return new Map(list.map((e) => [e.id, e]));
  });
}

/** All `financials` entries by company id. */
export function getFinancialsMap(): Promise<Map<string, FinancialsData>> {
  return memo('financials-map', async () => {
    const list = await safeCollection('financials');
    const out = new Map<string, FinancialsData>();
    for (const e of list) {
      const d = e.data as FinancialsData;
      const id = typeof d.company === 'string' ? d.company : (d.company as { id: string }).id;
      out.set(id ?? e.id, d);
    }
    return out;
  });
}

/** TTM revenue in USD per company id (null when unavailable or estimate-only). */
export function getTtmUsdMap(): Promise<Map<string, TtmUsdResult | null>> {
  return memo('ttm-usd-map', async () => {
    const fins = await getFinancialsMap();
    const out = new Map<string, TtmUsdResult | null>();
    for (const [id, fin] of fins) {
      let t: TtmUsdResult | null = null;
      try {
        t = ttmUsd(fin);
      } catch {
        t = null;
      }
      out.set(id, t);
    }
    return out;
  });
}

/** Ids that have a `companies` content entry (a full or compact profile is published). */
export function getCompanyEntryIds(): Promise<Set<string>> {
  return memo('company-entry-ids', async () => new Set((await safeCollection('companies')).map((e) => e.id)));
}

// ───────────── fallbacks while a segment entry is missing ─────────────
export const FALLBACK_TAGLINES: Record<SegmentId, string> = {
  'energy-power': 'AI 的第一道門檻：穩定而充足的電力與電網設備',
  'semi-equipment-materials': '微影、蝕刻、沉積等製程設備，以及晶圓與特殊化學材料',
  'foundry-packaging': '把設計圖變成晶片：先進製程與先進封裝產能',
  'memory-storage': 'HBM、DRAM、NAND 與企業級儲存，餵資料給運算晶片',
  'eda-ip-design': '設計晶片的軟體、可授權的電路模組與 ASIC 設計服務',
  'ai-accelerators': 'GPU、AI ASIC 與伺服器 CPU：訓練與推論的運算核心',
  'networking-optics': '交換器、網卡、光模組與高速連接，把 GPU 連成叢集',
  'servers-systems': 'AI 伺服器與整機櫃組裝，以及電源、散熱與電路板',
  'datacenter-infra': '機房的配電、散熱設備，以及資料中心的開發與營運',
  'cloud-neocloud': '超大規模雲端與 GPU 新雲，以租用方式提供算力',
  'foundation-models': '訓練大型語言模型與多模態模型的實驗室',
  'devtools-data-mlops': '資料平台、向量資料庫、MLOps 與 AI 程式開發工具',
  'apps-agents': '企業與消費者應用、垂直領域 AI 與 Agent',
  'physical-ai': '機器人、自駕車與終端 AI 裝置，讓 AI 進入真實世界',
};

/** Scene used on each segment page when the entry (or its `scene` field) is missing — docs/SCENES.md. */
export const FALLBACK_SCENES: Record<SegmentId, { id: string; variant: string }> = {
  'energy-power': { id: 'energy', variant: 'grid' },
  'semi-equipment-materials': { id: 'euv-litho', variant: 'euv' },
  'foundry-packaging': { id: 'wafer-transistor', variant: 'wafer' },
  'memory-storage': { id: 'hbm', variant: 'hbm' },
  'eda-ip-design': { id: 'chip-floorplan', variant: 'floorplan' },
  'ai-accelerators': { id: 'gpu-scale', variant: 'chip' },
  'networking-optics': { id: 'network', variant: 'scale-out' },
  'servers-systems': { id: 'gpu-scale', variant: 'rack' },
  'datacenter-infra': { id: 'datacenter', variant: 'overview' },
  'cloud-neocloud': { id: 'cloud-globe', variant: 'globe' },
  'foundation-models': { id: 'attention', variant: 'layers' },
  'devtools-data-mlops': { id: 'train-infer', variant: 'pipeline' },
  'apps-agents': { id: 'agent-loop', variant: 'loop' },
  'physical-ai': { id: 'physical-ai', variant: 'robot' },
};

/** Upstream/downstream when the entry is missing: the neighbours in chain order. */
export function fallbackNeighbours(id: SegmentId): { upstream: SegmentId[]; downstream: SegmentId[] } {
  const i = SEGMENTS.findIndex((s) => s.id === id);
  return {
    upstream: i > 0 ? [SEGMENTS[i - 1]!.id] : [],
    downstream: i >= 0 && i < SEGMENTS.length - 1 ? [SEGMENTS[i + 1]!.id] : [],
  };
}

// ───────────── company ranking ─────────────
export interface RankedCompany {
  company: RosterCompany;
  /** true when this segment is the company's primary segment */
  primary: boolean;
  ttm: TtmUsdResult | null;
  /** millions of USD, null when unavailable */
  ttmUsdM: number | null;
  /** position in the entry's featuredCompanies (Infinity when not featured) */
  featured: number;
  /** a `companies` content entry exists */
  hasProfile: boolean;
  /** a `financials` entry exists */
  hasFinancials: boolean;
}

function compareRanked(
  a: RankedCompany,
  b: RankedCompany,
  rosterIndex: Map<string, number>,
  by: 'revenue' | 'featured',
): number {
  if (a.company.tier !== b.company.tier) return a.company.tier - b.company.tier;
  if (by === 'featured' && a.featured !== b.featured) return a.featured - b.featured;
  const at = a.ttmUsdM ?? -1;
  const bt = b.ttmUsdM ?? -1;
  if (at !== bt) return bt - at;
  if (a.featured !== b.featured) return a.featured - b.featured;
  return (rosterIndex.get(a.company.id) ?? 0) - (rosterIndex.get(b.company.id) ?? 0);
}

export interface RankOptions {
  /** also include companies that list this segment in secondarySegments (default false) */
  includeSecondary?: boolean;
  /** keep acquired/merged/defunct companies (default true) */
  includeInactive?: boolean;
  /**
   * Order inside a tier: 'revenue' (default) = TTM revenue in USD, then the entry's
   * featuredCompanies; 'featured' = the entry's featuredCompanies first (editorial picks of the
   * companies that best represent the segment), then TTM revenue.
   */
  by?: 'revenue' | 'featured';
}

/**
 * Roster companies of a segment, tier 1 first; within a tier by TTM revenue in USD (descending,
 * companies without actual financials last), then by the entry's featuredCompanies order
 * (or featured first with `by: 'featured'`).
 */
export async function rankSegmentCompanies(id: SegmentId, opts: RankOptions = {}): Promise<RankedCompany[]> {
  const { includeSecondary = false, includeInactive = true, by = 'revenue' } = opts;
  const [entries, fins, ttms, profiles] = await Promise.all([
    getSegmentEntries(),
    getFinancialsMap(),
    getTtmUsdMap(),
    getCompanyEntryIds(),
  ]);
  const featuredList: string[] = (entries.get(id)?.data.featuredCompanies ?? []).map((r) => r.id);
  const roster = getRoster();
  const rosterIndex = new Map(roster.map((c, i) => [c.id, i]));
  const out: RankedCompany[] = [];
  for (const c of roster) {
    const primary = c.segment === id;
    if (!primary && !(includeSecondary && c.secondarySegments?.includes(id))) continue;
    if (!includeInactive && c.status !== 'active') continue;
    const ttm = ttms.get(c.id) ?? null;
    const fi = featuredList.indexOf(c.id);
    out.push({
      company: c,
      primary,
      ttm,
      ttmUsdM: ttm?.valueUsd ?? null,
      featured: fi < 0 ? Number.POSITIVE_INFINITY : fi,
      hasProfile: profiles.has(c.id),
      hasFinancials: fins.has(c.id),
    });
  }
  return out.sort((a, b) => compareRanked(a, b, rosterIndex, by));
}

/**
 * Representative companies of a segment for chips, tables and the panorama (active, primary segment
 * only): tier 1 first, the segment entry's featuredCompanies before the rest, so a conglomerate whose
 * revenue mostly comes from elsewhere (an ad business, rockets, phones) does not outrank the
 * segment's defining players. Without an entry this falls back to TTM revenue order.
 */
export async function topSegmentCompanies(id: SegmentId, n = 4): Promise<RankedCompany[]> {
  const ranked = await rankSegmentCompanies(id, { includeInactive: false, by: 'featured' });
  return ranked.slice(0, n);
}

// ───────────── chain-panorama payload ─────────────
export interface SegmentSceneCompany {
  id: string;
  name: string;
  nameZh: string;
}
export interface SegmentSceneDatum {
  id: SegmentId;
  title: string;
  titleEn: string;
  layer: SegmentMeta['layer'];
  order: number;
  tagline: string;
  /** site-relative, without the base path (the scene resolves it with ctx.href) */
  href: string;
  companies: SegmentSceneCompany[];
}

/** One datum per segment (all 14, chain order) with its top `perSegment` companies (3–5), tier 1 first. */
export async function buildSegmentsSceneData(perSegment = 4): Promise<SegmentSceneDatum[]> {
  const n = Math.max(3, Math.min(5, perSegment));
  const entries = await getSegmentEntries();
  const out: SegmentSceneDatum[] = [];
  for (const s of SEGMENTS) {
    const d = entries.get(s.id)?.data;
    const top = await topSegmentCompanies(s.id, n);
    out.push({
      id: s.id,
      title: d?.title ?? s.title,
      titleEn: d?.titleEn ?? s.titleEn,
      layer: d?.layer ?? s.layer,
      order: d?.order ?? s.order,
      tagline: d?.tagline ?? FALLBACK_TAGLINES[s.id],
      href: `/chain/${s.id}/`,
      companies: top.map(({ company: c }) => ({ id: c.id, name: c.name, nameZh: c.nameZh })),
    });
  }
  return out;
}
