// Page-level helpers for the home page, /chain/ and /chain/[segment]/ (build-time only).
// Owner: pages-home-chain. Every getter tolerates missing content entries and falls back to the
// static taxonomy (lib/collections.ts) and the roster.
import {
  LAYERS,
  REGION_LABELS,
  SEGMENTS,
  getRoster,
  isSegmentId,
  layerMeta,
  segmentMeta,
  type LayerMeta,
  type RosterCompany,
  type SegmentId,
  type SegmentMeta,
} from '../../lib/collections';
import { formatMoney } from '../../lib/format';
import {
  FALLBACK_SCENES,
  FALLBACK_TAGLINES,
  fallbackNeighbours,
  getSegmentEntries,
  type RankedCompany,
  type SegmentEntry,
} from '../../lib/scene-data/segments';
import type { SourceT } from '../../schemas/common';

// ───────────── labels ─────────────
export const CONCENTRATION: Record<string, { label: string; note: string }> = {
  monopoly: { label: '獨占', note: '一家業者掌握絕大多數市場' },
  oligopoly: { label: '寡占', note: '少數幾家業者主導' },
  competitive: { label: '競爭', note: '多家業者實力接近' },
  fragmented: { label: '分散', note: '業者眾多、尚未出現霸主' },
};

export const BOTTLENECK_WORDS = ['', '寬鬆', '略緊', '偏緊', '吃緊', '極度吃緊'] as const;

/** One-paragraph explainers for the five layers (bottom → top). */
export const LAYER_COPY: Record<LayerMeta['id'], { lead: string; body: string; flow: string }> = {
  foundation: {
    lead: '沒有電，就沒有算力',
    body: '一座大型 AI 園區的用電以百萬瓩（GW）計，相當於一座核電廠。發電、電網、變壓器與燃氣渦輪的交期，決定了資料中心能多快上線。',
    flow: '電力 → 晶圓廠與機房',
  },
  silicon: {
    lead: '把電路做成晶片',
    body: '從設計軟體、矽智財、設備材料到晶圓代工與先進封裝，最後產出 GPU、AI ASIC 與 HBM 記憶體。這一層技術門檻最高，也是台灣最關鍵的位置。',
    flow: '晶圓 → 晶片與記憶體',
  },
  systems: {
    lead: '把晶片組成 AI 工廠',
    body: '晶片被裝進伺服器與整機櫃，透過交換器與光模組連成數萬顆 GPU 的叢集，再放進有供電與液冷的資料中心。',
    flow: '晶片 → 機櫃與叢集',
  },
  'cloud-models': {
    lead: '把算力變成智慧',
    body: '雲端與新雲業者出租算力；模型實驗室用這些算力訓練基礎模型；資料平台與開發工具讓模型更容易被打造、評測與部署。',
    flow: '算力 → Token',
  },
  applications: {
    lead: '把模型變成產品',
    body: '企業軟體、AI 助理與 Agent 把模型能力交到使用者手上；實體 AI 則讓模型透過機器人、車輛與裝置進入真實世界。',
    flow: 'Token → 應用與營收',
  },
};

/** 「台灣」「美國」… */
export function regionLabel(region: string | undefined): string {
  return (region && REGION_LABELS[region]) || '其他';
}

/** Primary listing as 「TWSE 2330」 (first listing), or null for unlisted companies. */
export function primaryTicker(c: Pick<RosterCompany, 'listings'>): string | null {
  const l = c.listings?.[0];
  if (!l) return null;
  return l.exchange === 'other' || l.exchange === 'OTC' ? l.ticker : `${l.exchange} ${l.ticker}`;
}

export const OWNERSHIP_LABELS: Record<string, string> = {
  listed: '上市',
  private: '未上市',
  subsidiary: '子公司',
  'state-owned': '國營',
  nonprofit: '非營利',
};

/**
 * A short summary of a paragraph: its first sentence (up to 。；) when that fits in `max`
 * characters; otherwise the lead clause before 「：」 (「台灣同時是用電大戶與設備供應者」), or the
 * sentence cut at the last 「，」「、」 before the limit, so it never stops mid-phrase.
 */
export function firstSentence(text: string | undefined, max = 72): string {
  const t = (text ?? '').trim();
  if (!t) return '';
  const cut = t.split(/(?<=[。；])/)[0] ?? t;
  const s = cut.replace(/[；。]$/, '');
  const chars = [...s];
  if (chars.length <= max) return s;
  const colon = s.indexOf('：');
  if (colon >= 8 && [...s.slice(0, colon)].length <= max) return s.slice(0, colon);
  const head = chars.slice(0, max - 1).join('');
  const at = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'));
  return `${at >= 12 ? head.slice(0, at) : head}…`;
}

/** TTM revenue line for a ranked company: native currency plus the USD conversion. */
export function ttmText(r: RankedCompany): { native: string; usd: string | null; label: string; yoy: number | null } | null {
  const t = r.ttm;
  if (!t) return null;
  const native = formatMoney(t.value, t.currency);
  const usd = t.currency === 'USD' ? null : `約 ${formatMoney(t.valueUsd, 'USD')}`;
  return { native, usd, label: t.label, yoy: t.yoy };
}

