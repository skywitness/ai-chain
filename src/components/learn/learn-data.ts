// Build-time data for the learning-path pages (/learn/ and /learn/<slug>/). Owner: pages-learn agent.
//
// The curriculum registry (src/data/curriculum.yaml) is the spine: every registered article gets a
// card and a page, whether or not its MDX file exists yet. When the `learn` entry exists, its
// frontmatter adds the description, reading time, prerequisites and related ids. Entries that are
// not in the registry (should not happen; validate-data flags them) are appended by `order` so they
// never disappear.
import type { CollectionEntry } from 'astro:content';
import {
  getCurriculum,
  getTrendIndexEntry,
  isSegmentId,
  levelMeta,
  safeCollection,
  segmentMeta,
  TRACK_LABELS,
  type Level,
  type SegmentId,
  type TrackId,
} from '../../lib/collections';
import { sectionHref } from '../../lib/paths';
import { SCENE_IDS, type SceneId } from '../../schemas/common';

export type LearnEntry = CollectionEntry<'learn'>;

/** Same shape as NextSteps' `items` prop (src/components/content/NextSteps.astro). */
type StepCommon = { kicker?: string | undefined; description?: string | undefined };
export type NextItem =
  | (StepCommon & { href: string; title: string; color?: string | undefined })
  | (StepCommon & { learn: string })
  | (StepCommon & { segment: string })
  | (StepCommon & { trend: string });

export interface LearnSceneRef {
  id: SceneId;
  variant?: string | undefined;
}

export interface LearnItem {
  slug: string;
  title: string;
  /** Compact label for chips: 「機器如何學習」 */
  shortTitle: string;
  level: Level;
  order: number;
  track: TrackId;
  trackLabel: string;
  prereqs: string[];
  scene: LearnSceneRef | null;
  minutes?: number | undefined;
  description?: string | undefined;
  subtitle?: string | undefined;
  entry?: LearnEntry | undefined;
  /** listed in curriculum.yaml */
  registered: boolean;
}

export const TRACK_IDS = Object.keys(TRACK_LABELS) as TrackId[];

/** Track colour: each track borrows the colour of the chain layer it is closest to. */
export const TRACK_COLORS: Record<TrackId, string> = {
  foundations: 'var(--layer-foundation)',
  models: 'var(--layer-cloud-models)',
  hardware: 'var(--layer-silicon)',
  'infra-business': 'var(--layer-systems)',
  society: 'var(--layer-applications)',
};

export const LEVEL_BLURBS: Record<Level, string> = {
  1: '從零開始：AI 是什麼、模型怎麼學習、晶片與資料中心的基本樣貌。',
  2: '拆開來看：Transformer、推理與 Agent，以及 GPU、製程、封裝、記憶體與網路。',
  3: '產業前沿：縮放定律、推論最佳化、EUV、HBM、互連、電力散熱與資本支出。',
};

export const PATH_BLURBS: Record<string, string> = {
  models: '從 AI 的基本觀念出發，一路讀到 Transformer、推理模型、混合專家模型與模型評測。',
  hardware: '從「為什麼需要 GPU」開始，深入製程節點、先進封裝、HBM、微影與晶片互連。',
  business: '從產業鏈全貌與資料中心出發，看懂雲端商業模式、訓練與推論成本、資本支出與實體 AI。',
};

const isTrack = (t: string): t is TrackId => (TRACK_IDS as string[]).includes(t);
const isSceneId = (s: string): s is SceneId => (SCENE_IDS as readonly string[]).includes(s);

// Scenes are built by other agents; a scene folder without meta.json is not ready yet.
const SCENE_METAS = import.meta.glob('/src/three/scenes/*/meta.json');
/** True when src/three/scenes/<id>/meta.json exists (the scene can be embedded). */
export function sceneExists(id: string): boolean {
  return `/src/three/scenes/${id}/meta.json` in SCENE_METAS;
}

/** 「什麼是 AI？人工智慧…」→「什麼是 AI？」; 「機器如何學習：資料…」→「機器如何學習」 */
export function shortTitle(title: string): string {
  const t = title.trim();
  const q = t.indexOf('？');
  if (q > 0 && q < t.length - 1) return t.slice(0, q + 1);
  const c = t.indexOf('：');
  if (c > 0) return t.slice(0, c);
  return t;
}

/** 'gpu-scale:chip' → { id: 'gpu-scale', variant: 'chip' } (unknown scene ids → null) */
export function parseSceneRef(s: string | null | undefined): LearnSceneRef | null {
  if (!s) return null;
  const [id, variant] = s.split(':');
  if (!id || !isSceneId(id)) return null;
  return variant ? { id, variant } : { id };
}

