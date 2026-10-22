// Build-time loader for the 記憶體與儲存專題 (/memory/).
//
// Reads src/data/memory/{hbm,dram,nand,storage}.yaml (memoryMarket) and src/data/memory/fabs.yaml (memoryFabs),
// validates them with src/schemas/memory.ts and turns them into one page-wide view:
//   - Sources: every file has its own `sources` map. They are merged into one list (deduplicated by URL);
//     each `src` is rewritten to the merged key, so <Cite k> and the chart `source` props resolve against the
//     single list the page registers. A key that two files use for different URLs gets a `-<file>` suffix.
//   - Source keys mentioned inside notes (「見 tf-price-2q24」「（skh-q3-25）」) become cite markers
//     ⟦src:key⟧; CiteText.astro renders them as [n] links and plainText() strips them for tooltips.
//   - Helpers for the page: period parsing, current supply–demand state, headline numbers, metric grouping,
//     market-share groups and the merged cross-category expansion list.
// Files that fail validation are skipped with a console warning (scripts/check-memory.ts reports them).
// Build-time only (node:fs). Validate the data with: npx tsx scripts/check-memory.ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { z } from 'astro/zod';
import { memoryFabs, memoryMarket } from '../schemas/memory';
import type { SourceT } from '../schemas/common';
import { getRosterCompany } from './collections';

export type MemoryCategory = 'hbm' | 'dram' | 'nand' | 'storage';
export const MEMORY_CATEGORIES: readonly MemoryCategory[] = ['hbm', 'dram', 'nand', 'storage'];

export type MarketData = z.output<typeof memoryMarket>;
export type FabsData = z.output<typeof memoryFabs>;
export type Metric = MarketData['supply'][number];
export type BalanceEntry = MarketData['balance'][number];
export type BalanceState = BalanceEntry['state'];
export type DataStatus = Metric['status'];
export type ShareEntry = MarketData['marketShare'][number];
export type MixEntry = MarketData['demandMix'][number];
export type PriceSeries = MarketData['prices'][number];
export type CapacityRow = MarketData['capacity'][number];
export type Expansion = MarketData['expansions'][number];
export type ExpansionStage = Expansion['stage'];
export type TechItem = MarketData['technology'][number];
export type TechStatus = TechItem['status'];
export type MarketSizeEntry = MarketData['marketSize'][number];
export type Fab = FabsData['fabs'][number];
export type FabProduct = Fab['products'][number];
export type FabStatus = Fab['status'];

// ───────────── display metadata ─────────────

export interface CategoryMeta {
  /** short label for navigation and cards */
  short: string;
  /** what the market-share tables measure, e.g. 「NAND Flash」「HDD」 */
  shareName: string;
  /** one-line role description */
  role: string;
  /** colour token (matches the memory-fab-map product families) */
  color: string;
}
export const CATEGORY_META: Record<MemoryCategory, CategoryMeta> = {
  hbm: { short: 'HBM', shareName: 'HBM', role: '緊貼 AI 晶片的堆疊記憶體', color: 'var(--seg-memory-storage)' },
  dram: { short: 'DRAM', shareName: 'DRAM', role: '伺服器、手機與電腦的工作記憶體', color: 'var(--chart-1)' },
  nand: { short: 'NAND 與 SSD', shareName: 'NAND Flash', role: '斷電不遺失的快閃記憶體與固態硬碟', color: 'var(--chart-3)' },
  storage: { short: 'HDD 與新興記憶體', shareName: 'HDD', role: '資料中心的大容量硬碟與新型記憶體', color: 'var(--chart-4)' },
};

/** Balance scale from loose to tight (left → right in every meter and legend). */
export const BALANCE_ORDER: readonly BalanceState[] = ['oversupply', 'balanced', 'tight', 'shortage'];
export const BALANCE_META: Record<BalanceState, { label: string; color: string; hint: string }> = {
  oversupply: { label: '過剩', color: 'var(--mem-over)', hint: '供給大於需求，價格承壓' },
  balanced: { label: '平衡', color: 'var(--mem-bal)', hint: '供需大致相當' },
  tight: { label: '吃緊', color: 'var(--mem-tight)', hint: '供給偏緊，交期拉長、價格上漲' },
  shortage: { label: '短缺', color: 'var(--mem-short)', hint: '供給明顯不足，客戶拿不到足夠的貨' },
};

