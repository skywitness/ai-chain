// Build-time data for the reference pages (/glossary/, /sources/, /about/).
// Everything here tolerates missing collection entries: registries (glossary-index, curriculum,
// roster, models-index, trends-index) fill the gaps. Owner: pages-reference agent.
import type { MarkdownHeading } from 'astro';
import type { AstroComponentFactory } from 'astro/runtime/server/index.js';
import { render } from 'astro:content';
import { GLOSSARY_CATEGORIES, type SourceT } from '../../schemas/common';
import {
  getCurriculum,
  getCurriculumArticle,
  getGlossaryIndex,
  getModelFamily,
  getModelsIndex,
  getRoster,
  getTrendsIndex,
  getRosterCompany,
  getTrendIndexEntry,
  safeCollection,
  safeEntry,
  segmentMeta,
  SEGMENTS,
  type Level,
  type SegmentMeta,
} from '../../lib/collections';
import { DATA_DATE } from '../../lib/seo';
import {
  companyHref,
  glossaryHref,
  learnHref,
  modelHref,
  ROUTES,
  segmentHref,
  trendHref,
  withBase,
} from '../../lib/paths';

type Ref = string | { id: string };
const idOf = (r: Ref): string => (typeof r === 'string' ? r : r.id);
const refIds = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((x) => x && (typeof x === 'string' || typeof x.id === 'string')).map(idOf) : [];

// ───────────────────────── Glossary categories ─────────────────────────
export type GlossaryCategory = (typeof GLOSSARY_CATEGORIES)[number];

export interface CategoryMeta {
  id: GlossaryCategory;
  zh: string;
  en: string;
  blurb: string;
}

const CATEGORY_TEXT: Record<GlossaryCategory, Omit<CategoryMeta, 'id'>> = {
  'ai-basics': { zh: 'AI 基礎概念', en: 'AI Basics', blurb: '機器學習、神經網路與 AI 的基本詞彙。' },
  llm: { zh: '大型語言模型', en: 'Large Language Models', blurb: 'Token、Transformer、推理模型與 Agent 等模型相關名詞。' },
  training: { zh: '模型訓練', en: 'Training', blurb: '預訓練、微調、資料與擴展定律。' },
  inference: { zh: '推論與部署', en: 'Inference', blurb: '模型上線後的推論、延遲、成本與服務方式。' },
  hardware: { zh: 'AI 晶片與硬體', en: 'AI Hardware', blurb: 'GPU、ASIC、加速器架構與系統規格。' },
  semiconductor: { zh: '半導體製程', en: 'Semiconductors', blurb: '晶圓、製程節點、微影與設備材料。' },
  packaging: { zh: '先進封裝', en: 'Advanced Packaging', blurb: 'CoWoS、SoIC、中介層與基板。' },
  memory: { zh: '記憶體與儲存', en: 'Memory & Storage', blurb: 'DRAM、HBM、NAND 與記憶體階層。' },
  networking: { zh: '網路與光通訊', en: 'Networking & Optics', blurb: '機櫃內外的互連、交換器與光模組。' },
  datacenter: { zh: '資料中心', en: 'Data Centers', blurb: '機房、散熱、供電與營運指標。' },
  energy: { zh: '能源與電力', en: 'Energy & Power', blurb: '電網、發電、儲能與 AI 的用電需求。' },
  'cloud-business': { zh: '雲端與商業模式', en: 'Cloud & Business', blurb: '雲端服務、資本支出與 AI 的商業指標。' },
  policy: { zh: '政策與地緣政治', en: 'Policy & Geopolitics', blurb: '出口管制、產業政策與 AI 治理。' },
  robotics: { zh: '機器人與實體 AI', en: 'Robotics & Physical AI', blurb: '機器人、自駕車與邊緣裝置。' },
};

export const GLOSSARY_CATEGORY_LIST: readonly CategoryMeta[] = GLOSSARY_CATEGORIES.map((id) => ({
  id,
  ...CATEGORY_TEXT[id],
}));

