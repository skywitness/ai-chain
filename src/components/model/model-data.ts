// Build-time data layer for the /models/ pages (owner: pages-models).
// Joins the registry (src/data/models-index.yaml, always complete) with the `models` content
// collection (filled progressively). Every consumer must cope with `entry === undefined`.
import type { CollectionEntry } from 'astro:content';
import {
  getBenchmarks,
  getCurriculumArticle,
  getModelsIndex,
  getRosterCompany,
  safeEntry,
  type CurriculumArticle,
  type ModelFamilyIndex,
} from '../../lib/collections';
import { dayNumber } from '../../lib/fiscal';
import { formatNumber } from '../../lib/format';
import { modelHref } from '../../lib/paths';
import type { SourceT } from '../../schemas/common';

export type ModelData = CollectionEntry<'models'>['data'];
export type ModelVersion = ModelData['versions'][number];
export type ModelPricing = ModelVersion['pricing'][number];
export type ModelBenchmark = ModelVersion['benchmarks'][number];
export type ModelKind = ModelData['kind'];

// ───────────── Labels (zh-TW) ─────────────
export const KIND_LABELS: Record<string, string> = {
  llm: '大型語言模型',
  image: '圖像生成',
  video: '影片生成',
  audio: '語音與音樂',
  world: '世界模型',
  robotics: '機器人',
  embedding: '嵌入模型',
};
/** Short labels for chips and filters */
export const KIND_SHORT: Record<string, string> = {
  llm: '語言',
  image: '圖像',
  video: '影片',
  audio: '語音',
  world: '世界模型',
  robotics: '機器人',
  embedding: '嵌入',
};
export const KIND_ORDER = ['llm', 'image', 'video', 'audio', 'world', 'robotics', 'embedding'] as const;
/** Categorical colour per kind (CSS expression) */
export const KIND_COLORS: Record<string, string> = {
  llm: 'var(--chart-1)',
  image: 'var(--chart-2)',
  video: 'var(--chart-5)',
  audio: 'var(--chart-4)',
  world: 'var(--chart-3)',
  robotics: 'var(--chart-7)',
  embedding: 'var(--chart-6)',
};
export const kindColor = (kind: string): string => KIND_COLORS[kind] ?? 'var(--c-accent)';

export const ORIGIN_LABELS: Record<string, string> = {
  US: '美國',
  CN: '中國',
  EU: '歐洲',
  CA: '加拿大',
  TW: '台灣',
  KR: '韓國',
  JP: '日本',
  IL: '以色列',
  ME: '中東',
  other: '其他',
};
export interface OriginGroup {
  id: string;
  label: string;
  origins: readonly string[];
}
export const ORIGIN_GROUPS: readonly OriginGroup[] = [
  { id: 'us', label: '美國', origins: ['US'] },
  { id: 'cn', label: '中國', origins: ['CN'] },
  { id: 'eu-ca', label: '歐洲與加拿大', origins: ['EU', 'CA'] },
  { id: 'tw-kr', label: '台灣與韓國', origins: ['TW', 'KR'] },
  { id: 'other', label: '其他地區', origins: ['JP', 'IL', 'ME', 'other'] },
];
export function originGroupOf(origin: string): OriginGroup {
  return ORIGIN_GROUPS.find((g) => g.origins.includes(origin)) ?? ORIGIN_GROUPS[ORIGIN_GROUPS.length - 1]!;
}

export const WEIGHTS_LABELS: Record<string, string> = {
  closed: '封閉權重',
  'open-weights': '開放權重',
  'open-source': '完全開源',
};
export const TIER_LABELS: Record<string, string> = {
  flagship: '旗艦',
  mid: '中階',
  small: '輕量',
  reasoning: '推理',
  specialized: '特化',
};
export const STATUS_LABELS: Record<string, string> = {
  announced: '已發表',
  preview: '預覽版',
  ga: '正式版',
  deprecated: '停止更新',
  retired: '已下架',
};
export const REASONING_LABELS: Record<string, string> = {
  none: '不推理',
  hybrid: '可切換推理',
  always: '一律推理',
};
export const MODALITY_LABELS: Record<string, string> = {
  text: '文字',
  image: '圖像',
  audio: '音訊',
  video: '影片',
  pdf: 'PDF',
  '3d': '3D',
  action: '動作',
};
export const AVAILABILITY_LABELS: Record<string, string> = {
  api: 'API',
  'chat-app': '聊天應用',
  'cloud-marketplace': '雲端平台',
  'self-host': '自行部署',
  'on-device': '裝置端',
};
export const ARCH_LABELS: Record<string, string> = {
  dense: '密集',
  moe: '混合專家（MoE）',
  hybrid: '混合架構',
  diffusion: '擴散模型',
  unknown: '未公開',
};
export const REPORTER_LABELS: Record<string, string> = {
  lab: '實驗室自評',
  'third-party': '第三方',
  leaderboard: '排行榜',
};