const ids = (refs: ReadonlyArray<string | { id: string }> | undefined): string[] =>
  (refs ?? []).map((r) => (typeof r === 'string' ? r : r.id)).filter(Boolean);

/** Every learning article: curriculum rows merged with the learn collection, sorted by order. */
export async function getLearnItems(): Promise<LearnItem[]> {
  const cur = getCurriculum();
  const entries = await safeCollection('learn');
  const bySlug = new Map(entries.map((e) => [e.id, e]));
  const items: LearnItem[] = [];
  const seen = new Set<string>();

  for (const a of cur.articles) {
    if (!a?.slug || seen.has(a.slug)) continue;
    seen.add(a.slug);
    const e = bySlug.get(a.slug);
    const d = e?.data;
    const track: TrackId = isTrack(a.track) ? a.track : 'foundations';
    const entryPrereqs = ids(d?.prerequisites);
    const firstScene = d?.scenes?.[0];
    items.push({
      slug: a.slug,
      title: d?.title ?? a.title,
      shortTitle: shortTitle(d?.title ?? a.title),
      level: levelMeta(a.level).level,
      order: a.order,
      track,
      trackLabel: TRACK_LABELS[track],
      prereqs: entryPrereqs.length ? entryPrereqs : [...(a.prereqs ?? [])],
      scene: parseSceneRef(a.scene) ?? (firstScene ? { id: firstScene.id, variant: firstScene.variant } : null),
      minutes: d?.estimatedMinutes,
      description: d?.description,
      subtitle: d?.subtitle,
      entry: e,
      registered: true,
    });
  }

  // Entries missing from the registry: keep them reachable, ordered by their own frontmatter.
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    const d = e.data;
    const firstScene = d.scenes?.[0];
    items.push({
      slug: e.id,
      title: d.title,
      shortTitle: shortTitle(d.title),
      level: d.level,
      order: d.order,
      track: d.track,
      trackLabel: TRACK_LABELS[d.track],
      prereqs: ids(d.prerequisites),
      scene: firstScene ? { id: firstScene.id, variant: firstScene.variant } : null,
      minutes: d.estimatedMinutes,
      description: d.description,
      subtitle: d.subtitle,
      entry: e,
      registered: false,
    });
  }

  items.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
  // Drop prerequisites that point to unknown articles so chips never link to a 404.
  const known = new Set(items.map((i) => i.slug));
  for (const it of items) it.prereqs = it.prereqs.filter((p) => p !== it.slug && known.has(p));
  return items;
}

export interface SuggestedPath {
  id: string;
  title: string;
  blurb: string;
  items: LearnItem[];
}

/** The three suggested routes from curriculum.yaml, resolved to items (unknown slugs dropped). */
export function getSuggestedPaths(items: readonly LearnItem[]): SuggestedPath[] {
  const map = new Map(items.map((i) => [i.slug, i]));
  return getCurriculum()
    .paths.map((p) => ({
      id: p.id,
      title: p.title,
      blurb: PATH_BLURBS[p.id] ?? `依序閱讀 ${p.slugs.length} 篇文章。`,
      items: p.slugs.map((s) => map.get(s)).filter((x): x is LearnItem => !!x),
    }))
    .filter((p) => p.items.length > 0);
}

// ───────────── Article context: prev/next, NextSteps, related ─────────────

/** Rough segment for a scene, used only when an article has no related segments of its own. */
const SCENE_SEGMENT: Partial<Record<SceneId, SegmentId>> = {
  'neural-net': 'foundation-models',
  'embedding-space': 'devtools-data-mlops',
  attention: 'foundation-models',
  'train-infer': 'devtools-data-mlops',
  'scaling-surface': 'foundation-models',
  'euv-litho': 'semi-equipment-materials',
  'wafer-transistor': 'foundry-packaging',
  cowos: 'foundry-packaging',
  hbm: 'memory-storage',
  'chip-floorplan': 'eda-ip-design',
  'gpu-scale': 'ai-accelerators',
  network: 'networking-optics',
  datacenter: 'datacenter-infra',
  energy: 'energy-power',
  'cloud-globe': 'cloud-neocloud',
  'model-galaxy': 'foundation-models',
  'agent-loop': 'apps-agents',
  'physical-ai': 'physical-ai',
};
const TRACK_SEGMENT: Record<TrackId, SegmentId> = {
  foundations: 'foundation-models',
  models: 'foundation-models',
  hardware: 'ai-accelerators',
  'infra-business': 'cloud-neocloud',
  society: 'apps-agents',
};

export interface RelatedSet {
  segments: SegmentId[];
  companies: string[];
  models: string[];
  trends: string[];
}

