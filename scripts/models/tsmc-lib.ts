// TSMC-specific helpers for scripts/models/tsmc.ts (pure, deterministic, no I/O).
// The quarter table (income statement, USD revenue, FX, guidance, wafer shipments, node and platform mix), the
// node-mix price index used by the revenue rule, and small statistics helpers.
import { addQ, mean, qIndex, qRange, sum } from './lib';
import type { CompanyDrivers, CompanyInputs } from '../../src/schemas/forecast';

/* ───────────── quarter table ───────────── */

export interface TQ {
  period: string;
  R: number; // revenue, NT$ million
  Ru: number; // revenue, US$ million (extra.美元營收)
  fx: number; // average NTD per USD (extra.平均匯率)
  gp: number;
  gm: number; // gross margin, %
  C: number; // cost of revenue = R − gross profit
  opex: number; // gross profit − operating income (R&D + SG&A − other operating income)
  oi: number;
  nonop: number;
  pretax: number;
  tax: number; // income tax expense (positive)
  ni: number; // net income attributable to the parent
  eps: number; // diluted EPS, NT$
  shares: number; // diluted weighted shares, millions
  D: number; // depreciation & amortisation
  W: number; // wafer shipments, thousand 12-inch equivalent
  nodes: number[]; // wafer-revenue share by node (%), in NODE_GEN order
  hpc?: number | undefined; // HPC share of revenue (%), from 2018Q1
  guide?: { R: number; usd?: number | undefined; gm: number; om?: number | undefined; fx?: number | undefined } | undefined;
}

/** Node series in drivers, with a generation index (0 = 90 nm and above … 9 = 2 nm) for the price ladder. */
export const NODE_GEN: readonly (readonly [string, number, string])[] = [
  ['node-n90-above-share', 0, '90 奈米及以上'],
  ['node-n65-share', 1, '65 奈米'],
  ['node-n40-45-share', 2, '40／45 奈米'],
  ['node-n28-share', 3, '28 奈米'],
  ['node-n16-20-share', 4, '16／20 奈米'],
  ['node-n10-share', 5, '10 奈米'],
  ['node-n7-share', 6, '7 奈米'],
  ['node-n5-share', 7, '5 奈米'],
  ['node-n3-share', 8, '3 奈米'],
  ['node-n2-share', 9, '2 奈米'],
];

const need = (v: number | undefined, what: string, p: string): number => {
  if (v === undefined || !Number.isFinite(v)) throw new Error(`tsmc inputs: ${p} lacks ${what}`);
  return v;
};

export function seriesMap(drivers: CompanyDrivers, id: string): Map<string, number> {
  const s = drivers.series.find((x) => x.id === id);
  if (!s) throw new Error(`tsmc drivers: series ${id} missing`);
  return new Map(s.points.map((p) => [p.period, p.value]));
}
export function seriesPoint(drivers: CompanyDrivers, id: string, period: string) {
  const s = drivers.series.find((x) => x.id === id);
  const p = s?.points.find((x) => x.period === period);
  if (!p) throw new Error(`tsmc drivers: ${id} ${period} missing`);
  return p;
}

export function quarterTable(inputs: CompanyInputs, drivers: CompanyDrivers): TQ[] {
  const W = seriesMap(drivers, 'wafer-shipments');
  const nodeSeries = NODE_GEN.map(([id]) => seriesMap(drivers, id));
  const hpc = seriesMap(drivers, 'platform-hpc-share');
  return inputs.quarters.map((q) => {
    const p = q.period;
    const e = q.extra ?? {};
    const gp = need(q.grossProfit, 'grossProfit', p);
    const oi = need(q.operatingIncome, 'operatingIncome', p);
    const g = q.guidance;
    return {
      period: p,
      R: q.revenue,
      Ru: need(e['美元營收'], 'extra.美元營收', p),
      fx: need(e['平均匯率'], 'extra.平均匯率', p),
      gp,
      gm: (gp / q.revenue) * 100,
      C: q.revenue - gp,
      opex: gp - oi,
      oi,
      nonop: need(q.nonOperating, 'nonOperating', p),
      pretax: need(q.pretaxIncome, 'pretaxIncome', p),
      tax: need(e['所得稅費用'], 'extra.所得稅費用', p),
      ni: need(q.netIncome, 'netIncome', p),
      eps: need(q.eps, 'eps', p),
      shares: need(q.sharesDiluted, 'sharesDiluted', p),
      D: need(q.depreciation, 'depreciation', p),
      W: need(W.get(p), 'wafer-shipments', p),
      nodes: nodeSeries.map((s) => s.get(p) ?? 0),
      hpc: hpc.get(p),
      guide: g?.revenue !== undefined && g.grossMargin !== undefined
        ? { R: g.revenue, usd: e['財測營收美元中值'], gm: g.grossMargin, om: e['財測營益率中值'], fx: e['財測匯率'] }
        : undefined,
    };
  });
}

