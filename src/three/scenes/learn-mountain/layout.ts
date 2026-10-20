/**
 * learn-mountain layout: the terrain (stacked contour layers), article positions on the three
 * terraces and the prerequisite trails. Pure maths (no three.js objects), so it is cheap to rebuild.
 *
 * Coordinates: y up, the camera looks from +z. Angles θ are measured around a contour's own centre
 * from +z towards +x (x = r·sinθ, z = r·cosθ), so θ = 0 is the front of the mountain and negative
 * angles are on the reader's left.
 */

export type TrackId = 'foundations' | 'models' | 'hardware' | 'infra-business' | 'society';
export type Level = 1 | 2 | 3;

export interface Article {
  slug: string;
  title: string;
  level: Level;
  order: number;
  track: TrackId;
  prereqs: string[];
  href: string;
}

/** Left → right around the front of the mountain (keeps most trails running straight uphill). */
export const TRACK_ORDER: readonly TrackId[] = ['hardware', 'infra-business', 'foundations', 'models', 'society'];
export const TRACK_NAME: Record<TrackId, string> = {
  foundations: '基礎概念',
  models: '模型與軟體',
  hardware: '晶片與硬體',
  'infra-business': '基礎設施與商業',
  society: '社會與未來',
};
/** Same colour tokens as the 2D learning map (src/components/learn/learn-data.ts TRACK_COLORS). */
export const TRACK_LAYER = {
  foundations: 'foundation',
  models: 'cloud-models',
  hardware: 'silicon',
  'infra-business': 'systems',
  society: 'applications',
} as const satisfies Record<TrackId, string>;

export const LEVEL_NAME: Record<Level, string> = { 1: '入門', 2: '進階', 3: '深入' };

/* ───────────────────────── terrain ───────────────────────── */

export interface Contour {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  bottom: number;
  top: number;
  /** Wobble phase (keeps the outline organic but deterministic). */
  ph: number;
  /** 1–3 for the three terraces, 0 for the narrow steps between them. */
  level: 0 | Level;
}

export const GROUND_Y = -0.32;

/** Bottom → top. Terraces are wide and flat; the thin steps between them form the slopes. */
export const CONTOURS: readonly Contour[] = [
  { cx: 0, cz: 0.3, rx: 7.6, rz: 5.0, bottom: GROUND_Y, top: 0.5, ph: 0.4, level: 1 },
  { cx: 0, cz: -0.35, rx: 6.2, rz: 3.9, bottom: 0.35, top: 0.95, ph: 1.9, level: 0 },
  { cx: 0, cz: -0.4, rx: 5.98, rz: 3.74, bottom: 0.8, top: 1.4, ph: 2.6, level: 0 },
  { cx: 0, cz: -0.45, rx: 5.76, rz: 3.58, bottom: 1.25, top: 1.85, ph: 3.3, level: 2 },
  { cx: 0, cz: -0.95, rx: 4.55, rz: 2.8, bottom: 1.7, top: 2.3, ph: 4.4, level: 0 },
  { cx: 0, cz: -1.0, rx: 4.36, rz: 2.66, bottom: 2.15, top: 2.75, ph: 5.1, level: 0 },
  { cx: 0, cz: -1.05, rx: 4.18, rz: 2.52, bottom: 2.6, top: 3.2, ph: 5.9, level: 3 },
];

export const terraceIndex = (level: Level): number => CONTOURS.findIndex((c) => c.level === level);

/** Outline radius of contour `c` in direction θ from its own centre. */
export function contourRadius(c: Contour, theta: number): number {
  const s = Math.sin(theta);
  const co = Math.cos(theta);
  const e = 1 / Math.sqrt((s / c.rx) ** 2 + (co / c.rz) ** 2);
  const w = 1 + 0.03 * Math.sin(3 * theta + c.ph) + 0.022 * Math.sin(5 * theta + 1.7 * c.ph) + 0.012 * Math.sin(8 * theta + 0.6 * c.ph);
  return e * w;
}

