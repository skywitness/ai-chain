// Typed build-time getters for registries (YAML under src/data/) and safe wrappers around content
// collections. Server/build-time only (uses node:fs). Owner: design-system agent.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { getCollection, getEntry, type CollectionEntry, type CollectionKey } from 'astro:content';
import { SEGMENT_IDS, type LayerId, type SegmentId } from '../schemas/common';
import type { RosterEntryT } from '../schemas/roster';

export type { SegmentId, LayerId };
export type Level = 1 | 2 | 3;

// ───────────── Static taxonomy (mirrors docs/SEGMENTS.md) ─────────────
export interface SegmentMeta {
  id: SegmentId;
  order: number;
  title: string; // 「晶圓代工與先進封裝」
  titleEn: string;
  short: string; // compact label for chips/legends: 「代工封裝」
  layer: LayerId;
  /** CSS colour expression, e.g. 'var(--seg-foundry-packaging)' */
  color: string;
}

const SEG: ReadonlyArray<Omit<SegmentMeta, 'color'>> = [
  { id: 'energy-power', order: 1, title: '能源與電力', titleEn: 'Energy & Power', short: '能源', layer: 'foundation' },
  { id: 'semi-equipment-materials', order: 2, title: '半導體設備與材料', titleEn: 'Semiconductor Equipment & Materials', short: '設備材料', layer: 'silicon' },
  { id: 'foundry-packaging', order: 3, title: '晶圓代工與先進封裝', titleEn: 'Foundry & Advanced Packaging', short: '代工封裝', layer: 'silicon' },
  { id: 'memory-storage', order: 4, title: '記憶體與儲存', titleEn: 'Memory & Storage', short: '記憶體', layer: 'silicon' },
  { id: 'eda-ip-design', order: 5, title: '晶片設計工具、矽智財與設計服務', titleEn: 'EDA, IP & Design Services', short: '設計工具／IP', layer: 'silicon' },
  { id: 'ai-accelerators', order: 6, title: 'AI 晶片與加速器（GPU／ASIC／CPU）', titleEn: 'AI Accelerators (GPU / ASIC / CPU)', short: 'AI 晶片', layer: 'silicon' },
  { id: 'networking-optics', order: 7, title: '網通與光通訊', titleEn: 'Networking & Optics', short: '網通光通訊', layer: 'systems' },
  { id: 'servers-systems', order: 8, title: '伺服器、系統與關鍵零組件', titleEn: 'Servers, Systems & Components', short: '伺服器', layer: 'systems' },
  { id: 'datacenter-infra', order: 9, title: '資料中心（電力、散熱、營運）', titleEn: 'Data Center Infrastructure', short: '資料中心', layer: 'systems' },
  { id: 'cloud-neocloud', order: 10, title: '雲端與新雲', titleEn: 'Cloud & Neocloud', short: '雲端', layer: 'cloud-models' },
  { id: 'foundation-models', order: 11, title: '基礎模型', titleEn: 'Foundation Models', short: '基礎模型', layer: 'cloud-models' },
  { id: 'devtools-data-mlops', order: 12, title: '開發工具、資料與 MLOps', titleEn: 'Dev Tools, Data & MLOps', short: '工具與 MLOps', layer: 'cloud-models' },
  { id: 'apps-agents', order: 13, title: '應用與 Agent', titleEn: 'Applications & Agents', short: '應用與 Agent', layer: 'applications' },
  { id: 'physical-ai', order: 14, title: '實體 AI（機器人、自駕、邊緣裝置）', titleEn: 'Physical AI (Robotics, AV, Edge)', short: '實體 AI', layer: 'applications' },
];

/** All 14 segments in chain order (bottom → top). */
export const SEGMENTS: readonly SegmentMeta[] = SEG.map((s) => ({ ...s, color: `var(--seg-${s.id})` }));
const SEGMENT_MAP = new Map<string, SegmentMeta>(SEGMENTS.map((s) => [s.id, s]));

