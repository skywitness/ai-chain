// Phison-specific helpers for scripts/models/phison.ts (pure, deterministic, no I/O).
// Core idea: Phison buys NAND (wafers and packaged flash) and holds it for several quarters before the goods are sold.
// Its cost of goods sold therefore follows the NAND contract prices of the quarters in which the inventory was bought,
// while its selling prices follow the current quarter's prices. This file turns the reported inventory and cost of sales
// into a purchase-cost index (moving weighted average or FIFO layers) and provides the shared income-statement chain
// (operating expenses → operating income → non-operating → tax → net income → EPS).
import type { CompanyInputs, MarketPrices } from '../../src/schemas/forecast';
import { addQ, chainIndex, qIndex, seriesOf, type Series } from './lib';

/* ───────────── quarterly rows ───────────── */

export interface Row {
  period: string;
  revenue: number;
  cogs: number; // 營業成本（含存貨跌價損失）
  gp: number; // 營業毛利淨額
  gm: number; // %
  opex: number;
  oi: number;
  nonop: number;
  pretax: number;
  tax: number;
  ni: number;
  eps: number;
  inv: number;
  wd: number; // 存貨跌價損失（正）／回升利益（負），已含在 cogs
  shares: number; // 基本加權股數（百萬股）＝ 淨利 ÷ 基本 EPS
}

export function rowsOf(inputs: CompanyInputs): Row[] {
  return inputs.quarters.map((q) => {
    const x = q.extra ?? {};
    const cogs = x['營業成本'];
    const tax = x['所得稅費用'];
    if (cogs === undefined || tax === undefined) throw new Error(`${q.period}: 營業成本 or 所得稅費用 missing`);
    const { grossProfit: gp, operatingExpenses: opex, operatingIncome: oi, nonOperating: nonop, pretaxIncome: pretax, netIncome: ni, eps, inventory: inv } = q;
    if ([gp, opex, oi, nonop, pretax, ni, eps, inv].some((v) => v === undefined)) throw new Error(`${q.period}: incomplete income statement`);
    return { period: q.period, revenue: q.revenue, cogs, gp: gp!, gm: (gp! / q.revenue) * 100, opex: opex!, oi: oi!, nonop: nonop!, pretax: pretax!, tax, ni: ni!, eps: eps!, inv: inv!, wd: q.inventoryWritedown ?? 0, shares: ni! / eps! };
  });
}

/** Calendar-quarter revenue from monthly revenue (only quarters with all three months). */
export function quarterlyFromMonthly(inputs: CompanyInputs): Map<string, number> {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const m of inputs.monthly) {
    const q = `${m.period.slice(0, 4)}Q${Math.floor((Number(m.period.slice(5, 7)) - 1) / 3) + 1}`;
    const a = acc.get(q) ?? { sum: 0, n: 0 };
    acc.set(q, { sum: a.sum + m.revenue, n: a.n + 1 });
  }
  return new Map([...acc].filter(([, a]) => a.n === 3).map(([q, a]) => [q, a.sum]));
}

/* ───────────── prices ───────────── */

export const PRICE_BASE = '2016Q1';
export function priceSeries(prices: MarketPrices, id: string) {
  const s = prices.series.find((x) => x.id === id);
  if (!s) throw new Error(`market-prices: series ${id} missing`);
  return s;
}
/** NAND contract-price qoq changes (%), optionally overridden/extended by scenario values. */
export function nandQoq(prices: MarketPrices, extra: Record<string, number> = {}): Series {
  const qoq = seriesOf(priceSeries(prices, 'nand-contract-qoq').points);
  for (const [p, v] of Object.entries(extra)) qoq.set(p, v);
  return qoq;
}
/** NAND contract-price index (TrendForce 整體合約價季變化串成指數，2016Q1 = 100). */
export const nandIndex = (prices: MarketPrices, extra: Record<string, number> = {}): Series => chainIndex(nandQoq(prices, extra), PRICE_BASE);

/* ───────────── inventory simulations ───────────── */
// Units are "cost units": TWD million of cost at the price index of the purchase quarter (one unit bought in quarter t
// costs P_t). Purchases_t = COGS_t + Inv_t − Inv_{t−1} (every production cost that flows through inventory). A constant
// NAND share φ of these costs cancels out of the unit-cost index, so the index can be built from total costs; φ enters
// only when the index is turned into a gross margin.