export interface LearnContext {
  item: LearnItem;
  index: number;
  total: number;
  prev?: LearnItem | undefined;
  next?: LearnItem | undefined;
  related: RelatedSet;
  nextSteps: NextItem[];
  /** Article that lists this one as a prerequisite one level up (「準備好進階了嗎？」) */
  levelUp?: LearnItem | undefined;
}

function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

export async function getLearnContext(slug: string, items?: readonly LearnItem[]): Promise<LearnContext | undefined> {
  const all = items ?? (await getLearnItems());
  const index = all.findIndex((i) => i.slug === slug);
  if (index < 0) return undefined;
  const item = all[index]!;
  const d = item.entry?.data;

  // Backlinks: segment and trend entries that list this article in relatedLearn.
  const [segments, trends] = await Promise.all([safeCollection('segments'), safeCollection('trends')]);
  const segBack = segments
    .filter((s) => ids(s.data.relatedLearn).includes(slug))
    .sort((a, b) => a.data.order - b.data.order);
  const trendBack = trends.filter((t) => ids(t.data.relatedLearn).includes(slug));

  const relSegments = uniq([...ids(d?.relatedSegments), ...segBack.map((s) => s.id)]).filter(isSegmentId);
  const relTrends = uniq([...ids(d?.relatedTrends), ...trendBack.map((t) => t.id)]).filter(
    (t) => !!getTrendIndexEntry(t) || trends.some((x) => x.id === t),
  );
  const related: RelatedSet = {
    segments: relSegments,
    companies: uniq(ids(d?.relatedCompanies)),
    models: uniq(ids(d?.relatedModels)),
    trends: relTrends,
  };

  // NextSteps ------------------------------------------------------------
  const bySlug = new Map(all.map((i) => [i.slug, i]));
  const explicit = ids(d?.next)
    .map((s) => bySlug.get(s))
    .filter((x): x is LearnItem => !!x && x.slug !== slug);
  const globalNext = all[index + 1];
  const laterInTrack = all.filter((i) => i.track === item.track && i.order > item.order);
  const levelUp = all.find((i) => i.level === item.level + 1 && i.prereqs.includes(slug));
  // Any later article that builds on this one (same level), for articles with no level-up follow-up.
  const buildsOn = all.find((i) => i.order > item.order && i.prereqs.includes(slug));

  const steps: NextItem[] = [];
  const used = new Set<string>([slug]);
  const pushLearn = (it: LearnItem | undefined, kicker: string) => {
    if (!it || used.has(it.slug)) return;
    used.add(it.slug);
    // The card shows the short subtitle only; meta descriptions are too long for a three-up grid.
    steps.push({ learn: it.slug, kicker, description: it.subtitle });
  };
  // One learning suggestion: explicit next[] → next in the same track → one level up → an article that
  // builds on this one. The global 「下一篇」 (and usually the route's next step) is already linked right
  // below the cards, so a candidate equal to it is skipped (then the cards are the segment and the trend).
  const explicitShown = explicit.filter((it) => it.slug !== globalNext?.slug);
  if (explicitShown.length) {
    for (const it of explicitShown.slice(0, 3)) pushLearn(it, `建議接著讀 · ${levelMeta(it.level).label}`);
  } else {
    const candidates: Array<[LearnItem | undefined, string]> = [
      [laterInTrack[0], `同主題的下一篇 · ${item.trackLabel}`],
      [levelUp, `準備好進階了嗎？ · ${levelMeta(levelUp?.level ?? item.level).label}`],
      [buildsOn, `以這篇為基礎 · ${levelMeta(buildsOn?.level ?? item.level).label}`],
      [laterInTrack[1], `同主題的下一篇 · ${item.trackLabel}`],
    ];
    const pick = candidates.find(([it]) => !!it && it.slug !== globalNext?.slug);
    if (pick) pushLearn(pick[0], pick[1]);
  }

  // Segment: the article's own first related segment, else the segment its scene illustrates, else a
  // segment page that links back to it, else the track's home segment.
  const ownSegments = ids(d?.relatedSegments).filter(isSegmentId);
  const segForNext =
    ownSegments[0] ??
    (item.scene ? SCENE_SEGMENT[item.scene.id] : undefined) ??
    related.segments[0] ??
    TRACK_SEGMENT[item.track];
  if (segForNext && segmentMeta(segForNext)) {
    const s = segmentMeta(segForNext)!;
    steps.push({ segment: s.id, kicker: `相關產業鏈環節 · 第 ${s.order} 環` });
  }

  // Trend: the article's own (or a backlink), else one listed by the NextSteps segment or another
  // related segment, in that order.
  let trendForNext = related.trends.find((t) => !!getTrendIndexEntry(t));
  if (!trendForNext) {
    for (const sid of uniq([segForNext, ...related.segments])) {
      const s = segments.find((x) => x.id === sid);
      trendForNext = ids(s?.data.relatedTrends).find((t) => !!getTrendIndexEntry(t));
      if (trendForNext) break;
    }
  }
  if (trendForNext) steps.push({ trend: trendForNext, kicker: '相關未來趨勢' });

  // The last article of the path has no 「下一篇」: close the path (first card) instead of ending in a dead end.
  if (!globalNext) {
    steps.unshift({
      href: sectionHref('learn'),
      title: '回到學習路徑總覽',
      kicker: '學習路徑的最後一篇',
      description: '看看還有哪幾篇沒讀，或換一條建議路線複習。',
      color: 'var(--c-accent)',
    });
  }

  return {
    item,
    index,
    total: all.length,
    prev: all[index - 1],
    next: globalNext,
    related,
    nextSteps: steps,
    levelUp,
  };
}