// Openness classes (CONTENT-GUIDE §4.5: 0 封閉、0.5 開放權重受限授權、0.8 開放權重寬鬆授權、1 完全開源)
export type OpennessClass = 'closed' | 'restricted' | 'open' | 'source' | 'unknown';
export const OPENNESS_LABELS: Record<OpennessClass, string> = {
  closed: '封閉',
  restricted: '開放權重（限制授權）',
  open: '開放權重',
  source: '完全開源',
  unknown: '整理中',
};
/** Filter buckets: closed / open weights (any licence) / fully open source */
export const OPENNESS_FILTERS = [
  { id: 'closed', label: '封閉' },
  { id: 'open', label: '開放權重' },
  { id: 'source', label: '完全開源' },
] as const;
export function opennessClass(openness: number | undefined): OpennessClass {
  if (openness === undefined || !Number.isFinite(openness)) return 'unknown';
  if (openness >= 0.95) return 'source';
  if (openness >= 0.7) return 'open';
  if (openness >= 0.3) return 'restricted';
  return 'closed';
}
/** Filter bucket for an openness class (restricted and permissive open weights share 「開放權重」). */
export function opennessBucket(c: OpennessClass): 'closed' | 'open' | 'source' | 'unknown' {
  return c === 'restricted' ? 'open' : c;
}

// ───────────── Formatting ─────────────
const CJK = /[㐀-鿿豈-﫿]/;
/** Join text with a half-width space only between Latin/digits and CJK (盤古之白): zh('Midjourney', '的特性') → 'Midjourney 的特性'. */
export function zh(...parts: string[]): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    const a = out.slice(-1);
    const b = p.charAt(0);
    const space = out && ((/[A-Za-z0-9]/.test(a) && CJK.test(b)) || (CJK.test(a) && /[A-Za-z0-9]/.test(b)));
    out += space ? ` ${p}` : p;
  }
  return out;
}

/**
 * Split a title so that short hyphenated Latin tokens (「gpt-oss」, 「K-EXAONE」) can be kept on one
 * line: `keep` parts are rendered inside a `white-space: nowrap` span.
 */
export function noBreakParts(text: string): Array<{ text: string; keep: boolean }> {
  return text
    .split(/([A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)+)/)
    .filter(Boolean)
    .map((t) => ({ text: t, keep: /^[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)+$/.test(t) && t.length <= 16 }));
}

/** 1,050,000 → 「105 萬」 · 262,144 → 「26.2 萬」 · 8,192 → 「8,192」 */
export function formatTokens(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e8) return `${formatNumber(n / 1e8, { digits: 1, trim: true })} 億`;
  if (n >= 1e4) {
    const w = n / 1e4;
    return `${formatNumber(w, { digits: w >= 100 ? 0 : 1, trim: true })} 萬`;
  }
  return formatNumber(n);
}
/** US-dollar price per 1M tokens: 10 → 「$10」 · 0.1 → 「$0.10」 · 1.25 → 「$1.25」 · 0.075 → 「$0.075」 */
export function formatUsd(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '免費';
  if (Number.isInteger(n)) return `$${formatNumber(n)}`;
  const digits = n < 0.1 && Math.round(n * 1000) % 10 !== 0 ? 3 : 2;
  return `$${formatNumber(n, { digits })}`;
}
/** 「$10／$50」 (input／output per 1M tokens) */
export function formatPricePair(p: Pick<ModelPricing, 'inputPerMTok' | 'outputPerMTok'> | undefined): string {
  if (!p) return '—';
  return `${formatUsd(p.inputPerMTok)}／${formatUsd(p.outputPerMTok)}`;
}
/** 3:1 blended input/output price — the same blend that `positioning.costIndex` uses. */
export function blendedPrice(p: Pick<ModelPricing, 'inputPerMTok' | 'outputPerMTok'>): number {
  return (3 * p.inputPerMTok + p.outputPerMTok) / 4;
}
export function formatParams(v: ModelVersion): string {
  const p = v.params;
  if (!p || !p.disclosed || (!p.totalB && !p.activeB)) return '未公開';
  // Billions with the Latin unit B, as model cards print them (「總 1,000B／啟用 32B」).
  const fmt = (x: number) => `${formatNumber(x, { digits: x < 10 ? 1 : 0, trim: true })}B`;
  if (p.totalB && p.activeB && p.activeB !== p.totalB) return `總 ${fmt(p.totalB)}／啟用 ${fmt(p.activeB)}`;
  return fmt((p.totalB ?? p.activeB)!);
}
export function modalitiesText(list: readonly string[] | undefined): string {
  return (list ?? []).map((m) => MODALITY_LABELS[m] ?? m).join('、') || '—';
}
export function daysBetween(a: string, b: string): number {
  return Math.abs(dayNumber(a.slice(0, 10)) - dayNumber(b.slice(0, 10)));
}
/** Largest gap in days between the given ISO dates (0 for fewer than two). */
export function dateSpread(dates: ReadonlyArray<string | undefined | null>): number {
  const ds = dates.filter((d): d is string => !!d).map((d) => dayNumber(d.slice(0, 10)));
  if (ds.length < 2) return 0;
  return Math.max(...ds) - Math.min(...ds);
}