export const STATUS_LABEL: Record<DataStatus, string> = { actual: '實際', estimate: '估計', forecast: '預測' };

export const STAGE_META: Record<ExpansionStage, { label: string; order: number }> = {
  announced: { label: '已宣布', order: 1 },
  construction: { label: '興建中', order: 2 },
  equipping: { label: '裝機中', order: 3 },
  ramping: { label: '量產爬坡', order: 4 },
  operating: { label: '營運中', order: 5 },
  delayed: { label: '延後', order: 6 },
  cancelled: { label: '取消', order: 7 },
};

/** Maturity scale for the technology roadmap (1 = earliest). */
export const TECH_META: Record<TechStatus, { label: string; level: number }> = {
  research: { label: '研發中', level: 1 },
  roadmap: { label: '規劃中', level: 2 },
  sampling: { label: '送樣', level: 3 },
  ramping: { label: '爬坡', level: 4 },
  volume: { label: '量產', level: 5 },
};

export const SHARE_BASIS_LABEL: Record<ShareEntry['basis'], string> = { revenue: '營收', bit: '位元出貨', capacity: '產能', unit: '出貨台數' };
export const MIX_BASIS_LABEL: Record<MixEntry['basis'], string> = { revenue: '營收', bit: '位元', unit: '出貨量' };

export const FAB_STATUS_LABEL: Record<FabStatus, string> = {
  operating: '營運中',
  expanding: '擴產中',
  construction: '興建中',
  planned: '規劃中',
  delayed: '延後',
};
export const FAB_PRODUCT_LABEL: Record<FabProduct, string> = {
  dram: 'DRAM',
  hbm: 'HBM',
  'hbm-packaging': 'HBM 封裝',
  nand: 'NAND',
  hdd: 'HDD',
  ssd: 'SSD',
  other: '其他',
};
export type FabFamily = 'dram' | 'hbm' | 'nand' | 'other';
export const FAB_FAMILY_ORDER: readonly FabFamily[] = ['dram', 'hbm', 'nand', 'other'];
export const FAB_FAMILY_META: Record<FabFamily, { label: string; color: string }> = {
  dram: { label: 'DRAM', color: 'var(--chart-1)' },
  hbm: { label: 'HBM 與 HBM 封裝', color: 'var(--seg-memory-storage)' },
  nand: { label: 'NAND Flash', color: 'var(--chart-3)' },
  other: { label: 'HDD、SSD 與其他', color: 'var(--chart-4)' },
};
export const fabFamilyOf = (p: FabProduct): FabFamily =>
  p === 'dram' ? 'dram' : p === 'hbm' || p === 'hbm-packaging' ? 'hbm' : p === 'nand' ? 'nand' : 'other';

export const COUNTRY_ZH: Record<string, string> = {
  KR: '韓國', TW: '台灣', JP: '日本', CN: '中國', US: '美國', SG: '新加坡', MY: '馬來西亞', TH: '泰國',
  PH: '菲律賓', VN: '越南', IN: '印度', GB: '英國', IE: '愛爾蘭', DE: '德國', IL: '以色列',
};

/** Fixed colours per company so the same company keeps its colour across the page's share charts. */
const COMPANY_COLOR: Record<string, string> = {
  'samsung-electronics': 'var(--chart-1)',
  'sk-hynix': 'var(--chart-2)',
  micron: 'var(--chart-3)',
  kioxia: 'var(--chart-4)',
  sandisk: 'var(--chart-5)',
  ymtc: 'var(--chart-8)',
  solidigm: 'var(--chart-7)',
  cxmt: 'var(--chart-8)',
  'nanya-tech': 'var(--chart-4)',
  winbond: 'var(--chart-5)',
  'western-digital': 'var(--chart-1)',
  seagate: 'var(--chart-2)',
  toshiba: 'var(--chart-3)',
};
export const OTHER_COLOR = 'color-mix(in oklab, var(--c-fg-subtle) 55%, var(--c-bg-elev))';
export function companyColor(id: string, fallbackIndex = 0): string {
  if (id === 'other') return OTHER_COLOR;
  return COMPANY_COLOR[id] ?? `var(--chart-${Math.min(8, fallbackIndex + 1)})`;
}
export function companyName(id: string): string {
  if (id === 'other') return '其他';
  return getRosterCompany(id)?.nameZh ?? id;
}