export function categoryMeta(id: string | undefined): CategoryMeta | undefined {
  return GLOSSARY_CATEGORY_LIST.find((c) => c.id === id);
}

// ───────────────────────── Link targets (backlinks, bibliography) ─────────────────────────
export type PageKind = 'learn' | 'segment' | 'company' | 'financials' | 'model' | 'trend' | 'glossary' | 'page';

export const PAGE_KIND_LABELS: Record<PageKind, string> = {
  learn: '學習',
  segment: '環節',
  company: '公司',
  financials: '財務',
  model: '模型',
  trend: '趨勢',
  glossary: '名詞',
  page: '頁面',
};

const KIND_ORDER: Record<PageKind, number> = {
  learn: 0,
  segment: 1,
  trend: 2,
  model: 3,
  company: 4,
  financials: 5,
  glossary: 6,
  page: 7,
};

export interface PageLink {
  /** unique key, e.g. 'learn:what-is-ai' */
  key: string;
  kind: PageKind;
  label: string;
  href: string;
  /** sort key inside a kind */
  order: number;
}

/** Singleton pages (pages collection) → the route that renders them. */
const PAGE_ROUTES: Record<string, { label: string; path: string }> = {
  home: { label: '首頁', path: ROUTES.home },
  chain: { label: '產業鏈總覽', path: ROUTES.chain },
  taiwan: { label: '台灣 AI 供應鏈', path: ROUTES.taiwan },
  methodology: { label: '資料來源與研究方法', path: ROUTES.sources },
  about: { label: '關於本站', path: ROUTES.about },
  'models-intro': { label: '大模型特性分析', path: ROUTES.models },
  'learn-intro': { label: '學習路徑', path: ROUTES.learn },
};

export function sortLinks(list: Iterable<PageLink>): PageLink[] {
  return [...list].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.order - b.order || a.label.localeCompare(b.label, 'zh-Hant'),
  );
}

// ───────────────────────── Raw corpus (all collections, loaded once per build) ─────────────────────────
interface CorpusItem {
  link: PageLink;
  collection: 'learn' | 'segments' | 'companies' | 'financials' | 'models' | 'trends' | 'glossary' | 'pages';
  id: string;
  data: Record<string, any>;
  body: string;
}

let corpusPromise: Promise<CorpusItem[]> | null = null;
let corpusAt = 0;

async function loadCorpus(): Promise<CorpusItem[]> {
  const out: CorpusItem[] = [];
  const curriculumOrder = new Map(getCurriculum().articles.map((a) => [a.slug, a.order]));

  for (const e of await safeCollection('learn')) {
    const d = e.data as Record<string, any>;
    out.push({
      collection: 'learn',
      id: e.id,
      data: d,
      body: e.body ?? '',
      link: { key: `learn:${e.id}`, kind: 'learn', label: d.title ?? e.id, href: learnHref(e.id), order: d.order ?? curriculumOrder.get(e.id) ?? 999 },
    });
  }
  for (const e of await safeCollection('segments')) {
    const d = e.data as Record<string, any>;
    const meta = segmentMeta(e.id);
    out.push({
      collection: 'segments',
      id: e.id,
      data: d,
      body: e.body ?? '',
      link: { key: `segment:${e.id}`, kind: 'segment', label: d.title ?? meta?.title ?? e.id, href: segmentHref(e.id), order: d.order ?? meta?.order ?? 99 },
    });
  }
  for (const e of await safeCollection('trends')) {
    const d = e.data as Record<string, any>;
    out.push({
      collection: 'trends',
      id: e.id,
      data: d,
      body: e.body ?? '',
      link: { key: `trend:${e.id}`, kind: 'trend', label: d.title ?? getTrendIndexEntry(e.id)?.title ?? e.id, href: trendHref(e.id), order: 0 },
    });
  }
  for (const e of await safeCollection('models')) {
    const d = e.data as Record<string, any>;
    out.push({
      collection: 'models',
      id: e.id,
      data: d,
      body: e.body ?? '',
      link: { key: `model:${e.id}`, kind: 'model', label: d.title ?? getModelFamily(e.id)?.title ?? e.id, href: modelHref(e.id), order: 0 },
    });
  }
  for (const e of await safeCollection('companies')) {
    const d = e.data as Record<string, any>;
    out.push({
      collection: 'companies',
      id: e.id,
      data: d,
      body: e.body ?? '',
      link: { key: `company:${e.id}`, kind: 'company', label: d.nameZh ?? d.name ?? e.id, href: companyHref(e.id), order: d.tier ?? 3 },
    });
  }
  for (const e of await safeCollection('financials')) {
    const d = e.data as Record<string, any>;
    const cid = d.company ? idOf(d.company) : e.id;
    const r = getRosterCompany(cid);
    out.push({
      collection: 'financials',
      id: e.id,
      data: d,
      body: '',
      link: { key: `company:${cid}`, kind: 'company', label: r?.nameZh ?? r?.name ?? cid, href: companyHref(cid), order: r?.tier ?? 3 },
    });
  }
  for (const e of await safeCollection('glossary')) {
    const d = e.data as Record<string, any>;
    out.push({
      collection: 'glossary',
      id: e.id,
      data: d,
      body: '',
      link: { key: `glossary:${e.id}`, kind: 'glossary', label: d.term ?? e.id, href: glossaryHref(e.id), order: 0 },
    });
  }
  for (const e of await safeCollection('pages')) {
    const d = e.data as Record<string, any>;
    const route = PAGE_ROUTES[e.id];
    if (!route) continue; // a singleton without a public route
    out.push({
      collection: 'pages',
      id: e.id,
      data: d,
      body: e.body ?? '',
      link: { key: `page:${e.id}`, kind: 'page', label: route.label, href: withBase(route.path), order: 0 },
    });
  }
  return out;
}

