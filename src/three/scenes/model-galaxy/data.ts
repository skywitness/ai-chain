/**
 * model-galaxy data: the `models` page payload (docs/SCENES.md), its type guard, and the pure
 * helpers the scene needs (timelines, region / kind names, the efficient frontier).
 *
 * Shape (docs/SCENES.md): { id, title, lab, origin, capability, costIndex, openness, released,
 * href, kind }[]. Optional extensions (see proposals/scene-model-galaxy.yaml): `short` (3D label),
 * `tier` (star size) and `history` (earlier versions → trails and the moving frontier).
 */

export type Kind = 'llm' | 'image' | 'video' | 'audio' | 'world' | 'robotics' | 'embedding';
export type Tier = 'flagship' | 'mid' | 'small' | 'reasoning' | 'specialized';
export type Region = 'us' | 'cn' | 'eu' | 'tw' | 'other';
export type Shape = 'sphere' | 'diamond' | 'cube' | 'tetra' | 'dodeca' | 'ring';
export type Size = 'L' | 'M' | 'S';

export interface ModelPoint {
  released: string;
  capability: number;
  costIndex: number;
  openness?: number;
}

export interface ModelDatum {
  id: string;
  title: string;
  lab: string;
  origin: string;
  /** 0–100 composite capability index. */
  capability: number;
  /** 0–100: log-scaled blended price per million tokens (0 = US$0.05, 100 = US$100). */
  costIndex: number;
  /** 0 closed … 1 fully open. */
  openness: number;
  /** YYYY-MM-DD (or YYYY-MM): release of the version these coordinates describe. */
  released: string;
  href?: string;
  kind?: string;
  short?: string;
  tier?: string;
  history?: ModelPoint[];
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isModels(d: unknown): d is ModelDatum[] {
  return (
    Array.isArray(d) &&
    d.length > 0 &&
    d.every((m) => {
      if (!m || typeof m !== 'object') return false;
      const x = m as ModelDatum;
      return (
        typeof x.id === 'string' &&
        typeof x.title === 'string' &&
        typeof x.origin === 'string' &&
        num(x.capability) &&
        num(x.costIndex) &&
        num(x.openness) &&
        typeof x.released === 'string' &&
        Number.isFinite(monthOf(x.released)) &&
        (x.history === undefined ||
          (Array.isArray(x.history) &&
            x.history.every((h) => !!h && typeof h.released === 'string' && num(h.capability) && num(h.costIndex))))
      );
    })
  );
}

/* ───────── names ───────── */

export const REGIONS: readonly Region[] = ['us', 'cn', 'eu', 'tw', 'other'];
export const REGION_NAME: Record<Region, string> = { us: '美國', cn: '中國', eu: '歐洲', tw: '台灣', other: '其他' };
export const regionOf = (origin: string): Region =>
  origin === 'US' ? 'us' : origin === 'CN' ? 'cn' : origin === 'EU' ? 'eu' : origin === 'TW' ? 'tw' : 'other';
export const ORIGIN_NAME: Record<string, string> = {
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

export const KINDS: readonly Kind[] = ['llm', 'image', 'video', 'audio', 'world', 'robotics', 'embedding'];
/** Filter chip names (short). */
export const KIND_CHIP: Record<Kind, string> = {
  llm: 'LLM',
  image: '影像',
  video: '影片',
  audio: '語音',
  world: '世界模型',
  robotics: '機器人',
  embedding: '嵌入',
};
/** Card names (full). */
export const KIND_NAME: Record<Kind, string> = {
  llm: '大型語言模型',
  image: '影像生成',
  video: '影片生成',
  audio: '語音／音訊',
  world: '世界模型',
  robotics: '機器人模型',
  embedding: '嵌入模型',
};
export const kindOf = (k: string | undefined): Kind => ((KINDS as readonly string[]).includes(k ?? '') ? (k as Kind) : 'llm');
export const SHAPE_OF: Record<Kind, Shape> = {
  llm: 'sphere',
  embedding: 'sphere',
  image: 'diamond',
  video: 'cube',
  audio: 'tetra',
  world: 'dodeca',
  robotics: 'ring',
};
export const SIZE_NAME: Record<Size, string> = { L: '旗艦', M: '中階', S: '輕量' };

/* ───────── time ───────── */

/** Fractional month index (year·12 + month − 1 + day fraction); NaN when unparseable. */
export function monthOf(s: string): number {
  const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(s);
  if (!m) return Number.NaN;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return Number.NaN;
  const d = m[3] ? Number(m[3]) : 1;
  return Number(m[1]) * 12 + mo - 1 + (Math.min(31, Math.max(1, d)) - 1) / 31;
}

export const formatMonth = (t: number): string => {
  const i = Math.floor(t + 1e-6);
  return `${Math.floor(i / 12)} 年 ${(i % 12) + 1} 月`;
};

export interface Checkpoint {
  /** Month index just before the checkpoint closes (end of that month). */
  t: number;
  /** Short zh-TW label: 「2024 年底」 or 「2025 年中」. */
  label: string;
}

/**
 * Snapshots for the moving frontier and the cost-decline markers: year ends when the data spans
 * three years or more, otherwise half-year ends (June and December), always ending before tMax.
 */
export function checkpoints(tMin: number, tMax: number): Checkpoint[] {
  const half = tMax - tMin < 36;
  const out: Checkpoint[] = [];
  const first = Math.floor(tMin / 12) * 12;
  for (let m = first; m < tMax; m += half ? 6 : 12) {
    const end = m + (half ? 6 : 12) - 1; // the last month of the period
    if (end < tMin || end >= Math.floor(tMax)) continue;
    const y = Math.floor(end / 12);
    out.push({ t: end + 0.98, label: end % 12 === 11 ? `${y} 年底` : `${y} 年中` });
  }
  return out;
}

/* ───────── per-model timeline ───────── */

export interface TrackPoint {
  t: number;
  c: number;
  ci: number;
  o: number;
}

export interface Model {
  d: ModelDatum;
  id: string;
  short: string;
  region: Region;
  kind: Kind;
  size: Size;
  /** Versions sorted by time; the last one is the current position. */
  track: TrackPoint[];
  first: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

const LATIN = /^[A-Za-z0-9π][A-Za-z0-9π.+\-]*$/;
const PAREN = /[（(]([^）)]*)[）)]/g;

/**
 * A compact 3D label from a family title: the model brand without the company name.
 * 「OpenAI GPT 系列」→ GPT,「阿里巴巴通義千問 Qwen 系列」→ Qwen,「NVIDIA Isaac GR00T」→ Isaac GR00T,
 * 「Meta Muse 與 Llama 系列」→ Muse／Llama,「Apple 基礎模型（AFM）」→ AFM,「DeepSeek 系列」→ DeepSeek.
 * Latin runs are split at CJK text, 「／」 and 「與」; leading words that also appear in the lab name
 * are dropped (unless nothing else is left).
 */
export function shortName(d: ModelDatum): string {
  if (d.short) return d.short;
  const paren: string[] = [];
  const main = d.title.replace(PAREN, (_, x: string) => (paren.push(x.trim()), ' '));
  const labWords = new Set((d.lab ?? '').split(/[^A-Za-z0-9π]+/).filter(Boolean));
  // Tokenise, keeping 「與」 and 「／」 as separators that we remember.
  const toks = main.split(/(\s+|／|\/|與)/).filter((t) => t && !/^\s+$/.test(t));
  const runs: { words: string[]; joinedBy: string }[] = [];
  let cur: string[] = [];
  let sep = '';
  for (const t of toks) {
    if (LATIN.test(t)) {
      cur.push(t);
      continue;
    }
    if (cur.length) runs.push({ words: cur, joinedBy: sep });
    cur = [];
    sep = t === '與' || t === '／' || t === '/' ? t : '';
  }
  if (cur.length) runs.push({ words: cur, joinedBy: sep });
  const strip = (w: string[]) => {
    let i = 0;
    while (i < w.length && labWords.has(w[i]!)) i++;
    return w.slice(i);
  };
  const named = runs.map((r) => ({ ...r, words: strip(r.words) })).filter((r) => r.words.length);
  if (named.length) {
    let s = named[0]!.words.join(' ');
    const next = named[1];
    if (next && next.joinedBy === '與') s += `／${next.words.join(' ')}`;
    return s;
  }
  const raw = runs[0]?.words.join(' ');
  if (raw) return raw;
  const p = paren.find((x) => LATIN.test(x));
  if (p) return p;
  return d.title.replace(/\s*系列\s*$/, '').trim() || d.title;
}

/** Openness scale used by the site (docs/CONTENT-GUIDE.md → positioning.openness). */
export const openText = (o: number): string =>
  o < 0.2 ? '封閉（只透過 API／App）' : o < 0.65 ? '開放權重（授權有限制）' : o < 0.95 ? '開放權重（寬鬆授權）' : '完全開源（含資料與程式）';

export function buildModels(list: readonly ModelDatum[]): Model[] {
  const out: Model[] = list.map((d) => {
    const o = clamp(d.openness, 0, 1);
    const pts: TrackPoint[] = [
      ...(d.history ?? []).map((h) => ({
        t: monthOf(h.released),
        c: clamp(h.capability, 0, 100),
        ci: clamp(h.costIndex, 0, 100),
        o: clamp(h.openness ?? o, 0, 1),
      })),
      { t: monthOf(d.released), c: clamp(d.capability, 0, 100), ci: clamp(d.costIndex, 0, 100), o },
    ].filter((p) => Number.isFinite(p.t));
    pts.sort((a, b) => a.t - b.t);
    const kind = kindOf(d.kind);
    return { d, id: d.id, short: shortName(d), region: regionOf(d.origin), kind, size: 'M' as Size, track: pts, first: pts[0]!.t };
  });
  // Size by tier; without a tier, by capability rank within the kind (top ≈ 35 % large, bottom ≈ 30 % small).
  for (const k of KINDS) {
    const group = out.filter((m) => m.kind === k);
    const ranked = [...group].sort((a, b) => last(b).c - last(a).c);
    ranked.forEach((m, i) => {
      const t = m.d.tier;
      if (t === 'flagship' || t === 'reasoning') m.size = 'L';
      else if (t === 'small') m.size = 'S';
      else if (t === 'mid' || t === 'specialized') m.size = 'M';
      else {
        const q = group.length > 1 ? i / (group.length - 1) : 0;
        m.size = q < 0.35 ? 'L' : q > 0.7 ? 'S' : 'M';
      }
    });
  }
  return out;
}

export const last = (m: Model): TrackPoint => m.track[m.track.length - 1]!;

/** The version shown at time `t` (null before the family's first release). */
export function pointAt(m: Model, t: number): TrackPoint | null {
  let p: TrackPoint | null = null;
  for (const q of m.track) {
    if (q.t <= t + 1e-6) p = q;
    else break;
  }
  return p;
}

/* ───────── efficient frontier ───────── */

export interface FrontierPoint {
  m: Model;
  p: TrackPoint;
}

/**
 * Pareto frontier of capability over cost: walking from cheap to expensive, keep every model that
 * beats all cheaper ones. Nothing on it can be matched for less money.
 */
export function frontierAt(models: readonly Model[], t: number, include: (m: Model) => boolean): FrontierPoint[] {
  const pts: FrontierPoint[] = [];
  for (const m of models) {
    if (!include(m)) continue;
    const p = pointAt(m, t);
    if (p) pts.push({ m, p });
  }
  pts.sort((a, b) => a.p.ci - b.p.ci || b.p.c - a.p.c);
  const out: FrontierPoint[] = [];
  let best = -Infinity;
  for (const x of pts) {
    if (x.p.c > best + 1e-9) {
      out.push(x);
      best = x.p.c;
    }
  }
  return out;
}

/** The cheapest model at time `t` whose capability is at least `cap`. */
export function cheapestAt(models: readonly Model[], t: number, cap: number, include: (m: Model) => boolean): FrontierPoint | null {
  let best: FrontierPoint | null = null;
  for (const m of models) {
    if (!include(m)) continue;
    const p = pointAt(m, t);
    if (p && p.c >= cap - 1e-9 && (!best || p.ci < best.p.ci)) best = { m, p };
  }
  return best;
}
