// Build-time view model for the trends pages (/trends/ and /trends/[slug]/).
// Registry first (src/data/trends-index.yaml), merged with the `trends` content entry when it exists,
// so every registered trend renders even while its article is still being written.
// Owner: pages-trends-taiwan.
import type { CollectionEntry } from 'astro:content';
import { getTrendsIndex, safeCollection, TREND_CATEGORY_LABELS, type TrendIndexEntry } from '../../lib/collections';
import { trendHref } from '../../lib/paths';
import { DATA_DATE } from '../../lib/seo';

export type TrendCategory = TrendIndexEntry['category'];
export type Horizon = 'near' | 'mid' | 'long';
export type Level3 = 'high' | 'medium' | 'low';
export type MilestoneStatus = 'done' | 'expected' | 'speculative';
export type TrendEntry = CollectionEntry<'trends'>;
export type TrendData = TrendEntry['data'];

export const TREND_CATEGORIES: readonly TrendCategory[] = ['hardware', 'software', 'market', 'policy'];

export interface CategoryMeta {
  id: TrendCategory;
  label: string; // 硬體
  en: string;
  /** CSS colour (validated categorical chart colours; used for dots and accents, never for text) */
  color: string;
  blurb: string;
}
export const CATEGORY_META: Record<TrendCategory, CategoryMeta> = {
  hardware: {
    id: 'hardware',
    label: TREND_CATEGORY_LABELS.hardware,
    en: 'Hardware',
    color: 'var(--chart-1)',
    blurb: '製程、封裝、記憶體、互連、機櫃、散熱與供電：算力的物理基礎怎麼演進。',
  },
  software: {
    id: 'software',
    label: TREND_CATEGORY_LABELS.software,
    en: 'Software',
    color: 'var(--chart-3)',
    blurb: '推理模型、Agent、開放權重與世界模型：模型與應用層正在發生的轉變。',
  },
  market: {
    id: 'market',
    label: TREND_CATEGORY_LABELS.market,
    en: 'Market',
    color: 'var(--chart-4)',
    blurb: '資本支出、融資、需求與營收化，以及電力這個最現實的限制。',
  },
  policy: {
    id: 'policy',
    label: TREND_CATEGORY_LABELS.policy,
    en: 'Policy',
    color: 'var(--chart-7)',
    blurb: '出口管制、各國法規、主權 AI 與在地影響：規則如何重塑產業鏈。',
  },
};
export function categoryMeta(c: string): CategoryMeta {
  return CATEGORY_META[(c in CATEGORY_META ? c : 'hardware') as TrendCategory];
}

export const HORIZON_META: Record<Horizon, { label: string; range: string; order: number }> = {
  near: { label: '近期', range: '2026–2027', order: 1 },
  mid: { label: '中期', range: '2028–2030', order: 2 },
  long: { label: '長期', range: '2030 年以後', order: 3 },
};

export const CONFIDENCE_META: Record<Level3, { label: string; tone: 'pos' | 'info' | 'warn'; hint: string; order: number }> = {
  high: { label: '高', tone: 'pos', hint: '多數證據指向同一方向，時程大致明確', order: 1 },
  medium: { label: '中', tone: 'info', hint: '方向清楚，但時程或規模仍有變數', order: 2 },
  low: { label: '低', tone: 'warn', hint: '仍屬早期，可能延後或改變型態', order: 3 },
};

export const IMPACT_META: Record<Level3, { label: string; tone: 'accent' | 'neutral'; order: number }> = {
  high: { label: '高', tone: 'accent', order: 1 },
  medium: { label: '中', tone: 'neutral', order: 2 },
  low: { label: '低', tone: 'neutral', order: 3 },
};

export const MILESTONE_STATUS_META: Record<MilestoneStatus, { label: string; hint: string }> = {
  done: { label: '已發生', hint: '已經發生或已正式宣布完成' },
  expected: { label: '預期', hint: '公司或機構已公布的時程' },
  speculative: { label: '推測', hint: '業界推測，時程不確定' },
};

export interface Milestone {
  date: string; // YYYY | YYYY-MM | YYYY-MM-DD
  label: string;
  status: MilestoneStatus;
}

