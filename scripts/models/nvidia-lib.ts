// NVIDIA-specific helpers for scripts/models/nvidia.ts (pure, deterministic, no I/O).
// The quarter table (income statement, data-center / edge split, provisions, guidance, the matching calendar quarter of
// hyperscaler capex), the capture-ratio rule and small statistics helpers (OLS with standard errors, percentiles).
import { addQ, mean, ols, qIndex, sum } from './lib';
import type { CompanyDrivers, CompanyInputs } from '../../src/schemas/forecast';

/* ───────────── periods ───────────── */

/** NVIDIA FY(Y)Qn ≈ calendar (Y−1)Qn shifted about one month later (nvidia-inputs.yaml periodNote). */
export const calOf = (p: string): string => {
  const m = /^FY(\d{4})Q([1-4])$/.exec(p);
  if (!m) throw new Error(`not a fiscal quarter: ${p}`);
  return `${Number(m[1]) - 1}Q${m[2]}`;
};
/** Fiscal quarter of the year (1–4). */
export const fq = (p: string): number => (qIndex(p) % 4) + 1;

/* ───────────── quarter table ───────────── */

export type ProvKind = 'total' | 'writedown' | 'none';
export interface NQ {
  period: string;
  weeks: number; // 13, or 14 in a 53-week fiscal year's fourth quarter
  R: number; // revenue, US$ million
  gp: number;
  gm: number; // GAAP gross margin, %
  opex: number;
  oi: number;
  nonop: number;
  pretax: number;
  tax: number;
  ni: number;
  eps: number; // GAAP diluted EPS (split-adjusted)
  shares: number; // diluted weighted shares, millions
  dc: number; // data-center revenue (same in the old and the FY2027 market-platform structure)
  edge: number; // revenue − data center (gaming + pro viz + auto + OEM until FY2026; Edge Computing from FY2025 restated)
  hyper?: number | undefined; // Data Center – Hyperscale (FY2025Q1 on)
  acie?: number | undefined; // Data Center – ACIE (FY2025Q1 on)
  prov: number; // inventory and excess purchase-obligation provisions charged to cost of revenue (0 when not disclosed)
  provKind: ProvKind;
  K?: number | undefined; // capex of the five hyperscalers in the matching calendar quarter (drivers)
  supply?: number | undefined; // 供應與產能承諾 at quarter end
  guide?: { R: number; lo: number; hi: number; gm: number; opex: number; issued?: string | undefined; src: string } | undefined;
}

const need = (v: number | undefined, what: string, p: string): number => {
  if (v === undefined || !Number.isFinite(v)) throw new Error(`nvidia inputs: ${p} lacks ${what}`);
  return v;
};

export function seriesMap(drivers: CompanyDrivers, id: string): Map<string, number> {
  const s = drivers.series.find((x) => x.id === id);
  if (!s) throw new Error(`nvidia drivers: series ${id} missing`);
  return new Map(s.points.map((p) => [p.period, p.value]));
}
export function seriesPoint(drivers: CompanyDrivers, id: string, period: string) {
  const p = drivers.series.find((x) => x.id === id)?.points.find((x) => x.period === period);
  if (!p) throw new Error(`nvidia drivers: ${id} ${period} missing`);
  return p;
}

const DAY = 86400000;
export function quarterTable(inputs: CompanyInputs, drivers: CompanyDrivers): NQ[] {
  const K = seriesMap(drivers, 'hyperscaler-capex-total');
  return inputs.quarters.map((q) => {
    const p = q.period;
    const e = q.extra ?? {};
    const days = Math.round((Date.parse(q.end) - Date.parse(q.start)) / DAY) + 1;
    const gp = need(q.grossProfit, 'grossProfit', p);
    const dc = need(e['資料中心營收'], 'extra.資料中心營收', p);
    const total = e['存貨與超額採購承諾提列'];
    const prov = total ?? q.inventoryWritedown ?? 0;
    const g = q.guidance;
    return {
      period: p,
      weeks: Math.round(days / 7),
      R: q.revenue,
      gp,
      gm: (gp / q.revenue) * 100,
      opex: need(q.operatingExpenses, 'operatingExpenses', p),
      oi: need(q.operatingIncome, 'operatingIncome', p),
      nonop: need(q.nonOperating, 'nonOperating', p),
      pretax: need(q.pretaxIncome, 'pretaxIncome', p),
      tax: need(e['所得稅費用'], 'extra.所得稅費用', p),
      ni: need(q.netIncome, 'netIncome', p),
      eps: need(q.eps, 'eps', p),
      shares: need(q.sharesDiluted, 'sharesDiluted', p),
      dc,
      edge: q.revenue - dc,
      hyper: e['超大規模營收'],
      acie: e['ACIE營收'],
      prov,
      provKind: total !== undefined ? 'total' : q.inventoryWritedown !== undefined ? 'writedown' : 'none',
      K: K.get(calOf(p)),
      supply: e['供應與產能承諾'],
      guide:
        g?.revenue !== undefined && g.grossMargin !== undefined
          ? { R: g.revenue, lo: need(g.revenueLow, 'guidance.revenueLow', p), hi: need(g.revenueHigh, 'guidance.revenueHigh', p), gm: g.grossMargin, opex: need(e['財測GAAP營業費用'], 'extra.財測GAAP營業費用', p), issued: g.issued, src: g.src }
          : undefined,
    };
  });
}