export type Method = 'wa' | 'fifo';
export interface SimState {
  method: Method;
  U: number; // units in ending inventory
  cEnd: number; // carrying cost per unit at quarter end (after write-downs)
  layers: { u: number; p: number }[]; // FIFO: u units carried at p per unit (oldest first)
  sold: number; // units sold in the quarter
}
export interface SimStep {
  period: string;
  c: number; // average purchase cost of the goods sold in the quarter (index points)
  x: number; // c ÷ current price index（購入成本指數 ÷ 售價指數）
  purchases: number; // TWD million (production costs that went into inventory)
  valueSold: number; // cost of goods sold before write-downs (TWD million)
  invValue: number; // ending inventory before any modelled write-down (TWD million)
  state: SimState;
}

/** Consume `units` from FIFO layers; returns their carrying cost. */
function takeUnits(layers: { u: number; p: number }[], units: number): number {
  let need = units;
  let cost = 0;
  while (need > 1e-12 && layers.length) {
    const L = layers[0]!;
    const take = Math.min(L.u, need);
    cost += take * L.p;
    L.u -= take;
    need -= take;
    if (L.u <= 1e-12) layers.shift();
  }
  return cost;
}
/** Consume `value` TWD of the oldest FIFO layers; returns the number of units. */
function takeValue(layers: { u: number; p: number }[], value: number): number {
  let need = value;
  let units = 0;
  while (need > 1e-9 && layers.length) {
    const L = layers[0]!;
    const v = L.u * L.p;
    if (v <= need) {
      need -= v;
      units += L.u;
      layers.shift();
    } else {
      const take = need / L.p;
      L.u -= take;
      units += take;
      need = 0;
    }
  }
  return units;
}

/** One quarter with reported numbers (history): purchases and units sold follow from COGS and inventory. */
export function stepActual(s: SimState, r: Row, prevInv: number, P: number): SimStep {
  const purchases = r.cogs + r.inv - prevInv;
  const q = Math.max(purchases, 0) / P;
  const valueSold = r.cogs - r.wd; // cost of goods sold before write-downs
  if (s.method === 'wa') {
    const c = (s.U * s.cEnd + q * P) / (s.U + q);
    const sold = valueSold / c;
    const U = Math.max(s.U + q - sold, 1e-9);
    return { period: r.period, c, x: c / P, purchases, valueSold, invValue: r.inv + r.wd, state: { ...s, U, cEnd: r.inv / U, sold, layers: [] } };
  }
  const layers = s.layers.map((L) => ({ ...L }));
  layers.push({ u: q, p: P });
  const sold = takeValue(layers, valueSold);
  const c = sold > 0 ? valueSold / sold : P;
  const rem = layers.reduce((a, L) => a + L.u * L.p, 0);
  const k = rem > 0 ? r.inv / rem : 1;
  for (const L of layers) L.p *= k; // carry the layers at the reported inventory value (write-downs, other costs)
  const U = Math.max(layers.reduce((a, L) => a + L.u, 0), 1e-9);
  return { period: r.period, c, x: c / P, purchases, valueSold, invValue: r.inv + r.wd, state: { ...s, U, cEnd: r.inv / U, sold, layers } };
}

/**
 * One projected quarter: units sold change with real volume (revenue ÷ selling-price index), and purchases at the
 * quarter's price index keep the inventory at `days` days of sales (inventory days ≈ inventory ÷ COGS × 91).
 */
export function stepProjected(s: SimState, period: string, P: number, volumeRatio: number, days: number): SimStep {
  const sold = s.sold * volumeRatio;
  const targetU = (days / 91) * sold;
  const q = Math.max(targetU - s.U + sold, 0);
  if (s.method === 'wa') {
    const c = (s.U * s.cEnd + q * P) / (s.U + q);
    const U = Math.max(s.U + q - sold, 1e-9);
    return { period, c, x: c / P, purchases: q * P, valueSold: sold * c, invValue: U * c, state: { ...s, U, cEnd: c, sold, layers: [] } };
  }
  const layers = s.layers.map((L) => ({ ...L }));
  layers.push({ u: q, p: P });
  const cost = takeUnits(layers, sold);
  const U = Math.max(layers.reduce((a, L) => a + L.u, 0), 1e-9);
  const val = layers.reduce((a, L) => a + L.u * L.p, 0);
  return { period, c: cost / sold, x: cost / sold / P, purchases: q * P, valueSold: cost, invValue: val, state: { ...s, U, cEnd: val / U, sold, layers } };
}

