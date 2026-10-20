/**
 * learn-mountain label placement: a screen-space pre-pass for the article labels.
 *
 * The shared LabelLayer places every label at one fixed side of its anchor and drops it on any
 * collision. On the terraces the rows run across the screen at the front and almost along the view
 * direction on the flanks, so one fixed side either stacks labels on top of each other or covers
 * the neighbouring beacons. This pass tries up to four sides per label (in a per-node order of
 * preference, keeping the previous side while it still fits) and avoids the other labels, the
 * stage edges and the beacons themselves. The scene then hands the chosen side and a pixel offset
 * to the LabelLayer. Pure maths, no three.js and no DOM.
 * (Proposed as a kit capability in proposals/scene-learn-mountain.yaml.)
 */

/** Label side: the four LabelLayer aligns plus above / below shifted to hang off one side of the
 *  orb (…L grows leftwards from the orb, …R rightwards), for rows that climb across the screen. */
export type Side = 'above' | 'below' | 'left' | 'right' | 'aboveL' | 'aboveR' | 'belowL' | 'belowR';
export type Align = 'above' | 'below' | 'left' | 'right';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlaceCandidate {
  key: number;
  /** Projected anchor (orb centre) and the beacon's screen extent around it. */
  cx: number;
  cy: number;
  top: number;
  bottom: number;
  r: number;
  /** Label size in px. */
  w: number;
  h: number;
  prefer: readonly Side[];
  prev: Side | null;
}

/** Gap between a beacon and its label (px). */
export const GAP = 5;
/** Extra clearance around labels: the LabelLayer's 4 px collision grid needs ≥ 8 px between rects. */
const LABEL_PAD = 4;

export const alignOf = (side: Side): Align => (side.startsWith('above') ? 'above' : side.startsWith('below') ? 'below' : (side as Align));

export function rectFor(c: PlaceCandidate, side: Side): Rect {
  const { w, h } = c;
  const yAbove = c.top - GAP - h;
  const yBelow = c.bottom + GAP;
  const xL = c.cx + c.r * 0.6 - w;
  const xR = c.cx - c.r * 0.6;
  switch (side) {
    case 'above':
      return { x: c.cx - w / 2, y: yAbove, w, h };
    case 'below':
      return { x: c.cx - w / 2, y: yBelow, w, h };
    case 'aboveL':
      return { x: xL, y: yAbove, w, h };
    case 'aboveR':
      return { x: xR, y: yAbove, w, h };
    case 'belowL':
      return { x: xL, y: yBelow, w, h };
    case 'belowR':
      return { x: xR, y: yBelow, w, h };
    case 'left':
      return { x: c.cx - c.r - GAP - w, y: c.cy - h / 2, w, h };
    default:
      return { x: c.cx + c.r + GAP, y: c.cy - h / 2, w, h };
  }
}

/**
 * Offset (px) that moves the LabelLayer's own placement for alignOf(side) (anchor ± 8/10 px, see
 * core/labels.ts) onto rectFor(c, side).
 */
export function offsetFor(c: PlaceCandidate, side: Side): [number, number] {
  const r = rectFor(c, side);
  const { cx, cy, w, h } = c;
  const base: Record<Align, [number, number]> = {
    above: [cx - w / 2, cy - h - 8],
    below: [cx - w / 2, cy + 8],
    left: [cx - w - 10, cy - h / 2],
    right: [cx + 10, cy - h / 2],
  };
  const [bx, by] = base[alignOf(side)];
  return [Math.round(r.x - bx), Math.round(r.y - by)];
}

const hits = (a: Rect, b: Rect, pad: number): boolean =>
  a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;

/**
 * Greedy placement in the given order (most important first). `labels` are rects already taken
 * (fixed labels); `hard` beacons must stay clear, `soft` ones (dimmed) only when possible.
 * Beacon rects are indexed by candidate key so a label may touch its own beacon.
 */
export function placeLabels(
  cands: readonly PlaceCandidate[],
  labels: Rect[],
  hard: ReadonlyMap<number, Rect>,
  soft: ReadonlyMap<number, Rect>,
  width: number,
  height: number,
  max: number,
): Map<number, Side> {
  const out = new Map<number, Side>();
  const inside = (r: Rect) => r.x >= 4 && r.y >= 4 && r.x + r.w <= width - 4 && r.y + r.h <= height - 4;
  const clearOf = (r: Rect, set: ReadonlyMap<number, Rect>, own: number) => {
    for (const [k, b] of set) if (k !== own && hits(r, b, 1)) return false;
    return true;
  };
  const freeOfLabels = (r: Rect) => labels.every((b) => !hits(r, b, LABEL_PAD));
  for (const c of cands) {
    if (out.size >= max) break;
    const order: Side[] = c.prev ? [c.prev, ...c.prefer.filter((s) => s !== c.prev)] : [...c.prefer];
    let chosen: Side | null = null;
    // Pass 1: clear of everything; pass 2: may cover dimmed beacons. Never cover a lit beacon:
    // a label that does not fit stays hidden (hover and the cards still name every article).
    for (let pass = 0; pass < 2 && !chosen; pass++) {
      for (const s of order) {
        const r = rectFor(c, s);
        if (!inside(r) || !freeOfLabels(r) || !clearOf(r, hard, c.key)) continue;
        if (pass < 1 && !clearOf(r, soft, c.key)) continue;
        chosen = s;
        break;
      }
    }
    if (!chosen) continue;
    labels.push(rectFor(c, chosen));
    out.set(c.key, chosen);
  }
  return out;
}
