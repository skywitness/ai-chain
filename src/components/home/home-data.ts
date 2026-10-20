// Build-time data for the home page (owner: pages-home-chain). Every getter tolerates missing
// content: computed tiles fall back to registry counts, the capex chart returns null without
// capex series, featured trends fall back to the trends index.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  REGION_LABELS,
  getModelsIndex,
  getRoster,
  getTrendsIndex,
  safeCollection,
  segmentMeta,
  TREND_CATEGORY_LABELS,
  type SegmentId,
} from '../../lib/collections';
import { calendarQuarterPoints, sourcesFor, type FinancialsData } from '../../lib/financial-metrics';
import { formatMoney } from '../../lib/format';
import { getFinancialsMap, getSegmentEntries, getTtmUsdMap } from '../../lib/scene-data/segments';
import { DATA_DATE } from '../../lib/seo';

// ───────────── 關鍵數字 ─────────────
export interface KeyTile {
  label: string;
  /** big number */
  value: string;
  /** smaller text after the number (e.g. 「年增 117%」) */
  detail?: string | undefined;
  note?: string | undefined;
  asOf?: string | undefined;
  source?: { publisher: string; title: string; url: string } | undefined;
  /** internal link (segment page, methodology) */
  link?: { href: string; label: string } | undefined;
  /** CSS colour accent */
  accent?: string | undefined;
}

/** Split 「890 億美元（年增 117%）」 into 「890 億美元」 and 「年增 117%」. */
function splitValue(v: string): { value: string; detail?: string } {
  const m = /^(.+?)[（(，；](.+?)[）)]?$/.exec(v.trim());
  if (!m || [...m[1]!].length < 2) return { value: v };
  return { value: m[1]!.trim(), detail: m[2]!.trim() };
}

/** Segments whose first keyMetric is shown on the home page, in display order. */
export const HOME_FACT_SEGMENTS: SegmentId[] = ['energy-power', 'foundry-packaging', 'ai-accelerators', 'cloud-neocloud'];

export async function getKeyTiles(segmentHref: (id: string) => string): Promise<{ computed: KeyTile[]; facts: KeyTile[] }> {
  const roster = getRoster();
  const tier = (t: number) => roster.filter((c) => c.tier === t).length;
  const tw = roster.filter((c) => c.region === 'TW').length;
  const computed: KeyTile[] = [
    {
      label: '本站收錄的 AI 產業鏈公司',
      value: `${roster.length} 家`,
      detail: `一線 ${tier(1)}・二線 ${tier(2)}・三線與新創 ${tier(3)}`,
      note: `橫跨 5 層 14 個環節，其中台灣公司 ${tw} 家。`,
      asOf: DATA_DATE,
      accent: 'var(--c-accent)',
    },
  ];

  const ttms = await getTtmUsdMap();
  const tier1 = roster.filter((c) => c.tier === 1 && c.status === 'active');
  let sum = 0;
  let n = 0;
  let lastEnd = '';
  for (const c of tier1) {
    const t = ttms.get(c.id);
    if (!t) continue;
    sum += t.valueUsd;
    n++;
    if (t.end > lastEnd) lastEnd = t.end;
  }
  if (n > 0) {
    // Counted against every tier-1 roster company, so 「一線 N」 on the tile above = n + left.
    const left = tier(1) - n;
    computed.push({
      label: '一線公司近四季營收合計',
      value: `約 ${formatMoney(sum, 'USD', { digits: 1 })}`,
      detail: `${n} 家一線公司加總`,
      // Whole-company revenue (Apple, Amazon … include non-AI businesses): say so, so the total is
      // not read as the size of the AI market.
      note: `公司整體營收（含非 AI 業務），不是 AI 市場規模。依最近四季已公布的實際營收、按各期平均匯率換算美元，不含估計值${
        left > 0 ? `；另有 ${left} 家一線公司未上市、已被併購或尚無完整財報，未計入` : ''
      }。`,
      asOf: lastEnd || undefined,
      accent: 'var(--layer-silicon)',
    });
  }

  const entries = await getSegmentEntries();
  const facts: KeyTile[] = [];
  for (const id of HOME_FACT_SEGMENTS) {
    const m = entries.get(id)?.data.keyMetrics?.[0];
    if (!m) continue;
    const sv = splitValue(m.value);
    facts.push({
      label: m.label,
      value: sv.value,
      detail: sv.detail,
      note: m.note,
      asOf: m.asOf,
      source: { publisher: m.source.publisher, title: m.source.title, url: m.source.url },
      link: { href: segmentHref(id), label: segmentMeta(id)?.title ?? id },
      accent: `var(--seg-${id})`,
    });
  }
  return { computed, facts };
}

// ───────────── 雲端業者資本支出 ─────────────
export const HYPERSCALERS: Array<{ id: string; name: string }> = [
  { id: 'microsoft', name: 'Microsoft' },
  { id: 'amazon', name: 'Amazon' },
  { id: 'alphabet', name: 'Alphabet' },
  { id: 'meta', name: 'Meta' },
  { id: 'oracle', name: 'Oracle' },
];