/** All collections, cached for the build (refreshed after 15 s in dev so edits show up). */
function corpus(): Promise<CorpusItem[]> {
  const now = Date.now();
  if (!corpusPromise || (import.meta.env.DEV && now - corpusAt > 15000)) {
    corpusAt = now;
    corpusPromise = loadCorpus();
  }
  return corpusPromise;
}

// ───────────────────────── Glossary terms ─────────────────────────
export interface TermRef {
  id: string;
  label: string;
  href: string;
}

export interface GlossaryTermView {
  id: string;
  term: string;
  zh?: string | undefined;
  en?: string | undefined;
  aliases: string[];
  category: GlossaryCategory | 'other';
  level: Level;
  short?: string | undefined;
  definition?: string | undefined;
  example?: string | undefined;
  related: TermRef[];
  learnMore: TermRef[];
  segments: SegmentMeta[];
  sources: SourceT[];
  /** true when src/content/glossary/<id>.yaml exists */
  hasEntry: boolean;
  status?: string | undefined;
  backlinks: PageLink[];
}

const TERM_RE = /<Term\b[^>]*?\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*["']([^"']+)["']\s*\})/g;

/** Glossary ids used as <Term id> in an MDX body. */
export function termIdsInBody(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(TERM_RE)) {
    const id = m[1] ?? m[2] ?? m[3];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** termId → pages that use it (frontmatter glossary lists and <Term> in MDX bodies). */
export async function glossaryBacklinks(): Promise<Map<string, PageLink[]>> {
  const map = new Map<string, Map<string, PageLink>>();
  const add = (termId: string, link: PageLink) => {
    let m = map.get(termId);
    if (!m) map.set(termId, (m = new Map()));
    if (!m.has(link.key)) m.set(link.key, link);
  };
  for (const item of await corpus()) {
    if (item.collection === 'glossary' || item.collection === 'financials') continue;
    const ids = new Set<string>([...refIds(item.data.glossary), ...termIdsInBody(item.body)]);
    if (item.collection === 'companies') {
      for (const t of (item.data.technologies ?? []) as Array<{ glossary?: unknown }>) {
        for (const g of refIds(t?.glossary)) ids.add(g);
      }
    }
    for (const id of ids) add(id, item.link);
  }
  const out = new Map<string, PageLink[]>();
  for (const [id, m] of map) out.set(id, sortLinks(m.values()));
  return out;
}


/** Every glossary term: the index rows (complete registry) merged with the collection entries. */
export async function getGlossaryTerms(): Promise<GlossaryTermView[]> {
  const index = getGlossaryIndex();
  const entries = new Map((await safeCollection('glossary')).map((e) => [e.id, e.data as Record<string, any>]));
  const backlinks = await glossaryBacklinks();

  // Display names for related-term links (entry first, then index)
  const label = new Map<string, string>();
  for (const row of index) label.set(row.id, row.term ?? row.zh ?? row.en ?? row.id);
  for (const [id, d] of entries) label.set(id, d.term ?? label.get(id) ?? id);

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of index) if (!seen.has(row.id)) (seen.add(row.id), ids.push(row.id));
  for (const id of entries.keys()) if (!seen.has(id)) (seen.add(id), ids.push(id));
  const indexMap = new Map(index.map((r) => [r.id, r]));

  const terms: GlossaryTermView[] = [];
  for (const id of ids) {
    const row = indexMap.get(id);
    const d = entries.get(id);
    const term = (d?.term ?? row?.term ?? row?.zh ?? row?.en ?? id) as string;
    const rawCat = (d?.category ?? row?.category) as string | undefined;
    const category = (categoryMeta(rawCat)?.id ?? 'other') as GlossaryTermView['category'];
    const lvRaw = Number(d?.level ?? row?.level ?? 1);
    const level = (lvRaw >= 1 && lvRaw <= 3 ? lvRaw : 1) as Level;
    const aliases = ((d?.aliases ?? row?.aliases ?? []) as string[]).filter((a) => typeof a === 'string');

    const related: TermRef[] = refIds(d?.related)
      .filter((r) => r !== id && label.has(r))
      .map((r) => ({ id: r, label: label.get(r) ?? r, href: `#${r}` }));
    const learnMore: TermRef[] = refIds(d?.learnMore)
      .map((slug) => {
        const a = getCurriculumArticle(slug);
        return a ? { id: slug, label: a.title, href: learnHref(slug) } : undefined;
      })
      .filter((x): x is TermRef => !!x);
    const segments = refIds(d?.segments)
      .map((s) => segmentMeta(s))
      .filter((s): s is SegmentMeta => !!s);

    const zh = (d?.zh ?? row?.zh) as string | undefined;
    const en = (d?.en ?? row?.en) as string | undefined;
    const short = (d?.short ?? row?.short) as string | undefined;
    terms.push({
      id,
      term,
      zh,
      en,
      aliases,
      category,
      level,
      short,
      definition: d?.definition,
      example: d?.example,
      related,
      learnMore,
      segments,
      sources: Array.isArray(d?.sources) ? (d!.sources as SourceT[]) : [],
      hasEntry: !!d,
      status: d?.editorial?.status,
      backlinks: backlinks.get(id) ?? [],
    });
  }
  return terms;
}

