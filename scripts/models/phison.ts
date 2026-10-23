// 群聯（8299）財報模型：用 NAND 合約價推估「購入成本」，再對應到存貨賣出的季度，推估毛利率與獲利。
//   npx tsx scripts/models/phison.ts   → writes src/data/memory/forecast/phison-model.json
// buildModel(inputs, prices) is pure and deterministic; scripts/check-forecast.ts re-runs it and compares with the JSON.
//
// Steps
//  1. Price index P_t: TrendForce NAND Flash contract-price qoq changes chained into an index (2016Q1 = 100).
//  2. Purchase-cost index c_t: an inventory simulation in "cost units" driven by the reported cost of sales and inventory
//     (purchases_t = COGS_t + Inv_t − Inv_{t−1}, bought at P_t); moving weighted average or FIFO layers.
//  3. Gross margin: cost ratio_t = cost ratio_{t−1} × [(1 − φ) + φ × x_t ÷ x_{t−1}], x = c ÷ P (purchase cost ÷ current
//     selling-price index), φ = NAND/material share of cost of sales from the annual reports; plus a lower-of-cost-or-market
//     write-down rule.
//  4. Revenue: price × volume; operating expenses, non-operating income, tax and share count from a shared chain.
//  5. Candidates are fitted on 2017Q1–2024Q4 and tested one quarter ahead on 2025Q1–2026Q2; the best (lowest
//     gross-margin MAE, ties by EPS MAE) is re-fitted on all data and run under three NAND price scenarios.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { companyInputs, marketPrices, modelOutput, type CompanyInputs, type MarketPrices, type ModelOutput } from '../../src/schemas/forecast';
import { addQ, metrics, ols, qIndex, qRange, round, type Pair, type Series } from './lib';
import * as L from './phison-lib';

type Out = ModelOutput;
type Target = 'revenue' | 'grossMargin' | 'operatingIncome' | 'netIncome' | 'eps';
const TARGETS: Target[] = ['revenue', 'grossMargin', 'operatingIncome', 'netIncome', 'eps'];

