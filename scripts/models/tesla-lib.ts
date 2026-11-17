// Tesla-specific helpers for scripts/models/tesla.ts (pure, deterministic, no I/O).
// The quarter table (segment revenue and cost, deliveries, storage deployments), the one-quarter "unit" step that
// rebuilds revenue and gross profit segment by segment, and the least-squares fits of its parameters.
import { addQ, mean, ols, qIndex, qRange } from './lib';
import type { CompanyDrivers, CompanyInputs } from '../../src/schemas/forecast';

/* ───────────── quarter table ───────────── */

/** Segment amounts in US$ million; deliveries in vehicles; storage in GWh. */
export interface TQ {
  period: string;
  rev: number;
  gp: number;
  gm: number; // %
  opex: number;
  oi: number;
  nonOp: number;
  pretax: number;
  ni: number;
  eps: number;
  shares: number;
  da: number;
  capex: number;
  rd: number;
  sga: number;
  /** Automotive sales revenue, excluding regulatory credits and leasing (includes FSD and other ancillary sales). */
  autoSales: number;
  autoSalesC: number;
  credits: number;
  lease: number;
  leaseC: number;
  en: number; // energy generation & storage revenue
  enC: number;
  sv: number; // services & other revenue
  svC: number;
  D: number; // total deliveries
  L: number; // deliveries subject to operating-lease accounting
  N: number; // D − L: vehicles whose sale is recognised as automotive sales revenue
  sO: number; // share of "other models" (Model S/X, Cybertruck …) in deliveries
  gwh: number; // storage deployed
  asp: number; // autoSales ÷ N, US$ per vehicle
  cpv: number; // autoSalesC ÷ N, US$ per vehicle
}

const need = (v: number | undefined, what: string, p: string): number => {
  if (v === undefined || !Number.isFinite(v)) throw new Error(`tesla inputs: ${p} lacks ${what}`);
  return v;
};

export type DriverMap = Map<string, Map<string, number>>;
export function driverMap(drivers: CompanyDrivers): DriverMap {
  return new Map(drivers.series.map((s) => [s.id, new Map(s.points.map((p) => [p.period, p.value]))]));
}
export const driver = (dm: DriverMap, id: string): Map<string, number> => {
  const s = dm.get(id);
  if (!s) throw new Error(`tesla drivers: series ${id} missing`);
  return s;
};

/** Quarters from `from` to the last reported quarter, with every field the model needs. */
export function quarterTable(inputs: CompanyInputs, dm: DriverMap, from: string): TQ[] {
  const D = driver(dm, 'deliveries-total');
  const L = driver(dm, 'deliveries-leased');
  const DO = driver(dm, 'deliveries-other');
  const G = driver(dm, 'storage-deployed');
  return inputs.quarters
    .filter((q) => qIndex(q.period) >= qIndex(from))
    .map((q) => {
      const p = q.period;
      const x = q.extra ?? {};
      const e = (k: string) => need(x[k], `extra.${k}`, p);
      const d = need(D.get(p), 'deliveries-total', p);
      const l = need(L.get(p), 'deliveries-leased', p);
      const N = d - l;
      const autoSales = e('汽車銷售營收');
      const autoSalesC = e('汽車銷售成本');
      const gp = need(q.grossProfit, 'grossProfit', p);
      return {
        period: p,
        rev: q.revenue,
        gp,
        gm: (100 * gp) / q.revenue,
        opex: need(q.operatingExpenses, 'operatingExpenses', p),
        oi: need(q.operatingIncome, 'operatingIncome', p),
        nonOp: need(q.nonOperating, 'nonOperating', p),
        pretax: need(q.pretaxIncome, 'pretaxIncome', p),
        ni: need(q.netIncome, 'netIncome', p),
        eps: need(q.eps, 'eps', p),
        shares: need(q.sharesDiluted, 'sharesDiluted', p),
        da: need(q.depreciation, 'depreciation', p),
        capex: need(q.capex, 'capex', p),
        rd: e('研發費用'),
        sga: e('銷管費用'),
        autoSales,
        autoSalesC,
        credits: e('監管積分營收'),
        lease: e('汽車租賃營收'),
        leaseC: e('汽車租賃成本'),
        en: e('能源營收'),
        enC: e('能源營業成本'),
        sv: e('服務及其他營收'),
        svC: e('服務及其他營業成本'),
        D: d,
        L: l,
        N,
        sO: need(DO.get(p), 'deliveries-other', p) / d,
        gwh: need(G.get(p), 'storage-deployed', p),
        asp: (autoSales * 1e6) / N,
        cpv: (autoSalesC * 1e6) / N,
      };
    });
}

