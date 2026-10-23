// Micron-specific helpers for scripts/models/micron.ts (pure, deterministic, no I/O).
// Fiscal ↔ calendar mapping of TrendForce contract prices, the quarter table used by the model,
// the bit-volume index, the HBM wafer-equivalent factor and the depreciation (capex → D&A) recursion.
import { addQ, chainIndex, qIndex, seriesOf, type Series } from './lib';
import type { CompanyInputs, MarketPrices } from '../../src/schemas/forecast';

/* ───────────── quarter table ───────────── */

export interface MQ {
  period: string;
  weeks: number; // 13, or 14 in a 53-week year
  revenue: number;
  gm: number; // non-GAAP gross margin, % (FY2016Q1: GAAP, not disclosed)
  gmGaap: number; // %
  cogs: number; // non-GAAP cost of goods sold = revenue × (1 − gm)
  dram: number;
  nand: number;
  other: number;
  bD: number; // DRAM bit shipments q/q, %
  aD: number; // DRAM ASP q/q, %
  bN: number;
  aN: number;
  da: number; // depreciation & amortisation
  capex: number; // net capex (gross purchases where net is not disclosed)
  u: number; // underutilisation charges in COGS
  w: number; // inventory write-down in COGS
  wb: number; // later COGS benefit from selling written-down inventory
  opex: number; // GAAP operating expenses
  oi: number; // GAAP operating income
  nonOp: number;
  pretax: number;
  ni: number; // GAAP net income
  eps: number; // GAAP diluted EPS
  epsNg: number; // non-GAAP diluted EPS
  shares: number; // diluted, millions
  guidance?: { revenue?: number | undefined; grossMargin?: number | undefined; eps?: number | undefined } | undefined;
}

const need = (v: number | undefined, what: string, p: string): number => {
  if (v === undefined || !Number.isFinite(v)) throw new Error(`micron inputs: ${p} lacks ${what}`);
  return v;
};

export function quarterTable(inputs: CompanyInputs): MQ[] {
  return inputs.quarters.map((q) => {
    const p = q.period;
    const revenue = q.revenue;
    const gp = need(q.grossProfit, 'grossProfit', p);
    const gmGaap = (gp / revenue) * 100;
    const gm = q.grossMarginNonGaap ?? gmGaap;
    const dram = need(q.dramRevenue, 'dramRevenue', p);
    const nand = need(q.nandRevenue, 'nandRevenue', p);
    const g = q.guidance;
    return {
      period: p,
      weeks: q.extra?.['週數'] ?? 13,
      revenue,
      gm,
      gmGaap,
      cogs: revenue * (1 - gm / 100),
      dram,
      nand,
      other: revenue - dram - nand,
      bD: need(q.dramBitQoq, 'dramBitQoq', p),
      aD: need(q.dramAspQoq, 'dramAspQoq', p),
      bN: need(q.nandBitQoq, 'nandBitQoq', p),
      aN: need(q.nandAspQoq, 'nandAspQoq', p),
      da: need(q.depreciation, 'depreciation', p),
      capex: need(q.capex ?? q.extra?.['資本支出總額'], 'capex', p),
      u: q.underutilization ?? 0,
      w: q.inventoryWritedown ?? 0,
      wb: q.extra?.['已跌價存貨售出降低成本'] ?? 0,
      opex: need(q.operatingExpenses, 'operatingExpenses', p),
      oi: need(q.operatingIncome, 'operatingIncome', p),
      nonOp: need(q.nonOperating, 'nonOperating', p),
      pretax: need(q.pretaxIncome, 'pretaxIncome', p),
      ni: need(q.netIncome, 'netIncome', p),
      eps: need(q.eps, 'eps', p),
      epsNg: need(q.epsNonGaap, 'epsNonGaap', p),
      shares: need(q.sharesDiluted, 'sharesDiluted', p),
      guidance: g && g.basis === 'non-GAAP' ? { revenue: g.revenue, grossMargin: g.grossMargin, eps: g.eps } : undefined,
    };
  });
}

/* ───────────── calendar contract prices → Micron fiscal quarters ───────────── */

/** Micron fiscal quarter → the two calendar quarters it overlaps: [one month, two months].
 *  FQ1 = Sep–Nov (CQ3 Sep + CQ4 Oct–Nov), FQ2 = Dec–Feb, FQ3 = Mar–May, FQ4 = Jun–Aug. */