/* ───────────── node-mix price index ───────────── */

/** H_t(γ) = Σ_n share_n × e^(−γ × generation_n) (shares normalised to 1). Average price per wafer ∝ 1 ÷ H. */
export function nodeH(r: TQ, gamma: number): number {
  const tot = sum(r.nodes);
  return sum(r.nodes.map((s, i) => (s / tot) * Math.exp(-gamma * NODE_GEN[i]![1])));
}
/** USD revenue of t from the realised wafer shipments and node mix of t: Ru_{t−1} ÷ W_{t−1} × W_t × e^δ × H_{t−1} ÷ H_t. */
export const mixRevenue = (r: TQ, q: TQ, gamma: number, delta: number) => (q.Ru / q.W) * r.W * Math.exp(delta) * (nodeH(q, gamma) / nodeH(r, gamma));

/** Grid search γ ∈ [0, 0.6] (step 0.01); δ is the mean log residual (closed form). Least squares on log errors. */
export function fitNodeMix(by: Map<string, TQ>, from: string, to: string) {
  const ps = qRange(from, to);
  let best: { gamma: number; delta: number; sse: number; n: number } | undefined;
  for (let k = 0; k <= 60; k++) {
    const gamma = k / 100;
    const res = ps.map((p) => {
      const r = by.get(p)!;
      const q = by.get(addQ(p, -1))!;
      return Math.log(r.Ru / r.W) - Math.log(q.Ru / q.W) - Math.log(nodeH(q, gamma) / nodeH(r, gamma));
    });
    const delta = mean(res);
    const sse = sum(res.map((x) => (x - delta) ** 2));
    if (!best || sse < best.sse - 1e-15) best = { gamma, delta, sse, n: ps.length };
  }
  return best!;
}
/** Same rule without the node mix (γ = 0): price per wafer grows by the average drift only. */
export function fitWaferOnly(by: Map<string, TQ>, from: string, to: string) {
  const ps = qRange(from, to);
  return mean(ps.map((p) => { const r = by.get(p)!; const q = by.get(addQ(p, -1))!; return Math.log(r.Ru / r.W) - Math.log(q.Ru / q.W); }));
}

/* ───────────── statistics ───────────── */

/** Linear-interpolated percentile (p in [0, 1]) of a sample. */
export function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo]! + (s[hi]! - s[lo]!) * (h - lo);
}
export const median = (xs: readonly number[]) => percentile(xs, 0.5);

/** Quarter-of-year seasonal log factors of a series (mean log q/q change per quarter of the year, minus the overall mean). */
export function seasonalFactors(values: Map<string, number>, from: string, to: string): { factors: number[]; trend: number; n: number[] } {
  const buckets: number[][] = [[], [], [], []];
  for (const p of qRange(from, to)) {
    const v = values.get(p);
    const u = values.get(addQ(p, -1));
    if (v === undefined || u === undefined) continue;
    buckets[qIndex(p) % 4]!.push(Math.log(v / u));
  }
  const avg = buckets.map((b) => mean(b));
  const trend = mean(avg);
  return { factors: avg.map((a) => a - trend), trend, n: buckets.map((b) => b.length) };
}