export function insideContour(c: Contour, x: number, z: number, margin = 0): boolean {
  const dx = x - c.cx;
  const dz = z - c.cz;
  return Math.hypot(dx, dz) <= contourRadius(c, Math.atan2(dx, dz)) + margin;
}

/** Terrain height (top of the highest contour containing the point). */
export function heightAt(x: number, z: number): number {
  for (let i = CONTOURS.length - 1; i >= 0; i--) {
    const c = CONTOURS[i]!;
    if (insideContour(c, x, z)) return c.top;
  }
  return GROUND_Y;
}

/** Distance along the ray from contour `c`'s centre (direction θ) at which `inner` ends. */
function innerRadius(c: Contour, inner: Contour | undefined, theta: number, outer: number): number {
  if (!inner) return 0;
  const sx = Math.sin(theta);
  const cz = Math.cos(theta);
  let lo = 0;
  let hi = outer;
  if (!insideContour(inner, c.cx, c.cz)) return 0;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (insideContour(inner, c.cx + sx * m, c.cz + cz * m)) lo = m;
    else hi = m;
  }
  return lo;
}

/** Point on terrace `level` at angle θ and band fraction f (0 = foot of the slope above, 1 = rim). */
export function bandPoint(level: Level, theta: number, f: number): [number, number] {
  const ti = terraceIndex(level);
  const c = CONTOURS[ti]!;
  const outer = contourRadius(c, theta);
  // The summit has no slope above it: use the plateau from 0 to the rim.
  const inner = level === 3 ? outer * 0.3 : innerRadius(c, CONTOURS[ti + 1], theta, outer);
  const r = inner + (outer - inner) * f;
  return [c.cx + Math.sin(theta) * r, c.cz + Math.cos(theta) * r];
}

/* ───────────────────────── nodes ───────────────────────── */

export interface NodeLayout {
  a: Article;
  i: number;
  level: Level;
  theta: number;
  /** Band fraction (see bandPoint). */
  f: number;
  x: number;
  y: number;
  z: number;
}

/** Half-span of the usable arc per terrace (radians) and the band fraction of the node row. */
const SPAN: Record<Level, number> = { 1: 1.3, 2: 1.42, 3: 1.62 };
export const BAND_F: Record<Level, number> = { 1: 0.46, 2: 0.5, 3: 0.6 };
const GROUP_GAP = 0.55;
/** Preferred spacing between neighbours along the row (world units); below ZIGZAG_BELOW the row staggers. */
const PREF_SPACING = 1.15;
const ZIGZAG_BELOW = 0.82;
const ZIGZAG_F = 0.24;

export function layoutNodes(articles: readonly Article[]): NodeLayout[] {
  const out: NodeLayout[] = [];
  for (const level of [1, 2, 3] as const) {
    const list = articles
      .filter((a) => a.level === level)
      .sort((a, b) => TRACK_ORDER.indexOf(a.track) - TRACK_ORDER.indexOf(b.track) || a.order - b.order);
    if (!list.length) continue;
    const units: number[] = [];
    let u = 0;
    list.forEach((a, k) => {
      if (k > 0) u += 1 + (a.track !== list[k - 1]!.track ? GROUP_GAP : 0);
      units.push(u);
    });
    // Arc-length table of the row curve, so neighbours are evenly spaced in world units.
    const S = SPAN[level];
    const f0 = BAND_F[level];
    const M = 240;
    const th: number[] = [];
    const len: number[] = [];
    let prev = bandPoint(level, -S, f0);
    for (let s = 0; s <= M; s++) {
      const t = -S + (2 * S * s) / M;
      const p = bandPoint(level, t, f0);
      th.push(t);
      len.push(s ? len[s - 1]! + Math.hypot(p[0] - prev[0], p[1] - prev[1]) : 0);
      prev = p;
    }
    const total = len[M]!;
    const mid = len[M / 2]!;
    const d = u > 0 ? Math.min(PREF_SPACING, total / u) : 0;
    // Lower terraces keep one tidy row (a path along the terrace); the summit plateau may stagger.
    const zig = d < (level === 3 ? ZIGZAG_BELOW : 0.6) && list.length > 3;
    const thetaAt = (l: number): number => {
      let i = 0;
      while (i < M - 1 && len[i + 1]! < l) i++;
      const span = len[i + 1]! - len[i]!;
      const k = span > 0 ? (l - len[i]!) / span : 0;
      return th[i]! + (th[i + 1]! - th[i]!) * Math.max(0, Math.min(1, k));
    };
    const top = CONTOURS[terraceIndex(level)]!.top;
    list.forEach((a, k) => {
      const theta = thetaAt(mid + (units[k]! - u / 2) * d);
      const f = zig ? f0 + (k % 2 ? -ZIGZAG_F : ZIGZAG_F) : f0;
      const [x, z] = bandPoint(level, theta, f);
      out.push({ a, i: -1, level, theta, f, x, y: top, z });
    });
  }
  out.forEach((n, i) => (n.i = i));
  return out;
}