export function fiscalToCalendar(fq: string): [string, string] {
  const m = fq.match(/^FY(\d{4})Q([1-4])$/);
  if (!m) throw new Error(`not a fiscal quarter: ${fq}`);
  const y = Number(m[1]);
  const k = Number(m[2]);
  if (k === 1) return [`${y - 1}Q3`, `${y - 1}Q4`];
  if (k === 2) return [`${y - 1}Q4`, `${y}Q1`];
  if (k === 3) return [`${y}Q1`, `${y}Q2`];
  return [`${y}Q2`, `${y}Q3`];
}

/** Calendar price index from q/q changes (%), optionally overriding / extending some quarters. */
export function calendarIndex(qoq: Series, extend: Record<string, number> = {}): Series {
  const s: Series = new Map(qoq);
  for (const [p, v] of Object.entries(extend)) s.set(p, v);
  const first = [...s.keys()].sort((a, b) => qIndex(a) - qIndex(b))[0]!;
  return chainIndex(s, first);
}

/** Fiscal-quarter price level = (1 × level of the 1-month calendar quarter + 2 × level of the 2-month one) ÷ 3. */
export function fiscalLevel(idx: Series, fq: string): number | undefined {
  const [a, b] = fiscalToCalendar(fq);
  const va = idx.get(a);
  const vb = idx.get(b);
  return va === undefined || vb === undefined ? undefined : (va + 2 * vb) / 3;
}
/** Fiscal-quarter q/q change of a calendar price index, %. */
export function fiscalChange(idx: Series, fq: string): number | undefined {
  const l = fiscalLevel(idx, fq);
  const p = fiscalLevel(idx, addQ(fq, -1));
  return l === undefined || p === undefined ? undefined : (l / p - 1) * 100;
}

/** Same as fiscalChange but with weight `wEarly` on the earlier (one-month) calendar quarter; fiscalChange ≡ wEarly = 1/3. */
export function fiscalChangeW(idx: Series, fq: string, wEarly: number): number | undefined {
  const lv = (q: string) => {
    const [a, b] = fiscalToCalendar(q);
    const va = idx.get(a);
    const vb = idx.get(b);
    return va === undefined || vb === undefined ? undefined : wEarly * va + (1 - wEarly) * vb;
  };
  const l = lv(fq);
  const p = lv(addQ(fq, -1));
  return l === undefined || p === undefined ? undefined : (l / p - 1) * 100;
}

export function priceSeries(prices: MarketPrices, id: string): Series {
  const s = prices.series.find((x) => x.id === id);
  if (!s) throw new Error(`market-prices: series ${id} missing`);
  return seriesOf(s.points);
}
/** Conventional DRAM before `from`, HBM-blended DRAM from `from` on (TrendForce splits them from 2024Q3). */
export function splice(base: Series, blended: Series, from: string): Series {
  const out: Series = new Map();
  for (const [p, v] of base) if (qIndex(p) < qIndex(from)) out.set(p, v);
  for (const [p, v] of blended) if (qIndex(p) >= qIndex(from)) out.set(p, v);
  return out;
}

/* ───────────── HBM wafer-equivalent factor ───────────── */

/** Piecewise-linear path in quarter space, flat beyond both ends. points: [period, value][] sorted. */
export function pathValue(points: readonly (readonly [string, number])[], p: string): number {
  const i = qIndex(p);
  if (i <= qIndex(points[0]![0])) return points[0]![1];
  for (let k = 1; k < points.length; k++) {
    const [p1, v1] = points[k]!;
    const [p0, v0] = points[k - 1]!;
    if (i <= qIndex(p1)) return v0 + ((v1 - v0) * (i - qIndex(p0))) / (qIndex(p1) - qIndex(p0));
  }
  return points.at(-1)![1];
}
/** DRAM wafer-equivalent multiplier: 1 + (tradeRatio − 1) × HBM share of DRAM bits. */
export const hbmFactor = (share: number, tradeRatio: number) => 1 + (tradeRatio - 1) * (share / 100);

/* ───────────── depreciation ───────────── */

/** One-quarter D&A step on a 13-week basis: D_t = D_{t−1} + θ × (mean net capex of the previous 4 quarters − D_{t−1}). */
export function daStep(prevDa13: number, capexLags13: readonly number[], theta: number): number {
  const avg = capexLags13.reduce((a, b) => a + b, 0) / capexLags13.length;
  return prevDa13 + theta * (avg - prevDa13);
}