export interface CategoryGroup extends Omit<CategoryMeta, 'id'> {
  id: GlossaryCategory | 'other';
  terms: GlossaryTermView[];
}

/** Terms grouped by category (schema order), each group sorted by level then display name. */
export function groupTerms(terms: readonly GlossaryTermView[]): CategoryGroup[] {
  const groups: CategoryGroup[] = GLOSSARY_CATEGORY_LIST.map((c) => ({ ...c, terms: [] }));
  const other: CategoryGroup = { id: 'other', zh: '其他', en: 'Other', blurb: '尚未分類的名詞。', terms: [] };
  for (const t of terms) (groups.find((g) => g.id === t.category) ?? other).terms.push(t);
  const all = other.terms.length ? [...groups, other] : groups;
  for (const g of all) g.terms.sort((a, b) => a.level - b.level || a.term.localeCompare(b.term, 'zh-Hant'));
  return all.filter((g) => g.terms.length > 0);
}

// ───────────────────────── Bibliography ─────────────────────────
export interface BibEntry {
  url: string;
  title: string;
  publisher: string;
  type: string;
  lang: string;
  published?: string | undefined;
  accessed?: string | undefined;
  citedBy: PageLink[];
}

export interface PublisherGroup {
  publisher: string;
  /** slug-ish anchor id */
  anchor: string;
  entries: BibEntry[];
  citations: number;
}