/* ───────────────────────── trails ───────────────────────── */

export interface EdgeLayout {
  from: number;
  to: number;
  /** Dense polyline hugging the terrain (already lifted above the surface). */
  points: [number, number, number][];
}

const LIFT = 0.035;

/** Centripetal Catmull-Rom through 2D control points, sampled into `n` points. */
function spline2(ctrl: readonly [number, number][], n: number): [number, number][] {
  if (ctrl.length < 3) {
    const [a, b] = [ctrl[0]!, ctrl[ctrl.length - 1]!];
    return Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    });
  }
  // Accumulate chord lengths so samples are roughly uniform along the path.
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < ctrl.length; i++) {
    const d = Math.hypot(ctrl[i]![0] - ctrl[i - 1]![0], ctrl[i]![1] - ctrl[i - 1]![1]);
    seg.push(d);
    total += d;
  }
  const out: [number, number][] = [];
  const P = (i: number) => ctrl[Math.max(0, Math.min(ctrl.length - 1, i))]!;
  for (let s = 0; s < n; s++) {
    let d = (s / (n - 1)) * total;
    let i = 0;
    while (i < seg.length - 1 && d > seg[i]!) d -= seg[i++]!;
    const t = seg[i]! > 0 ? Math.min(1, d / seg[i]!) : 0;
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    out.push([catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t)]);
  }
  return out;
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * Lift a 2D path onto the terrain as a smooth ramp: the upper envelope of the stepped heights
 * (max over a window), averaged, never below the surface. Trails cross the narrow steps between
 * terraces in one gentle climb instead of a staircase.
 */
function drape(pts: readonly [number, number][]): [number, number, number][] {
  const n = pts.length;
  const raw = pts.map(([x, z]) => heightAt(x, z));
  const W = 4;
  const at = (arr: readonly number[], i: number) => arr[Math.max(0, Math.min(n - 1, i))]!;
  const maxed = raw.map((_, i) => {
    let m = -Infinity;
    for (let k = -W; k <= W; k++) m = Math.max(m, at(raw, i + k));
    return m;
  });
  const smooth = maxed.map((_, i) => {
    let s = 0;
    for (let k = -W; k <= W; k++) s += at(maxed, i + k);
    return s / (2 * W + 1);
  });
  return pts.map(([x, z], i) => {
    // Ends sit exactly on their terrace (the node pads).
    const y = i === 0 || i === n - 1 ? raw[i]! : Math.max(smooth[i]!, raw[i]! + 0.01);
    return [x, y + LIFT, z];
  });
}

export function layoutEdges(nodes: readonly NodeLayout[]): EdgeLayout[] {
  const bySlug = new Map(nodes.map((n) => [n.a.slug, n]));
  // Index of each node within its terrace row (for bulge sizes).
  const rowIndex = new Map<number, number>();
  for (const level of [1, 2, 3] as const) nodes.filter((n) => n.level === level).forEach((n, k) => rowIndex.set(n.i, k));
  const edges: EdgeLayout[] = [];
  for (const b of nodes) {
    for (const p of b.a.prereqs) {
      const a = bySlug.get(p);
      if (!a || a === b) continue;
      edges.push({ from: a.i, to: b.i, points: trailPoints(a, b, Math.abs((rowIndex.get(a.i) ?? 0) - (rowIndex.get(b.i) ?? 0))) });
    }
  }
  return edges;
}