// ───────────── Benchmarks registry ─────────────
export interface BenchmarkInfo {
  id: string;
  name: string;
  zh: string;
  measures: string;
  scale: string;
  higherIsBetter: boolean;
  url?: string | undefined;
  order: number;
}
export function benchmarkMap(): Map<string, BenchmarkInfo> {
  const m = new Map<string, BenchmarkInfo>();
  getBenchmarks().forEach((b, i) => {
    const r = b as Record<string, unknown>;
    m.set(b.id, {
      id: b.id,
      name: String(r['name'] ?? b.id),
      zh: String(r['zh'] ?? r['name'] ?? b.id),
      measures: String(r['measures'] ?? ''),
      scale: String(r['scale'] ?? ''),
      higherIsBetter: r['higherIsBetter'] !== false,
      url: typeof r['url'] === 'string' ? (r['url'] as string) : undefined,
      order: i,
    });
  });
  return m;
}
export function benchmarkInfo(id: string, map = benchmarkMap()): BenchmarkInfo {
  return map.get(id) ?? { id, name: id, zh: id, measures: '', scale: '', higherIsBetter: true, order: 999 };
}
const REPORTER_RANK: Record<string, number> = { 'third-party': 0, leaderboard: 1, lab: 2 };
/**
 * The representative score of one version on one benchmark: independent measurements
 * (third-party, leaderboard) before lab self-reports, then the most recent date.
 */
export function pickBenchmark(v: ModelVersion | undefined, benchmarkId: string): ModelBenchmark | undefined {
  if (!v) return undefined;
  const list = v.benchmarks.filter((b) => b.benchmark === benchmarkId);
  if (list.length === 0) return undefined;
  return [...list].sort(
    (a, b) => (REPORTER_RANK[a.reportedBy] ?? 9) - (REPORTER_RANK[b.reportedBy] ?? 9) || b.date.localeCompare(a.date),
  )[0];
}
/** Display a score with the benchmark's unit: 「96.1%」 · 「1,477」 · 「52.7」 */
export function formatScore(score: number, info: Pick<BenchmarkInfo, 'scale'> | undefined): string {
  const scale = info?.scale ?? '';
  // Elo ratings are whole numbers on the leaderboards (「1,494」, not 「1,494.3」).
  const digits = Number.isInteger(score) || /elo/i.test(scale) ? 0 : 1;
  const n = formatNumber(score, { digits });
  if (/%/.test(scale)) return `${n}%`;
  if (/分鐘/.test(scale)) return `${n} 分鐘`;
  return n;
}

// ───────────── Families ─────────────
export interface FamilyView {
  id: string;
  title: string;
  kind: string;
  origin: string;
  labId?: string | undefined;
  labUnit?: string | undefined;
  labName: string;
  href: string;
  entry?: CollectionEntry<'models'> | undefined;
  data?: ModelData | undefined;
  /** versions newest first ([] without an entry) */
  versions: ModelVersion[];
  flagship?: ModelVersion | undefined;
  opennessClass: OpennessClass;
  /** flagship's latest standard price */
  price?: ModelPricing | undefined;
  lastVerified?: string | undefined;
}