/** Lower of cost or market: write the ending inventory down to the market price index when it is carried above it. */
export function applyMarketFloor(st: SimStep, P: number, share: number): { wd: number; state: SimState } {
  const s = st.state;
  if (s.cEnd <= P) return { wd: 0, state: s };
  const wd = share * s.U * (s.cEnd - P);
  const cEnd = s.cEnd - wd / s.U;
  const k = cEnd / s.cEnd;
  return { wd, state: { ...s, cEnd, layers: s.layers.map((L) => ({ u: L.u, p: L.p * k })) } };
}

/** History simulation from the first reported quarter (initial unit cost = average of the two latest price levels). */
export function simulateHistory(method: Method, rows: Row[], P: Series): SimStep[] {
  const r0 = rows[0]!;
  const c0 = (P.get(addQ(r0.period, -1))! + P.get(r0.period)!) / 2;
  let s: SimState = { method, U: r0.inv / c0, cEnd: c0, layers: [{ u: r0.inv / c0, p: c0 }], sold: (r0.cogs - r0.wd) / c0 };
  const out: SimStep[] = [{ period: r0.period, c: c0, x: c0 / P.get(r0.period)!, purchases: NaN, valueSold: r0.cogs - r0.wd, invValue: r0.inv + r0.wd, state: s }];
  for (let i = 1; i < rows.length; i++) {
    const st = stepActual(s, rows[i]!, rows[i - 1]!.inv, P.get(rows[i]!.period)!);
    out.push(st);
    s = st.state;
  }
  return out;
}

/**
 * Purchase vintages of the goods sold in quarter `target`: share of the units sold that were bought in each earlier
 * quarter (history only, same flows as simulateHistory). Moving average mixes every vintage in proportion; FIFO sells
 * the oldest layers first.
 */
export function soldVintages(method: Method, rows: Row[], P: Series, target: string): Map<string, number> {
  const r0 = rows[0]!;
  const c0 = (P.get(addQ(r0.period, -1))! + P.get(r0.period)!) / 2;
  const start = `≤${r0.period}`;
  let U = r0.inv / c0;
  let cEnd = c0;
  let comp = new Map<string, number>([[start, 1]]); // WA: composition of the units on hand
  let layers: { u: number; p: number; from: string }[] = [{ u: U, p: c0, from: start }]; // FIFO
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const Pt = P.get(r.period)!;
    const q = Math.max(r.cogs + r.inv - rows[i - 1]!.inv, 0) / Pt;
    const valueSold = r.cogs - r.wd;
    if (method === 'wa') {
      const c = (U * cEnd + q * Pt) / (U + q);
      const mixed = new Map<string, number>();
      for (const [k, v] of comp) mixed.set(k, (v * U) / (U + q));
      mixed.set(r.period, (mixed.get(r.period) ?? 0) + q / (U + q));
      if (r.period === target) return mixed;
      comp = mixed;
      U = Math.max(U + q - valueSold / c, 1e-9);
      cEnd = r.inv / U;
    } else {
      layers.push({ u: q, p: Pt, from: r.period });
      let need = valueSold;
      const sold = new Map<string, number>();
      let units = 0;
      while (need > 1e-9 && layers.length) {
        const L = layers[0]!;
        const take = Math.min(L.u, need / L.p);
        sold.set(L.from, (sold.get(L.from) ?? 0) + take);
        units += take;
        need -= take * L.p;
        L.u -= take;
        if (L.u <= 1e-12) layers.shift();
      }
      if (r.period === target) return new Map([...sold].map(([k, v]) => [k, v / units]));
      const rem = layers.reduce((a, L) => a + L.u * L.p, 0);
      for (const L of layers) L.p *= rem > 0 ? r.inv / rem : 1;
    }
  }
  throw new Error(`soldVintages: ${target} not found`);
}