export interface Bibliography {
  groups: PublisherGroup[];
  totalSources: number;
  totalCitations: number;
  byType: Array<{ type: string; count: number }>;
  byLang: Array<{ lang: string; count: number }>;
  pagesWithSources: number;
}

function normUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = '';
    x.hostname = x.hostname.toLowerCase().replace(/^www\./, '');
    let s = x.href.replace(/^http:/, 'https:');
    if (s.endsWith('/') && x.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return u.trim();
  }
}

function isSource(x: unknown): x is SourceT {
  return !!x && typeof x === 'object' && typeof (x as SourceT).url === 'string' && typeof (x as SourceT).title === 'string';
}

/** Every Source object found in one entry's data (top-level and nested). */
function sourcesOf(item: CorpusItem): SourceT[] {
  const d = item.data;
  const out: SourceT[] = [];
  const push = (s: unknown) => {
    if (isSource(s)) out.push(s);
  };
  const each = (list: unknown, pick: (x: any) => unknown) => {
    if (Array.isArray(list)) for (const x of list) push(pick(x));
  };
  if (item.collection === 'financials') {
    if (d.sources && typeof d.sources === 'object') for (const s of Object.values(d.sources)) push(s);
    return out;
  }
  each(d.sources, (x) => x);
  each(d.keyMetrics, (x) => x?.source);
  each(d.marketSize, (x) => x?.source);
  each(d.products, (x) => x?.source);
  each(d.technologies, (x) => x?.source);
  each(d.timeline, (x) => x?.source);
  each(d.relationships, (x) => x?.source);
  each(d.funding, (x) => x?.source);
  each(d.signals, (x) => x?.source);
  push(d.employees?.source);
  if (Array.isArray(d.versions)) {
    for (const v of d.versions) {
      each(v?.pricing, (x) => x?.source);
      each(v?.benchmarks, (x) => x?.source);
    }
  }
  return out;
}

const later = (a?: string, b?: string) => (!a ? b : !b ? a : a > b ? a : b);

function publisherKey(p: string): string {
  return p.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function getBibliography(): Promise<Bibliography> {
  const byUrl = new Map<string, BibEntry & { linkKeys: Set<string> }>();
  const typeCount = new Map<string, number>();
  const langCount = new Map<string, number>();
  let totalCitations = 0;
  const pages = new Set<string>();

  for (const item of await corpus()) {
    const list = sourcesOf(item);
    if (list.length) pages.add(item.link.key);
    for (const s of list) {
      totalCitations++;
      const key = normUrl(s.url);
      let e = byUrl.get(key);
      if (!e) {
        e = {
          url: s.url,
          title: s.title,
          publisher: (s.publisher ?? '').trim() || '未標示發布者',
          type: s.type ?? 'other',
          lang: s.lang ?? 'en',
          published: s.published,
          accessed: s.accessed,
          citedBy: [],
          linkKeys: new Set(),
        };
        byUrl.set(key, e);
        typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + 1);
        langCount.set(e.lang, (langCount.get(e.lang) ?? 0) + 1);
      } else {
        e.accessed = later(e.accessed, s.accessed);
        e.published ??= s.published;
      }
      if (!e.linkKeys.has(item.link.key)) {
        e.linkKeys.add(item.link.key);
        e.citedBy.push(item.link);
      }
    }
  }

  const groupsMap = new Map<string, PublisherGroup>();
  for (const e of byUrl.values()) {
    const k = publisherKey(e.publisher);
    let g = groupsMap.get(k);
    if (!g) groupsMap.set(k, (g = { publisher: e.publisher, anchor: '', entries: [], citations: 0 }));
    const { linkKeys: _drop, ...entry } = e;
    entry.citedBy = sortLinks(entry.citedBy);
    g.entries.push(entry);
    g.citations += entry.citedBy.length;
  }
  const groups = [...groupsMap.values()].sort(
    (a, b) => b.entries.length - a.entries.length || b.citations - a.citations || a.publisher.localeCompare(b.publisher, 'zh-Hant'),
  );
  groups.forEach((g, i) => {
    g.anchor = `pub-${i + 1}`;
    g.entries.sort((a, b) => b.citedBy.length - a.citedBy.length || (b.published ?? '').localeCompare(a.published ?? '') || a.title.localeCompare(b.title));
  });
  const sortCount = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    groups,
    totalSources: byUrl.size,
    totalCitations,
    byType: sortCount(typeCount).map(([type, count]) => ({ type, count })),
    byLang: sortCount(langCount).map(([lang, count]) => ({ lang, count })),
    pagesWithSources: pages.size,
  };
}