// ───────────── key metrics ─────────────
export interface MetricParts {
  /** the headline number, e.g. 「1,434 億美元」 */
  value: string;
  /** growth shown as a Stat delta, e.g. 「+43%」 with label 「年增」 */
  delta?: string | undefined;
  deltaLabel?: string | undefined;
  trend?: 'up' | 'down' | undefined;
  /** the rest of the qualifier, shown before the metric's note */
  detail?: string | undefined;
  estimate?: boolean | undefined;
}

const GROWTH = /^(年增|季增|月增|年減|季減|月減)(逾|約|近|超過)?\s*([+＋\-−]?[\d.,]+\s*(?:%|％|倍|億美元|億元)?)\s*[；;，,]?\s*(.*)$/;

/**
 * Split a keyMetric value such as 「1,434 億美元，年增 43%」 or 「890 億美元（年增 117%）」 into a
 * short headline number and its qualifier, so the big number never wraps mid-phrase. Growth turns
 * into a Stat delta; a leading 「估計」 marks the value as an estimate. Lists (「；」「、」) and
 * ranges stay whole.
 */
export function splitMetricValue(raw: string): MetricParts {
  const v = raw.trim();
  let value = v;
  let rest = '';
  const paren = /^(.+?)\s*[（(]([^（）()]+)[）)]$/.exec(v);
  const comma = /^(.+?)，\s*((?:年增|季增|月增|年減|季減|月減).+)$/.exec(v);
  if (paren && [...paren[1]!].length >= 2) [value, rest] = [paren[1]!.trim(), paren[2]!.trim()];
  else if (comma && [...comma[1]!].length >= 2) [value, rest] = [comma[1]!.trim(), comma[2]!.trim()];
  if (!rest) return { value };
  const out: MetricParts = { value };
  if (/^估計/.test(rest)) {
    out.estimate = true;
    rest = rest.replace(/^估計[，,；;\s]*/, '');
  }
  const g = GROWTH.exec(rest);
  if (g) {
    const down = /減/.test(g[1]!);
    const num = g[3]!.replace(/^[+＋\-−]/, '');
    out.delta = `${down ? '−' : '+'}${num}`;
    out.deltaLabel = `${g[1]}${g[2] ?? ''}`;
    out.trend = down ? 'down' : 'up';
    rest = g[4]?.trim() ?? '';
  }
  if (rest) out.detail = rest;
  return out;
}

// ───────────── sources ─────────────
/**
 * Concatenate source lists, keeping the first list's order (so <Cite> numbers stay stable) and
 * dropping later duplicates by URL. Keys that would collide are removed from the later copies.
 */
export function mergeSources(...lists: ReadonlyArray<readonly SourceT[] | undefined>): SourceT[] {
  const out: SourceT[] = [];
  const urls = new Set<string>();
  const keys = new Set<string>();
  for (const list of lists) {
    for (const s of list ?? []) {
      if (!s?.url || urls.has(s.url)) continue;
      urls.add(s.url);
      if (s.key && keys.has(s.key)) {
        const { key: _drop, ...rest } = s;
        out.push(rest as SourceT);
        continue;
      }
      if (s.key) keys.add(s.key);
      out.push(s);
    }
  }
  return out;
}

// ───────────── segment view (entry + fallbacks) ─────────────
export interface SegmentView {
  id: SegmentId;
  meta: SegmentMeta;
  layer: LayerMeta;
  entry: SegmentEntry | undefined;
  title: string;
  titleEn: string;
  tagline: string;
  description: string;
  order: number;
  upstream: SegmentId[];
  downstream: SegmentId[];
  scene: { id: string; variant?: string | undefined };
  concentration: string | undefined;
  bottleneck: { level: number; note: string } | undefined;
  taiwanRole: string | undefined;
  keyMetrics: NonNullable<SegmentEntry['data']['keyMetrics']>;
  marketSize: NonNullable<SegmentEntry['data']['marketSize']>;
  relatedLearn: string[];
  relatedTrends: string[];
  scopeIncludes: string[];
  scopeExcludes: string[];
  sources: SourceT[];
  lastVerified: string | undefined;
}

const ids = (list: ReadonlyArray<{ id: string }> | undefined): string[] => (list ?? []).map((r) => r.id);