function trailPoints(a: NodeLayout, b: NodeLayout, span: number): [number, number, number][] {
  const N = 56;
  if (a.level === b.level) {
    // Along the terrace: an arc that bulges towards the rim, more for longer hops.
    const bulge = Math.min(0.42, 0.12 + 0.06 * span) * (a.level === 3 ? 0.7 : 1);
    const pts: [number, number][] = [];
    for (let s = 0; s < N; s++) {
      const t = s / (N - 1);
      const theta = a.theta + (b.theta - a.theta) * t;
      const f = a.f + (b.f - a.f) * t + bulge * Math.sin(Math.PI * t);
      pts.push(bandPoint(a.level, theta, Math.min(0.94, f)));
    }
    return drape(pts);
  }
  // Uphill (or, defensively, downhill): leave A towards the slope, cross any middle terrace, arrive at B from its rim.
  const lo = a.level < b.level ? a : b;
  const hi = lo === a ? b : a;
  const ctrl: [number, number][] = [[lo.x, lo.z], bandPoint(lo.level, lo.theta + (hi.theta - lo.theta) * 0.12, 0.1)];
  for (let lv = lo.level + 1; lv < hi.level; lv++) {
    const k = (lv - lo.level) / (hi.level - lo.level);
    const th = lo.theta + (hi.theta - lo.theta) * k;
    ctrl.push(bandPoint(lv as Level, th, 0.86), bandPoint(lv as Level, th, 0.14));
  }
  ctrl.push(bandPoint(hi.level, hi.theta - (hi.theta - lo.theta) * 0.12, 0.9), [hi.x, hi.z]);
  if (lo !== a) ctrl.reverse();
  return drape(spline2(ctrl, N));
}

/* ───────────────────────── graph helpers ───────────────────────── */

/** All ancestors (prerequisites, transitively) of node `i`. */
export function ancestors(nodes: readonly NodeLayout[], i: number): Set<number> {
  const bySlug = new Map(nodes.map((n) => [n.a.slug, n.i]));
  const seen = new Set<number>();
  const stack = [i];
  while (stack.length) {
    const k = stack.pop()!;
    for (const p of nodes[k]!.a.prereqs) {
      const j = bySlug.get(p);
      if (j !== undefined && !seen.has(j) && j !== i) {
        seen.add(j);
        stack.push(j);
      }
    }
  }
  return seen;
}

/** The summit article with the longest prerequisite tree (ties → the later article). */
export function routeTarget(nodes: readonly NodeLayout[]): number {
  let best = -1;
  let bestN = -1;
  const top = Math.max(...nodes.map((n) => n.level));
  for (const n of nodes) {
    if (n.level !== top) continue;
    const k = ancestors(nodes, n.i).size;
    if (k > bestN || (k === bestN && best >= 0 && n.a.order > nodes[best]!.a.order)) {
      best = n.i;
      bestN = k;
    }
  }
  return best;
}

/** Visual width in CJK character units (Latin letters, digits and spaces are about half as wide). */
const textWidth = (s: string): number => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x2e80 ? 0.55 : 1), 0);

/**
 * Short 3D label: the part before 「：」, or a leading question up to its 「？」 (「什麼是 AI？」), so
 * labels end at a natural break instead of an ellipsis; anything still wider than ~14 CJK
 * characters is trimmed.
 */
export function shortTitle(title: string): string {
  let t = title.split('：')[0]!.trim();
  const q = t.indexOf('？');
  if (q > 0 && q < t.length - 1) t = t.slice(0, q + 1);
  t = t.replace(/[（(][^）)]*[）)]$/, (m) => (textWidth(t) > 12 ? '' : m)).trim();
  if (textWidth(t) <= 14.5) return t;
  let out = '';
  for (const ch of t) {
    if (textWidth(out + ch) > 13.5) break;
    out += ch;
  }
  return `${out.trim()}…`;
}