export function isSegmentId(id: string): id is SegmentId {
  return (SEGMENT_IDS as readonly string[]).includes(id);
}
/** Segment metadata by id (accepts a content reference too). Returns undefined for unknown ids. */
export function segmentMeta(id: string | { id: string }): SegmentMeta | undefined {
  return SEGMENT_MAP.get(typeof id === 'string' ? id : id.id);
}

export interface LayerMeta {
  id: LayerId;
  order: number;
  title: string;
  titleEn: string;
  color: string;
  segments: SegmentId[];
}
const LAYER_BASE: ReadonlyArray<Omit<LayerMeta, 'color' | 'segments'>> = [
  { id: 'foundation', order: 1, title: '能源基礎', titleEn: 'Foundation' },
  { id: 'silicon', order: 2, title: '晶片與半導體', titleEn: 'Silicon' },
  { id: 'systems', order: 3, title: '系統與基礎設施', titleEn: 'Systems' },
  { id: 'cloud-models', order: 4, title: '雲端與模型', titleEn: 'Cloud & Models' },
  { id: 'applications', order: 5, title: '應用', titleEn: 'Applications' },
];
/** The 5 layers, bottom → top, each with its segments. */
export const LAYERS: readonly LayerMeta[] = LAYER_BASE.map((l) => ({
  ...l,
  color: `var(--layer-${l.id})`,
  segments: SEGMENTS.filter((s) => s.layer === l.id).map((s) => s.id),
}));
export function layerMeta(id: string): LayerMeta | undefined {
  return LAYERS.find((l) => l.id === id);
}

export interface LevelMeta {
  level: Level;
  label: string; // 入門
  labelEn: string;
  color: string;
}
export const LEVELS: readonly LevelMeta[] = [
  { level: 1, label: '入門', labelEn: 'Beginner', color: 'var(--level-1)' },
  { level: 2, label: '進階', labelEn: 'Intermediate', color: 'var(--level-2)' },
  { level: 3, label: '深入', labelEn: 'Advanced', color: 'var(--level-3)' },
];
export function levelMeta(level: number): LevelMeta {
  return LEVELS[Math.min(3, Math.max(1, Math.round(level))) - 1]!;
}

export const TRACK_LABELS = {
  foundations: '基礎概念',
  models: '模型與軟體',
  hardware: '晶片與硬體',
  'infra-business': '基礎設施與商業',
  society: '社會與未來',
} as const;
export type TrackId = keyof typeof TRACK_LABELS;

export const REGION_LABELS: Record<string, string> = {
  TW: '台灣', US: '美國', CN: '中國', JP: '日本', KR: '韓國', EU: '歐洲', UK: '英國', IL: '以色列',
  IN: '印度', CA: '加拿大', ME: '中東', SEA: '東南亞', OTHER: '其他',
};
export const TIER_LABELS: Record<1 | 2 | 3, string> = { 1: '一線', 2: '二線', 3: '三線與新創' };

// ───────────── YAML registry readers (cached; refreshed in dev) ─────────────
const ROOT = process.cwd();
const DEV = import.meta.env.DEV;
const cache = new Map<string, { at: number; value: unknown }>();

function cached<T>(key: string, load: () => T): T {
  const hit = cache.get(key);
  const now = Date.now();
  // In dev, re-read after 1.5 s so edits to registries show up without restarting the server.
  if (hit && (!DEV || now - hit.at < 1500)) return hit.value as T;
  const value = load();
  cache.set(key, { at: now, value });
  return value;
}

function readYaml(rel: string): unknown {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return undefined;
  try {
    return parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`[collections] could not parse ${rel}: ${(err as Error).message}`);
    return undefined;
  }
}

function yamlFilesIn(relDir: string): string[] {
  const dir = join(ROOT, relDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('_'))
    .sort()
    .map((f) => `${relDir}/${f}`);
}

// Roster ---------------------------------------------------------------
export type RosterCompany = RosterEntryT & {
  /** primary segment (= the roster file's `segment`) */
  segment: SegmentId;
};