const TRAIN = { from: '2017Q1', to: '2024Q4' };
const TEST = { from: '2025Q1', to: '2026Q2' };
/** One-off operating expense in 2024Q4: costs and employee compensation tied to the Hosin (宏芯宇) stake sale (4Q24 法說簡報). */
const OPEX_ONE_OFF = new Map([['2024Q4', 1701]]);
/** Equal gross-margin MAE (pp) within this band counts as a tie; ties are broken by EPS MAE. */
const TIE_PP = 0.5;
const fmt = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${fmt(v, d)}%`;
/** 季變化的中文說法：「季增 5%」「季減 10%」「持平」 */
const qoqText = (v: number) => (v > 0 ? `季增 ${fmt(v, Number.isInteger(v) ? 0 : 1)}%` : v < 0 ? `季減 ${fmt(-v, Number.isInteger(v) ? 0 : 1)}%` : '持平');

interface Pred { revenue: number; grossMargin: number; operatingIncome: number; netIncome: number; eps: number }
interface Fitted {
  /**
   * One quarter ahead: everything reported up to t−1, the price index of t (`Pt`; default the realised TrendForce value)
   * and the revenue of t (known from monthly revenue in the conditional backtest, or the candidate's own rule ex ante).
   */
  predict(t: string, revenue: number, Pt?: number): Pred;
  /** Revenue of quarter t from the candidate's own revenue rule (no monthly revenue), at price index `Pt`. */
  revenue(t: string, Pt?: number): number;
  /** Several quarters ahead from `origin`: no reports after origin; realised prices and the given revenue of each quarter. */
  dynamic(origin: string, path: string[], revenueOf: (t: string) => number): Pred[];
}
interface Candidate {
  id: string;
  name: string;
  description: string;
  equations: string[];
  fit(from: string, to: string): Fitted & { params: { name: string; value: number; unit?: string; note?: string }[] };
}

export function buildModel(inputs: CompanyInputs, prices: MarketPrices): Out {
  const rows = L.rowsOf(inputs);
  const by = new Map(rows.map((r) => [r.period, r]));
  const LAST = rows.at(-1)!.period;
  const NEXT = addQ(LAST, 1);
  const monthlyQ = L.quarterlyFromMonthly(inputs);
  const P = L.nandIndex(prices);
  const dP = L.nandQoq(prices);
  const row = (p: string) => {
    const r = by.get(p);
    if (!r) throw new Error(`no reported quarter ${p}`);
    return r;
  };
  const periodsIn = (from: string, to: string) => rows.map((r) => r.period).filter((p) => L.between(p, from, to));
  const realVolumeGrowth = (from: string, to: string) => {
    const g = periodsIn(from, to).map((p) => Math.log((row(p).revenue / P.get(p)!) / (row(addQ(p, -1)).revenue / P.get(addQ(p, -1))!)));
    return Math.exp(g.reduce((a, v) => a + v, 0) / g.length) - 1;
  };

  /* ── φ: NAND/material share of production cost, from the annual reports (進貨淨額 − 控制晶片進貨值) ÷ (營業成本 + Δ存貨) ── */
  const phiYears = inputs.annual
    .map((a) => {
      const y = a.year;
      const qs = rows.filter((r) => r.period.startsWith(`${y}Q`));
      const prevQ4 = by.get(`${Number(y) - 1}Q4`);
      const ctrl = a.extra?.['產值－控制晶片（百萬元）'];
      if (qs.length !== 4 || !prevQ4 || ctrl === undefined || a.totalPurchases === undefined) return undefined;
      const cogs = qs.reduce((s, r) => s + r.cogs, 0);
      const production = cogs + qs[3]!.inv - prevQ4.inv;
      return { year: y, phi: (a.totalPurchases - ctrl) / production, production, purchases: a.totalPurchases, ctrl };
    })
    .filter((x): x is NonNullable<typeof x> => x !== undefined);
  // Only annual reports published by the time the quarter after `to` is forecast: the report for year Y comes out around
  // May–June of Y + 1, i.e. after the Q4 results of Y and around the Q1 results of Y + 1.
  const phiYearsFor = (to: string) => {
    const latest = Math.floor(qIndex(to) / 4) - (to.endsWith('Q1') ? 2 : 1);
    const ys = phiYears.filter((y) => Number(y.year) <= latest);
    if (!ys.length) throw new Error(`phi: no annual report available before ${to}`);
    return ys;
  };
  const phiFor = (to: string) => { const ys = phiYearsFor(to); return ys.reduce((a, y) => a + y.phi, 0) / ys.length; };

  /* ── inventory simulations on reported data ── */
  const hist = { wa: L.simulateHistory('wa', rows, P), fifo: L.simulateHistory('fifo', rows, P) };
  const H = { wa: new Map(hist.wa.map((h) => [h.period, h])), fifo: new Map(hist.fifo.map((h) => [h.period, h])) };
  const invDays = (p: string) => (row(p).inv / row(p).cogs) * 91; // 庫存天數 = 存貨 ÷ 營業成本 × 91

  /* ── candidates ── */
  // Naive benchmarks keep last quarter's (or last year's) margins. Given the same information as the other candidates —
  // the revenue of t — they scale operating income, net income and EPS with it (constant margins); without it (revenue
  // metric, ex-ante test) they simply repeat the old quarter.
  const naive = (lag: 1 | 4, id: string, name: string, description: string): Candidate => ({
    id, name, description,
    equations: [
      lag === 1 ? '營收_t = 營收_{t−1}；毛利率_t = 毛利率_{t−1}' : '營收_t = 營收_{t−4}；毛利率_t = 毛利率_{t−4}',
      lag === 1 ? '已知當季營收時：營業利益、淨利與 EPS = 上一季的營業利益率、淨利率與每元營收 EPS × 當季營收' : '已知當季營收時：營業利益、淨利與 EPS = 去年同季的營業利益率、淨利率與每元營收 EPS × 當季營收',
    ],
    fit: () => {
      const scaled = (r: L.Row, R: number): Pred => ({ revenue: R, grossMargin: r.gm, operatingIncome: (r.oi * R) / r.revenue, netIncome: (r.ni * R) / r.revenue, eps: (r.eps * R) / r.revenue });
      /** The latest reported quarter the rule can use when nothing after `origin` is known. */
      const sourceAt = (t: string, origin: string) => {
        if (lag === 1) return row(origin);
        let s = addQ(t, -4);
        while (qIndex(s) > qIndex(origin)) s = addQ(s, -4);
        return row(s);
      };
      return {
        params: [],
        predict: (t, R) => scaled(row(addQ(t, -lag)), R),
        revenue: (t) => row(addQ(t, -lag)).revenue,
        dynamic: (origin, path, revenueOf) => path.map((t) => scaled(sourceAt(t, origin), revenueOf(t))),
      };
    },
  });

  const chainFor = (from: string, to: string) => L.fitOpex(rows, periodsIn(from, to), new Set(OPEX_ONE_OFF.keys()));
  const pnl = (t: string, revenue: number, gm: number, cp: L.ChainParams): Pred => {
    const p = L.runChain(revenue, gm, L.chainStateAt(rows, addQ(t, -1), OPEX_ONE_OFF), cp);
    return { revenue, grossMargin: gm, operatingIncome: p.oi, netIncome: p.ni, eps: p.eps };
  };
  /** Several quarters on modelled numbers: the P&L chain is carried forward from `origin` (no later reports). */
  const rollChain = (origin: string, path: string[], revenueOf: (t: string) => number, gmOf: (t: string, prevGm: number) => number, cp: L.ChainParams): Pred[] => {
    let st = L.chainStateAt(rows, origin, OPEX_ONE_OFF);
    let gm = row(origin).gm;
    return path.map((t) => {
      const R = revenueOf(t);
      gm = gmOf(t, gm);
      const p = L.runChain(R, gm, st, cp);
      st = L.nextChainState(st, p);
      return { revenue: R, grossMargin: gm, operatingIncome: p.oi, netIncome: p.ni, eps: p.eps };
    });
  };
  /** Price change of quarter t (%) at price index Pt (default: realised). */
  const dPat = (t: string, Pt?: number) => (Pt === undefined ? dP.get(t)! : (Pt / P.get(addQ(t, -1))! - 1) * 100);
  const Pat = (t: string, Pt?: number) => Pt ?? P.get(t)!;
  const chainParams = (cp: ReturnType<typeof chainFor>) => [
    { name: '營業費用：毛利每增加 1 元，營業費用增加', value: round(cp.opexBeta, 3), unit: '元', note: `Δ營業費用 = d × 上季營業費用 + β × Δ毛利，最小平方法（${cp.n} 季；排除含 2024Q4 的季差，因為該季有處分宏芯宇相關的一次性費用 1,701 百萬元）` },
    { name: '營業費用：毛利不變時的季成長 d', value: round(cp.opexDrift * 100, 2), unit: '%' },
  ];

  const priceRegression: Candidate = {
    id: 'price-regression',
    name: '價格迴歸',
    description: '不模擬庫存，直接用同一季 NAND 合約價的漲跌幅解釋毛利率與營收成長（毛利率另含上一季毛利率，吸收產品組合的慢變化）。這是一般「價格漲、毛利率跟著漲」的直覺版本。',
    equations: ['毛利率_t = a + b × 合約價季變化_t + c × 毛利率_{t−1}', 'ln(營收_t ÷ 營收_{t−1}) = a′ + b′ × ln(1 + 合約價季變化_t)', '營業費用、業外、稅與股數：共用的損益鏈（見參數）'],
    fit(from, to) {
      const ps = periodsIn(from, to);
      const g = ols(ps.map((p) => [dP.get(p)!, row(addQ(p, -1)).gm]), ps.map((p) => row(p).gm));
      const rv = ols(ps.map((p) => [Math.log(1 + dP.get(p)! / 100)]), ps.map((p) => Math.log(row(p).revenue / row(addQ(p, -1)).revenue)));
      const cp = chainFor(from, to);
      const revenue = (t: string, Pt?: number) => row(addQ(t, -1)).revenue * Math.exp(rv[0]! + rv[1]! * Math.log(1 + dPat(t, Pt) / 100));
      return {
        params: [
          { name: '價格迴歸：毛利率對合約價季變化的係數 b', value: round(g[1]!, 3), unit: '個百分點／%' },
          { name: '價格迴歸：上一季毛利率係數 c', value: round(g[2]!, 3) },
          { name: '價格迴歸：營收對合約價的彈性 b′', value: round(rv[1]!, 3) },
        ],
        predict: (t, R, Pt) => pnl(t, R, g[0]! + g[1]! * dPat(t, Pt) + g[2]! * row(addQ(t, -1)).gm, cp),
        revenue,
        dynamic: (origin, path, revenueOf) => rollChain(origin, path, revenueOf, (t, prevGm) => g[0]! + g[1]! * dP.get(t)! + g[2]! * prevGm, cp),
      };
    },
  };

  const lagIndex: Candidate = {
    id: 'lag-weighted-index',
    name: '加權落後成本指數',
    description: '把購入成本寫成過去各季合約價的加權平均（幾何遞減權重，最近一季權重 λ），售價則跟當季合約價；λ 與毛利率對「成本 ÷ 售價」的反應幅度 β 都只用 2017–2024 年資料估計。',
    equations: ['成本指數 C_t = Σ w_k × P_{t−k}，w_k = λ × (1 − λ)^k', 'x_t = C_t ÷ P_t（購入成本 ÷ 當季售價）', '毛利率_t = 毛利率_{t−1} − β × (x_t − x_{t−1})', '營收_t = 營收_{t−1} × (P_t ÷ P_{t−1}) × (1 + g)'],
    fit(from, to) {
      const ps = periodsIn(from, to);
      let best: { lambda: number; beta: number; sse: number } | undefined;
      for (let k = 1; k <= 19; k++) {
        const lambda = k / 20;
        const C = L.emaIndex(P, lambda);
        const x = (p: string) => C.get(p)! / P.get(p)!;
        let sxx = 0, sxy = 0;
        for (const p of ps) { const dx = (x(p) - x(addQ(p, -1))) * 100; sxx += dx * dx; sxy += dx * (row(p).gm - row(addQ(p, -1)).gm); }
        const beta = -sxy / sxx;
        const sse = ps.reduce((a, p) => a + (row(p).gm - row(addQ(p, -1)).gm + beta * (x(p) - x(addQ(p, -1))) * 100) ** 2, 0);
        if (!best || sse < best.sse - 1e-9) best = { lambda, beta, sse };
      }
      const { lambda, beta } = best!;
      const C = L.emaIndex(P, lambda);
      const x = (p: string) => C.get(p)! / P.get(p)!;
      const g = realVolumeGrowth(from, to);
      const cp = chainFor(from, to);
      return {
        params: [
          { name: '加權落後指數：最近一季權重 λ', value: lambda, note: `平均落後 ${fmt((1 - lambda) / lambda, 2)} 季；以 0.05 為間距搜尋，取訓練期毛利率誤差平方和最小者` },
          { name: '加權落後指數：毛利率對 x 每變動 0.01 的反應 β', value: round(beta, 3), unit: '個百分點' },
        ],
        predict: (t, R, Pt) => {
          // with a price other than the realised one, C_t = λ P_t + (1 − λ) C_{t−1}
          const xt = Pt === undefined ? x(t) : (lambda * Pt + (1 - lambda) * C.get(addQ(t, -1))!) / Pt;
          return pnl(t, R, row(addQ(t, -1)).gm - beta * (xt - x(addQ(t, -1))) * 100, cp);
        },
        revenue: (t, Pt) => row(addQ(t, -1)).revenue * (Pat(t, Pt) / P.get(addQ(t, -1))!) * (1 + g),
        dynamic: (origin, path, revenueOf) => rollChain(origin, path, revenueOf, (t) => row(origin).gm - beta * (x(t) - x(origin)) * 100, cp),
      };
    },
  };

  /** Structural inventory model: purchase-cost index from the simulated inventory, NAND share φ, write-down rule. */
  const inventoryModel = (method: L.Method): Candidate => ({
    id: method === 'wa' ? 'moving-average-inventory' : 'fifo-layers',
    name: method === 'wa' ? '移動加權平均庫存模擬' : '分層庫存（先進先出）模擬',
    description:
      method === 'wa'
        ? '用財報的營業成本與存貨推回每季進貨（進貨 ≈ 營業成本 + 存貨增加），以當季合約價買進、以移動加權平均法算出「賣出商品的平均購入成本」。庫存天數越長，新進貨在平均成本中的比重越低，成本追上市價越慢；這正是 2025 年底至 2026 年「低價庫存」推高毛利率的機制。NAND 占成本比重 φ 取自年報，存貨帳面成本高於市價時依比例提列跌價損失。'
        : '和移動加權平均相同的進貨推估，但改用分層的先進先出：每季進貨是一層，賣出時先用最舊的一層。成本對價格的落後是「整段」的（約等於庫存天數），在價格急漲或急跌時反應比加權平均更劇烈。NAND 占成本比重 φ 與跌價規則和移動加權平均模型相同。',
    equations: [
      '進貨_t ≈ 營業成本_t + 存貨_t − 存貨_{t−1}；庫存天數 ≈ 存貨 ÷ 營業成本 × 91',
      method === 'wa' ? '購入成本 c_t =（期初存貨成本 + 本季進貨量 × P_t）÷（期初數量 + 本季進貨量）' : '購入成本 c_t = 本季賣出的各層存貨（最舊者先出）的平均購入價',
      'x_t = c_t ÷ P_t（賣出商品的購入成本 ÷ 當季售價指數）',
      '成本率_t = 成本率_{t−1} × [(1 − φ) + φ × x_t ÷ x_{t−1}]（不含跌價損失）',
      '跌價損失_t = κ × 存貨數量 × max(0, 帳面單位成本 − P_t)',
      '毛利率_t = 1 − 成本率_t − 跌價損失_t ÷ 營收_t',
      '營收_t = 營收_{t−1} × (P_t ÷ P_{t−1}) × (1 + g)',
    ],
    fit(from, to) {
      const h = H[method];
      const phi = phiFor(to);
      const g = realVolumeGrowth(from, to);
      const cp = chainFor(from, to);
      // κ: least squares through the origin of reported write-downs on the simulated exposure U × max(0, cEnd − P)
      let sxx = 0, sxy = 0;
      for (const p of periodsIn(from, to)) {
        const st = h.get(p)!.state;
        const preCost = (row(p).inv + row(p).wd) / st.U;
        const e = st.U * Math.max(0, preCost - P.get(p)!);
        sxx += e * e;
        sxy += e * row(p).wd;
      }
      const kappa = Math.max(0, sxy / sxx);
      const step = (t: string, R: number, Pt: number) => {
        const prev = row(addQ(t, -1));
        const s0 = h.get(prev.period)!.state;
        const vol = (R / Pt) / (prev.revenue / P.get(prev.period)!);
        const st = L.stepProjected(s0, t, Pt, vol, invDays(prev.period));
        const wd = L.applyMarketFloor(st, Pt, kappa).wd;
        const cr0 = (prev.cogs - prev.wd) / prev.revenue;
        const cr = cr0 * (1 - phi + (phi * st.x) / h.get(prev.period)!.x);
        return (1 - cr - wd / R) * 100;
      };
      return {
        params: [
          { name: 'φ：NAND 等材料占生產成本比重', value: round(phi, 3), note: `年報「進貨淨額」減「控制晶片產值（即進貨值）」，除以（營業成本 + 存貨增加），${phiYearsFor(to).map((y) => `${y.year} 年 ${fmt(y.phi, 3)}`).join('、')}，取平均（只用預測 ${addQ(to, 1)} 時已出版的年報；2024 年起年報不再列產值）` },
          { name: '實質出貨量季成長 g', value: round(g * 100, 2), unit: '%', note: `ln(營收 ÷ 合約價指數) 的平均季變化，${from}–${to}` },
          { name: '跌價提列比例 κ', value: round(kappa, 3), note: '財報存貨跌價損失對「帳面單位成本高於合約價指數的部分 × 存貨數量」的迴歸（過原點，負值取 0）' },
        ],
        predict: (t, R, Pt) => pnl(t, R, step(t, R, Pat(t, Pt)), cp),
        revenue: (t, Pt) => row(addQ(t, -1)).revenue * (Pat(t, Pt) / P.get(addQ(t, -1))!) * (1 + g),
        dynamic: (origin, path, revenueOf) =>
          projectPath({ method, origin, path, phi, kappa, cp, revenueOf, volumeGrowth: g, days: () => invDays(origin), chain: L.chainStateAt(rows, origin, OPEX_ONE_OFF) })
            .map((r) => ({ revenue: r.pnl.revenue, grossMargin: r.pnl.gm, operatingIncome: r.pnl.oi, netIncome: r.pnl.ni, eps: r.pnl.eps })),
      };
    },
  });

  const candidates: Candidate[] = [
    naive(1, 'naive-last-quarter', '天真模型：沿用上一季', '假設毛利率、營業利益率與淨利率都和上一季一樣。回測時它和其他模型一樣知道當季營收（月營收），所以營業利益、淨利與 EPS 隨當季營收等比例變動；營收本身則沿用上一季。用來檢驗其他模型是否真的比「什麼都不做」好。'),
    naive(4, 'naive-same-quarter', '天真模型：沿用去年同季', '假設毛利率與利潤率和去年同一季一樣（同樣乘上已知的當季營收），可抓到季節性，但追不上一年內的價格變化。'),
    priceRegression,
    lagIndex,
    inventoryModel('fifo'),
    inventoryModel('wa'),
  ];

  /* ── backtest: fit on TRAIN, predict TEST one quarter ahead ── */
  const testPeriods = periodsIn(TEST.from, TEST.to);
  const fitted = new Map(candidates.map((c) => [c.id, c.fit(TRAIN.from, TRAIN.to)]));
  const naiveFit = fitted.get('naive-last-quarter')!;
  const backtest: Out['backtest'] = [];
  const candMetrics = new Map<string, Record<string, ReturnType<typeof metrics>>>();
  const nextRevenueCheck = new Map<string, number>();
  // Ex-ante price of t: last quarter's index × TrendForce's latest forecast published around the start of the quarter.
  const startQoq = new Map(L.priceSeries(prices, 'nand-contract-qoq-start-forecast').points.map((p) => [p.period, p.value]));
  const exAntePrice = (t: string) => { const f = startQoq.get(t); return f === undefined ? undefined : P.get(addQ(t, -1))! * (1 + f / 100); };
  const knownRevenue = (t: string) => monthlyQ.get(t) ?? row(t).revenue;
  const actualOf = (t: string): Pred => { const r = row(t); return { revenue: r.revenue, grossMargin: r.gm, operatingIncome: r.oi, netIncome: r.ni, eps: r.eps }; };
  const benchLabel = (m: Target) => (m === 'revenue' ? '天真模型（沿用上一季營收）' : '天真模型（沿用上一季毛利率與利潤率，乘上當季營收）');
  const dynamicOf = new Map<string, Pred[]>();
  for (const c of candidates) {
    const f = fitted.get(c.id)!;
    const pairs: Record<Target, Pair[]> = { revenue: [], grossMargin: [], operatingIncome: [], netIncome: [], eps: [] };
    const exAnte: Record<'revenue' | 'grossMargin' | 'eps', Pair[]> = { revenue: [], grossMargin: [], eps: [] };
    for (const t of testPeriods) {
      const known = knownRevenue(t);
      const p = f.predict(t, known);
      const bench = naiveFit.predict(t, known);
      const actual = actualOf(t);
      const predicted: Pred = { ...p, revenue: f.revenue(t) };
      for (const m of TARGETS) {
        pairs[m].push({ actual: actual[m], predicted: predicted[m] });
        const d = m === 'grossMargin' || m === 'eps' ? 2 : 1;
        backtest.push({
          period: t, metric: m, actual: round(actual[m], d), predicted: round(predicted[m], d), candidate: c.id,
          ...(c.id !== 'naive-last-quarter' ? { benchmark: round((m === 'revenue' ? naiveFit.revenue(t) : bench[m]), d), benchmarkLabel: benchLabel(m) } : {}),
        });
      }
      // ex ante: TrendForce's start-of-quarter price forecast instead of the realised price, and no monthly revenue
      const Pe = exAntePrice(t);
      if (Pe !== undefined) {
        const Re = f.revenue(t, Pe);
        const pe = f.predict(t, Re, Pe);
        exAnte.revenue.push({ actual: actual.revenue, predicted: Re });
        exAnte.grossMargin.push({ actual: actual.grossMargin, predicted: pe.grossMargin });
        exAnte.eps.push({ actual: actual.eps, predicted: pe.eps });
      }
    }
    // out-of-sample revenue check for the quarter after the last report (known from monthly revenue)
    const known = monthlyQ.get(NEXT);
    if (known !== undefined && P.has(NEXT)) {
      const v = f.revenue(NEXT);
      nextRevenueCheck.set(c.id, v);
      backtest.push({ period: NEXT, metric: 'revenue', actual: round(known, 1), predicted: round(v, 1), candidate: c.id, ...(c.id !== 'naive-last-quarter' ? { benchmark: round(naiveFit.revenue(NEXT), 1), benchmarkLabel: benchLabel('revenue') } : {}) });
    }
    // dynamic: from the last training quarter, no later reports (only realised prices and monthly revenue)
    const dyn = f.dynamic(TRAIN.to, testPeriods, knownRevenue);
    dynamicOf.set(c.id, dyn);
    // in-sample one-step gross margin over the training window (same information set as the test)
    const train = periodsIn(TRAIN.from, TRAIN.to).map((t) => ({ actual: row(t).gm, predicted: f.predict(t, row(t).revenue).grossMargin }));
    candMetrics.set(c.id, {
      ...Object.fromEntries(TARGETS.map((m) => [m, metrics(pairs[m])])),
      ...(exAnte.grossMargin.length ? { revenueExAnte: metrics(exAnte.revenue), grossMarginExAnte: metrics(exAnte.grossMargin), epsExAnte: metrics(exAnte.eps) } : {}),
      grossMarginDynamic: metrics(testPeriods.map((t, i) => ({ actual: row(t).gm, predicted: dyn[i]!.grossMargin }))),
      epsDynamic: metrics(testPeriods.map((t, i) => ({ actual: row(t).eps, predicted: dyn[i]!.eps }))),
      grossMarginTrain: metrics(train),
    });
  }

  /* ── selection: lowest gross-margin MAE; ties (within TIE_PP) by EPS MAE; only engines that can run price scenarios ── */
  const ENGINES = new Map<string, L.Method>([['moving-average-inventory', 'wa'], ['fifo-layers', 'fifo']]);
  const ranked = [...candidates].sort((a, b) => {
    const ma = candMetrics.get(a.id)!, mb = candMetrics.get(b.id)!;
    const d = ma.grossMargin!.mae - mb.grossMargin!.mae;
    return Math.abs(d) > TIE_PP ? d : ma.eps!.mae - mb.eps!.mae;
  });
  const sel = ranked.find((c) => ENGINES.has(c.id))!;
  const selMethod = ENGINES.get(sel.id)!;
  const beatenBy = ranked.slice(0, ranked.indexOf(sel));

  /* ── multi-step diagnostic for the selected engine: from the last training quarter, only prices and revenue known ── */
  const multi = dynamicOf.get(sel.id)!.map((p, i) => ({ period: testPeriods[i]!, pnl: { gm: p.grossMargin, eps: p.eps } }));
  const dynMae = (id: string) => candMetrics.get(id)!.grossMarginDynamic!.mae;
  const sm = candMetrics.get(sel.id)!;
  const nm = candMetrics.get('naive-last-quarter')!;

  /* ── projection engine (selected inventory model) ── */
  function projectPath(o: {
    method: L.Method; origin: string; path: string[]; phi: number; kappa: number; cp: L.ChainParams; Pidx?: Series;
    revenueOf: (t: string, prevRevenue: number, Pt: number, Pprev: number) => number | undefined; volumeGrowth: number;
    days: (t: string) => number; chain: L.ChainState;
  }) {
    const Pi = o.Pidx ?? P;
    const h = H[o.method];
    const a = row(o.origin);
    const crA = (a.cogs - a.wd) / a.revenue;
    const xA = h.get(o.origin)!.x;
    let s = h.get(o.origin)!.state;
    let revPrev = a.revenue;
    let chain = o.chain;
    const out: { period: string; pnl: L.PnL; c: number; x: number; purchases: number; invDays: number; inv: number; wd: number; known: boolean }[] = [];
    for (const t of o.path) {
      const Pt = Pi.get(t)!, Pp = Pi.get(addQ(t, -1))!;
      const given = o.revenueOf(t, revPrev, Pt, Pp);
      const R = given ?? revPrev * (Pt / Pp) * (1 + o.volumeGrowth);
      const vol = (R / Pt) / (revPrev / Pp);
      const st = L.stepProjected(s, t, Pt, vol, o.days(t));
      const floor = L.applyMarketFloor(st, Pt, o.kappa);
      const cr = crA * (1 - o.phi + (o.phi * st.x) / xA);
      const gm = (1 - cr - floor.wd / R) * 100;
      const p = L.runChain(R, gm, chain, o.cp);
      const inv = floor.state.U * floor.state.cEnd;
      out.push({ period: t, pnl: p, c: st.c, x: st.x, purchases: st.purchases, invDays: (inv / (st.valueSold + floor.wd)) * 91, inv, wd: floor.wd, known: given !== undefined });
      chain = L.nextChainState(chain, p);
      s = floor.state;
      revPrev = R;
    }
    return out;
  }

  /* ── re-fit on all data and run the scenarios ── */
  const ALL = { from: TRAIN.from, to: LAST };
  const final = sel.fit(ALL.from, ALL.to);
  const phiAll = final.params.find((p) => p.name.startsWith('φ'))!.value;
  const gAll = final.params.find((p) => p.name.startsWith('實質出貨量'))!.value / 100;
  const kappaAll = final.params.find((p) => p.name.startsWith('跌價提列比例'))!.value;
  const cpAll = chainFor(ALL.from, ALL.to);
  const chain0 = L.chainStateAt(rows, LAST, OPEX_ONE_OFF);
  const days23to25 = rows.filter((r) => L.between(r.period, '2023Q1', '2025Q4')).map((r) => (r.inv / r.cogs) * 91);
  const normalDays = days23to25.reduce((a, v) => a + v, 0) / days23to25.length;
  const H_LAST = H[selMethod].get(LAST)!;
  const startDays = invDays(LAST);
  const horizon = qRange(NEXT, '2027Q4');
  const glideFrom = '2026Q4';
  const daysPath = (t: string) => {
    if (qIndex(t) <= qIndex(glideFrom)) return startDays;
    const n = qIndex('2027Q4') - qIndex(glideFrom);
    const k = qIndex(t) - qIndex(glideFrom);
    return startDays + ((normalDays - startDays) * k) / n;
  };
  const q3 = L.priceSeries(prices, 'nand-contract-qoq').points.find((p) => p.period === NEXT);
  const q4 = L.priceSeries(prices, 'nand-contract-qoq').points.find((p) => p.period === addQ(NEXT, 1));
  if (!q3 || !q4 || q3.low === undefined || q3.high === undefined || q4.low === undefined || q4.high === undefined) throw new Error('market-prices: 2026Q3/Q4 NAND ranges missing');
  const nonopBase = chain0.nonop;
  const last4 = inputs.quarters.slice(-4);
  const equityShare = last4.reduce((a, q) => a + (q.extra?.['採用權益法之關聯企業損益份額'] ?? NaN), 0) / last4.reduce((a, q) => a + q.nonOperating!, 0);
  const scen = [
    { id: 'bear' as const, name: '保守', dp: [q3.low, q4.low, 0, -10, -15, -20], vol: 0, nonop: nonopBase / 2, story: '2026 年下半年取 TrendForce 區間的下緣；2027 年第一季持平、之後逐季下跌，出貨量不成長（消費性需求疲弱、2027 下半年新產能開出）' },
    { id: 'base' as const, name: '基準', dp: [q3.value, q4.value, 5, 0, -5, -10], vol: gAll, nonop: nonopBase, story: '2026 年下半年取 TrendForce 區間的中值；2027 年第一季小漲、第二季持平，下半年供給轉寬鬆而回落' },
    { id: 'bull' as const, name: '樂觀', dp: [q3.high, q4.high, 10, 5, 0, -5], vol: gAll, nonop: row(LAST).nonop, story: '2026 年下半年取 TrendForce 區間的上緣；供給吃緊延續到 2027 年上半年，價格到下半年才持平小跌' },
  ];
  const runScenario = (dp: number[], vol: number, nonop: number, opts: { phi?: number; days?: (t: string) => number; level2027?: number } = {}) => {
    const extra: Record<string, number> = Object.fromEntries(horizon.map((t, i) => [t, dp[i]!]));
    if (opts.level2027) extra['2027Q1'] = ((1 + extra['2027Q1']! / 100) * opts.level2027 - 1) * 100;
    const Pidx = L.nandIndex(prices, extra);
    return projectPath({
      method: selMethod, origin: LAST, path: horizon, phi: opts.phi ?? phiAll, kappa: kappaAll, cp: cpAll, Pidx,
      revenueOf: (t) => monthlyQ.get(t), volumeGrowth: vol, days: (t) => (opts.days ?? daysPath)(t), chain: { ...chain0, nonop },
    }).map((r) => ({ ...r, P: Pidx.get(r.period)! }));
  };
  const annualOf = (rs: ReturnType<typeof runScenario>, year: string) => {
    const q = rs.filter((r) => r.period.startsWith(year));
    const rev = q.reduce((a, r) => a + r.pnl.revenue, 0);
    const gp = q.reduce((a, r) => a + r.pnl.gp, 0);
    return { revenue: rev, gm: (gp / rev) * 100, oi: q.reduce((a, r) => a + r.pnl.oi, 0), ni: q.reduce((a, r) => a + r.pnl.ni, 0), eps: q.reduce((a, r) => a + r.pnl.eps, 0) };
  };
  const runs = new Map(scen.map((s) => [s.id, runScenario(s.dp, s.vol, s.nonop)]));
  const base = runs.get('base')!;
  const base2027 = annualOf(base, '2027');

  const scenarios: Out['scenarios'] = scen.map((s) => {
    const rs = runs.get(s.id)!;
    const a27 = annualOf(rs, '2027');
    const h1 = rows.filter((r) => r.period.startsWith('2026Q')).map((r) => r);
    const h2 = rs.filter((r) => r.period.startsWith('2026'));
    const rev26 = h1.reduce((a, r) => a + r.revenue, 0) + h2.reduce((a, r) => a + r.pnl.revenue, 0);
    const gp26 = h1.reduce((a, r) => a + r.gp, 0) + h2.reduce((a, r) => a + r.pnl.gp, 0);
    return {
      id: s.id,
      name: s.name,
      assumptions: [
        { name: '情境說明', value: s.story },
        { name: `NAND 合約價季變化 ${NEXT}`, value: `${qoqText(s.dp[0]!)}（TrendForce 2026-09-30 季末估計區間季增 ${q3.low}–${q3.high}% 的${s.id === 'base' ? '中值' : s.id === 'bear' ? '下緣' : '上緣'}）`, src: q3.src },
        { name: `NAND 合約價季變化 ${addQ(NEXT, 1)}`, value: `${qoqText(s.dp[1]!)}（TrendForce 2026-09-30 預測區間季增 ${q4.low}–${q4.high}% 的${s.id === 'base' ? '中值' : s.id === 'bear' ? '下緣' : '上緣'}）`, src: q4.src },
        { name: 'NAND 合約價季變化 2027Q1–Q4', value: `依序${s.dp.slice(2).map(qoqText).join('、')}（本模型的假設，不是 TrendForce 的數字：截至 2026-10-23 TrendForce 未公布 2027 年逐季合約價預測，只指出 2027 下半年供給轉寬鬆、消費性需求疲弱使價格面臨下行壓力）`, src: 'tf-20260730-13158' },
        { name: 'TrendForce 的 2027 年展望', value: 'NAND 供給成長將高於需求，供給吃緊在 2027 下半年緩解（偏向保守情境）', src: 'tf-20260721-13148' },
        { name: '群聯執行長的看法', value: 'NAND 供應相當吃緊，2027、2028 年也難以平衡（偏向樂觀情境的價格路徑）；同時表示低成本庫存的效益會隨價格上漲逐步淡化（三種情境的毛利率都由高點回落）', src: 'uanalyze-20260813' },
        { name: `營收 ${NEXT}`, value: `${fmt(monthlyQ.get(NEXT) ?? NaN, 0)} 百萬元（7–9 月月營收合計，已知）`, src: 'mops-monthly' },
        { name: '之後各季營收', value: `上季營收 × 合約價指數變化 × (1 + 實質出貨量季成長 ${fmt(s.vol * 100, 1)}%)${s.id === 'bear' ? '（出貨量不成長）' : '（2017Q1–2026Q2 平均）'}` },
        { name: '庫存天數', value: `起點 ${LAST} 約 ${fmt(startDays, 0)} 天由財報的存貨與營業成本計算；之後維持到 ${glideFrom}、再線性降到 2023–2025 年平均約 ${fmt(normalDays, 0)} 天（2027Q4）是本模型的假設，三種情境相同`, src: 'fr-2026' },
        { name: '營業費用', value: `Δ營業費用 = ${fmt(cpAll.opexDrift * 100, 2)}% × 上季營業費用 + ${fmt(cpAll.opexBeta, 2)} × Δ毛利（2017Q1–${LAST} 估計）` },
        { name: '業外收支（每季）', value: `${fmt(s.nonop, 0)} 百萬元（${s.id === 'base' ? `近四季中位數` : s.id === 'bear' ? '近四季中位數的一半' : `${LAST} 實際值`}；近四季業外收支約 ${fmt(equityShare * 100, 0)}% 來自採用權益法認列的關聯企業損益）`, src: 'fr-2026' },
        { name: '有效稅率', value: `${fmt(chain0.taxRate * 100, 1)}%（近四季所得稅 ÷ 稅前淨利）`, src: 'fr-2026' },
        { name: '股數', value: `${fmt(chain0.shares, 1)} 百萬股（${LAST} 基本加權平均股數；同季稀釋加權股數為 ${fmt(inputs.quarters.at(-1)!.sharesDiluted ?? NaN, 1)} 百萬股，模型不計稀釋）`, src: 'fr-2026' },
      ],
      forecasts: [
        ...rs.map((r) => ({
          period: r.period,
          revenue: round(r.pnl.revenue, 0),
          grossMargin: round(r.pnl.gm, 1),
          operatingIncome: round(r.pnl.oi, 0),
          netIncome: round(r.pnl.ni, 0),
          eps: round(r.pnl.eps, 2),
          known: r.known ? ['revenue'] : [],
          note: r.known ? `營收為 7–9 月月營收合計（已公布）；毛利率以下為模型推估（逐季回測的毛利率平均誤差約 ${fmt(sm.grossMargin!.mae, 1)} 個百分點）` : undefined,
        })),
        { period: '2026', revenue: round(rev26, 0), grossMargin: round((gp26 / rev26) * 100, 1), operatingIncome: round(h1.reduce((a, r) => a + r.oi, 0) + h2.reduce((a, r) => a + r.pnl.oi, 0), 0), netIncome: round(h1.reduce((a, r) => a + r.ni, 0) + h2.reduce((a, r) => a + r.pnl.ni, 0), 0), eps: round(h1.reduce((a, r) => a + r.eps, 0) + h2.reduce((a, r) => a + r.pnl.eps, 0), 2), known: [], note: '上半年為財報實際數、第三季營收為月營收合計，其餘為模型推估；全年 EPS 為四季加總' },
        { period: '2027', revenue: round(a27.revenue, 0), grossMargin: round(a27.gm, 1), operatingIncome: round(a27.oi, 0), netIncome: round(a27.ni, 0), eps: round(a27.eps, 2), known: [], note: `四季加總（EPS 為四季 EPS 加總，股數不變）；回測中連續預測六季的毛利率平均誤差約 ${fmt(sm.grossMarginDynamic!.mae, 0)} 個百分點` },
      ],
    };
  });

  /* ── sensitivities (base scenario, 2027 full year) ── */
  const baseS = scen.find((s) => s.id === 'base')!;
  const sens = (label: string, change: string, rs: ReturnType<typeof runScenario>) => {
    const a = annualOf(rs, '2027');
    return { driver: label, change, effect: `2027 年 EPS ${fmt(a.eps, 1)} 元（基準 ${fmt(base2027.eps, 1)} 元，${pct(((a.eps - base2027.eps) / base2027.eps) * 100, 0)}）；毛利率 ${fmt(a.gm, 1)}%（基準 ${fmt(base2027.gm, 1)}%）` };
  };
  const sensitivities: Out['sensitivities'] = [
    sens('2027 年 NAND 合約價水準', '整年高 10%（2027Q1 起每季都比基準高 10%）', runScenario(baseS.dp, baseS.vol, baseS.nonop, { level2027: 1.1 })),
    sens('2027 年 NAND 合約價水準', '整年低 10%', runScenario(baseS.dp, baseS.vol, baseS.nonop, { level2027: 0.9 })),
    sens('庫存天數', `維持 ${LAST} 的約 ${fmt((row(LAST).inv / row(LAST).cogs) * 91, 0)} 天、不回落`, runScenario(baseS.dp, baseS.vol, baseS.nonop, { days: () => startDays })),
    sens('NAND 占成本比重 φ', `${fmt(phiAll, 2)} → ${fmt(phiAll + 0.1, 2)}`, runScenario(baseS.dp, baseS.vol, baseS.nonop, { phi: phiAll + 0.1 })),
    sens('NAND 占成本比重 φ', `${fmt(phiAll, 2)} → ${fmt(phiAll - 0.1, 2)}`, runScenario(baseS.dp, baseS.vol, baseS.nonop, { phi: phiAll - 0.1 })),
    sens('實質出貨量季成長', `${fmt(gAll * 100, 1)}% → 0%`, runScenario(baseS.dp, 0, baseS.nonop)),
  ];

  /* ── derived series ── */
  const hs = hist[selMethod];
  const other: L.Method = selMethod === 'wa' ? 'fifo' : 'wa';
  const histPeriods = rows.map((r) => r.period);
  const derived: Out['derived'] = [
    {
      id: 'selling-price-index', name: '售價指數（NAND 合約價指數）', unit: `指數（${L.PRICE_BASE}=100）`,
      points: [...histPeriods.map((p) => ({ period: p, value: round(P.get(p)!, 2), status: 'estimate' as const })), ...base.map((r) => ({ period: r.period, value: round(r.P, 2), status: L.priceSeries(prices, 'nand-contract-qoq').points.find((p) => p.period === r.period)?.status === 'estimate' ? ('estimate' as const) : ('forecast' as const) }))],
      note: 'TrendForce NAND Flash 整體合約價季變化串成的指數；模型假設群聯售價與當季合約價同步。2026Q3 為 TrendForce 季末估計的中值，2026Q4 為其預測區間的中值，2027 年為基準情境的假設。',
    },
    {
      id: 'purchase-cost-index', name: `購入成本指數（${selMethod === 'wa' ? '移動加權平均' : '先進先出'}）`, unit: `指數（${L.PRICE_BASE}=100）`,
      points: [...hs.slice(1).map((h) => ({ period: h.period, value: round(h.c, 2), status: 'estimate' as const })), ...base.map((r) => ({ period: r.period, value: round(r.c, 2), status: 'forecast' as const }))],
      note: '當季賣出商品的平均購入成本：由財報的營業成本與存貨推回各季進貨，以進貨當季的合約價指數計價。歷史值由財報推算，2026Q3 起為基準情境。',
    },
    {
      id: `purchase-cost-index-${other}`, name: `購入成本指數（${other === 'wa' ? '移動加權平均' : '先進先出'}，對照）`, unit: `指數（${L.PRICE_BASE}=100）`,
      points: hist[other].slice(1).map((h) => ({ period: h.period, value: round(h.c, 2), status: 'estimate' as const })),
      note: '同樣的進貨推估改用另一種存貨成本法，供比較。',
    },
    {
      id: 'cost-price-ratio', name: '購入成本 ÷ 售價（x）', unit: '倍',
      points: [...hs.slice(1).map((h) => ({ period: h.period, value: round(h.x, 3), status: 'estimate' as const })), ...base.map((r) => ({ period: r.period, value: round(r.x, 3), status: 'forecast' as const }))],
      note: '小於 1 代表手上存貨是用比現在便宜的價格買進（低價庫存），毛利率會被推高；大於 1 代表存貨成本高於市價，毛利率受壓並可能提列跌價損失。',
    },
    {
      id: 'inventory-days', name: '庫存天數', unit: '天',
      points: [...rows.map((r) => ({ period: r.period, value: round((r.inv / r.cogs) * 91, 0), status: 'estimate' as const })), ...base.map((r) => ({ period: r.period, value: round(r.invDays, 0), status: 'forecast' as const }))],
      note: '存貨 ÷ 當季營業成本 × 91；預測期為基準情境假設（維持到 2026Q4，之後回到 2023–2025 年平均）。',
    },
    {
      id: 'estimated-purchases', name: '推估進貨（營業成本 + 存貨增加）', unit: '百萬元',
      points: [...rows.slice(1).map((r, i) => ({ period: r.period, value: round(r.cogs + r.inv - rows[i]!.inv, 0), status: 'estimate' as const })), ...base.map((r) => ({ period: r.period, value: round(r.purchases, 0), status: 'forecast' as const }))],
      note: '含材料以外的封測、人工等生產成本；年報的「進貨淨額」只含材料，兩者對照見「進貨淨額（年報）」。',
    },
    {
      id: 'inventory-writedown-model', name: '模型推估的存貨跌價損失（保守情境）', unit: '百萬元',
      points: runs.get('bear')!.map((r) => ({ period: r.period, value: round(r.wd, 0), status: 'forecast' as const })),
      note: '帳面單位成本高於當季合約價指數時，依 κ 提列；只要合約價仍高於帳上成本就是 0（基準與樂觀情境各季皆為 0 或接近 0）。',
    },
    ...[LAST, '2025Q4'].map((t) => {
      const v = L.soldVintages(selMethod, rows, P, t);
      const recent = [...v].filter(([k]) => !k.startsWith('≤') && qIndex(k) >= qIndex(t) - 7).sort((a, b) => qIndex(a[0]) - qIndex(b[0]));
      const older = 1 - recent.reduce((a, [, x]) => a + x, 0);
      return {
        id: `purchase-vintage-${t}`, name: `${t} 賣出商品的進貨季度分布`, unit: '%',
        points: recent.map(([k, x]) => ({ period: k, value: round(x * 100, 1), status: 'estimate' as const })),
        note: `模型推估 ${t} 賣出的商品（以數量計）是在哪一季買進的：${selMethod === 'wa' ? '移動加權平均法下各季進貨按比例混在一起' : '先進先出'}；更早買進的占 ${fmt(older * 100, 1)}%。進貨價見售價指數（同一季的合約價）。`,
      };
    }),
    {
      id: 'backtest-multistep-gross-margin', name: `多步回測：從 ${TRAIN.to} 出發的毛利率（不更新財報）`, unit: '%',
      points: multi.map((r) => ({ period: r.period, value: round(r.pnl.gm, 2), status: 'estimate' as const })),
      note: `參數只用 ${TRAIN.from}–${TRAIN.to} 估計，之後只輸入各季實際合約價與月營收、不使用新財報，模擬「一次預測六季」的誤差；實際毛利率見財報。`,
    },
  ];
  // annual sanity checks: units and per-unit values from the 產銷量值表, purchases vs the reported 進貨淨額
  const annualPts = (f: (a: CompanyInputs['annual'][number]) => number | undefined, status: 'actual' | 'estimate' = 'estimate') =>
    inputs.annual.map((a) => ({ period: a.year, v: f(a) })).filter((x): x is { period: string; v: number } => x.v !== undefined && Number.isFinite(x.v)).map((x) => ({ period: x.period, value: round(x.v, 1), status }));
  const moduleOf = (a: CompanyInputs['annual'][number]) => a.sales.find((s) => s.product.startsWith('快閃記憶體模組'));
  const prodUnits = (a: CompanyInputs['annual'][number]) => a.extra?.['產量－快閃記憶體模組產品（千片）'] ?? a.extra?.['產量－快閃記憶體模組產品（千個）'];
  const prodValue = (a: CompanyInputs['annual'][number]) => a.extra?.['產值－快閃記憶體模組產品（百萬元）'];
  const annualCost = new Map(inputs.annual.map((a) => {
    const v = hs.filter((h) => h.period.startsWith(`${a.year}Q`));
    return [a.year, v.length === 4 ? v.reduce((s, h) => s + h.c, 0) / 4 : NaN];
  }));
  const unitCost = new Map(inputs.annual.map((a) => { const u = prodUnits(a), v = prodValue(a); return [a.year, u && v ? (v / u) * 1000 : NaN]; }));
  const yoy = (m: Map<string, number>, y: string) => Math.log(m.get(y)! / m.get(String(Number(y) - 1))!);
  const corrYears = inputs.annual.map((a) => a.year).filter((y) => Number.isFinite(yoy(unitCost, y)) && Number.isFinite(yoy(annualCost, y)));
  const corr = (() => {
    const xs = corrYears.map((y) => yoy(annualCost, y)), ys = corrYears.map((y) => yoy(unitCost, y));
    const mx = xs.reduce((a, v) => a + v, 0) / xs.length, my = ys.reduce((a, v) => a + v, 0) / ys.length;
    const sxy = xs.reduce((a, v, i) => a + (v - mx) * (ys[i]! - my), 0), sxx = xs.reduce((a, v) => a + (v - mx) ** 2, 0), syy = ys.reduce((a, v) => a + (v - my) ** 2, 0);
    return sxy / Math.sqrt(sxx * syy);
  })();
  const gaps = inputs.annual
    .map((a) => {
      const qs = rows.filter((r) => r.period.startsWith(`${a.year}Q`));
      const prev = by.get(`${Number(a.year) - 1}Q4`);
      return qs.length === 4 && prev && a.totalPurchases ? (qs.reduce((s, r) => s + r.cogs, 0) + qs[3]!.inv - prev.inv) / a.totalPurchases - 1 : undefined;
    })
    .filter((x): x is number => x !== undefined);
  const purchaseGap = `${fmt(Math.min(...gaps) * 100, 0)}–${fmt(Math.max(...gaps) * 100, 0)}%`;
  derived.push(
    { id: 'module-units-sold', name: '快閃記憶體模組銷售量（年報）', unit: '千片', points: annualPts((a) => moduleOf(a)?.units, 'actual'), note: '年報「銷售量值表」內銷加外銷；2019 年以前單位寫「千個」，2020 年起寫「千片」。2024 年起年報不再列產銷量值表。' },
    { id: 'module-asp-per-unit', name: '快閃記憶體模組平均售價（銷售值 ÷ 銷售量）', unit: '元／片', points: annualPts((a) => { const m = moduleOf(a); return m?.units ? (m.value / m.units) * 1000 : undefined; }), note: '每片容量隨時間變大，所以這不是每 GB 價格；可看出 2017、2021 年漲價年與 2018–2019、2022 年跌價年的方向。' },
    { id: 'module-cost-per-unit', name: '快閃記憶體模組單位生產成本（產值 ÷ 產量）', unit: '元／片', points: annualPts((a) => { const u = prodUnits(a), v = prodValue(a); return u && v ? (v / u) * 1000 : undefined; }), note: `年報「生產量值表」：模組委外組裝，產值即投入成本。與模型購入成本指數的年平均相比，${corrYears[0]}–${corrYears.at(-1)} 年的年變化相關係數為 ${fmt(corr, 2)}。` },
    { id: 'purchase-cost-index-annual', name: '購入成本指數年平均（模型）', unit: `指數（${L.PRICE_BASE}=100）`, points: [...annualCost].filter(([, v]) => Number.isFinite(v)).map(([y, v]) => ({ period: y, value: round(v, 2), status: 'estimate' as const })), note: '與上面的模組單位生產成本對照，檢驗推回的進貨成本方向是否合理。' },
    { id: 'annual-purchases-reported', name: '進貨淨額（年報）', unit: '百萬元', points: annualPts((a) => a.totalPurchases, 'actual'), note: '年報「主要供應商進貨」表的進貨淨額（材料）。' },
    { id: 'annual-purchases-estimated', name: '推估進貨（營業成本 + 存貨增加，全年）', unit: '百萬元', points: inputs.annual.map((a) => { const qs = rows.filter((r) => r.period.startsWith(`${a.year}Q`)); const prev = by.get(`${Number(a.year) - 1}Q4`); return qs.length === 4 && prev ? { period: a.year, value: round(qs.reduce((s, r) => s + r.cogs, 0) + qs[3]!.inv - prev.inv, 0), status: 'estimate' as const } : undefined; }).filter((x): x is NonNullable<typeof x> => x !== undefined), note: `比年報進貨淨額高約 ${purchaseGap}，差額是封測、人工與製造費用等非材料成本。` },
    { id: 'nand-material-share', name: 'φ：材料（扣除控制晶片）占生產成本比重', unit: '比率', points: phiYears.map((y) => ({ period: y.year, value: round(y.phi, 3), status: 'estimate' as const })), note: '（進貨淨額 − 控制晶片產值）÷（營業成本 + 存貨增加）；模型取 2017–2023 年平均。' },
  );

  /* ── candidate entries ── */
  const knownNext = monthlyQ.get(NEXT)!;
  // where the selected engine's training errors come from: quarters with rising vs falling contract prices
  const trainBias = (sign: 1 | -1) => {
    const f = fitted.get(sel.id)!;
    const e = periodsIn(TRAIN.from, TRAIN.to).filter((t) => Math.sign(dP.get(t)!) === sign).map((t) => f.predict(t, row(t).revenue).grossMargin - row(t).gm);
    return { bias: e.reduce((a, v) => a + v, 0) / e.length, n: e.length };
  };
  const upBias = trainBias(1), downBias = trainBias(-1);
  const selErrs = testPeriods.map((t) => Math.abs((backtest.find((b) => b.candidate === sel.id && b.period === t && b.metric === 'grossMargin')!.predicted) - row(t).gm));
  const worst = testPeriods[selErrs.indexOf(Math.max(...selErrs))]!;
  const worstShare = Math.max(...selErrs) / selErrs.reduce((a, v) => a + v, 0);
  const benchmarks = candidates.filter((c) => !ENGINES.has(c.id) && c.id.startsWith('naive') === false);
  const vint = L.soldVintages(selMethod, rows, P, LAST);
  const meanAge = [...vint].reduce((a, [k, x]) => a + x * (qIndex(LAST) - qIndex(k.startsWith('≤') ? k.slice(1) : k)), 0) / [...vint].reduce((a, [, x]) => a + x, 0);
  const candOut: Out['candidates'] = candidates.map((c) => {
    const nr = nextRevenueCheck.get(c.id);
    const notes: string[] = [];
    const from = c.id === 'naive-last-quarter' ? `沿用 ${LAST} 營收` : c.id === 'naive-same-quarter' ? `沿用 ${addQ(NEXT, -4)} 營收` : `以 ${LAST} 實際營收為起點、沿用訓練期參數`;
    if (nr !== undefined) notes.push(`${NEXT} 營收（${from}）預測 ${fmt(nr, 0)} 百萬元，月營收合計 ${fmt(knownNext, 0)} 百萬元（誤差 ${pct(((nr - knownNext) / knownNext) * 100)}）。`);
    if (c.id === sel.id) {
      notes.push(`選模規則：在能跑價格與庫存情境的兩個庫存模擬中，取測試期毛利率 MAE 最低者，差距在 ${TIE_PP} 個百分點以內時改比 EPS MAE${beatenBy.length ? `（${beatenBy.map((b) => b.name).join('、')}的測試期毛利率誤差更低，但無法跑情境）` : ''}；EPS 誤差較小的是${[...candidates].sort((a, b) => candMetrics.get(a.id)!.eps!.mae - candMetrics.get(b.id)!.eps!.mae)[0]!.name}。`);
      notes.push(`測試期同時用來選模，誤差數字因此略為偏樂觀；6 季中 ${worst} 一季就占毛利率誤差總和的 ${fmt(worstShare * 100, 0)}%。`);
      notes.push(`多步檢驗：從 ${TRAIN.to} 出發、之後六季不更新財報（只知道合約價與月營收），毛利率 MAE ${fmt(sm.grossMarginDynamic!.mae, 1)} 個百分點、EPS MAE ${fmt(sm.epsDynamic!.mae, 1)} 元；同樣條件下沿用 ${TRAIN.to} 毛利率與利潤率的天真做法為 ${fmt(nm.grossMarginDynamic!.mae, 1)} 個百分點、${fmt(nm.epsDynamic!.mae, 1)} 元，${benchmarks.map((b) => `${b.name} ${fmt(dynMae(b.id), 1)} 個百分點`).join('、')}。主模型的多步路徑為 ${multi.map((r) => `${r.period} ${fmt(r.pnl.gm, 1)}%`).join('、')}：${testPeriods[0]} 合約價下跌時預測毛利率大降但實際沒有，之後幾季都偏低。`);
      notes.push(`事前檢驗：改用 TrendForce 季初公布的合約價預測、也不知道月營收時，毛利率 MAE ${fmt(sm.grossMarginExAnte?.mae ?? NaN, 1)} 個百分點（天真模型 ${fmt(nm.grossMarginExAnte?.mae ?? NaN, 1)}）。`);
      notes.push(`訓練期樣本內檢驗：毛利率 MAE ${fmt(sm.grossMarginTrain!.mae, 1)} 個百分點（天真模型 ${fmt(nm.grossMarginTrain!.mae, 1)}）；合約價上漲的 ${upBias.n} 季平均高估 ${fmt(upBias.bias, 1)} 個百分點、下跌的 ${downBias.n} 季平均低估 ${fmt(-downBias.bias, 1)} 個百分點。`);
    }
    if (c.id === 'naive-last-quarter') notes.push(`多步預測（從 ${TRAIN.to} 出發、一直沿用該季的毛利率與利潤率）時，毛利率誤差 ${fmt(nm.grossMarginDynamic!.mae, 1)} 個百分點，${nm.grossMarginDynamic!.mae < sm.grossMarginDynamic!.mae ? '低於' : '高於'}主模型的 ${fmt(sm.grossMarginDynamic!.mae, 1)}；EPS 誤差 ${fmt(nm.epsDynamic!.mae, 1)} 元，主模型 ${fmt(sm.epsDynamic!.mae, 1)} 元（${TRAIN.to} 含處分宏芯宇的一次性損益，天真做法照樣沿用）。天真模型無法回答「價格變了會怎樣」，所以不能用來跑情境。`);
    if (['lag-weighted-index', 'fifo-layers', 'moving-average-inventory'].includes(c.id)) notes.push('營收都用同一條「上季營收 × 合約價變化 × (1 + g)」規則，所以這三個模型的營收誤差相同。');
    if (c.id === 'lag-weighted-index') notes.push('訓練期（2017–2024 年）價格波動不大，資料偏好幾乎沒有落後的權重，因此抓不到 2025 年底起的低價庫存效應。');
    if (c.id === 'price-regression') notes.push('訓練期毛利率對同季價格變化的反應很小，係數外推到 2026 年的大漲時明顯低估。');
    return {
      id: c.id, name: c.name, description: c.description, equations: c.equations,
      metrics: candMetrics.get(c.id)!, selected: c.id === sel.id,
      ...(notes.length ? { note: notes.join('') } : {}),
    };
  });

  /* ── parameters ── */
  const selTrain = fitted.get(sel.id)!.params;
  const parameters: Out['parameters'] = [
    ...selTrain.map((p) => ({ ...p, name: `回測（${TRAIN.from}–${TRAIN.to} 估計）：${p.name}` })),
    ...chainParams(chainFor(TRAIN.from, TRAIN.to)).map((p) => ({ ...p, name: `回測（${TRAIN.from}–${TRAIN.to} 估計）：${p.name}` })),
    ...fitted.get('lag-weighted-index')!.params,
    ...fitted.get('price-regression')!.params,
    ...final.params.map((p) => ({ ...p, name: `預測（${ALL.from}–${ALL.to} 重估）：${p.name}` })),
    ...chainParams(cpAll).map((p) => ({ ...p, name: `預測（${ALL.from}–${ALL.to} 重估）：${p.name}` })),
    { name: `預測起點 ${LAST} 的購入成本 ÷ 售價（x）`, value: round(H_LAST.x, 3), note: '小於 1 表示帳上存貨比市價便宜' },
    { name: `預測起點 ${LAST} 的庫存天數`, value: round(invDays(LAST), 0), unit: '天', note: `存貨約等於 ${fmt(invDays(LAST) / 91, 1)} 季的營業成本` },
    { name: `${LAST} 賣出商品的平均進貨落後`, value: round(meanAge, 2), unit: '季', note: `依${selMethod === 'wa' ? '移動加權平均' : '先進先出'}庫存模擬的進貨季度分布加權（當季買進當季賣出算 0）；比庫存天數換算的 ${fmt(invDays(LAST) / 91, 1)} 季短，因為近幾季進貨量大、較新的存貨比重高` },
    { name: '2023–2025 年平均庫存天數（預測期回歸目標）', value: round(normalDays, 0), unit: '天' },
    { name: '有效稅率（近四季）', value: round(chain0.taxRate * 100, 1), unit: '%' },
    { name: '業外收支（近四季中位數，每季）', value: round(nonopBase, 0), unit: '百萬元' },
    { name: '基本加權平均股數', value: round(chain0.shares, 1), unit: '百萬股' },
    { name: '2024Q4 一次性營業費用（不計入費用趨勢）', value: OPEX_ONE_OFF.get('2024Q4')!, unit: '百萬元', note: '處分深圳宏芯宇部分股權相關的成本與員工酬勞提列（4Q24 法說簡報 Non-TIFRS 調節表）' },
    { name: '模組單位生產成本與購入成本指數的年變化相關係數', value: round(corr, 2), note: `${corrYears[0]}–${corrYears.at(-1)} 年；用來檢驗推回的進貨成本是否合理` },
  ];

  /* ── texts ── */
  const b26q3 = base[0]!, b26q4 = base[1]!;
  const g1 = (v: number) => fmt(v, 1);
  const worseOrBetter = (a: number, b: number) => (a > b ? '高於' : '低於');
  const dynWorse = sm.grossMarginDynamic!.mae > nm.grossMarginDynamic!.mae;
  const exWorse = (sm.grossMarginExAnte?.mae ?? 0) > (nm.grossMarginExAnte?.mae ?? 0);
  const summary =
    `回測（${TRAIN.from}–${TRAIN.to} 估計參數，逐季預測 ${TEST.from}–${TEST.to}，已知當季合約價與月營收）中，${sel.name}的毛利率平均誤差 ${g1(sm.grossMargin!.mae)} 個百分點、EPS ${g1(sm.eps!.mae)} 元，${worseOrBetter(sm.grossMargin!.mae, nm.grossMargin!.mae)}沿用上一季毛利率與利潤率的 ${g1(nm.grossMargin!.mae)} 個百分點、${g1(nm.eps!.mae)} 元，因此被選為主模型；它把 2026 年上半年 60% 以上的毛利率解釋為「用平均約 ${g1(meanAge)} 季前的低價買進的庫存、以現在的高價賣出」。` +
    `${dynWorse || exWorse ? '但優勢不穩定：' : ''}從 ${TRAIN.to} 一次往後預測六季時毛利率誤差 ${g1(sm.grossMarginDynamic!.mae)} 個百分點，${worseOrBetter(sm.grossMarginDynamic!.mae, nm.grossMarginDynamic!.mae)}天真做法的 ${g1(nm.grossMarginDynamic!.mae)}；改用季初的合約價預測、不知道月營收時，毛利率誤差為 ${g1(sm.grossMarginExAnte?.mae ?? NaN)} 個百分點，${worseOrBetter(sm.grossMarginExAnte?.mae ?? NaN, nm.grossMarginExAnte?.mae ?? NaN)}天真模型的 ${g1(nm.grossMarginExAnte?.mae ?? NaN)}。` +
    `${LAST} 底存貨約 ${fmt(invDays(LAST), 0)} 天、購入成本約為市價的 ${fmt(H_LAST.x * 100, 0)}%，基準情境下 ${NEXT} 毛利率約 ${fmt(b26q3.pnl.gm, 0)}%、${addQ(NEXT, 1)} 約 ${fmt(b26q4.pnl.gm, 0)}%，2027 年隨成本追上市價降到約 ${fmt(base2027.gm, 0)}%（保守 ${fmt(annualOf(runs.get('bear')!, '2027').gm, 0)}%、樂觀 ${fmt(annualOf(runs.get('bull')!, '2027').gm, 0)}%）。` +
    `這是依假設價格路徑推算的模型結果，誤差區間大，不是對公司財報或股價的預測。`;

  const firstTest = backtest.find((b) => b.candidate === sel.id && b.period === TEST.from && b.metric === 'grossMargin')!;
  const limitations = [
    '價格指數是 TrendForce 的 NAND Flash 整體合約價（涵蓋 eMMC／UFS、SSD 與晶圓），不是群聯實際的進貨價或售價；群聯除了原廠也向通路商採購（年報），2025 年第四季起晶圓合約價未再公開，實際進貨成本與售價的漲幅可能不同。2018 年第一季以前與 2019 年第四季的合約價是代表性品項的代理值，可信度較低，主要影響庫存模擬的起點與訓練期參數。',
    `模型假設售價與當季合約價同步，對價格的反應偏大：${TRAIN.from}–${TRAIN.to} 逐季回測（樣本內）中，合約價上漲的季度平均高估毛利率 ${g1(upBias.bias)} 個百分點、下跌的季度平均低估 ${g1(-downBias.bias)} 個百分點，整體誤差 ${g1(sm.grossMarginTrain!.mae)} 個百分點，${worseOrBetter(sm.grossMarginTrain!.mae, nm.grossMarginTrain!.mae)}沿用上一季的 ${g1(nm.grossMarginTrain!.mae)}。${TEST.from} 合約價季減約 ${g1(-dP.get(TEST.from)!)}%，模型預測毛利率降到 ${g1(firstTest.predicted)}%，實際是 ${g1(firstTest.actual)}%，與上一季（${g1(row(addQ(TEST.from, -1)).gm)}%）相近。可能是售價調整較慢，或群聯的進貨價跌得比整體合約價快；因此價格下跌的季度，模型容易高估毛利率的下滑，保守情境可能偏悲觀。`,
    `NAND 等材料占成本比重 φ 取自 2017–2023 年年報；2024 年起年報不再列產銷量值表，產品組合轉向企業級 SSD 與 AI 應用後，φ 可能已改變（φ 加減 0.1 的影響見敏感度）。`,
    `非 NAND 成本（控制晶片、封測、人工等）占營收的比重固定在預測起點 ${LAST} 的水準（約 ${fmt((1 - phiAll) * ((row(LAST).cogs - row(LAST).wd) / row(LAST).revenue) * 100, 0)}%）；NAND 價格高漲時這部分被大幅稀釋，若之後售價回落或加價空間被競爭壓縮，毛利率會低於模型。`,
    `庫存模擬把所有生產成本當成同一種「NAND 當量」，沒有區分晶圓、控制晶片與在製品；存貨跌價規則只看帳面成本是否高於合約價，實際提列還涉及呆滯品與在製品評價。2026 年上半年價格大漲時群聯仍提列跌價損失（${rows.filter((r) => r.period.startsWith('2026Q')).map((r) => `${r.period} 約占營收 ${fmt((r.wd / r.revenue) * 100, 1)}%`).join('、')}），模型在合約價高於帳面成本時把跌價損失算成 0，基準與樂觀情境的毛利率可能因此偏高約 1 個百分點。`,
    '營業費用中的員工酬勞、業外的權益法投資收益與匯兌損益很難由價格推得，EPS 的誤差明顯大於毛利率；2027 年逐季價格也沒有公開的數字預測，三種情境都是模型假設。',
    `回測只有 ${testPeriods.length} 季，同時用來選模（誤差數字因此略為偏樂觀），而且 2026 年上半年的漲價幅度遠超過訓練期；從 ${TRAIN.to} 連續預測六季時，主模型的毛利率誤差（${g1(sm.grossMarginDynamic!.mae)} 個百分點）${worseOrBetter(sm.grossMarginDynamic!.mae, nm.grossMarginDynamic!.mae)}天真做法（${g1(nm.grossMarginDynamic!.mae)}），預測的季度離起點愈遠，誤差可能愈大。輸入資料沒有群聯的數字財測，因此只和天真模型比較。本頁是說明價格如何影響財報的教學模型，不構成投資建議。`,
  ];

  const sourceKeys = [...new Set([
    'mops-monthly', 'fr-2016', 'fr-2017', 'fr-2018', 'fr-2019', 'fr-2020', 'fr-2021', 'fr-2022', 'fr-2023', 'fr-2024', 'fr-2025', 'fr-2026',
    'ar-2017', 'ar-2019', 'ar-2021', 'ar-2023', 'ar-2024', 'ar-2025', 'ir-4q24', 'uanalyze-20260813',
    q3.src, q4.src, 'tf-20260730-13158', 'tf-20260721-13148',
    // realised and start-of-quarter contract prices of the test window (conditional and ex-ante backtests)
    ...L.priceSeries(prices, 'nand-contract-qoq').points.filter((p) => L.between(p.period, TEST.from, TEST.to)).map((p) => p.src),
    ...L.priceSeries(prices, 'nand-contract-qoq-start-forecast').points.filter((p) => L.between(p.period, TEST.from, TEST.to)).map((p) => p.src),
  ])].filter((k) => k in inputs.sources || k in prices.sources);

  const out: Out = {
    company: 'phison',
    generatedBy: 'scripts/models/phison.ts',
    generatedOn: inputs.asOf > prices.asOf ? inputs.asOf : prices.asOf,
    asOf: inputs.asOf < prices.asOf ? inputs.asOf : prices.asOf,
    currency: 'TWD',
    amountUnit: 'million',
    periodLabel: '日曆季度（新台幣百萬元；EPS 為元）',
    train: TRAIN,
    test: TEST,
    summary,
    candidates: candOut,
    parameters,
    derived,
    backtest,
    scenarios,
    sensitivities,
    limitations,
    sourceKeys,
  };
  return modelOutput.parse(out);
}

/* ───────────── CLI ───────────── */
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const dir = process.argv.includes('--dir') ? process.argv[process.argv.indexOf('--dir') + 1]! : 'src/data/memory/forecast';
  const inputs = companyInputs.parse(parse(readFileSync(`${dir}/phison-inputs.yaml`, 'utf8')));
  const prices = marketPrices.parse(parse(readFileSync(`${dir}/market-prices.yaml`, 'utf8')));
  const out = buildModel(inputs, prices);
  const file = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : `${dir}/phison-model.json`;
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  const sel = out.candidates.find((c) => c.selected)!;
  console.log(`✓ ${file}: selected ${sel.id}`);
  for (const c of out.candidates) console.log(`  ${c.selected ? '*' : ' '} ${c.id.padEnd(26)} GM MAE ${c.metrics.grossMargin?.mae}  EPS MAE ${c.metrics.eps?.mae}  OI MAPE ${c.metrics.operatingIncome?.mape}  Rev MAPE ${c.metrics.revenue?.mape}`);
  for (const s of out.scenarios) console.log(`  ${s.id}: ${s.forecasts.map((f) => `${f.period} R${f.revenue} GM${f.grossMargin} EPS${f.eps}`).join(' | ')}`);
}