/* ───────────── the unit step ───────────── */

/** Parameters of the unit model (log changes per quarter). */
export interface UnitParams {
  a0: number; // ASP drift
  aMix: number; // ASP response to the change in the other-model share
  c0: number; // cost-per-vehicle drift
  cVol: number; // cost-per-vehicle elasticity to the vehicle count (fixed-cost absorption)
  cMix: number; // cost-per-vehicle response to the change in the other-model share
  e0: number; // energy revenue drift
  e1: number; // energy revenue elasticity to storage deployments
  enRule: GmRule; // energy gross margin: previous quarter or trailing four quarters
  svRule: GmRule; // services & other gross margin
  svGrowth: boolean; // services & other revenue grows at its trailing 8-quarter mean log growth (else flat)
}
export type GmRule = 'last' | 'ttm';
/** "Scale last quarter": ASP, cost per vehicle and revenue per kWh unchanged; every other segment flat. */
export const BASIC: UnitParams = { a0: 0, aMix: 0, c0: 0, cVol: 0, cMix: 0, e0: 0, e1: 1, enRule: 'last', svRule: 'last', svGrowth: false };

/** Quarter drivers: known from the production & deliveries report (≈ 2 days after the quarter) or assumed. */
export interface Drv { period: string; D: number; L: number; sO: number; gwh: number }
/** Rules derived from the history up to the previous quarter. */
export interface Rules { enGm: number; svGm: number; svG: number }
/** Scenario and sensitivity overrides. */
export interface Over {
  aspAdd?: number; // extra log change of the ASP per quarter
  cpvAdd?: number; // extra log change of the cost per vehicle per quarter
  credits?: number; // regulatory-credit revenue (US$ million)
  lease?: number;
}

const gmOf = (rows: readonly TQ[], rev: (r: TQ) => number, cost: (r: TQ) => number, rule: GmRule) => {
  const use = rule === 'last' ? rows.slice(-1) : rows.slice(-4);
  const R = use.reduce((a, r) => a + rev(r), 0);
  return (100 * (R - use.reduce((a, r) => a + cost(r), 0))) / R;
};
/** Margins and services growth from the quarters known at the start of the quarter (hist ends at t − 1). */
export function rulesAt(hist: readonly TQ[], P: UnitParams): Rules {
  const sv = hist.slice(-9).map((r) => r.sv);
  const g = sv.slice(1).map((v, i) => Math.log(v / sv[i]!));
  return {
    enGm: gmOf(hist, (r) => r.en, (r) => r.enC, P.enRule),
    svGm: gmOf(hist, (r) => r.sv, (r) => r.svC, P.svRule),
    svG: P.svGrowth ? mean(g) : 0,
  };
}

/** One quarter: automotive sales = vehicles × ASP, cost = vehicles × cost per vehicle; credits and leasing as last
 *  quarter; energy revenue scales with deployments; services & other grows at its trend; margins from `r`. */
export function step(prev: TQ, d: Drv, P: UnitParams, r: Rules, o: Over = {}): TQ {
  const N = d.D - d.L;
  const dlnN = Math.log(N / prev.N);
  const dsO = d.sO - prev.sO;
  const asp = prev.asp * Math.exp(P.a0 + P.aMix * dsO + (o.aspAdd ?? 0));
  const cpv = prev.cpv * Math.exp(P.c0 + P.cVol * dlnN + P.cMix * dsO + (o.cpvAdd ?? 0));
  const autoSales = (N * asp) / 1e6;
  const autoSalesC = (N * cpv) / 1e6;
  const credits = o.credits ?? prev.credits;
  const lease = o.lease ?? prev.lease;
  const leaseC = lease * (prev.leaseC / prev.lease);
  const en = prev.en * Math.exp(P.e0 + P.e1 * Math.log(d.gwh / prev.gwh));
  const enC = en * (1 - r.enGm / 100);
  const sv = prev.sv * Math.exp(r.svG);
  const svC = sv * (1 - r.svGm / 100);
  const rev = autoSales + credits + lease + en + sv;
  const gp = rev - autoSalesC - leaseC - enC - svC;
  return {
    ...prev, period: d.period, rev, gp, gm: (100 * gp) / rev,
    autoSales, autoSalesC, credits, lease, leaseC, en, enC, sv, svC,
    D: d.D, L: d.L, N, sO: d.sO, gwh: d.gwh, asp, cpv,
  };
}
export const drvOf = (r: TQ): Drv => ({ period: r.period, D: r.D, L: r.L, sO: r.sO, gwh: r.gwh });

/* ───────────── fits (only quarters from..to) ───────────── */