// ───────────────────────── Freshness and editorial status ─────────────────────────
export const COLLECTION_LABELS = {
  learn: '學習文章',
  segments: '產業鏈環節',
  companies: '公司檔案',
  financials: '財務資料',
  models: '模型系列',
  trends: '趨勢分析',
  glossary: '名詞解釋',
  pages: '單頁內容',
} as const;
export type ReportCollection = keyof typeof COLLECTION_LABELS;

export const STALE_DAYS = 180;
export const AGE_BUCKETS = [
  { id: 'fresh', label: '30 天內', max: 30 },
  { id: 'recent', label: '31–90 天', max: 90 },
  { id: 'aging', label: '91–180 天', max: 180 },
  { id: 'stale', label: '超過 180 天', max: Infinity },
] as const;
export type AgeBucketId = (typeof AGE_BUCKETS)[number]['id'];

function dayNum(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}
export function ageInDays(iso: string, ref = DATA_DATE): number {
  return dayNum(ref) - dayNum(iso);
}

export interface FreshnessRow {
  link: PageLink;
  collection: ReportCollection;
  lastVerified: string;
  age: number;
  stale: boolean;
}

export interface FreshnessSummary {
  collection: ReportCollection;
  label: string;
  count: number;
  newest?: string | undefined;
  oldest?: string | undefined;
  buckets: Record<AgeBucketId, number>;
  stale: number;
}

export interface FreshnessReport {
  reference: string;
  summaries: FreshnessSummary[];
  /** all entries older than STALE_DAYS, oldest first */
  stale: FreshnessRow[];
  /** the oldest entries overall (includes stale ones), oldest first */
  oldest: FreshnessRow[];
  total: number;
}

const DATED: ReportCollection[] = ['learn', 'segments', 'companies', 'financials', 'models', 'trends'];

export async function getFreshness(limit = 12): Promise<FreshnessReport> {
  const items = await corpus();
  const rows: FreshnessRow[] = [];
  const summaries: FreshnessSummary[] = [];
  for (const col of DATED) {
    const list = items.filter((i) => i.collection === col);
    const s: FreshnessSummary = {
      collection: col,
      label: COLLECTION_LABELS[col],
      count: 0,
      buckets: { fresh: 0, recent: 0, aging: 0, stale: 0 },
      stale: 0,
    };
    for (const i of list) {
      const lv = typeof i.data.lastVerified === 'string' ? i.data.lastVerified : undefined;
      if (!lv) continue;
      const age = ageInDays(lv);
      const bucket = AGE_BUCKETS.find((b) => age <= b.max)!;
      s.count++;
      s.buckets[bucket.id]++;
      s.newest = later(s.newest, lv);
      s.oldest = !s.oldest || lv < s.oldest ? lv : s.oldest;
      const label = col === 'financials' ? `${i.link.label}（財務）` : i.link.label;
      const row: FreshnessRow = { link: { ...i.link, label, kind: col === 'financials' ? 'financials' : i.link.kind }, collection: col, lastVerified: lv, age, stale: age > STALE_DAYS };
      if (row.stale) s.stale++;
      rows.push(row);
    }
    summaries.push(s);
  }
  rows.sort((a, b) => b.age - a.age || a.link.label.localeCompare(b.link.label, 'zh-Hant'));
  return {
    reference: DATA_DATE,
    summaries,
    stale: rows.filter((r) => r.stale),
    oldest: rows.slice(0, limit),
    total: rows.length,
  };
}