/** Does an MDX body embed a <Scene3D> itself? (Then the page does not add one.) */
export function bodyHasScene(entry: LearnEntry | undefined): boolean {
  return bodyScenes(entry?.body).length > 0;
}

// ───────────── Scene autoload: one scene per page loads on its own ─────────────
//
// Astro starts rendering slot and MDX children eagerly, so "the first <Scene3D> to render" is not
// always the first one in the document (a scene inside a <DeepDive> can start earlier). Pages
// therefore pass a hint: the scene that should autoload. <LearnScene> claims the autoload slot only
// for that scene; every other scene on the page is click-to-load.

export interface BodyScene extends LearnSceneRef {
  /** inside a <DeepDive> disclosure (closed by default) */
  nested: boolean;
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["'\`]([^"'\`]*)["'\`]\\s*\\})`).exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
};

/** The <Scene3D> tags of an MDX body in document order (code blocks and JSX comments ignored). */
export function bodyScenes(body: string | undefined): BodyScene[] {
  if (!body) return [];
  const src = body.replace(/^(```|~~~)[\s\S]*?^\1/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const out: BodyScene[] = [];
  const re = /<(\/?)(DeepDive|Scene3D)\b((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^}]*\})*)>/g;
  let depth = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const [, close, name, rest = ''] = m;
    if (name === 'DeepDive') {
      if (close) depth = Math.max(0, depth - 1);
      else if (!rest.trimEnd().endsWith('/')) depth++;
      continue;
    }
    if (close) continue;
    const id = attr(rest, 'id');
    if (!id) continue;
    const variant = attr(rest, 'variant');
    out.push({ id: id as SceneId, ...(variant ? { variant } : {}), nested: depth > 0 });
  }
  return out;
}

/**
 * The body scene that should autoload: the first built scene outside a <DeepDive>.
 * `null` when the body has scenes but none qualifies (all click-to-load); `undefined` when the body
 * has no scenes at all (then the first scene the page itself adds takes the slot).
 */
export function autoloadSceneOf(body: string | undefined): LearnSceneRef | null | undefined {
  const scenes = bodyScenes(body);
  if (!scenes.length) return undefined;
  const first = scenes.find((s) => !s.nested && sceneExists(s.id));
  return first ? { id: first.id, ...(first.variant ? { variant: first.variant } : {}) } : null;
}

type AstroLocals = { locals?: unknown };
interface AutoloadState {
  /** undefined: no hint (first ready scene wins) · null: nothing autoloads · ref: only this scene */
  hint?: LearnSceneRef | null;
  claimed: boolean;
}
const AUTOLOAD_KEY = '__acaLearnSceneAutoload';
const fallbackState = new WeakMap<object, AutoloadState>();

function autoloadState(astro: AstroLocals): AutoloadState {
  const locals = astro.locals;
  if (locals && typeof locals === 'object') {
    const bag = locals as Record<string, unknown>;
    let s = bag[AUTOLOAD_KEY] as AutoloadState | undefined;
    if (!s) {
      s = { claimed: false };
      bag[AUTOLOAD_KEY] = s;
    }
    return s;
  }
  let s = fallbackState.get(astro);
  if (!s) {
    s = { claimed: false };
    fallbackState.set(astro, s);
  }
  return s;
}

/** Page frontmatter: name the one scene that may autoload (call before the body renders). */
export function setSceneAutoload(astro: AstroLocals, hint: LearnSceneRef | null | undefined): void {
  const s = autoloadState(astro);
  if (hint !== undefined) s.hint = hint;
}

/** <LearnScene>: may this (built) scene autoload? Claims the page's single autoload slot. */
export function claimSceneAutoload(astro: AstroLocals, ref: LearnSceneRef): boolean {
  const s = autoloadState(astro);
  if (s.claimed) return false;
  if (s.hint === null) return false;
  if (s.hint && (s.hint.id !== ref.id || (s.hint.variant ?? '') !== (ref.variant ?? ''))) return false;
  s.claimed = true;
  return true;
}