export interface Fit { P: UnitParams; n: number; r2: { asp: number; cpv: number; en: number }; ruleErr: { en: Record<GmRule, number>; sv: Record<GmRule, number> } }

const r2 = (y: number[], yhat: number[]) => {
  const m = mean(y);
  const ss = y.reduce((a, v) => a + (v - m) ** 2, 0);
  return 1 - y.reduce((a, v, i) => a + (v - yhat[i]!) ** 2, 0) / ss;
};

/** Regressions of the log changes of ASP, cost per vehicle and energy revenue, and the margin rules chosen by the
 *  one-quarter-ahead mean absolute error of segment gross profit in the same window. */
export function fitUnit(by: Map<string, TQ>, from: string, to: string): Fit {
  const ps = qRange(from, to);
  const cur = ps.map((p) => by.get(p)!);
  const pre = ps.map((p) => by.get(addQ(p, -1))!);
  const dsO = cur.map((c, i) => c.sO - pre[i]!.sO);
  const dlnN = cur.map((c, i) => Math.log(c.N / pre[i]!.N));
  const yA = cur.map((c, i) => Math.log(c.asp / pre[i]!.asp));
  const yC = cur.map((c, i) => Math.log(c.cpv / pre[i]!.cpv));
  const xE = cur.map((c, i) => Math.log(c.gwh / pre[i]!.gwh));
  const yE = cur.map((c, i) => Math.log(c.en / pre[i]!.en));
  const a = ols(dsO.map((v) => [v]), yA);
  const c = ols(dlnN.map((v, i) => [v, dsO[i]!]), yC);
  const e = ols(xE.map((v) => [v]), yE);
  const ruleErr = { en: { last: 0, ttm: 0 }, sv: { last: 0, ttm: 0 } };
  for (const rule of ['last', 'ttm'] as const) {
    const P = { ...BASIC, enRule: rule, svRule: rule };
    let ee = 0;
    let es = 0;
    for (const p of ps) {
      const hist = histTo(by, addQ(p, -1));
      const r = rulesAt(hist, P);
      const a2 = by.get(p)!;
      ee += Math.abs(a2.en * (r.enGm / 100) - (a2.en - a2.enC));
      es += Math.abs(a2.sv * (r.svGm / 100) - (a2.sv - a2.svC));
    }
    ruleErr.en[rule] = ee / ps.length;
    ruleErr.sv[rule] = es / ps.length;
  }
  const pick = (x: Record<GmRule, number>): GmRule => (x.ttm < x.last ? 'ttm' : 'last');
  return {
    P: { a0: a[0]!, aMix: a[1]!, c0: c[0]!, cVol: c[1]!, cMix: c[2]!, e0: e[0]!, e1: e[1]!, enRule: pick(ruleErr.en), svRule: pick(ruleErr.sv), svGrowth: true },
    n: ps.length,
    r2: {
      asp: r2(yA, dsO.map((v) => a[0]! + a[1]! * v)),
      cpv: r2(yC, dlnN.map((v, i) => c[0]! + c[1]! * v + c[2]! * dsO[i]!)),
      en: r2(yE, xE.map((v) => e[0]! + e[1]! * v)),
    },
    ruleErr,
  };
}

/** Rows up to and including `to`, in order. */
export function histTo(by: Map<string, TQ>, to: string): TQ[] {
  return [...by.values()].filter((r) => qIndex(r.period) <= qIndex(to)).sort((x, y) => qIndex(x.period) - qIndex(y.period));
}

/** Simple regression benchmark: revenue growth on delivery and deployment growth; gross margin on its lag and delivery growth. */
export function fitRegression(by: Map<string, TQ>, from: string, to: string) {
  const ps = qRange(from, to);
  const X = ps.map((p) => { const c = by.get(p)!; const q = by.get(addQ(p, -1))!; return [Math.log(c.D / q.D), Math.log(c.gwh / q.gwh)]; });
  const rev = ols(X, ps.map((p) => Math.log(by.get(p)!.rev / by.get(addQ(p, -1))!.rev)));
  const gm = ols(ps.map((p, i) => [by.get(addQ(p, -1))!.gm, X[i]![0]!]), ps.map((p) => by.get(p)!.gm));
  return { rev, gm, n: ps.length };
}

/** Seasonal driver rule known before the quarter: the same quarter a year earlier × the trailing four-quarter growth. */
export function seasonalGuess(s: (p: string) => number, p: string): number {
  const sum4 = (end: string) => [0, 1, 2, 3].reduce((a, k) => a + s(addQ(end, -k)), 0);
  return s(addQ(p, -4)) * (sum4(addQ(p, -1)) / sum4(addQ(p, -5)));
}