export const STATUS_ORDER = ['fact-checked', 'researched', 'draft', 'stub'] as const;
export type EditorialStatus = (typeof STATUS_ORDER)[number];
export const STATUS_LABELS: Record<EditorialStatus, string> = {
  'fact-checked': '已查核',
  researched: '已調研',
  draft: '草稿',
  stub: '待補',
};

export interface StatusRow {
  collection: ReportCollection;
  label: string;
  total: number;
  counts: Record<EditorialStatus, number>;
}

export async function getEditorialStatus(): Promise<{ rows: StatusRow[]; totals: Record<EditorialStatus, number>; total: number }> {
  const items = await corpus();
  const totals: Record<EditorialStatus, number> = { 'fact-checked': 0, researched: 0, draft: 0, stub: 0 };
  const rows: StatusRow[] = [];
  for (const col of Object.keys(COLLECTION_LABELS) as ReportCollection[]) {
    const counts: Record<EditorialStatus, number> = { 'fact-checked': 0, researched: 0, draft: 0, stub: 0 };
    let total = 0;
    for (const i of items) {
      if (i.collection !== col) continue;
      const st = i.data.editorial?.status as EditorialStatus | undefined;
      if (!st || !(st in counts)) continue;
      counts[st]++;
      totals[st]++;
      total++;
    }
    rows.push({ collection: col, label: COLLECTION_LABELS[col], total, counts });
  }
  return { rows, totals, total: rows.reduce((a, r) => a + r.total, 0) };
}

// ───────────────────────── Site numbers (about page) ─────────────────────────
export interface SiteNumbers {
  segments: number;
  rosterCompanies: number;
  companyProfiles: number;
  financials: number;
  learnArticles: number;
  modelFamilies: number;
  trends: number;
  glossaryTerms: number;
}

export async function getSiteNumbers(): Promise<SiteNumbers> {
  const items = await corpus();
  const count = (c: CorpusItem['collection']) => items.filter((i) => i.collection === c).length;
  return {
    segments: SEGMENTS.length,
    rosterCompanies: getRoster().length,
    companyProfiles: count('companies'),
    financials: count('financials'),
    learnArticles: Math.max(getCurriculum().articles.length, count('learn')),
    modelFamilies: Math.max(getModelsIndex().length, count('models')),
    trends: Math.max(getTrendsIndex().length, count('trends')),
    glossaryTerms: Math.max(getGlossaryIndex().length, count('glossary')),
  };
}

// ───────────────────────── Labels shared by the pages ─────────────────────────
export const SOURCE_TYPE_LABELS: Record<string, string> = {
  filing: '監理申報',
  'annual-report': '年報',
  'ir-presentation': '法說簡報',
  'earnings-call': '法說會',
  'press-release': '新聞稿',
  'monthly-revenue': '月營收公告',
  'company-site': '公司網站',
  paper: '論文',
  docs: '官方文件',
  standard: '標準文件',
  government: '政府文件',
  dataset: '資料集',
  leaderboard: '排行榜',
  news: '新聞',
  analyst: '研究報告',
  book: '書籍',
  other: '其他',
};

export const LANG_LABELS: Record<string, string> = {
  'zh-TW': '繁體中文',
  'zh-CN': '簡體中文',
  en: '英文',
  ja: '日文',
  ko: '韓文',
  de: '德文',
  fr: '法文',
  other: '其他語言',
};

