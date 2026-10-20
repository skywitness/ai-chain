// Scene data for `model-galaxy` (docs/SCENES.md → 頁面資料形狀 `models`).
// Owner: pages-models. Used by /models/ and available to any page that embeds the galaxy
// (e.g. the learn article on model evaluation):
//
//   import { getModelGalaxyData } from '../lib/scene-data/models';
//   <Scene3D id="model-galaxy" variant="galaxy" data={await getModelGalaxyData()} />
//
// Only families with a content entry are plotted: their coordinates come from the editors'
// `positioning` block (capability 0–100, costIndex 0–100 log-scaled, openness 0–1). Families
// still being written are left out rather than placed at invented coordinates.
//
// Optional extension read by the scene (src/three/scenes/model-galaxy/data.ts): `history`, the
// family's earlier versions on the same scale, which drive the star trails, the time slider and
// the moving efficient frontier. It is only derived where it can be computed honestly: language
// families whose capability IS the Artificial Analysis Intelligence Index of the flagship, using
// each earlier version's own third-party index score and official price.
import { getModelsIndex, safeEntry } from '../collections';

export interface ModelGalaxyPoint {
  /** release date of that version, YYYY-MM-DD */
  released: string;
  capability: number;
  costIndex: number;
}

export interface ModelGalaxyDatum {
  id: string;
  title: string;
  /** lab display name (colour key in the scene) */
  lab: string;
  /** 'US' | 'CN' | 'EU' | 'TW' | 'KR' | … */
  origin: string;
  /** 'llm' | 'image' | 'video' | 'audio' | 'world' | 'robotics' | 'embedding' */
  kind: string;
  /** 0–100 */
  capability: number;
  /** 0–100 (log-scaled blended $/1M tokens; 100 = most expensive) */
  costIndex: number;
  /** 0 closed … 1 fully open */
  openness: number;
  /** flagship version release date, YYYY-MM-DD */
  released: string;
  /** site-relative, without the base path ('/models/openai-gpt/') */
  href: string;
  /** earlier versions, oldest first (optional; see the header comment) */
  history?: ModelGalaxyPoint[];
}

interface PriceLike {
  asOf: string;
  inputPerMTok: number;
  outputPerMTok: number;
}
interface BenchLike {
  benchmark: string;
  score: number;
  reportedBy: string;
  date: string;
}
interface VersionLike {
  id: string;
  released: string;
  tier?: string;
  pricing?: ReadonlyArray<PriceLike>;
  benchmarks?: ReadonlyArray<BenchLike>;
}
interface FamilyLike {
  title: string;
  labName: string;
  origin: string;
  kind?: string | undefined;
  positioning: { capability: number; costIndex: number; openness: number; method?: string };
  flagshipVersion: string;
  versions: ReadonlyArray<VersionLike>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const day = (d: unknown) => String(d ?? '').slice(0, 10);

/** The capability scale of language-model positioning (CONTENT-GUIDE §4.5). */
export const CAPABILITY_BENCHMARK = 'aa-intelligence-index';

/**
 * Cost index from a price: 3:1 blended input/output $/1M tokens, log-scaled so that US$0.05 → 0
 * and US$100 → 100 (the same formula the editors use for `positioning.costIndex`).
 */
export function costIndexOf(p: Pick<PriceLike, 'inputPerMTok' | 'outputPerMTok'>): number {
  const blended = (3 * p.inputPerMTok + p.outputPerMTok) / 4;
  if (!(blended > 0)) return 0;
  return clamp((100 * Math.log10(blended / 0.05)) / Math.log10(100 / 0.05), 0, 100);
}

function latestPrice(v: VersionLike): PriceLike | undefined {
  let best: PriceLike | undefined;
  for (const p of v.pricing ?? []) if (!best || day(p.asOf) > day(best.asOf)) best = p;
  return best;
}

/** The independent (third-party / leaderboard) index score of a version, latest first. */
function indexScore(v: VersionLike): number | undefined {
  const list = (v.benchmarks ?? []).filter((b) => b.benchmark === CAPABILITY_BENCHMARK && b.reportedBy !== 'lab');
  if (!list.length) return undefined;
  return [...list].sort((a, b) => day(b.date).localeCompare(day(a.date)))[0]!.score;
}

/**
 * Earlier positions of a language family on the galaxy's own scale. Empty unless the flagship's
 * capability equals its index score (so both ends of the trail use the same measure). Only
 * flagship-class versions count; the trail keeps, in release order, each one that matched or beat
 * the best capability so far (the family's own frontier), never above today's flagship.
 */
export function familyHistory(d: FamilyLike): ModelGalaxyPoint[] {
  if ((d.kind ?? 'llm') !== 'llm') return [];
  const flagship = d.versions.find((v) => v.id === d.flagshipVersion);
  if (!flagship) return [];
  const flagScore = indexScore(flagship);
  if (flagScore === undefined || Math.abs(flagScore - d.positioning.capability) > 1.5) return [];
  const until = day(flagship.released);
  const cap = d.positioning.capability;
  // The main line only: a small or mid model is not where the family stood at that time.
  const tiers = new Set(['flagship', 'reasoning', flagship.tier ?? 'flagship']);
  const pts = d.versions
    .filter((v) => v.id !== flagship.id && day(v.released) < until && tiers.has(v.tier ?? 'flagship'))
    .map((v) => ({ v, score: indexScore(v), price: latestPrice(v) }))
    .filter((x): x is { v: VersionLike; score: number; price: PriceLike } => x.score !== undefined && !!x.price)
    .sort((a, b) => day(a.v.released).localeCompare(day(b.v.released)));
  const out: ModelGalaxyPoint[] = [];
  let best = -Infinity;
  for (const x of pts) {
    if (x.score < best || x.score > cap + 1e-9) continue;
    best = x.score;
    const point = { released: day(x.v.released), capability: clamp(x.score, 0, 100), costIndex: Math.round(costIndexOf(x.price) * 10) / 10 };
    // one point per release day (the stronger version wins)
    if (out.at(-1)?.released === point.released) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}

/** One datum from a model entry's data; undefined when the entry lacks usable coordinates. */
export function modelGalaxyDatum(id: string, d: FamilyLike): ModelGalaxyDatum | undefined {
  const p = d.positioning;
  if (!p || ![p.capability, p.costIndex, p.openness].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const flagship = d.versions.find((v) => v.id === d.flagshipVersion);
  const released = flagship?.released ?? [...d.versions].map((v) => day(v.released)).sort().at(-1) ?? '';
  if (!/^\d{4}-\d{2}/.test(day(released))) return undefined;
  const datum: ModelGalaxyDatum = {
    id,
    title: d.title,
    lab: d.labName,
    origin: d.origin,
    kind: d.kind ?? 'llm',
    capability: clamp(p.capability, 0, 100),
    costIndex: clamp(p.costIndex, 0, 100),
    openness: clamp(p.openness, 0, 1),
    released: day(released),
    href: `/models/${id}/`,
  };
  const history = familyHistory(d);
  if (history.length) datum.history = history;
  return datum;
}

/** Data for every registered family that has a content entry (registry order). */
export async function getModelGalaxyData(opts: { kinds?: readonly string[] } = {}): Promise<ModelGalaxyDatum[]> {
  const out: ModelGalaxyDatum[] = [];
  for (const f of getModelsIndex()) {
    if (opts.kinds && !opts.kinds.includes(f.kind)) continue;
    const entry = await safeEntry('models', f.id);
    if (!entry) continue;
    const datum = modelGalaxyDatum(f.id, entry.data as unknown as FamilyLike);
    if (datum) out.push(datum);
  }
  return out;
}