export interface CapexChartData {
  /** hyperscalers without a capex series yet */
  missing: string[];
  series: Array<{ name: string; points: Array<{ x: string; y: number | null; estimate?: boolean }> }>;
  categories: string[];
  sources: Array<{ title: string; url: string; publisher: string }>;
  asOf: string;
}

/** Quarterly capex of the hyperscalers in 億美元 by calendar quarter, or null without ≥ 2 capex series. */
export async function getCapexChart(from = '2023-Q1'): Promise<CapexChartData | null> {
  const fins = await getFinancialsMap();
  const series: CapexChartData['series'] = [];
  const keys = new Map<string, string>(); // key → label
  const sources: CapexChartData['sources'] = [];
  const missing: string[] = [];
  let asOf = '';
  for (const h of HYPERSCALERS) {
    const fin = fins.get(h.id) as FinancialsData | undefined;
    const capex = fin?.series.find((s) => s.metric === 'capex' && s.periodType === 'quarter');
    if (!fin || !capex || capex.points.length < 4) {
      missing.push(h.name);
      continue;
    }
    let pts: ReturnType<typeof calendarQuarterPoints> = [];
    try {
      pts = calendarQuarterPoints(fin, 'capex', { usd: true, from });
    } catch {
      pts = [];
    }
    if (pts.length < 4) {
      missing.push(h.name);
      continue;
    }
    for (const p of pts) keys.set(p.key, p.x);
    series.push({ name: h.name, points: pts.map((p) => ({ x: p.x, y: Math.round(p.y) / 100, estimate: p.estimate })) });
    const src = sourcesFor(fin, capex.points.map((p) => p.src)).at(-1);
    if (src) sources.push({ title: src.title, url: src.url, publisher: src.publisher ?? h.name });
    if (fin.lastVerified > asOf) asOf = fin.lastVerified;
  }
  if (series.length < 2) return null;
  const categories = [...keys.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, label]) => label);
  return { missing, series, categories, sources, asOf };
}

// ───────────── 精選趨勢 ─────────────
export interface FeaturedTrend {
  id: string;
  title: string;
  category: string;
  categoryLabel: string;
  description?: string | undefined;
  horizon?: string | undefined;
  confidence?: string | undefined;
  impact?: string | undefined;
}
const HORIZON: Record<string, string> = { near: '2026–27', mid: '2028–30', long: '2030 以後' };
const LEVEL3: Record<string, string> = { high: '高', medium: '中', low: '低' };
export const PREFERRED_TRENDS = [
  'gpu-roadmap-rubin-feynman',
  'cowos-capacity-panel-level',
  'co-packaged-optics',
  'power-bottleneck-onsite-generation',
  'reasoning-test-time-compute',
  'agentic-ai-standards',
];

export async function getFeaturedTrends(n = 6): Promise<FeaturedTrend[]> {
  const index = getTrendsIndex();
  const entries = await safeCollection('trends');
  const byId = new Map(entries.map((e) => [e.id, e.data as Record<string, unknown>]));
  // Written trends first (high impact, then the editorial picks), then the index, capped per
  // category so the row mixes hardware, software, market and policy.
  const rank = (id: string) => {
    const i = PREFERRED_TRENDS.indexOf(id);
    return i < 0 ? 99 : i;
  };
  const impactRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const written = entries
    .map((e) => ({ id: e.id, impact: (e.data as { impact?: string }).impact ?? 'low' }))
    .sort((a, b) => (impactRank[a.impact] ?? 3) - (impactRank[b.impact] ?? 3) || rank(a.id) - rank(b.id))
    .map((e) => e.id);
  const candidates = [...new Set([...written, ...PREFERRED_TRENDS.filter((id) => index.some((t) => t.id === id)), ...index.map((t) => t.id)])];
  const catOf = (id: string) => ((byId.get(id) as { category?: string } | undefined)?.category ?? index.find((t) => t.id === id)?.category ?? 'hardware');
  const ids: string[] = [];
  const perCat = new Map<string, number>();
  // Pass 1: written articles (at most 3 per category, so a full card row is never all one topic
  // once more trends are written); pass 2: editorial picks and the index, at most 2 per category.
  const pick = (list: string[], cap: number) => {
    for (const id of list) {
      if (ids.length >= n) break;
      if (ids.includes(id)) continue;
      const c = catOf(id);
      if ((perCat.get(c) ?? 0) >= cap) continue;
      perCat.set(c, (perCat.get(c) ?? 0) + 1);
      ids.push(id);
    }
  };
  pick(written, 3);
  pick(candidates, 2);
  for (const id of candidates) {
    if (ids.length >= n) break;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => {
    const d = byId.get(id) as
      | { title: string; description: string; category: string; horizon: string; confidence: string; impact: string }
      | undefined;
    const idx = index.find((t) => t.id === id);
    const category = d?.category ?? idx?.category ?? 'hardware';
    return {
      id,
      title: d?.title ?? idx?.title ?? id,
      category,
      categoryLabel: TREND_CATEGORY_LABELS[category as keyof typeof TREND_CATEGORY_LABELS] ?? '',
      description: d?.description,
      horizon: d?.horizon ? HORIZON[d.horizon] : undefined,
      confidence: d?.confidence ? LEVEL3[d.confidence] : undefined,
      impact: d?.impact ? LEVEL3[d.impact] : undefined,
    };
  });
}