/* ───────────── cost index with fixed lag weights ───────────── */

/** Geometric lag weights: C_t = λ P_t + (1 − λ) C_{t−1}, i.e. w_k = λ (1 − λ)^k (mean lag (1 − λ) ÷ λ quarters). */
export function emaIndex(P: Series, lambda: number): Series {
  const out: Series = new Map();
  let c: number | undefined;
  for (const [p, v] of P) {
    c = c === undefined ? v : (1 - lambda) * c + lambda * v;
    out.set(p, c);
  }
  return out;
}

/* ───────────── shared income-statement chain ───────────── */

export interface ChainParams {
  opexBeta: number; // Δ營業費用 = 基本成長 × 上季營業費用 + β × Δ毛利
  opexDrift: number;
}
/** Fit Δopex_t = d × opex_{t−1} + β × ΔGP_t (least squares without intercept), skipping pairs that touch `exclude`. */
export function fitOpex(rows: Row[], periods: readonly string[], exclude: ReadonlySet<string>): ChainParams & { n: number } {
  const by = new Map(rows.map((r) => [r.period, r]));
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0, n = 0;
  for (const p of periods) {
    const r = by.get(p);
    const q = by.get(addQ(p, -1));
    if (!r || !q || exclude.has(p) || exclude.has(q.period)) continue;
    const u = q.opex, v = r.gp - q.gp, y = r.opex - q.opex;
    a11 += u * u; a12 += u * v; a22 += v * v; b1 += u * y; b2 += v * y; n++;
  }
  const det = a11 * a22 - a12 * a12;
  return { opexDrift: (b1 * a22 - b2 * a12) / det, opexBeta: (a11 * b2 - a12 * b1) / det, n };
}

export interface ChainState {
  opexPrev: number; // last quarter's operating expenses (one-off items removed)
  gpPrev: number;
  nonop: number; // assumed non-operating income for the quarter
  taxRate: number; // effective tax rate (0–1)
  niRatio: number; // net income attributable ÷ (pretax − tax)
  shares: number; // basic weighted shares (million)
}
/** What is known at the end of quarter `last`: trailing four quarters for non-operating (median), tax and minority share. */
export function chainStateAt(rows: readonly Row[], last: string, opexOneOff: ReadonlyMap<string, number>): ChainState {
  const i = rows.findIndex((r) => r.period === last);
  if (i < 3) throw new Error(`chainStateAt: not enough history before ${last}`);
  const win = rows.slice(i - 3, i + 1);
  const sorted = win.map((r) => r.nonop).sort((a, b) => a - b);
  const pre = win.reduce((a, r) => a + r.pretax, 0);
  const tax = win.reduce((a, r) => a + r.tax, 0);
  const ni = win.reduce((a, r) => a + r.ni, 0);
  const r = rows[i]!;
  return { opexPrev: r.opex - (opexOneOff.get(r.period) ?? 0), gpPrev: r.gp, nonop: (sorted[1]! + sorted[2]!) / 2, taxRate: tax / pre, niRatio: ni / (pre - tax), shares: r.shares };
}

export interface PnL { revenue: number; gm: number; gp: number; opex: number; oi: number; nonop: number; pretax: number; ni: number; eps: number }
export function runChain(revenue: number, gm: number, st: ChainState, cp: ChainParams): PnL {
  const gp = (revenue * gm) / 100;
  const opex = st.opexPrev * (1 + cp.opexDrift) + cp.opexBeta * (gp - st.gpPrev);
  const oi = gp - opex;
  const pretax = oi + st.nonop;
  const ni = pretax * (1 - st.taxRate) * st.niRatio;
  return { revenue, gm, gp, opex, oi, nonop: st.nonop, pretax, ni, eps: ni / st.shares };
}
/** Carry the chain state forward one quarter on modelled numbers. */
export const nextChainState = (st: ChainState, p: PnL): ChainState => ({ ...st, opexPrev: p.opex, gpPrev: p.gp });

export const between = (p: string, from: string, to: string) => qIndex(p) >= qIndex(from) && qIndex(p) <= qIndex(to);