export interface TrendView {
  id: string;
  title: string;
  category: TrendCategory;
  /** based URL of the trend page */
  href: string;
  /** site-relative path without base (for scene data) */
  path: string;
  hasEntry: boolean;
  description?: string | undefined;
  horizon?: Horizon | undefined;
  horizonYears?: readonly [number, number] | undefined;
  confidence?: Level3 | undefined;
  impact?: Level3 | undefined;
  milestones: Milestone[];
  relatedSegments: string[];
  lastVerified?: string | undefined;
  /** registry position (stable sort key) */
  order: number;
}

function toView(idx: TrendIndexEntry, order: number, entry: TrendEntry | undefined): TrendView {
  const base: TrendView = {
    id: idx.id,
    title: idx.title,
    category: idx.category,
    href: trendHref(idx.id),
    path: `/trends/${idx.id}/`,
    hasEntry: false,
    milestones: [],
    relatedSegments: [],
    order,
  };
  if (!entry) return base;
  const d = entry.data;
  return {
    ...base,
    title: d.title || idx.title,
    category: (d.category ?? idx.category) as TrendCategory,
    hasEntry: true,
    description: d.description,
    horizon: d.horizon,
    horizonYears: d.horizonYears,
    confidence: d.confidence,
    impact: d.impact,
    milestones: [...(d.milestones ?? [])].sort((a, b) => milestoneKey(a.date).localeCompare(milestoneKey(b.date))),
    relatedSegments: (d.relatedSegments ?? []).map((r) => (typeof r === 'string' ? r : r.id)),
    lastVerified: d.lastVerified,
  };
}

/** Every registered trend (registry order), merged with its content entry when present. */
export async function getTrendViews(): Promise<TrendView[]> {
  const index = getTrendsIndex();
  const entries = await safeCollection('trends');
  const byId = new Map(entries.map((e) => [e.id, e]));
  return index.map((idx, i) => toView(idx, i, byId.get(idx.id)));
}

/** One trend view (registry + entry); undefined for an id that is not registered. */
export async function getTrendView(id: string, entry?: TrendEntry): Promise<TrendView | undefined> {
  const index = getTrendsIndex();
  const i = index.findIndex((t) => t.id === id);
  if (i < 0) return undefined;
  return toView(index[i]!, i, entry);
}

/** Sort key for partial dates: a bare year sorts at the start of its year ('2026' → '2026-00-00'),
 *  a bare month at the start of that month ('2026-03' → '2026-03-00'). */
export function milestoneKey(date: string): string {
  const d = String(date);
  if (d.length === 4) return `${d}-00-00`;
  if (d.length === 7) return `${d}-00`;
  return d.slice(0, 10);
}

export function milestoneYear(date: string): number {
  return Number(String(date).slice(0, 4));
}

/** 「2026 年 3 月」, 「2027 年」, 「2026 年 3 月 18 日」 */
export function milestoneDateLabel(date: string, style: 'long' | 'short' = 'long'): string {
  const d = String(date);
  const [y, m, day] = d.split('-').map(Number);
  if (style === 'short') {
    if (!m) return '年內';
    return day ? `${m}/${day}` : `${m} 月`;
  }
  if (!m) return `${y} 年`;
  return day ? `${y} 年 ${m} 月 ${day} 日` : `${y} 年 ${m} 月`;
}

/** Whether a milestone date lies in the past relative to the data date (bare years count as current). */
export function isPast(date: string, today = DATA_DATE): boolean {
  return milestoneKey(date) < milestoneKey(today);
}

/** 「2026–2027」 (or a single year) */
export function yearsLabel(years: readonly [number, number] | undefined): string {
  if (!years) return '';
  return years[0] === years[1] ? `${years[0]}` : `${years[0]}–${years[1]}`;
}

/** Shared axis for horizon bars on a page: [min, max] years covering every trend. */
export function horizonAxis(views: readonly TrendView[]): [number, number] {
  let lo = 2025;
  let hi = 2032;
  for (const v of views) {
    if (!v.horizonYears) continue;
    lo = Math.min(lo, v.horizonYears[0]);
    hi = Math.max(hi, v.horizonYears[1]);
  }
  return [lo, Math.min(hi, 2040)];
}