// ───────────── cite markers ─────────────

const MARK = /⟦src:([a-z0-9][a-z0-9-]*)⟧/g;
export type CitePart = string | { cite: string };

/** Split a text with ⟦src:key⟧ markers into strings and { cite } parts. */
export function splitCites(text: string | undefined | null): CitePart[] {
  if (!text) return [];
  const out: CitePart[] = [];
  let last = 0;
  for (const m of text.matchAll(MARK)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push({ cite: m[1]! });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
/** Text without cite markers (for tooltips, aria labels and the 3D scene). */
export function plainText(text: string | undefined | null): string {
  if (!text) return '';
  return text
    .replace(/[（(]\s*(?:⟦src:[^⟧]+⟧[\s、，,]*)+[）)]/g, '')
    .replace(/\s*見\s*⟦src:[^⟧]+⟧/g, '')
    .replace(MARK, '')
    .replace(/、(?=[）。；，]|$)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
/** Merged keys cited inside a text. */
export function citesIn(text: string | undefined | null): string[] {
  return text ? [...new Set([...text.matchAll(MARK)].map((m) => m[1]!))] : [];
}

// ───────────── periods ─────────────

export interface PeriodRange {
  /** month index (year * 12 + month - 1), inclusive */
  s: number;
  e: number;
}
const mi = (y: number, m: number) => y * 12 + (m - 1);

/**
 * Parse the period strings used in the memory data into a month range:
 * 「2026」「2026 全年」「2026 Q2」「2026 H1」「2027 上半年」「2026-09」「2026 年底」「2025–2030」
 * 「FY2026 Q4（截至 2026-09-03）」「FY2027 H1」「HBM4（2026）」. Unknown formats return null.
 */
export function periodRange(raw: string): PeriodRange | null {
  const p = raw.trim();
  let m: RegExpMatchArray | null;
  const until = p.match(/截至\s*(\d{4})-(\d{2})/);
  if (until) {
    const e = mi(Number(until[1]), Number(until[2]));
    return { s: /Q[1-4]/.test(p) ? e - 2 : e - 11, e };
  }
  if ((m = p.match(/^(?:FY)?(\d{4})\s*[–-]\s*(?:FY)?(\d{4})/))) return { s: mi(Number(m[1]), 1), e: mi(Number(m[2]), 12) };
  if ((m = p.match(/^(?:FY)?(\d{4})\s*Q([1-4])/))) {
    const q = Number(m[2]);
    return { s: mi(Number(m[1]), q * 3 - 2), e: mi(Number(m[1]), q * 3) };
  }
  if ((m = p.match(/^(?:FY)?(\d{4})\s*(?:H([12])|(上|下)半年)/))) {
    const h = m[2] ? Number(m[2]) : m[3] === '上' ? 1 : 2;
    return { s: mi(Number(m[1]), h === 1 ? 1 : 7), e: mi(Number(m[1]), h === 1 ? 6 : 12) };
  }
  if ((m = p.match(/^(\d{4})-(0[1-9]|1[0-2])(?!\d)/))) {
    const x = mi(Number(m[1]), Number(m[2]));
    return { s: x, e: x };
  }
  if ((m = p.match(/^(\d{4})\s*年底/))) return { s: mi(Number(m[1]), 12), e: mi(Number(m[1]), 12) };
  if ((m = p.match(/^(?:FY)?(\d{4})/))) return { s: mi(Number(m[1]), 1), e: mi(Number(m[1]), 12) };
  if ((m = p.match(/(?:FY)?(\d{4})/))) return { s: mi(Number(m[1]), 1), e: mi(Number(m[1]), 12) };
  return null;
}
const isoMonth = (iso: string) => mi(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)));
/** Sort key for a period: end month, then span (narrow first); unknown periods sort last. */
export function periodSortKey(p: string): [number, number] {
  const r = periodRange(p);
  return r ? [r.e, r.e - r.s] : [Number.MAX_SAFE_INTEGER, 0];
}
export function comparePeriods(a: string, b: string): number {
  const [ae, as] = periodSortKey(a);
  const [be, bs] = periodSortKey(b);
  return ae - be || as - bs;
}

// ───────────── loading ─────────────

export interface MemoryData {
  /** latest `asOf` of the files */
  asOf: string;
  lastVerified: string;
  markets: MarketData[];
  fabs: FabsData | undefined;
  /** merged sources, keys rewritten; data sources only (pages entry sources are merged by mergePageSources) */
  sources: SourceT[];
  /** file → local source key → merged key (for page copy that cites a data source) */
  keyMaps: Record<string, Record<string, string>>;
  problems: string[];
}

/** Merged key of a source as named in one data file, e.g. srcKey(data, 'nand', 'mu-singapore') → 'mu-singapore-nand'. */
export function srcKey(d: MemoryData, file: MemoryCategory | 'fabs', local: string): string {
  const k = d.keyMaps[file]?.[local];
  if (!k) console.warn(`[memory-data] unknown source key ${file}:${local}`);
  return k ?? local;
}

const DIR = 'src/data/memory';
const FILES = [...MEMORY_CATEGORIES, 'fabs'] as const;
type FileId = (typeof FILES)[number];
/** fields whose string values are never scanned for source keys */
const SKIP_TEXT = new Set(['id', 'company', 'category', 'status', 'state', 'stage', 'basis', 'kind', 'unit', 'currency', 'products', 'capacityStatus', 'country', 'asOf', 'lastVerified', 'editorial', 'period', 'year']);

let cache: { stamp: string; data: MemoryData } | undefined;

function stampOf(): string {
  return FILES.map((f) => {
    const p = join(process.cwd(), DIR, `${f}.yaml`);
    try {
      return `${f}:${statSync(p).mtimeMs}`;
    } catch {
      return `${f}:-`;
    }
  }).join('|');
}

/** Rewrite `src` keys and cite mentions in every string field of a parsed data file. */
function rewrite(value: unknown, keyMap: Map<string, string>, re: RegExp | null, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => rewrite(v, keyMap, re, parentKey));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'sources') out[k] = v;
      else if (k === 'src' && typeof v === 'string') out[k] = keyMap.get(v) ?? v;
      else if (SKIP_TEXT.has(k)) out[k] = v;
      else out[k] = rewrite(v, keyMap, re, k);
    }
    return out;
  }
  if (typeof value === 'string' && re) {
    return value
      .replace(re, (_m, key: string) => `⟦src:${keyMap.get(key) ?? key}⟧`)
      // 「（key）」「（key、key2）」: the citation marks replace the parentheses
      .replace(/[（(]\s*((?:⟦src:[^⟧]+⟧[\s、，,]*)+)[）)]/g, (_m, inner: string) => inner.replace(/[\s、，,]+/g, ''));
  }
  return value;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