// ───────────── 台灣 ─────────────
export interface TaiwanSummary {
  count: number;
  bySegment: Array<{ id: SegmentId; title: string; count: number }>;
  top: Array<{ id: string; nameZh: string; segment: SegmentId; ttmUsdM: number }>;
  sites: number | null;
}

export async function getTaiwanSummary(): Promise<TaiwanSummary> {
  const roster = getRoster().filter((c) => c.region === 'TW');
  const counts = new Map<SegmentId, number>();
  for (const c of roster) counts.set(c.segment, (counts.get(c.segment) ?? 0) + 1);
  const bySegment = [...counts.entries()]
    .map(([id, count]) => ({ id, title: segmentMeta(id)?.short ?? id, count }))
    .sort((a, b) => b.count - a.count);
  const ttms = await getTtmUsdMap();
  const top = roster
    .map((c) => ({ id: c.id, nameZh: c.nameZh, segment: c.segment, ttmUsdM: ttms.get(c.id)?.valueUsd ?? 0 }))
    .filter((c) => c.ttmUsdM > 0)
    .sort((a, b) => b.ttmUsdM - a.ttmUsdM)
    .slice(0, 10);
  let sites: number | null = null;
  const p = join(process.cwd(), 'src/data/taiwan/sites.yaml');
  if (existsSync(p)) {
    try {
      const doc = parse(readFileSync(p, 'utf8')) as unknown;
      const list = Array.isArray(doc) ? doc : (doc as { sites?: unknown[] } | null)?.sites;
      if (Array.isArray(list) && list.length) sites = list.length;
    } catch {
      sites = null;
    }
  }
  return { count: roster.length, bySegment, top, sites };
}

// ───────────── 大模型 ─────────────
export const ORIGIN_LABELS: Record<string, string> = {
  US: '美國',
  CN: '中國',
  EU: '歐洲',
  TW: '台灣',
  KR: '韓國',
  JP: '日本',
  IL: '以色列',
  CA: '加拿大',
  ME: '中東',
  other: '其他',
};

export const MODEL_KIND_LABELS: Record<string, string> = {
  llm: '語言模型',
  video: '影片生成',
  image: '圖像生成',
  world: '世界模型',
  robotics: '機器人模型',
  audio: '語音與音樂',
  embedding: '嵌入模型',
};

export interface ModelsSummary {
  families: number;
  profiles: number;
  labs: number;
  byOrigin: Array<{ origin: string; label: string; count: number }>;
  byKind: Array<{ kind: string; label: string; count: number }>;
  featured: Array<{ id: string; title: string; origin: string }>;
}

export async function getModelsSummary(): Promise<ModelsSummary> {
  const index = getModelsIndex();
  const entries = await safeCollection('models');
  const counts = new Map<string, number>();
  for (const f of index) counts.set(f.origin, (counts.get(f.origin) ?? 0) + 1);
  const byOrigin = [...counts.entries()]
    .map(([origin, count]) => ({ origin, label: ORIGIN_LABELS[origin] ?? REGION_LABELS[origin] ?? origin, count }))
    .sort((a, b) => b.count - a.count);
  const labs = new Set(index.map((f) => f.lab ?? f.labName ?? f.id)).size;
  const kinds = new Map<string, number>();
  for (const f of index) kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
  const byKind = [...kinds.entries()]
    .map(([kind, count]) => ({ kind, label: MODEL_KIND_LABELS[kind] ?? kind, count }))
    .sort((a, b) => b.count - a.count);
  const written = new Set(entries.map((e) => e.id));
  // Flagship LLM families first (written profiles preferred), one per lab.
  const seenLabs = new Set<string>();
  const featured: ModelsSummary['featured'] = [];
  const llms = index.filter((f) => f.kind === 'llm');
  for (const f of [...llms.filter((x) => written.has(x.id)), ...llms]) {
    const lab = f.lab ?? f.id;
    if (seenLabs.has(lab) || featured.some((x) => x.id === f.id)) continue;
    seenLabs.add(lab);
    featured.push({ id: f.id, title: f.title, origin: f.origin });
    if (featured.length >= 8) break;
  }
  return { families: index.length, profiles: entries.length, labs, byOrigin, byKind, featured };
}
