/**
 * The illustrative (示意) scaling-law surface and its world mapping.
 *
 * Loss uses the functional form fitted in the Chinchilla paper (Hoffmann et al., 2022):
 *     L(N, D) = E + A / N^α + B / D^β
 * with α = β and B = A · 20^α, so that for every compute budget C ≈ 6ND the loss-minimising split
 * is exactly D / N = 20 (the "about 20 tokens per parameter" rule). The constants are illustrative;
 * the scene labels every loss value as 示意 and never shows them as measurements.
 *
 * Axes (all log10): N = parameters 10^8 … 10^12, D = training tokens 10^9 … 10^13.
 * World: N along +x, D along +z (toward the default camera), height y = (L − E) · Y_SCALE, so the
 * floor y = 0 is the irreducible loss E. One decade is 1.5 world units on both axes, so iso-compute
 * lines (lgN + lgD = const) are straight 45° lines and the optimal ridge is the perpendicular diagonal.
 */

export const LG_N = [8, 12] as const;
export const LG_D = [9, 13] as const;
export const TOKENS_PER_PARAM = 20;
export const LG_RATIO = Math.log10(TOKENS_PER_PARAM);
export const LG6 = Math.log10(6);

const ALPHA = 0.34;
const A = 406.4;
const B = A * TOKENS_PER_PARAM ** ALPHA;
export const E = 1.69;

export const HALF = 3;
const SPAN = 2 * HALF;
const PER_DECADE = SPAN / 4;
export const Y_SCALE = 1.55;

/** Loss (示意) at log10 parameters / log10 tokens. */
export const loss = (lgN: number, lgD: number): number => E + A * 10 ** (-ALPHA * lgN) + B * 10 ** (-ALPHA * lgD);

export const wx = (lgN: number): number => -HALF + (lgN - LG_N[0]) * PER_DECADE;
export const wz = (lgD: number): number => -HALF + (lgD - LG_D[0]) * PER_DECADE;
export const wy = (L: number): number => (L - E) * Y_SCALE;
export const lgNofX = (x: number): number => LG_N[0] + (x + HALF) / PER_DECADE;
export const lgDofZ = (z: number): number => LG_D[0] + (z + HALF) / PER_DECADE;
/** Height of the surface above the floor at (lgN, lgD). */
export const height = (lgN: number, lgD: number): number => wy(loss(lgN, lgD));
export const Y_MAX = height(LG_N[0], LG_D[0]);

/** log10 of training compute, C ≈ 6·N·D FLOP. */
export const lgCompute = (lgN: number, lgD: number): number => LG6 + lgN + lgD;

/** Loss-minimising (lgN, lgD) for a budget lgC (on the ridge D = 20N). */
export function optimum(lgC: number): { lgN: number; lgD: number } {
  const lgN = (lgC - LG6 - LG_RATIO) / 2;
  return { lgN, lgD: lgN + LG_RATIO };
}

/** The part of the iso-compute line lgN + lgD = lgC − lg6 inside the domain, as an lgN interval. */
export function isoSpan(lgC: number): [number, number] | null {
  const s = lgC - LG6;
  const a = Math.max(LG_N[0], s - LG_D[1]);
  const b = Math.min(LG_N[1], s - LG_D[0]);
  return b - a > 1e-3 ? [a, b] : null;
}

/** lgN of the ridge point (D = 20N) whose loss equals L: L = E + 2A·N^−α. */
export const ridgeLgNForLoss = (L: number): number => Math.log10((2 * A) / (L - E)) / ALPHA;

/** lgD on the iso-loss curve through L at a given lgN (null when it leaves the domain). */
export function isoLossLgD(L: number, lgN: number): number | null {
  const rest = L - E - A * 10 ** (-ALPHA * lgN);
  if (rest <= 0) return null;
  const lgD = -Math.log10(rest / B) / ALPHA;
  return lgD >= LG_D[0] - 1e-6 && lgD <= LG_D[1] + 1e-6 ? lgD : null;
}

/* ───────── zh-TW number formatting ───────── */

const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const sup = (n: number): string =>
  String(n)
    .split('')
    .map((d) => SUP[Number(d)] ?? d)
    .join('');

/** 2 significant digits with 萬／億／兆 units: 9.1e9 → 「91 億」, 1.83e11 → 「1,800 億」. */
export function zhCount(v: number): string {
  const units: [number, string][] = [
    [1e12, '兆'],
    [1e8, '億'],
    [1e4, '萬'],
  ];
  const [div, unit] = units.find(([d]) => v >= d) ?? [1, ''];
  const x = v / div;
  const p = 10 ** (Math.floor(Math.log10(x)) - 1);
  const r = Math.round(x / p) * p;
  const s = r.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return unit ? `${s} ${unit}` : s;
}

/** Scientific notation for compute: 21.8 → 「6.3×10²¹」 (and a spoken form for aria-valuetext). */
export function sci(lg: number): { text: string; spoken: string } {
  let e = Math.floor(lg);
  let m = Math.round(10 ** (lg - e) * 10) / 10;
  if (m >= 10) {
    m = 1;
    e += 1;
  }
  const ms = Number.isInteger(m) ? String(m) : m.toFixed(1);
  return { text: `${ms}×10${sup(e)}`, spoken: `${ms} 乘以 10 的 ${e} 次方` };
}

/** Tokens per parameter, rounded for display. */
export const ratioText = (lgN: number, lgD: number): string => {
  const r = 10 ** (lgD - lgN);
  return r >= 100 ? (Math.round(r / 10) * 10).toLocaleString('en-US') : String(Math.round(r));
};