function labNameOf(f: ModelFamilyIndex, data?: ModelData): string {
  if (data?.labName) return data.labName;
  if (f.labName) return f.labName;
  if (f.lab) {
    const r = getRosterCompany(f.lab);
    // Chinese-language labs read better under their Chinese name (「快手」, not 「Kuaishou」).
    if (r) return r.nameZh && CJK.test(r.nameZh) && f.origin && ['CN', 'TW'].includes(f.origin) ? r.nameZh : r.name || r.nameZh;
  }
  return f.lab ?? '—';
}

/** Latest pricing point of a version (the first listed one on that date = the standard tier). */
export function latestPrice(v: ModelVersion | undefined): ModelPricing | undefined {
  if (!v || v.pricing.length === 0) return undefined;
  let best = v.pricing[0]!;
  for (const p of v.pricing) if (p.asOf > best.asOf) best = p;
  return best;
}

export function sortVersions(versions: readonly ModelVersion[]): ModelVersion[] {
  return [...versions].sort((a, b) => b.released.localeCompare(a.released) || a.name.localeCompare(b.name));
}

function buildFamily(f: ModelFamilyIndex, entry: CollectionEntry<'models'> | undefined): FamilyView {
  const data = entry?.data;
  const versions = data ? sortVersions(data.versions) : [];
  const flagship = data ? (data.versions.find((v) => v.id === data.flagshipVersion) ?? versions[0]) : undefined;
  const labId = (data?.lab as { id: string } | undefined)?.id ?? f.lab;
  return {
    id: f.id,
    title: data?.title ?? f.title,
    kind: data?.kind ?? f.kind ?? 'llm',
    origin: data?.origin ?? f.origin ?? 'other',
    labId,
    labUnit: data?.labUnit ?? f.labUnit,
    labName: labNameOf(f, data),
    href: modelHref(f.id),
    entry,
    data,
    versions,
    flagship,
    opennessClass: data ? opennessClass(data.positioning.openness) : 'unknown',
    price: latestPrice(flagship),
    lastVerified: data?.lastVerified,
  };
}

let familiesPromise: Promise<FamilyView[]> | null = null;
let familiesAt = 0;
/** Every registered family (registry order), joined with its content entry when it exists. */
export function getFamilies(): Promise<FamilyView[]> {
  // Cache per build; in dev re-read after 1.5 s so freshly written entries show up.
  const now = Date.now();
  if (!familiesPromise || (import.meta.env.DEV && now - familiesAt > 1500)) {
    familiesAt = now;
    familiesPromise = (async () => {
      const out: FamilyView[] = [];
      for (const f of getModelsIndex()) out.push(buildFamily(f, await safeEntry('models', f.id)));
      return out;
    })();
  }
  return familiesPromise;
}
export async function getFamily(id: string): Promise<FamilyView | undefined> {
  return (await getFamilies()).find((f) => f.id === id);
}

// ───────────── Related learning ─────────────
export interface LearnLink {
  slug: string;
  title: string;
  level: CurriculumArticle['level'];
  /** the article's subtitle or description once written, else the given fallback */
  description?: string | undefined;
}
/** Curriculum articles (registry order of `slugs`), with a one-line description when available. */
export async function getLearnLinks(slugs: readonly string[], fallback: Readonly<Record<string, string>> = {}): Promise<LearnLink[]> {
  const out: LearnLink[] = [];
  for (const s of new Set(slugs)) {
    const a = getCurriculumArticle(s);
    if (!a) continue;
    const e = await safeEntry('learn', a.slug);
    out.push({ slug: a.slug, title: e?.data.title ?? a.title, level: a.level, description: e?.data.subtitle ?? e?.data.description ?? fallback[a.slug] });
  }
  return out;
}

/** Unique sources (by url) in first-seen order. */
export function uniqueSources(list: ReadonlyArray<SourceT | undefined>): SourceT[] {
  const seen = new Set<string>();
  const out: SourceT[] = [];
  for (const s of list) {
    if (!s || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

/** Benchmark ids that most of the given versions report, in registry order on ties. */
export function commonBenchmarks(versions: ReadonlyArray<ModelVersion | undefined>, limit: number, exclude: readonly string[] = []): string[] {
  const map = benchmarkMap();
  const count = new Map<string, number>();
  for (const v of versions) {
    if (!v) continue;
    for (const id of new Set(v.benchmarks.map((b) => b.benchmark))) count.set(id, (count.get(id) ?? 0) + 1);
  }
  return [...count.entries()]
    .filter(([id, n]) => n >= 2 && !exclude.includes(id))
    .sort((a, b) => b[1] - a[1] || benchmarkInfo(a[0], map).order - benchmarkInfo(b[0], map).order)
    .slice(0, limit)
    .map(([id]) => id);
}
