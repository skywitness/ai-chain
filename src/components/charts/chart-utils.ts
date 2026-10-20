/**
 * Shared build-time helpers for the chart components (never shipped to the client).
 *
 * Layout model: every plot has a fixed pixel height and a fluid width. Vertical positions are
 * percentages of that height (computed here), horizontal positions are percentages of the plot
 * width, so the markup is correct at any width without client JS. Text is HTML (real px sizes);
 * lines are SVG paths with non-scaling strokes inside a stretched viewBox.
 */
import { scaleLinear } from 'd3-scale';
import { line as d3line } from 'd3-shape';
import { formatNumber } from '../../lib/format';

export interface Ticks {
  domain: [number, number];
  ticks: number[];
}

/**
 * Nice linear domain and ticks. Zero is always included for magnitude charts (bars) unless
 * `includeZero` is false (margins, rates).
 */
export function niceTicks(min: number, max: number, count = 4, opts: { includeZero?: boolean; floor?: number; ceil?: number } = {}): Ticks {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (opts.includeZero !== false) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { domain: [0, 1], ticks: [0, 1] };
  if (lo === hi) {
    const pad = Math.abs(hi) || 1;
    hi += pad * 0.5;
    if (opts.includeZero === false) lo -= pad * 0.5;
  }
  const s = scaleLinear().domain([lo, hi]).nice(count);
  let [a, b] = s.domain() as [number, number];
  if (opts.floor != null) a = Math.max(a, opts.floor);
  if (opts.ceil != null) b = Math.min(b, opts.ceil);
  const ticks = scaleLinear().domain([a, b]).ticks(count).filter((t) => t >= a - 1e-9 && t <= b + 1e-9);
  return { domain: [a, b], ticks };
}

/** Position of v within the domain as a percentage (0 = bottom/left, 100 = top/right), clamped. */
export function pct(v: number, [a, b]: [number, number]): number {
  if (b === a) return 0;
  return round(Math.max(0, Math.min(100, ((v - a) / (b - a)) * 100)), 3);
}

export function round(n: number, d = 2): number {
  const k = 10 ** d;
  return Math.round(n * k) / k;
}

/** Approximate rendered width of text in `ch` units of the UI sans (digits = 1ch, CJK ≈ 2ch). */
export function textWidthCh(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (/[⺀-￯]/.test(ch)) w += 1.9;
    else if (/[0-9]/.test(ch)) w += 1;
    else if (/[,.:;'|]/.test(ch)) w += 0.5;
    else if (ch === ' ') w += 0.55;
    else if (/[%MW@]/.test(ch)) w += 1.55;
    else if (/[A-Z]/.test(ch)) w += 1.2;
    else w += 0.95;
  }
  return w;
}

/** Width of a y-axis label column for the given labels (CSS length). */
export function axisWidth(labels: readonly string[], min = 2.5): string {
  const w = Math.max(min, ...labels.map(textWidthCh));
  return `${round(w + 0.6, 1)}ch`;
}

/** Build an inline style string from CSS custom properties (skips null/undefined). */
export function vars(o: Record<string, string | number | null | undefined>): string {
  return Object.entries(o)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}

/** Categorical colour slot (1-based order, never cycled: >8 folds into the last slot). */
export function slot(i: number): string {
  return `var(--chart-${Math.min(8, Math.max(1, i + 1))})`;
}

/** Segment colour token. */
export function segColor(id: string | null | undefined): string {
  return id ? `var(--seg-${id}, var(--chart-1))` : 'var(--chart-1)';
}

/** Tooltip payload: a title line, then `label<TAB>value` rows (read by chart-tooltip.ts). */
export function tip(title: string, rows: ReadonlyArray<readonly [string, string] | null | false | undefined> = []): string {
  const r = rows.filter((x): x is readonly [string, string] => !!x && !!x[1]).map(([l, v]) => `${l}\t${v}`);
  return [title, ...r].join('\n');
}

/** SVG path for a polyline in a 0..width × 0..100 box; null values break the line. */
export function linePath(pts: ReadonlyArray<readonly [number, number | null]>): string {
  const gen = d3line<readonly [number, number | null]>()
    .defined((d) => d[1] != null && Number.isFinite(d[1]))
    .x((d) => round(d[0], 3))
    .y((d) => round(100 - (d[1] as number), 3));
  return gen(pts as Array<readonly [number, number | null]>) ?? '';
}

/** Tick label formatter for plain numbers and percents. */
export function fmtTick(v: number, opts: { percent?: boolean; digits?: number } = {}): string {
  const digits = opts.digits ?? (Number.isInteger(v) ? 0 : Math.abs(v) < 1 ? 2 : 1);
  return opts.percent ? `${formatNumber(v, { digits })}%` : formatNumber(v, { digits });
}

/** Digits needed so that every tick in a list renders distinctly. */
export function tickDigits(ticks: readonly number[]): number {
  for (let d = 0; d <= 3; d++) {
    if (ticks.every((t) => Math.abs(Number(t.toFixed(d)) - t) < 1e-9)) return d;
  }
  return 3;
}

/**
 * Spread label anchors (pixel y from top) so neighbours are at least `gap` apart, keeping them
 * inside [0, height]. Returns new positions in the same order.
 */
export function spreadLabels(ys: readonly number[], gap: number, height: number): number[] {
  const idx = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = idx.map((d) => d.y);
  for (let k = 1; k < out.length; k++) if (out[k]! - out[k - 1]! < gap) out[k] = out[k - 1]! + gap;
  const overflow = (out.at(-1) ?? 0) - height;
  if (overflow > 0) {
    out[out.length - 1]! -= overflow;
    for (let k = out.length - 2; k >= 0; k--) if (out[k + 1]! - out[k]! < gap) out[k] = out[k + 1]! - gap;
  }
  const res: number[] = new Array(ys.length);
  idx.forEach((d, k) => (res[d.i] = Math.max(0, out[k]!)));
  return res;
}

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function extent(values: ReadonlyArray<number | null | undefined>): [number, number] | null {
  const v = values.filter(isNum);
  if (!v.length) return null;
  return [Math.min(...v), Math.max(...v)];
}

/** Label every n-th tick so at most `max` axis labels show (gridlines stay). */
export function axisStep(count: number, max = 5): number {
  return Math.max(1, Math.ceil(count / max));
}