/** Every company in src/data/roster/*.yaml (one file per primary segment), in file order. */
export function getRoster(): RosterCompany[] {
  return cached('roster', () => {
    const out: RosterCompany[] = [];
    for (const file of yamlFilesIn('src/data/roster')) {
      const doc = readYaml(file) as { segment?: string; companies?: Partial<RosterEntryT>[] } | undefined;
      if (!doc?.segment || !Array.isArray(doc.companies)) continue;
      const segment = doc.segment as SegmentId;
      for (const c of doc.companies) {
        if (!c?.id) continue;
        const e = c as RosterEntryT;
        out.push({
          ...e,
          status: e.status ?? 'active',
          listings: e.listings ?? [],
          stockanalysis: e.stockanalysis ?? null,
          twMonthly: e.twMonthly ?? null,
          secondarySegments: e.secondarySegments ?? [],
          segment,
        });
      }
    }
    return out;
  });
}
export function getRosterMap(): Map<string, RosterCompany> {
  return cached('roster-map', () => new Map(getRoster().map((c) => [c.id, c])));
}
export function getRosterCompany(id: string | { id: string }): RosterCompany | undefined {
  return getRosterMap().get(typeof id === 'string' ? id : id.id);
}

// Curriculum -----------------------------------------------------------
export interface CurriculumArticle {
  order: number;
  slug: string;
  level: Level;
  track: TrackId;
  title: string;
  prereqs: string[];
  /** 'scene-id:variant' or null */
  scene: string | null;
}
export interface CurriculumPath {
  id: string;
  title: string;
  slugs: string[];
}
export interface Curriculum {
  tracks: Record<string, string>;
  paths: CurriculumPath[];
  articles: CurriculumArticle[];
}
/** src/data/curriculum.yaml: articles sorted by `order`. */
export function getCurriculum(): Curriculum {
  return cached('curriculum', () => {
    const doc = (readYaml('src/data/curriculum.yaml') ?? {}) as Partial<Curriculum>;
    return {
      tracks: doc.tracks ?? { ...TRACK_LABELS },
      paths: doc.paths ?? [],
      articles: [...(doc.articles ?? [])].sort((a, b) => a.order - b.order),
    };
  });
}
export function getCurriculumArticle(slug: string | { id: string }): CurriculumArticle | undefined {
  const s = typeof slug === 'string' ? slug : slug.id;
  return getCurriculum().articles.find((a) => a.slug === s);
}

// Models index ----------------------------------------------------------
export interface ModelFamilyIndex {
  id: string;
  title: string;
  lab?: string;
  labUnit?: string;
  labName?: string;
  origin: string;
  kind: string;
}
/** src/data/models-index.yaml → families */
export function getModelsIndex(): ModelFamilyIndex[] {
  return cached('models-index', () => {
    const doc = readYaml('src/data/models-index.yaml') as { families?: ModelFamilyIndex[] } | undefined;
    return (doc?.families ?? []).filter((f) => f && f.id);
  });
}
export function getModelFamily(id: string | { id: string }): ModelFamilyIndex | undefined {
  const k = typeof id === 'string' ? id : id.id;
  return getModelsIndex().find((f) => f.id === k);
}

// Trends index ----------------------------------------------------------
export interface TrendIndexEntry {
  id: string;
  category: 'hardware' | 'software' | 'market' | 'policy';
  title: string;
}
export const TREND_CATEGORY_LABELS: Record<TrendIndexEntry['category'], string> = {
  hardware: '硬體',
  software: '軟體',
  market: '市場',
  policy: '政策',
};
/** src/data/trends-index.yaml → trends */
export function getTrendsIndex(): TrendIndexEntry[] {
  return cached('trends-index', () => {
    const doc = readYaml('src/data/trends-index.yaml') as { trends?: TrendIndexEntry[] } | undefined;
    return (doc?.trends ?? []).filter((t) => t && t.id);
  });
}
export function getTrendIndexEntry(id: string | { id: string }): TrendIndexEntry | undefined {
  const k = typeof id === 'string' ? id : id.id;
  return getTrendsIndex().find((t) => t.id === k);
}