export const REGISTRY_KIND_LABELS: Record<string, { zh: string; blurb: string }> = {
  'company-ir': { zh: '公司投資人關係', blurb: '財報、法說會與新聞稿等一手公司資訊。' },
  regulator: { zh: '監理機關', blurb: '證券主管機關的申報系統與公告。' },
  exchange: { zh: '證券交易所', blurb: '上市資訊、月營收與重大訊息。' },
  government: { zh: '政府機關', blurb: '產業政策、出口管制與統計資料。' },
  'standards-body': { zh: '標準組織', blurb: '技術規格與產業標準。' },
  'research-lab': { zh: '研究實驗室', blurb: 'AI 實驗室的技術報告、模型卡與官方部落格。' },
  academic: { zh: '學術論文', blurb: '經同儕審查或公開發表的研究。' },
  media: { zh: '新聞媒體', blurb: '產業與財經新聞，作為補充與交叉查證。' },
  analyst: { zh: '研究機構', blurb: '市場研究與產業分析報告。' },
  dataset: { zh: '資料集', blurb: '可重複取得的公開資料，例如匯率與統計數列。' },
  leaderboard: { zh: '評測排行榜', blurb: '模型評測與第三方排行榜。' },
};

export const RELIABILITY_LABELS: Record<string, string> = {
  primary: '一手來源',
  secondary: '二手來源',
  tertiary: '參考來源',
};

/** Curriculum titles for slugs (used by about/sources prose). */
export function learnTitle(slug: string): string | undefined {
  return getCurriculumArticle(slug)?.title;
}

// ───────────────────────── Singleton page entries (pages collection) ─────────────────────────
export interface LoadedPage {
  data: { title: string; description: string; updated: string; sources: SourceT[]; editorial?: { status?: string } };
  Content: AstroComponentFactory;
  headings: MarkdownHeading[];
  body: string;
}

const CJK = /[⺀-鿿　-〿＀-￯]/;

/** Inline Markdown/MDX → plain text: emphasis, links, code and inline components keep their text. */
function plainInline(md: string): string {
  const lines = md.split(/\r?\n/).map((l) => l.trim());
  // Markdown joins soft line breaks with a space; between two CJK characters that space is dropped.
  let text = lines.reduce((acc, line) => {
    if (!acc) return line;
    const a = acc.at(-1) ?? '';
    const b = line[0] ?? '';
    return CJK.test(a) && CJK.test(b) ? acc + line : `${acc} ${line}`;
  }, '');
  text = text
    .replace(/<([A-Z][\w.]*)\b[^>]*\/>/g, '')
    .replace(/<([A-Z][\w.]*)\b[^>]*>([\s\S]*?)<\/\1>/g, '$2')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '');
  return text.trim();
}

/**
 * The paragraphs of the LAST `## {heading}` section of a raw MDX body, as plain text, so a page can
 * show that section somewhere else (e.g. /about/ moves 「免責聲明」 to the end of the page).
 * Returns undefined when the heading is missing, is not the last H2 section, or the section holds
 * anything but plain paragraphs (lists, tables, quotes, components on their own line).
 */
export function trailingSectionParagraphs(body: string, heading: string): string[] | undefined {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^##[ \\t]+${esc}[ \\t]*#*[ \\t]*$`, 'm').exec(body);
  if (!m) return undefined;
  const rest = body.slice(m.index + m[0].length);
  if (/^#{1,2}[ \t]/m.test(rest)) return undefined;
  const paras = rest
    .split(/\r?\n[ \t]*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paras.length) return undefined;
  if (paras.some((p) => /^(?:[-*+][ \t]|\d+[.)][ \t]|>|\||<[A-Za-z]|\{|import[ \t]|export[ \t]|#{3,6}[ \t])/m.test(p))) return undefined;
  const out = paras.map(plainInline).filter(Boolean);
  return out.length ? out : undefined;
}

/** Render a pages-collection entry (e.g. 'methodology', 'about'); undefined when missing or broken. */
export async function loadPageEntry(id: string): Promise<LoadedPage | undefined> {
  const entry = await safeEntry('pages', id);
  if (!entry) return undefined;
  try {
    const r = await render(entry);
    return {
      data: entry.data as LoadedPage['data'],
      Content: r.Content as AstroComponentFactory,
      headings: r.headings,
      body: entry.body ?? '',
    };
  } catch (err) {
    console.warn(`[reference] could not render pages/${id}: ${(err as Error).message}`);
    return undefined;
  }
}