export async function getSegmentView(id: SegmentId): Promise<SegmentView> {
  const meta = segmentMeta(id)!;
  const entry = (await getSegmentEntries()).get(id);
  const d = entry?.data;
  const nb = fallbackNeighbours(id);
  const segIds = (list: ReadonlyArray<{ id: string }> | undefined, fb: SegmentId[]): SegmentId[] =>
    list ? ids(list).filter(isSegmentId) : fb;
  return {
    id,
    meta,
    layer: layerMeta(d?.layer ?? meta.layer)!,
    entry,
    title: d?.title ?? meta.title,
    titleEn: d?.titleEn ?? meta.titleEn,
    tagline: d?.tagline ?? FALLBACK_TAGLINES[id],
    description: d?.description ?? `${meta.title}：${FALLBACK_TAGLINES[id]}。本頁整理這一環的角色、關鍵公司與台灣廠商。`,
    order: d?.order ?? meta.order,
    upstream: segIds(d?.upstream, nb.upstream),
    downstream: segIds(d?.downstream, nb.downstream),
    scene: d?.scene ?? FALLBACK_SCENES[id],
    concentration: d?.concentration,
    bottleneck: d?.bottleneck,
    taiwanRole: d?.taiwanRole,
    keyMetrics: d?.keyMetrics ?? [],
    marketSize: d?.marketSize ?? [],
    relatedLearn: ids(d?.relatedLearn),
    relatedTrends: ids(d?.relatedTrends),
    scopeIncludes: d?.scope?.includes ?? [],
    scopeExcludes: d?.scope?.excludes ?? [],
    sources: (d?.sources ?? []) as SourceT[],
    lastVerified: d?.lastVerified,
  };
}

export async function getAllSegmentViews(): Promise<SegmentView[]> {
  return Promise.all(SEGMENTS.map((s) => getSegmentView(s.id)));
}

/** Layers bottom → top with their segments. */
export function layersWithSegments(): Array<LayerMeta & { segs: SegmentMeta[] }> {
  return LAYERS.map((l) => ({ ...l, segs: SEGMENTS.filter((s) => s.layer === l.id) }));
}

// ───────────── Taiwan ─────────────
/** Roster companies in Taiwan that take part in a segment (primary or secondary). */
export function taiwanCompaniesIn(id: SegmentId): RosterCompany[] {
  return getRoster().filter((c) => c.region === 'TW' && (c.segment === id || c.secondarySegments?.includes(id)));
}

// ───────────── market size grouping ─────────────
export type MarketRow = SegmentView['marketSize'][number];
export interface MarketGroup {
  /** short label from the definition, e.g. 「全球晶圓代工營收」 */
  title: string;
  rows: MarketRow[];
  unit: string;
  currency: string;
}

function head(def: string): string {
  const flat = def.replace(/（[^）]*）|\([^)]*\)/g, '');
  // A digit-group comma (「1,300」) is not a clause break.
  return (flat.split(/[（(，；;。：:]|,(?!\d)/)[0] ?? flat).trim();
}

/** Longest common substring length (short strings only). */
function lcs(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  let best = 0;
  const prev = new Array<number>(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    let diag = 0;
    for (let j = 1; j <= B.length; j++) {
      const tmp = prev[j]!;
      prev[j] = A[i - 1] === B[j - 1] ? diag + 1 : 0;
      if (prev[j]! > best) best = prev[j]!;
      diag = tmp;
    }
  }
  return best;
}

/**
 * Split a segment's marketSize rows into coherent series: rows join the same group when they share
 * unit and currency, their definitions clearly describe the same market (one heading is a prefix of
 * the other or they share ≥ 5 consecutive characters), and the group would not get the same year
 * twice. Groups keep the authored order; rows inside a group are sorted by year.
 */
export function groupMarketSize(rows: readonly MarketRow[]): MarketGroup[] {
  const groups: Array<{ heads: string[]; rows: MarketRow[]; unit: string; currency: string }> = [];
  for (const r of rows) {
    const h = head(r.definition);
    const g = groups.find(
      (g) =>
        g.unit === r.unit &&
        g.currency === r.currency &&
        !g.rows.some((x) => x.year === r.year) &&
        g.heads.some((gh) => gh.startsWith(h) || h.startsWith(gh) || lcs(gh, h) >= 5),
    );
    if (g) {
      g.rows.push(r);
      if (!g.heads.includes(h)) g.heads.push(h);
    } else groups.push({ heads: [h], rows: [r], unit: r.unit, currency: r.currency });
  }
  return groups.map((g) => ({
    title: g.heads.reduce((a, b) => ([...b].length < [...a].length ? b : a)),
    rows: [...g.rows].sort((a, b) => a.year - b.year),
    unit: g.unit,
    currency: g.currency,
  }));
}

export const MARKET_STATUS: Record<string, string> = { actual: '實際', estimate: '估計', forecast: '預測' };

/** Value of a market-size row in 億 of its currency (billion × 10, million ÷ 100). */
export function marketValueYi(r: MarketRow): number {
  return r.unit === 'billion' ? r.value * 10 : r.value / 100;
}

export function marketUnitLabel(currency: string): string {
  return currency === 'USD' ? '億美元' : currency === 'TWD' ? '新台幣億元' : `億（${currency}）`;
}

/** The segments a page links to, as metadata (unknown ids dropped). */
export function segmentMetas(list: readonly string[]): SegmentMeta[] {
  return list.map((s) => segmentMeta(s)).filter((s): s is SegmentMeta => !!s);
}

/** Roster `status` other than active. */
export const STATUS_LABELS: Record<string, string> = {
  acquired: '已被收購',
  merged: '已合併',
  defunct: '已停止營運',
};