export function getMemoryData(): MemoryData {
  const stamp = stampOf();
  if (cache && cache.stamp === stamp) return cache.data;

  const problems: string[] = [];
  const parsed = new Map<FileId, MarketData | FabsData>();
  for (const f of FILES) {
    const p = join(process.cwd(), DIR, `${f}.yaml`);
    if (!existsSync(p)) {
      problems.push(`${f}.yaml missing`);
      continue;
    }
    let raw: unknown;
    try {
      raw = parse(readFileSync(p, 'utf8'));
    } catch (e) {
      problems.push(`${f}.yaml: YAML error ${(e as Error).message}`);
      continue;
    }
    const r = (f === 'fabs' ? memoryFabs : memoryMarket).safeParse(raw);
    if (!r.success) {
      problems.push(`${f}.yaml: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      continue;
    }
    parsed.set(f, r.data);
  }

  // merge sources by URL; keep the first key, suffix a key reused for a different URL
  const sources: SourceT[] = [];
  const keyByUrl = new Map<string, string>();
  const urlByKey = new Map<string, string>();
  const keyMaps = new Map<FileId, Map<string, string>>();
  for (const f of FILES) {
    const d = parsed.get(f);
    if (!d) continue;
    const map = new Map<string, string>();
    for (const [local, src] of Object.entries(d.sources)) {
      const seen = keyByUrl.get(src.url);
      if (seen) {
        map.set(local, seen);
        continue;
      }
      let key = local;
      if (urlByKey.has(key)) key = `${local}-${f}`;
      keyByUrl.set(src.url, key);
      urlByKey.set(key, src.url);
      map.set(local, key);
      sources.push({ ...src, key });
    }
    keyMaps.set(f, map);
  }

  const markets: MarketData[] = [];
  let fabs: FabsData | undefined;
  for (const f of FILES) {
    const d = parsed.get(f);
    const map = keyMaps.get(f);
    if (!d || !map) continue;
    const locals = [...map.keys()].sort((a, b) => b.length - a.length);
    const re = locals.length ? new RegExp(`(?<![A-Za-z0-9-])(${locals.map(escapeRe).join('|')})(?![A-Za-z0-9-])`, 'g') : null;
    const out = rewrite(d, map, re);
    if (f === 'fabs') fabs = out as FabsData;
    else markets.push(out as MarketData);
  }
  for (const p of problems) console.warn(`[memory-data] ${p}`);

  const dates = [...parsed.values()].map((d) => d.asOf).sort();
  const verified = [...parsed.values()].map((d) => d.lastVerified).sort();
  const data: MemoryData = {
    asOf: dates.at(-1) ?? '',
    lastVerified: verified.at(-1) ?? '',
    markets,
    fabs,
    sources,
    keyMaps: Object.fromEntries([...keyMaps].map(([f, m]) => [f, Object.fromEntries(m)])),
    problems,
  };
  cache = { stamp, data };
  return data;
}

/**
 * Page source list: the pages entry's own sources first (their keys are used by <Cite> in the MDX intro), then
 * the data sources whose URL is not already listed. A data key that the intro reuses for the same URL keeps
 * pointing at the intro's entry.
 */
export function mergePageSources(first: readonly SourceT[], data: readonly SourceT[]): SourceT[] {
  const urls = new Map(first.map((s) => [s.url, s.key]));
  const keys = new Set(first.map((s) => s.key).filter(Boolean));
  const out: SourceT[] = [...first];
  for (const s of data) {
    const k = urls.get(s.url);
    if (k !== undefined) {
      if (k === s.key) continue;
      // different keys for one URL: keep both so that neither the intro's nor the data's citations break
      console.warn(`[memory-data] intro source "${k}" and data source "${s.key}" share a URL; use the data key in the intro`);
    }
    if (s.key && keys.has(s.key)) console.warn(`[memory-data] key "${s.key}" is used by the intro for a different URL`);
    out.push(s);
  }
  return out;
}

// ───────────── derived views ─────────────

export const market = (d: MemoryData, c: MemoryCategory): MarketData | undefined => d.markets.find((m) => m.category === c);

export function sortedBalance(m: MarketData): BalanceEntry[] {
  return [...m.balance].sort((a, b) => comparePeriods(a.period, b.period));
}

/** The entry covering the data date (narrowest span wins), and the later entries as the outlook. */
export function balanceNow(m: MarketData, asOf: string): { current: BalanceEntry | undefined; outlook: BalanceEntry[] } {
  const now = isoMonth(asOf);
  const withRange = m.balance.map((b) => ({ b, r: periodRange(b.period) })).filter((x): x is { b: BalanceEntry; r: PeriodRange } => !!x.r);
  const covering = withRange.filter((x) => x.r.s <= now && x.r.e >= now).sort((a, b) => a.r.e - a.r.s - (b.r.e - b.r.s));
  const past = withRange.filter((x) => x.r.e < now).sort((a, b) => b.r.e - a.r.e);
  const cur = covering[0] ?? past[0];
  const curEnd = cur?.r.e ?? now;
  const outlook = withRange
    .filter((x) => x.r.s > curEnd)
    .sort((a, b) => a.r.e - b.r.e || a.r.e - a.r.s - (b.r.e - b.r.s))
    .map((x) => x.b);
  return { current: cur?.b, outlook };
}

/** 「美國銀行預測的 HBM 市場規模」 from the full definition (first clause, parentheses removed). */
export function shortDefinition(def: string): string {
  const bare = def.replace(/（[^）]*）/g, '');
  return (bare.split(/[，；]/)[0] ?? bare).replace(/\s{2,}/g, ' ').trim();
}

/** Market-size entries for the data year (or the latest earlier year). */
export function headlineMarketSize(m: MarketData, asOf: string): MarketSizeEntry[] {
  const y = Number(asOf.slice(0, 4));
  const same = m.marketSize.filter((x) => x.year === y);
  if (same.length) return same;
  const earlier = m.marketSize.filter((x) => x.year < y).sort((a, b) => b.year - a.year);
  const ly = earlier[0]?.year;
  return ly == null ? [] : earlier.filter((x) => x.year === ly);
}

/** USD amount in 億美元 (value given in million or billion). */
export function usdYi(x: Pick<MarketSizeEntry, 'value' | 'unit'>): number {
  return x.unit === 'billion' ? x.value * 10 : x.value / 100;
}

/** 「FY2026」 when the definition says the figure is a fiscal year (company revenue), otherwise 「2026」. */
export function sizePeriod(x: Pick<MarketSizeEntry, 'year' | 'definition'>): string {
  return new RegExp(`FY\\s*${x.year}`).test(x.definition) ? `FY${x.year}` : String(x.year);
}
/**
 * True when a market-size entry is a company's revenue standing in for the market: its short definition (outside
 * the parentheses) does not mention 全球／市場／產業／產值／TAM, e.g. 「希捷全公司營收（FY2026，…資料中心市場占 80%）」.
 */
export function isProxySize(x: Pick<MarketSizeEntry, 'definition'>): boolean {
  return !/全球|市場|產業|產值|TAM/.test(shortDefinition(x.definition));
}

/** Subject of a market-share entry inside a category (separates 企業級 SSD and 近線 HDD tables). */
export function shareSubject(e: ShareEntry): string {
  const l = e.label ?? '';
  if (/企業級 SSD/.test(l)) return '企業級 SSD';
  if (/近線/.test(l)) return '近線 HDD';
  return '';
}

export interface ShareGroup {
  key: string;
  basis: ShareEntry['basis'];
  subject: string;
  /** chronological */
  entries: ShareEntry[];
}
export function shareGroups(m: MarketData): ShareGroup[] {
  const groups: ShareGroup[] = [];
  for (const e of m.marketShare) {
    const subject = shareSubject(e);
    const key = `${e.basis}|${subject}`;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, basis: e.basis, subject, entries: [] }));
    g.entries.push(e);
  }
  for (const g of groups) g.entries.sort((a, b) => comparePeriods(a.period, b.period));
  // main subject first, then revenue before other bases
  const rank = (g: ShareGroup) => (g.subject ? 10 : 0) + (g.basis === 'revenue' ? 0 : 1);
  return groups.sort((a, b) => rank(a) - rank(b));
}

/** The most recent share snapshot (revenue basis and the main subject win ties). */
export function latestShare(m: MarketData): ShareEntry | undefined {
  const rank = (e: ShareEntry) => (e.basis === 'revenue' ? 0 : 1) + (shareSubject(e) ? 2 : 0);
  return [...m.marketShare].sort((a, b) => comparePeriods(b.period, a.period) || rank(a) - rank(b))[0];
}

/** Share items sorted by share, 「其他」 last. */
export function sortedShareItems(e: ShareEntry): ShareEntry['items'] {
  return [...e.items].sort((a, b) => (a.company === 'other' ? 1 : 0) - (b.company === 'other' ? 1 : 0) || b.share - a.share);
}

/** The price series that reaches furthest in time (ties keep the data order). */
export function headlinePrice(m: MarketData): PriceSeries | undefined {
  let best: PriceSeries | undefined;
  let bestEnd = -Infinity;
  for (const s of m.prices) {
    const end = Math.max(...s.points.map((p) => periodRange(p.period)?.e ?? -Infinity));
    if (end > bestEnd) {
      best = s;
      bestEnd = end;
    }
  }
  return best;
}

/** For a qoq series: the latest non-forecast point and the next forecast point. */
export function priceNow(s: PriceSeries): { last: PriceSeries['points'][number] | undefined; next: PriceSeries['points'][number] | undefined } {
  const pts = [...s.points].sort((a, b) => comparePeriods(a.period, b.period));
  const known = pts.filter((p) => p.status !== 'forecast');
  const last = known.at(-1);
  const next = pts.find((p) => p.status === 'forecast' && (!last || comparePeriods(p.period, last.period) > 0));
  return { last, next };
}

// ───────────── metric grouping ─────────────

export interface MetricPoint {
  label: string;
  /** small second line (period or sub-label) */
  sub?: string | undefined;
  value: number;
  status: DataStatus;
  period: string;
  note?: string | undefined;
  src: string;
}
export interface MetricSeries {
  name: string;
  points: MetricPoint[];
}
export interface MetricChart {
  key: string;
  title: string;
  unit: string;
  series: MetricSeries[];
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/**
 * Group metrics for charts: labels with 「前綴：項目」 share a chart (one bar per item); otherwise a label with
 * two or more periods makes a chart. Consecutive label charts with the same unit and the same periods are merged
 * into one grouped chart (e.g. HBM 佔晶圓投片比重 vs 佔位元供給比重). Everything else is a single figure.
 */
export function groupMetrics(list: readonly Metric[]): { charts: MetricChart[]; singles: Metric[] } {
  const order: string[] = [];
  const groups = new Map<string, { prefix: boolean; title: string; unit: string; items: Metric[] }>();
  for (const m of list) {
    const i = m.label.indexOf('：');
    const prefix = i > 0 ? m.label.slice(0, i) : null;
    const key = `${prefix ?? m.label}|${m.unit}`;
    if (!groups.has(key)) {
      groups.set(key, { prefix: !!prefix, title: prefix ?? m.label, unit: m.unit, items: [] });
      order.push(key);
    }
    groups.get(key)!.items.push(m);
  }
  const charts: MetricChart[] = [];
  const singles: Metric[] = [];
  let prev: { chart: MetricChart; periods: string; merged: boolean } | undefined;
  for (const key of order) {
    const g = groups.get(key)!;
    if (g.items.length < 2) {
      singles.push(...g.items);
      prev = undefined;
      continue;
    }
    const points: MetricPoint[] = g.items.map((m) => {
      const sub = g.prefix ? m.label.slice(m.label.indexOf('：') + 1) : undefined;
      return {
        label: sub ?? m.period,
        sub: sub ? m.period : undefined,
        value: m.value,
        status: m.status,
        period: m.period,
        note: m.note,
        src: m.src,
      };
    });
    if (!g.prefix) points.sort((a, b) => comparePeriods(a.period, b.period));
    const periods = points.map((p) => p.period).join('|');
    if (prev && !prev.merged && !g.prefix && prev.chart.unit === g.unit && prev.periods === periods && prev.chart.series.length === 1) {
      const a = prev.chart.series[0]!.name;
      const b = g.title;
      const pre = commonPrefix(a, b);
      prev.chart.title = pre.length >= 4 ? `${a}與${b.slice(pre.length)}` : `${a}與${b}`;
      prev.chart.series.push({ name: b, points });
      prev.merged = true;
      continue;
    }
    const chart: MetricChart = { key, title: g.title, unit: g.unit, series: [{ name: g.title, points }] };
    charts.push(chart);
    prev = g.prefix ? undefined : { chart, periods, merged: false };
  }
  return { charts, singles };
}

/** Capacity rows grouped by metric + unit (charts need two or more rows). */
export function capacityGroups(rows: readonly CapacityRow[]): Array<{ metric: string; unit: string; rows: CapacityRow[] }> {
  const out: Array<{ metric: string; unit: string; rows: CapacityRow[] }> = [];
  for (const r of rows) {
    let g = out.find((x) => x.metric === r.metric && x.unit === r.unit);
    if (!g) out.push((g = { metric: r.metric, unit: r.unit, rows: [] }));
    g.rows.push(r);
  }
  return out;
}

// ───────────── expansions (cross-category) ─────────────

export interface ExpansionRow {
  id: string;
  company: string;
  project: string;
  fab?: string | undefined;
  product: string;
  categories: MemoryCategory[];
  addCapacity?: string | undefined;
  capex?: string | undefined;
  stage: ExpansionStage;
  start?: string | undefined;
  production?: string | undefined;
  note?: string | undefined;
  srcs: string[];
}

const norm = (s: string | undefined) => (s ?? '').replace(/[\s（）()]/g, '');
const sameFab = (a: string | undefined, b: string | undefined) => {
  const x = norm(a);
  const y = norm(b);
  return x.length >= 2 && y.length >= 2 && (x === y || x.includes(y) || y.includes(x));
};
const moreSpecific = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : b.length > a.length && b.startsWith(a) ? b : a);

/**
 * Every expansion of the four markets, HBM and DRAM entries for the same fab merged (HBM wafers are DRAM),
 * sorted by production date (YYYY < YYYY-MM; undated last).
 */
export function allExpansions(d: MemoryData): ExpansionRow[] {
  const rows: ExpansionRow[] = [];
  for (const m of d.markets) {
    for (const x of m.expansions) {
      const dramFamily = m.category === 'hbm' || m.category === 'dram';
      const hit = dramFamily
        ? rows.find((r) => r.company === x.company && r.categories.some((c) => c === 'hbm' || c === 'dram') && !r.categories.includes(m.category) && sameFab(r.fab, x.fab))
        : undefined;
      if (hit) {
        hit.categories.push(m.category);
        hit.production = moreSpecific(hit.production, x.production);
        hit.start = moreSpecific(hit.start, x.start);
        hit.addCapacity ??= x.addCapacity;
        hit.capex ??= x.capex;
        hit.note ??= x.note;
        if (!hit.srcs.includes(x.src)) hit.srcs.push(x.src);
        continue;
      }
      rows.push({
        id: `xp-${rows.length + 1}`,
        company: x.company,
        project: x.project,
        fab: x.fab,
        product: x.product,
        categories: [m.category],
        addCapacity: x.addCapacity,
        capex: x.capex,
        stage: x.stage,
        start: x.start,
        production: x.production,
        note: x.note,
        srcs: [x.src],
      });
    }
  }
  return rows.sort((a, b) => {
    if (a.production && b.production) return a.production.localeCompare(b.production) || STAGE_META[b.stage].order - STAGE_META[a.stage].order;
    if (a.production) return -1;
    if (b.production) return 1;
    return STAGE_META[b.stage].order - STAGE_META[a.stage].order || a.company.localeCompare(b.company);
  });
}

/** 「2027 年」「2027 年 2 月」「2026 年 4 月 22 日」 for a PartialDate. */
export function partialDateZh(p: string | undefined): string {
  if (!p) return '';
  const [y, m, d] = p.split('-');
  if (d) return `${y} 年 ${Number(m)} 月 ${Number(d)} 日`;
  if (m) return `${y} 年 ${Number(m)} 月`;
  return `${y} 年`;
}
/** Fractional year for a PartialDate (mid-month / mid-year). */
export function partialDateYear(p: string): number {
  const [y, m, d] = p.split('-').map(Number);
  if (m == null) return y! + 0.5;
  return y! + (m - 1) / 12 + (d != null ? (d - 1) / 365 : 1 / 24);
}

// ───────────── fabs ─────────────

export interface FabRow extends Fab {
  companyName: string;
  family: FabFamily;
  families: FabFamily[];
}
export function fabRows(d: MemoryData): FabRow[] {
  if (!d.fabs) return [];
  return d.fabs.fabs.map((f) => {
    const families = [...new Set(f.products.map(fabFamilyOf))];
    return { ...f, companyName: companyName(f.company), family: fabFamilyOf(f.products[0]!), families };
  });
}