// Glossary index ----------------------------------------------------------
/** One row of src/data/glossary-index/*.yaml (`terms: [...]`). Only `id` is guaranteed. */
export interface GlossaryIndexEntry {
  id: string;
  term?: string;
  zh?: string;
  en?: string;
  category?: string;
  level?: Level;
  short?: string;
  aliases?: string[];
}
export function getGlossaryIndex(): GlossaryIndexEntry[] {
  return cached('glossary-index', () => {
    const out: GlossaryIndexEntry[] = [];
    for (const file of yamlFilesIn('src/data/glossary-index')) {
      const doc = readYaml(file) as { terms?: GlossaryIndexEntry[]; category?: string } | undefined;
      const fileCategory = doc?.category ?? file.split('/').pop()?.replace(/\.ya?ml$/, '');
      for (const t of doc?.terms ?? []) {
        if (!t?.id) continue;
        out.push(fileCategory && !t.category ? { ...t, category: fileCategory } : t);
      }
    }
    return out;
  });
}
export function getGlossaryIndexEntry(id: string | { id: string }): GlossaryIndexEntry | undefined {
  const k = typeof id === 'string' ? id : id.id;
  return cached('glossary-index-map', () => new Map(getGlossaryIndex().map((t) => [t.id, t]))).get(k);
}

// Benchmarks ----------------------------------------------------------------
export interface BenchmarkDef {
  id: string;
  name?: string;
  [k: string]: unknown;
}
export function getBenchmarks(): BenchmarkDef[] {
  return cached('benchmarks', () => {
    const doc = readYaml('src/data/benchmarks.yaml') as { benchmarks?: BenchmarkDef[] } | undefined;
    return (doc?.benchmarks ?? []).filter((b) => b && b.id);
  });
}

// ───────────── Safe content-collection wrappers ─────────────
/** getCollection() that returns [] instead of throwing when a collection is missing or empty. */
export async function safeCollection<C extends CollectionKey>(
  collection: C,
  filter?: (entry: CollectionEntry<C>) => unknown,
): Promise<CollectionEntry<C>[]> {
  try {
    const list = await getCollection(collection, filter);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** getEntry() that returns undefined instead of throwing. Accepts an id or a reference. */
export async function safeEntry<C extends CollectionKey>(
  collection: C,
  id: string | { id: string },
): Promise<CollectionEntry<C> | undefined> {
  const key = typeof id === 'string' ? id : id.id;
  try {
    const entry = await (getEntry as (c: C, id: string) => Promise<CollectionEntry<C> | undefined>)(collection, key);
    return entry ?? undefined;
  } catch {
    return undefined;
  }
}

/** Resolve many references at once, dropping the ones that do not exist yet. */
export async function safeEntries<C extends CollectionKey>(
  collection: C,
  ids: ReadonlyArray<string | { id: string }>,
): Promise<CollectionEntry<C>[]> {
  const out: CollectionEntry<C>[] = [];
  for (const id of ids) {
    const e = await safeEntry(collection, id);
    if (e) out.push(e);
  }
  return out;
}

// ───────────── Display-name helpers (content entry first, registry fallback) ─────────────
export interface CompanyDisplay {
  id: string;
  name: string; // English / Latin name
  nameZh: string;
  segment: SegmentId | undefined;
  exists: boolean; // true when the id is known in the collection or the roster
  hasPage: boolean; // true when the content entry exists
}
export async function companyDisplay(id: string | { id: string }): Promise<CompanyDisplay> {
  const key = typeof id === 'string' ? id : id.id;
  const entry = await safeEntry('companies', key);
  if (entry) {
    const d = entry.data as { name: string; nameZh: string; primarySegment: { id: string } };
    const seg = d.primarySegment?.id;
    return {
      id: key,
      name: d.name,
      nameZh: d.nameZh,
      segment: seg && isSegmentId(seg) ? seg : undefined,
      exists: true,
      hasPage: true,
    };
  }
  const r = getRosterCompany(key);
  if (r) return { id: key, name: r.name, nameZh: r.nameZh, segment: r.segment, exists: true, hasPage: false };
  return { id: key, name: key, nameZh: key, segment: undefined, exists: false, hasPage: false };
}
