// Shared helpers for the financial models in scripts/models/<company>.ts (pure, deterministic, no I/O).
// Each model exports buildModel(inputs, prices): ModelOutput (src/schemas/forecast.ts); its CLI entry writes
// src/data/memory/forecast/<company>-model.json. scripts/check-forecast.ts re-runs buildModel and compares.

/* ───────────── periods ───────────── */

/** "2025Q3" / "FY2026Q4" → a sortable quarter number (year × 4 + quarter − 1). */
export function qIndex(p: string): number {
  const m = p.match(/^(FY)?(\d{4})Q([1-4])$/);
  if (!m) throw new Error(`not a quarter id: ${p}`);
  return Number(m[2]) * 4 + Number(m[3]) - 1;
}
/** Inverse of qIndex, keeping the prefix style of `like` ("FY" or none). */
export function qLabel(i: number, like = ''): string {
  const fy = like.startsWith('FY') ? 'FY' : '';
  return `${fy}${Math.floor(i / 4)}Q${(i % 4) + 1}`;
}
export const addQ = (p: string, n: number) => qLabel(qIndex(p) + n, p);
export const qYear = (p: string) => Math.floor(qIndex(p) / 4);
/** Quarters from..to inclusive. */
export function qRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let i = qIndex(from); i <= qIndex(to); i++) out.push(qLabel(i, from));
  return out;
}
/** "2026-08" → "2026Q3" (calendar). */
export const monthToQuarter = (m: string) => `${m.slice(0, 4)}Q${Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1}`;

/* ───────────── series ───────────── */

export type Series = Map<string, number>;
export const seriesOf = (points: readonly { period: string; value: number }[]): Series => new Map(points.map((p) => [p.period, p.value]));

/** Chain quarter-on-quarter % changes into an index (value at `base` = baseValue). */
export function chainIndex(qoq: Series, base: string, baseValue = 100): Series {
  const periods = [...qoq.keys()].sort((a, b) => qIndex(a) - qIndex(b));
  const out: Series = new Map([[base, baseValue]]);
  // forward
  for (const p of periods.filter((x) => qIndex(x) > qIndex(base))) {
    const prev = out.get(addQ(p, -1));
    if (prev === undefined) break;
    out.set(p, prev * (1 + (qoq.get(p) ?? 0) / 100));
  }
  // backward: index_{t-1} = index_t / (1 + qoq_t)
  for (let i = qIndex(base); ; i--) {
    const p = qLabel(i, base);
    const cur = out.get(p);
    const ch = qoq.get(p);
    if (cur === undefined || ch === undefined) break;
    out.set(qLabel(i - 1, base), cur / (1 + ch / 100));
  }
  return new Map([...out.entries()].sort((a, b) => qIndex(a[0]) - qIndex(b[0])));
}
/** Weighted average of a series over lags (weights[k] applies to lag k quarters). */
export function laggedAverage(s: Series, period: string, weights: readonly number[]): number | undefined {
  let sum = 0;
  let w = 0;
  for (let k = 0; k < weights.length; k++) {
    const v = s.get(addQ(period, -k));
    if (v === undefined) return undefined;
    sum += v * weights[k]!;
    w += weights[k]!;
  }
  return w ? sum / w : undefined;
}

/* ───────────── regression ───────────── */

/** Ordinary least squares with an intercept. X: rows of regressors. Returns [intercept, ...betas]. */
export function ols(X: readonly (readonly number[])[], y: readonly number[], ridge = 0): number[] {
  const n = X.length;
  if (!n || n !== y.length) throw new Error('ols: bad dimensions');
  const k = X[0]!.length + 1;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    const row = [1, ...X[i]!];
    for (let r = 0; r < k; r++) {
      b[r]! += row[r]! * y[i]!;
      for (let c = 0; c < k; c++) A[r]![c]! += row[r]! * row[c]!;
    }
  }
  for (let r = 1; r < k; r++) A[r]![r]! += ridge; // never penalise the intercept
  return solve(A, b);
}
/** Gaussian elimination with partial pivoting. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) throw new Error('solve: singular matrix');
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let j = c; j <= n; j++) M[r]![j]! -= f * M[c]![j]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}
export const predict = (coef: readonly number[], x: readonly number[]) => coef[0]! + x.reduce((a, v, i) => a + v * coef[i + 1]!, 0);

/* ───────────── metrics ───────────── */

export interface Pair { actual: number; predicted: number }
/** Mean absolute percentage error (%), skipping actual = 0. */
export const mape = (ps: readonly Pair[]) => {
  const v = ps.filter((p) => p.actual !== 0);
  return v.length ? (100 * v.reduce((a, p) => a + Math.abs((p.predicted - p.actual) / p.actual), 0)) / v.length : NaN;
};
export const mae = (ps: readonly Pair[]) => (ps.length ? ps.reduce((a, p) => a + Math.abs(p.predicted - p.actual), 0) / ps.length : NaN);
export const bias = (ps: readonly Pair[]) => (ps.length ? ps.reduce((a, p) => a + (p.predicted - p.actual), 0) / ps.length : NaN);
export function metrics(ps: readonly Pair[], pct = true) {
  const out: { mape?: number; mae: number; bias: number; n: number } = { mae: round(mae(ps), 3), bias: round(bias(ps), 3), n: ps.length };
  if (pct) out.mape = round(mape(ps), 2);
  return out;
}

/* ───────────── numbers ───────────── */

export const round = (v: number, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : NaN);