/** Provisions as % of revenue. */
export const provRate = (r: NQ): number => (r.prov / r.R) * 100;
/** Gross margin before inventory and purchase-obligation provisions (「核心毛利率」). */
export const coreGm = (r: NQ): number => r.gm + provRate(r);
/** Per-13-week value (a 14-week quarter scaled down). */
export const n13 = (v: number, r: { weeks: number }): number => (v * 13) / r.weeks;

/* ───────────── capture ratio ───────────── */

/**
 * Capture ratio of quarter t: data-center revenue of the last four quarters (13-week basis) ÷ the five hyperscalers'
 * capex of the matching four calendar quarters. Uses only quarters before t.
 */
export function captureRatio(by: Map<string, NQ>, t: string, lag = 0): number | undefined {
  let d = 0;
  let k = 0;
  for (let j = 1; j <= 4; j++) {
    const r = by.get(addQ(t, -j));
    const s = by.get(addQ(t, -j - lag));
    if (!r || s?.K === undefined) return undefined;
    d += n13(r.dc, r);
    k += s.K;
  }
  return d / k;
}

/* ───────────── statistics ───────────── */

/** OLS with an intercept, standard errors and t values (classical, homoskedastic). */
export function olsSE(X: readonly (readonly number[])[], y: readonly number[]) {
  const coef = ols(X, y);
  const n = y.length;
  const k = coef.length;
  const fit = X.map((row) => coef[0]! + row.reduce((a, v, i) => a + v * coef[i + 1]!, 0));
  const res = y.map((v, i) => v - fit[i]!);
  const s2 = sum(res.map((r) => r * r)) / (n - k);
  // (X'X)^-1 by Gauss–Jordan
  const A = Array.from({ length: k }, () => new Array<number>(2 * k).fill(0));
  for (const row0 of X) {
    const row = [1, ...row0];
    for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) A[r]![c]! += row[r]! * row[c]!;
  }
  for (let i = 0; i < k; i++) A[i]![k + i] = 1;
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    [A[c], A[p]] = [A[p]!, A[c]!];
    const d = A[c]![c]!;
    if (Math.abs(d) < 1e-12) throw new Error('olsSE: singular matrix');
    for (let j = 0; j < 2 * k; j++) A[c]![j]! /= d;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r]![c]!;
      for (let j = 0; j < 2 * k; j++) A[r]![j]! -= f * A[c]![j]!;
    }
  }
  const se = coef.map((_, i) => Math.sqrt(s2 * A[i]![k + i]!));
  return { coef, se, t: coef.map((c, i) => c / se[i]!), n, s2 };
}

/** Linear-interpolated percentile (p in [0, 1]). */
export function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo]! + (s[hi]! - s[lo]!) * (h - lo);
}
export const median = (xs: readonly number[]) => percentile(xs, 0.5);

/** Paired t value of a sample of differences (mean ÷ standard error). */
export function pairedT(d: readonly number[]): number {
  const m = mean(d);
  const sd = Math.sqrt(sum(d.map((v) => (v - m) ** 2)) / (d.length - 1));
  return m / (sd / Math.sqrt(d.length));
}

/** Two-sided 5% critical value of Student's t for small samples (df 1–30), else 1.96. */
export function tCrit(df: number): number {
  const T = [12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.2, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.1, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05, 2.04];
  return df >= 1 && df <= 30 ? T[df - 1]! : 1.96;
}

/** Solve Σ_{n=1..4} w_n (1 + g)^n = target for g (bisection; target in (0, ∞); weights default to 1). */
export function growthForSum(target: number, w: readonly number[] = [1, 1, 1, 1]): number {
  const f = (g: number) => sum([1, 2, 3, 4].map((n) => w[n - 1]! * (1 + g) ** n)) - target;
  let lo = -0.9;
  let hi = 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
