// 美光（Micron）財報模型：用 DRAM／NAND 合約價、位元出貨與每位元生產成本推估營收、毛利率與獲利。
//   npx tsx scripts/models/micron.ts   → 寫出 src/data/memory/forecast/micron-model.json
// buildModel(inputs, prices) 是純函式（不讀檔、不取時間），scripts/check-forecast.ts 會重跑並比對輸出。
//
// 口徑：營收、毛利率（非 GAAP，與美光財測同口徑）、EPS（非 GAAP 稀釋）；營業利益與淨利為 GAAP。
// 期間：美光會計季度（FY2027Q1＝2026-09-04 至 2026-12-03）。TrendForce 合約價是日曆季度，
// 依月份重疊換算：會計季度價格水準＝（1 個月重疊的日曆季度 + 2 × 2 個月重疊的日曆季度）÷ 3。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { companyInputs, marketPrices, type CompanyInputs, type MarketPrices, type ModelOutput } from '../../src/schemas/forecast';
import { addQ, metrics, ols, predict, qIndex, qRange, round, sum, type Pair, type Series } from './lib';
import { calendarIndex, daStep, fiscalChange, fiscalChangeW, fiscalLevel, fiscalToCalendar, hbmFactor, pathValue, priceSeries, quarterTable, splice, type MQ } from './micron-lib';

const GENERATED_ON = '2026-10-23';
const TRAIN_FROM = 'FY2016Q4'; // 第一個能由合約價換算出會計季度季變化的季度
const TRAIN_TO = 'FY2024Q4';
const TEST_FROM = 'FY2025Q1';
const TEST_TO = 'FY2026Q4';
const FORECAST = ['FY2027Q1', 'FY2027Q2', 'FY2027Q3', 'FY2027Q4'];
const G_WINDOW = 12; // 每位元現金成本趨勢：最近 12 季
const PHI_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const ELIGIBLE = ['price-regression', 'unit-cost', 'unit-cost-hbm'];

/** HBM 占美光 DRAM 位元比重（%）的路徑與晶圓交換比。
 *  rm-fy2024q4（2024-09）：HBM 占產業 DRAM 位元由 2023 年 1.5% 升到 2025 年約 6%；美光 FY2024Q3 才開始有 HBM3E 營收，
 *  因此假設美光由 FY2024Q2 的 0 線性升到 FY2025Q4（約當 2025 年 6–8 月）的 6%，之後持平。
 *  rm-fy2024q2（2024-03）：同樣位元數的 HBM3E 約需 DDR5 的 3 倍晶圓。兩者在 FY2024Q4 法說會時都已公開，回測沒有偷看。 */
const HBM_SHARE: [string, number][] = [['FY2024Q2', 0], ['FY2025Q4', 6]];
const HBM_RATIO = 3;

/* ───────────── FY2027 assumptions (sources in micron-inputs.yaml / market-prices.yaml) ───────────── */

const GUIDE = { revenue: 61500, revenueLow: 60000, revenueHigh: 63000, gm: 86.25, gmGaap: 85.95, opexNg: 2060, opexGaap: 2310, eps: 38.15, shares: 1150, tax: 15.5 }; // pr-fy2026q4、rm-fy2026q4
const OPEX_NG_FY2026 = [1300, 1400, 1500, 2600]; // rm-fy2026q1…q4：非 GAAP 營業費用約 13、14、15、26 億美元
const OPEX_INCREASE_FY2027 = 2500; // rm-fy2026q4：FY2027 營業費用約增加 25 億美元
const CAPEX_FY2027 = [11500, 13500, 14000, 14000]; // rm-fy2026q4：第一季約 115 億、上半年約 250 億、下半年更高（下半年每季 140 億為本模型假設）

interface Scenario {
  id: 'bear' | 'base' | 'bull';
  name: string;
  dram: Record<string, number>; // 一般型 DRAM 合約價季變化（日曆季度，%）
  hbmAdd: Record<string, number>; // 含 HBM 合約價相對一般型多出的百分點
  nand: Record<string, number>;
  bits: { dram: number; nand: number }; // 底層位元季增率（%），FY2027Q1 另乘 13/14
  /** FY2027Q2 起每位元現金成本的年變化（%／年）；null＝沿用資料估計的歷史趨勢 g。
   *  FY2027Q1 一律用歷史趨勢再乘財測隱含的墊高倍數，三個情境的第一季銷貨成本都對齊財測。 */
  costAnnual: number | null;
  ratio: number[]; // FY2027Q1–Q4 HBM 晶圓交換比
}
// 每位元成本：資料的歷史趨勢約 −6.7%／年，但美光表示新產品與綠地新廠會使混合 DRAM 每位元成本由目前水準上升（rm-fy2026q3）。
// 基準取兩者之間的持平；保守依美光說法上升（幅度為本模型假設）；樂觀沿用歷史趨勢。
const SCENARIOS: Scenario[] = [
  {
    id: 'bear', name: '保守',
    dram: { '2026Q4': 10, '2027Q1': 0, '2027Q2': -5, '2027Q3': -10 },
    hbmAdd: { '2026Q4': 5, '2027Q1': 0 },
    nand: { '2026Q4': 15, '2027Q1': -5, '2027Q2': -10, '2027Q3': -15 },
    bits: { dram: 5, nand: 5 }, costAnnual: 6, ratio: [3, 3, 4, 4],
  },
  {
    id: 'base', name: '基準',
    dram: { '2026Q4': 12.5, '2027Q1': 6, '2027Q2': 4, '2027Q3': 2 },
    hbmAdd: { '2026Q4': 5, '2027Q1': 10 },
    nand: { '2026Q4': 17.5, '2027Q1': 5, '2027Q2': 0, '2027Q3': -5 },
    bits: { dram: 5, nand: 5 }, costAnnual: 0, ratio: [3, 3, 3, 3],
  },
  {
    id: 'bull', name: '樂觀',
    dram: { '2026Q4': 15, '2027Q1': 12, '2027Q2': 8, '2027Q3': 5 },
    hbmAdd: { '2026Q4': 5, '2027Q1': 20 },
    nand: { '2026Q4': 20, '2027Q1': 10, '2027Q2': 5, '2027Q3': 5 },
    bits: { dram: 5, nand: 5 }, costAnnual: null, ratio: [3, 3, 3, 3],
  },
];

/* ───────────── engine ───────────── */

interface Ctx {
  rows: MQ[];
  by: Map<string, MQ>;
  qoq: { dram: Series; blend: Series; nand: Series; dramStart: Series; nandStart: Series };
  idx: { dram: Series; blend: Series; nand: Series };
}
type PriceKind = 'conv' | 'blend';
interface Params {
  pd: number[]; // DRAM ASP q/q = pd0 + pd1 × 合約價（會計季度）q/q
  pn: number[];
  theta: number; // 折舊調整速度
  phi: number; // 折舊中當作固定成本的比重
  g: number; // 每位元現金成本的對數季變化
  hbm: boolean;
  kind: PriceKind;
}
interface State { period: string; weeks: number; dram: number; nand: number; other: number; cogs: number; da: number; u: number; w: number; wb: number; H: number }
interface Drivers { period: string; weeks: number; bD: number; bN: number; cD: number; cN: number; aD?: number | undefined; aN?: number | undefined; capexLags13: number[]; u: number; w: number; wb: number; H: number; drift: number; level?: number | undefined }
interface Step extends State { rev: number; gm: number; aD: number; aN: number; v: number; X: number }

const da13 = (r: { da: number; weeks: number }) => (r.da * 13) / r.weeks;
const hbmH = (p: string, on: boolean, ratio = HBM_RATIO) => (on ? hbmFactor(pathValue(HBM_SHARE, p), ratio) : 1);
const stateOf = (r: MQ, H: number): State => ({ period: r.period, weeks: r.weeks, dram: r.dram, nand: r.nand, other: r.other, cogs: r.cogs, da: r.da, u: r.u, w: r.w, wb: r.wb, H });

function context(inputs: CompanyInputs, prices: MarketPrices): Ctx {
  const rows = quarterTable(inputs);
  const dram = priceSeries(prices, 'dram-contract-qoq');
  const blend = splice(dram, priceSeries(prices, 'dram-incl-hbm-contract-qoq'), '2024Q3');
  const nand = priceSeries(prices, 'nand-contract-qoq');
  return {
    rows,
    by: new Map(rows.map((r) => [r.period, r])),
    qoq: { dram, blend, nand, dramStart: priceSeries(prices, 'dram-contract-qoq-start-forecast'), nandStart: priceSeries(prices, 'nand-contract-qoq-start-forecast') },
    idx: { dram: calendarIndex(dram), blend: calendarIndex(blend), nand: calendarIndex(nand) },
  };
}
const contract = (ctx: Ctx, p: string, kind: PriceKind) => ({ cD: fiscalChange(kind === 'blend' ? ctx.idx.blend : ctx.idx.dram, p), cN: fiscalChange(ctx.idx.nand, p) });

/** 事前版本：季度開始時還沒結束的兩個日曆季度改用 TrendForce 季初預測（其餘用實現值）。 */
function contractExAnte(ctx: Ctx, p: string): { cD: number | undefined; cN: number | undefined } {
  const pair = fiscalToCalendar(p);
  const build = (real: Series, start: Series) => {
    const s: Series = new Map();
    for (const [q, v] of real) if (qIndex(q) < qIndex(pair[0])) s.set(q, v);
    for (const q of pair) { const v = start.get(q); if (v === undefined) return undefined; s.set(q, v); }
    return calendarIndex(s);
  };
  const di = build(ctx.qoq.dram, ctx.qoq.dramStart);
  const ni = build(ctx.qoq.nand, ctx.qoq.nandStart);
  return { cD: di && fiscalChange(di, p), cN: ni && fiscalChange(ni, p) };
}

function volGrowth(prev: { dram: number; nand: number }, bD: number, bN: number, Hp: number, Hc: number) {
  const wD = prev.dram / (prev.dram + prev.nand);
  return wD * ((1 + bD / 100) * (Hc / Hp) - 1) + (1 - wD) * (bN / 100);
}

/** 一季的單位經濟計算：營收＝上季 × (1 + 位元) × (1 + 售價)；成本＝現金成本（隨位元與趨勢變動）＋ φ × 折舊 ＋ 稼動率不足與跌價。 */
function step(prev: State, d: Drivers, P: Params): Step {
  const aD = d.aD ?? predict(P.pd, [d.cD]);
  const aN = d.aN ?? predict(P.pn, [d.cN]);
  const dram = prev.dram * (1 + d.bD / 100) * (1 + aD / 100);
  const nand = prev.nand * (1 + d.bN / 100) * (1 + aN / 100);
  const other = (prev.other * d.weeks) / prev.weeks;
  const rev = dram + nand + other;
  const v = volGrowth(prev, d.bD, d.bN, prev.H, d.H);
  const da = (daStep(da13(prev), d.capexLags13, P.theta) * d.weeks) / 13;
  const X = (prev.cogs - P.phi * prev.da - prev.u - prev.w + prev.wb) * (1 + v) * Math.exp(P.g) * (1 + d.drift / 100) * (d.level ?? 1);
  const cogs = X + P.phi * da + d.u + d.w - d.wb;
  return { period: d.period, weeks: d.weeks, dram, nand, other, cogs, da, u: d.u, w: d.w, wb: d.wb, H: d.H, rev, gm: (1 - cogs / rev) * 100, aD, aN, v, X };
}

const capexLags13 = (ctx: Ctx, p: string, extra: Map<string, number> = new Map()) =>
  [1, 2, 3, 4].map((k) => {
    const q = addQ(p, -k);
    const r = ctx.by.get(q);
    if (r) return (r.capex * 13) / r.weeks;
    const x = extra.get(q);
    if (x === undefined) throw new Error(`capex missing for ${q}`);
    return x;
  });

function actualDrivers(ctx: Ctx, p: string, P: Params, ex?: { cD: number | undefined; cN: number | undefined }, reported = false): Drivers {
  const r = ctx.by.get(p)!;
  const c = ex ?? contract(ctx, p, P.kind);
  return {
    period: p, weeks: r.weeks, bD: r.bD, bN: r.bN, cD: c.cD!, cN: c.cN!,
    aD: reported ? r.aD : undefined, aN: reported ? r.aN : undefined,
    capexLags13: capexLags13(ctx, p), u: r.u, w: r.w, wb: r.wb, H: hbmH(p, P.hbm), drift: 0,
  };
}

/* ───────────── fitting (only quarters ≤ `to`) ───────────── */

function cashCostIndex(ctx: Ctx, phi: number, hbm: boolean): Series {
  const out: Series = new Map();
  let V = 100;
  ctx.rows.forEach((r, i) => {
    if (i > 0) { const q = ctx.rows[i - 1]!; V *= 1 + volGrowth(q, r.bD, r.bN, hbmH(q.period, hbm), hbmH(r.period, hbm)); }
    out.set(r.period, (r.cogs - phi * r.da - r.u - r.w + r.wb) / V);
  });
  return out;
}
function fitG(ctx: Ctx, phi: number, hbm: boolean, to: string): number {
  const c = cashCostIndex(ctx, phi, hbm);
  const ps = qRange(addQ(to, -(G_WINDOW - 1)), to);
  return ols(ps.map((p) => [qIndex(p)]), ps.map((p) => Math.log(c.get(p)!)))[1]!;
}
function fitTheta(ctx: Ctx, to: string): number {
  let sxy = 0;
  let sxx = 0;
  for (const p of qRange('FY2017Q1', to)) {
    const r = ctx.by.get(p)!;
    const q = ctx.by.get(addQ(p, -1))!;
    const lags = capexLags13(ctx, p);
    const x = sum(lags) / lags.length - da13(q);
    sxy += x * (da13(r) - da13(q));
    sxx += x * x;
  }
  return sxy / sxx;
}
function fitPass(ctx: Ctx, to: string, kind: PriceKind) {
  const ps = qRange(TRAIN_FROM, to);
  const cs = ps.map((p) => contract(ctx, p, kind));
  return {
    pd: ols(cs.map((c) => [c.cD!]), ps.map((p) => ctx.by.get(p)!.aD)),
    pn: ols(cs.map((c) => [c.cN!]), ps.map((p) => ctx.by.get(p)!.aN)),
    n: ps.length,
  };
}
function fitUnit(ctx: Ctx, to: string, hbm: boolean, kind: PriceKind): Params & { phiErr: number; phiErrs: number[]; n: number } {
  const { pd, pn, n } = fitPass(ctx, to, kind);
  const theta = fitTheta(ctx, to);
  let best: (Params & { phiErr: number; phiErrs: number[]; n: number }) | undefined;
  const phiErrs: number[] = [];
  for (const phi of PHI_GRID) {
    const g = fitG(ctx, phi, hbm, to);
    const P: Params = { pd, pn, theta, phi, g, hbm, kind };
    const errs = qRange('FY2017Q1', to).map((p) => {
      const q = ctx.by.get(addQ(p, -1))!;
      const s = step(stateOf(q, hbmH(q.period, hbm)), actualDrivers(ctx, p, P, undefined, true), P);
      return Math.abs(s.cogs / ctx.by.get(p)!.cogs - 1);
    });
    const e = (100 * sum(errs)) / errs.length;
    phiErrs.push(e);
    if (!best || e < best.phiErr - 1e-12) best = { ...P, phiErr: e, phiErrs, n };
  }
  return best!;
}
/** 只用訓練期檢驗日曆季度→會計季度的權重：各權重下 DRAM（含 HBM）與 NAND 價格傳導迴歸的殘差平方和。 */
const W_GRID = [0, 1 / 6, 1 / 3, 1 / 2, 2 / 3, 5 / 6, 1];
function weightCheck(ctx: Ctx, to: string) {
  const ps = qRange(TRAIN_FROM, to);
  const sse = (idx: Series, w: number, y: (r: MQ) => number) => {
    const x = ps.map((p) => fiscalChangeW(idx, p, w)!);
    const ys = ps.map((p) => y(ctx.by.get(p)!));
    const c = ols(x.map((v) => [v]), ys);
    return sum(ys.map((v, i) => (v - predict(c, [x[i]!])) ** 2));
  };
  const rows = W_GRID.map((w) => ({ w, sse: sse(ctx.idx.blend, w, (r) => r.aD) + sse(ctx.idx.nand, w, (r) => r.aN) }));
  return { rows, best: rows.reduce((a, b) => (b.sse < a.sse - 1e-9 ? b : a)) };
}
function fitRegression(ctx: Ctx, to: string) {
  const ps = qRange(TRAIN_FROM, to);
  const cs = ps.map((p) => contract(ctx, p, 'conv'));
  const rev = ols(cs.map((c) => [c.cD!, c.cN!]), ps.map((p) => 100 * Math.log(ctx.by.get(p)!.revenue / ctx.by.get(addQ(p, -1))!.revenue)));
  const gm = ols(ps.map((p, i) => [ctx.by.get(addQ(p, -1))!.gm, cs[i]!.cD!, cs[i]!.cN!]), ps.map((p) => ctx.by.get(p)!.gm));
  return { rev, gm, n: ps.length };
}

/* ───────────── backtest bridge: revenue & margin → GAAP operating / net income, non-GAAP EPS ───────────── */

interface Pred { rev: number; gm: number; oi?: number | undefined; ni?: number | undefined; eps?: number | undefined }
/** 營業費用、業外、稅率、股數與 GAAP／非 GAAP 毛利率差採當季實際值（視為已知），差異只來自營收與毛利率。 */
function bridge(a: MQ, rev: number, gm: number): Pred {
  const tau = a.pretax > 0 ? Math.min(Math.max(1 - a.ni / a.pretax, 0), 0.35) : 0.15;
  const oi = (rev * (gm - (a.gm - a.gmGaap))) / 100 - a.opex;
  const ni = a.ni + (oi - a.oi) * (1 - tau);
  const eps = a.epsNg + (((rev * gm) / 100 - (a.revenue * a.gm) / 100) * (1 - tau)) / a.shares;
  return { rev, gm, oi, ni, eps };
}

/* ───────────── forecast ───────────── */

interface FcRow { period: string; rev: number; gm: number; oi: number; ni: number; eps: number; dram: number; nand: number; aD: number; aN: number; bD: number; bN: number; da: number; cogs: number; v: number; X: number; H: number; cD: number; cN: number; opexNg: number }
interface FcOpts { dramAdd?: number; nandAdd?: number; bitAdd?: number; costAdd?: number; passAdd?: number; opexAdd?: number; taxAdd?: number }

function nonOpImplied() {
  // 由 FY2027Q1 財測反推業外收支：EPS × 股數 ÷ (1 − 稅率) −（營收 × 毛利率 − 營業費用）
  return (GUIDE.eps * GUIDE.shares) / (1 - GUIDE.tax / 100) - ((GUIDE.revenue * GUIDE.gm) / 100 - GUIDE.opexNg);
}
function opexPath(): number[] {
  const total = sum(OPEX_NG_FY2026) + OPEX_INCREASE_FY2027;
  const rest = (total - GUIDE.opexNg) / 3;
  return [GUIDE.opexNg, rest, rest, rest];
}

/** k：FY2027Q1 起每位元現金成本的一次性墊高倍數（由財測隱含的銷貨成本反推，之後隨遞迴延續）。 */
function forecast(ctx: Ctx, P: Params, sc: Scenario, o: FcOpts = {}, k = 1): FcRow[] {
  const last = ctx.rows.at(-1)!;
  const add = (path: Record<string, number>, extra = 0) => Object.fromEntries(Object.entries(path).map(([k, v]) => [k, v + (k.startsWith('2027') ? extra : 0)]));
  const dramPath = add(sc.dram, o.dramAdd);
  const blendPath = Object.fromEntries(Object.entries(dramPath).map(([k, v]) => [k, v + (sc.hbmAdd[k] ?? 0)]));
  const dIdx = calendarIndex(P.kind === 'blend' ? ctx.qoq.blend : ctx.qoq.dram, P.kind === 'blend' ? blendPath : dramPath);
  const nIdx = calendarIndex(ctx.qoq.nand, add(sc.nand, o.nandAdd));
  const capex = new Map(FORECAST.map((p, i) => [p, CAPEX_FY2027[i]!]));
  const opex = opexPath();
  const nonOp = nonOpImplied();
  const tax = (GUIDE.tax + (o.taxAdd ?? 0)) / 100;
  const gapGm = GUIDE.gm - GUIDE.gmGaap;
  const gapOpex = GUIDE.opexGaap - GUIDE.opexNg;
  const Pp: Params = { ...P, pd: [P.pd[0]!, P.pd[1]! + (o.passAdd ?? 0)], pn: [P.pn[0]!, P.pn[1]! + (o.passAdd ?? 0)] };
  let prev: State = stateOf(last, P.hbm ? hbmFactor(pathValue(HBM_SHARE, last.period), HBM_RATIO) : 1);
  const out: FcRow[] = [];
  FORECAST.forEach((p, i) => {
    const weeks = 13;
    const wk = weeks / prev.weeks;
    const bD = ((1 + (sc.bits.dram + (o.bitAdd ?? 0)) / 100) * wk - 1) * 100;
    const bN = ((1 + (sc.bits.nand + (o.bitAdd ?? 0)) / 100) * wk - 1) * 100;
    const cD = fiscalChange(dIdx, p)!;
    const cN = fiscalChange(nIdx, p)!;
    const H = P.hbm ? hbmFactor(pathValue(HBM_SHARE, p), sc.ratio[i]!) : 1;
    // 第一季：歷史趨勢 e^g × 財測隱含墊高 k（三個情境相同）；第二季起：情境設定的每位元成本年變化（null＝歷史趨勢），另加敏感度的每季變化
    const target = i === 0 ? Math.exp(P.g) : (sc.costAnnual === null ? Math.exp(P.g) : Math.pow(1 + sc.costAnnual / 100, 0.25)) * (1 + (o.costAdd ?? 0) / 100);
    const drift = (target / Math.exp(P.g) - 1) * 100;
    const d: Drivers = { period: p, weeks, bD, bN, cD, cN, capexLags13: capexLags13(ctx, p, capex), u: 0, w: 0, wb: 0, H, drift, level: i === 0 ? k : 1 };
    const s = step(prev, d, Pp);
    const opexNg = opex[i]! + (o.opexAdd ?? 0) / 4;
    const gpNg = (s.rev * s.gm) / 100;
    const eps = ((gpNg - opexNg + nonOp) * (1 - tax)) / GUIDE.shares;
    const oi = (s.rev * (s.gm - gapGm)) / 100 - (opexNg + gapOpex);
    const ni = (oi + nonOp) * (1 - tax);
    out.push({ period: p, rev: s.rev, gm: s.gm, oi, ni, eps, dram: s.dram, nand: s.nand, aD: s.aD, aN: s.aN, bD, bN, da: s.da, cogs: s.cogs, v: s.v, X: s.X, H, cD, cN, opexNg });
    prev = s;
  });
  return out;
}
const annual = (rows: FcRow[]) => {
  const rev = sum(rows.map((r) => r.rev));
  return { rev, gm: (100 * sum(rows.map((r) => (r.rev * r.gm) / 100))) / rev, oi: sum(rows.map((r) => r.oi)), ni: sum(rows.map((r) => r.ni)), eps: sum(rows.map((r) => r.eps)) };
};

/* ───────────── text helpers ───────────── */

/** 數字轉文字，負號用全形減號「−」。 */
const num = (v: number, d = 2) => `${v < 0 ? '−' : ''}${Math.abs(round(v, d))}`;
const term = (v: number, d = 3) => `${v < 0 ? '−' : '+'} ${Math.abs(round(v, d))}`;
const yi = (m: number) => `${round(m / 100, 0).toLocaleString('en-US')} 億美元`;
const yi1 = (m: number) => `${round(m / 100, 1).toLocaleString('en-US')} 億美元`;
const pct = (v: number, d = 1) => `${num(v, d)}%`;
const signed = (v: number, d = 1, unit = '%') => `${v >= 0 ? '+' : '−'}${Math.abs(round(v, d))}${unit}`;
const pp = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(round(v, d))} 個百分點`;
const usd = (v: number, d = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(round(v, d))} 美元`;
const annualRate = (gq: number) => (Math.exp(4 * gq) - 1) * 100;
const pathText = (path: Record<string, number>) => Object.entries(path).map(([k, v]) => `${k.slice(0, 4)} 年第 ${k.slice(5)} 季 ${signed(v, 1)}`).join('、');

/** 情境結果與美光 FY2027 展望（每季營收逐季成長、第一季為全年毛利率低點，rm-fy2026q4）及第一季財測區間的對照。 */
function outlookText(rows: FcRow[]): string {
  const q1 = rows[0]!;
  const range = q1.rev < GUIDE.revenueLow
    ? `低於財測區間下緣 ${yi(GUIDE.revenueLow)}`
    : q1.rev > GUIDE.revenueHigh ? `高於財測區間上緣 ${yi(GUIDE.revenueHigh)}` : `在財測區間 ${round(GUIDE.revenueLow / 100, 0)}–${yi(GUIDE.revenueHigh)}內`;
  const fall = rows.findIndex((r, i) => i > 0 && r.rev < rows[i - 1]!.rev);
  const below = rows.findIndex((r, i) => i > 0 && r.gm < q1.gm);
  const growth = fall < 0 ? '營收逐季成長' : `營收自 ${rows[fall]!.period} 起較前一季減少`;
  const floor = below < 0 ? '第二季起毛利率都高於第一季' : `${rows[below]!.period} 起毛利率低於第一季`;
  const tone = fall < 0 && below < 0 ? '與公司展望方向一致' : '比公司展望悲觀，代表合約價提前反轉的情況';
  return `美光預期 FY2027 每季營收逐季成長、第一季是全年毛利率低點；本情境第一季營收 ${yi(q1.rev)}（${range}），${growth}、${floor}，${tone}`;
}

/* ───────────── build ───────────── */

export function buildModel(inputs: CompanyInputs, prices: MarketPrices): ModelOutput {
  const ctx = context(inputs, prices);
  const test = qRange(TEST_FROM, TEST_TO);
  for (const p of [...qRange(TRAIN_FROM, TEST_TO)]) if (!ctx.by.has(p)) throw new Error(`micron inputs: ${p} missing`);
  if (ctx.rows.at(-1)!.period !== TEST_TO) throw new Error(`micron inputs must end at ${TEST_TO}`);

  // ── fit on training data only
  const unitTr = fitUnit(ctx, TRAIN_TO, false, 'conv');
  const hbmTr = fitUnit(ctx, TRAIN_TO, true, 'blend');
  const regTr = fitRegression(ctx, TRAIN_TO);
  // 消融檢驗：與選定模型相同（含 HBM 合約價），但不做 HBM 晶圓當量調整（不列為候選模型，只在說明中揭露）
  const ablTr = fitUnit(ctx, TRAIN_TO, false, 'blend');
  const wCheck = weightCheck(ctx, TRAIN_TO);

  // ── one-step-ahead predictions in the test window
  const preds: Record<string, Map<string, Pred>> = {};
  const put = (id: string, p: string, x: Pred) => { (preds[id] ??= new Map()).set(p, x); };
  const ablPreds = new Map<string, Pred>();
  const hbmSteps = new Map<string, Step>();
  for (const p of test) {
    const a = ctx.by.get(p)!;
    const q = ctx.by.get(addQ(p, -1))!;
    put('naive', p, bridge(a, q.revenue, q.gm));
    if (a.guidance?.revenue !== undefined && a.guidance.grossMargin !== undefined) put('guidance', p, { rev: a.guidance.revenue, gm: a.guidance.grossMargin, eps: a.guidance.eps });
    const c = contract(ctx, p, 'conv');
    const revR = q.revenue * Math.exp(predict(regTr.rev, [c.cD!, c.cN!]) / 100);
    put('price-regression', p, bridge(a, revR, predict(regTr.gm, [q.gm, c.cD!, c.cN!])));
    const s1 = step(stateOf(q, 1), actualDrivers(ctx, p, unitTr), unitTr);
    put('unit-cost', p, bridge(a, s1.rev, s1.gm));
    const s2 = step(stateOf(q, hbmH(q.period, true)), actualDrivers(ctx, p, hbmTr), hbmTr);
    hbmSteps.set(p, s2);
    put('unit-cost-hbm', p, bridge(a, s2.rev, s2.gm));
    const ex = contractExAnte(ctx, p);
    const exConv = { cD: ex.cD, cN: ex.cN }; // 含 HBM 的合約價沒有季初預測，事前版本用一般型 DRAM 的季初預測
    const s3 = step(stateOf(q, hbmH(q.period, true)), actualDrivers(ctx, p, hbmTr, exConv), hbmTr);
    put('unit-cost-hbm-ex-ante', p, bridge(a, s3.rev, s3.gm));
    const s4 = step(stateOf(q, hbmH(q.period, true)), actualDrivers(ctx, p, hbmTr, undefined, true), hbmTr);
    put('unit-cost-reported', p, bridge(a, s4.rev, s4.gm));
    const s5 = step(stateOf(q, 1), actualDrivers(ctx, p, ablTr), ablTr);
    ablPreds.set(p, bridge(a, s5.rev, s5.gm));
  }
  // dynamic 8-quarter path of the HBM unit-cost model from FY2024Q4 (actual drivers, no reset)
  const dyn = new Map<string, Step>();
  {
    let prev: State = stateOf(ctx.by.get(TRAIN_TO)!, hbmH(TRAIN_TO, true));
    for (const p of test) { const s = step(prev, actualDrivers(ctx, p, hbmTr), hbmTr); dyn.set(p, s); prev = s; }
  }

  const METRICS = ['revenue', 'grossMargin', 'operatingIncome', 'netIncome', 'eps'] as const;
  const field = { revenue: 'rev', grossMargin: 'gm', operatingIncome: 'oi', netIncome: 'ni', eps: 'eps' } as const;
  const actualOf = (a: MQ, m: (typeof METRICS)[number]) => ({ revenue: a.revenue, grossMargin: a.gm, operatingIncome: a.oi, netIncome: a.ni, eps: a.epsNg })[m];
  const pairs = (id: string, m: (typeof METRICS)[number]): Pair[] =>
    test.flatMap((p) => { const x = preds[id]?.get(p)?.[field[m]]; return x === undefined ? [] : [{ actual: actualOf(ctx.by.get(p)!, m), predicted: x }]; });
  const metricSet = (id: string) => {
    const out: Record<string, ReturnType<typeof metrics>> = {};
    for (const m of METRICS) { const ps = pairs(id, m); if (ps.length) out[m] = metrics(ps, m !== 'grossMargin'); }
    return out;
  };
  const M: Record<string, Record<string, ReturnType<typeof metrics>>> = {};
  for (const id of Object.keys(preds)) M[id] = metricSet(id);
  M['unit-cost-hbm']!.revenueDynamic = metrics(test.map((p) => ({ actual: ctx.by.get(p)!.revenue, predicted: dyn.get(p)!.rev })));
  M['unit-cost-hbm']!.grossMarginDynamic = metrics(test.map((p) => ({ actual: ctx.by.get(p)!.gm, predicted: dyn.get(p)!.gm })), false);
  const score = (id: string) => M[id]!.revenue!.mape! + M[id]!.grossMargin!.mae;
  const ablPairs = (m: (typeof METRICS)[number]): Pair[] => test.map((p) => ({ actual: actualOf(ctx.by.get(p)!, m), predicted: ablPreds.get(p)![field[m]]! }));
  const MA = { revenue: metrics(ablPairs('revenue')), grossMargin: metrics(ablPairs('grossMargin'), false), eps: metrics(ablPairs('eps')) };
  const ablScore = MA.revenue.mape! + MA.grossMargin.mae;
  const selected = [...ELIGIBLE].sort((x, y) => score(x) - score(y))[0]!;
  if (selected !== 'unit-cost-hbm') throw new Error(`selection changed to ${selected}; review the forecast wiring and texts`);

  // ── re-fit on all data to FY2026Q4 and forecast
  const full = fitUnit(ctx, TEST_TO, true, 'blend');
  const baseSc = SCENARIOS.find((s) => s.id === 'base')!;
  // 模型本身（未調整）的 FY2027Q1 與財測比較；差額視為財測隱含的額外成本（獎金計入存貨、FY2027 獎金較高等），自第一季起延續
  const raw = forecast(ctx, full, baseSc)[0]!;
  const guideCogs = GUIDE.revenue * (1 - GUIDE.gm / 100);
  const kCost = 1 + (guideCogs - raw.cogs) / raw.X;
  const fc = Object.fromEntries(SCENARIOS.map((s) => [s.id, forecast(ctx, full, s, {}, kCost)])) as Record<Scenario['id'], FcRow[]>;
  const base = fc.base;
  const baseY = annual(base);
  // 消融版本（不做 HBM 晶圓當量調整）的 FY2027 基準預測，用來說明這個結構對預測的影響
  const fullAbl = fitUnit(ctx, TEST_TO, false, 'blend');
  const rawAbl = forecast(ctx, fullAbl, baseSc)[0]!;
  const ablY = annual(forecast(ctx, fullAbl, baseSc, {}, 1 + (guideCogs - rawAbl.cogs) / rawAbl.X));
  const q1 = base[0]!;

  // ── sensitivities on FY2027 (base)
  const sens = (o: FcOpts) => { const y = annual(forecast(ctx, full, baseSc, o, kCost)); return { rev: y.rev - baseY.rev, revPct: (y.rev / baseY.rev - 1) * 100, gm: y.gm - baseY.gm, eps: y.eps - baseY.eps }; };
  const sensText = (x: ReturnType<typeof sens>) => {
    const parts: string[] = [];
    if (Math.abs(x.rev) >= 50) parts.push(`營收 ${x.rev >= 0 ? '+' : '−'}${yi(Math.abs(x.rev))}（${signed(x.revPct, 1)}）`);
    if (Math.abs(x.gm) >= 0.005) parts.push(`非 GAAP 毛利率 ${pp(x.gm, 2)}`);
    parts.push(`非 GAAP EPS ${usd(x.eps)}`);
    return `FY2027 ${parts.join('、')}${Math.abs(x.rev) < 50 ? '（營收不變）' : ''}`;
  };
  const sensitivities = [
    { driver: '含 HBM 的 DRAM 合約價（2027 年第 1–3 季）', change: '每季多漲 5 個百分點', effect: sensText(sens({ dramAdd: 5 })) },
    { driver: '含 HBM 的 DRAM 合約價（2027 年第 1–3 季）', change: '每季少漲 5 個百分點', effect: sensText(sens({ dramAdd: -5 })) },
    { driver: 'NAND 合約價（2027 年第 1–3 季）', change: '每季多漲 5 個百分點', effect: sensText(sens({ nandAdd: 5 })) },
    { driver: 'NAND 合約價（2027 年第 1–3 季）', change: '每季少漲 5 個百分點', effect: sensText(sens({ nandAdd: -5 })) },
    { driver: '價格傳導係數（合約價變動反映到美光售價的比例）', change: 'DRAM 與 NAND 各減 0.1', effect: sensText(sens({ passAdd: -0.1 })) },
    { driver: 'DRAM 與 NAND 位元出貨', change: '每季少 1 個百分點', effect: sensText(sens({ bitAdd: -1 })) },
    { driver: '每位元現金成本（FY2027 第二季起）', change: '每季多上升 2%', effect: sensText(sens({ costAdd: 2 })) },
    { driver: '營業費用（非 GAAP）', change: '全年多 10 億美元', effect: sensText(sens({ opexAdd: 1000 })) },
    { driver: '有效稅率', change: '多 2 個百分點', effect: sensText(sens({ taxAdd: 2 })) },
  ];

  // ── candidates
  const mt = (id: string) => M[id]!;
  const eqUnit = [
    'DRAM 營收_t = DRAM 營收_t−1 ×（1 + DRAM 位元季增率_t）×（1 + DRAM 售價季增率_t）；NAND 同理；其他營收維持上季（依週數調整）',
    '售價季增率_t = a + b × 合約價季增率_t（TrendForce 日曆季度換算成美光會計季度）',
    '位元量指數_t = 位元量指數_t−1 ×（1 + w_DRAM × DRAM 位元季增率 + w_NAND × NAND 位元季增率），w 為上季營收比重',
    '現金成本_t = 現金成本_t−1 ×（位元量指數_t ÷ 位元量指數_t−1）× e^g',
    '折舊_t = 折舊_t−1 + θ ×（前四季平均淨資本支出 − 折舊_t−1）（以 13 週為基準）',
    '銷貨成本_t = 現金成本_t + φ × 折舊_t + 稼動率不足_t + 存貨跌價_t − 已跌價存貨售出的成本降低_t',
    '非 GAAP 毛利率_t = 1 − 銷貨成本_t ÷ 營收_t',
  ];
  const coef = (v: number, d = 3) => num(v, d);
  const candidates: ModelOutput['candidates'] = [
    {
      id: 'naive', name: '天真模型（上一季不變）',
      description: '假設本季營收與毛利率都和上一季一樣。這是最簡單的對照組：任何模型如果贏不了它，就沒有存在的價值。',
      equations: ['營收_t = 營收_t−1', '毛利率_t = 毛利率_t−1'],
      metrics: mt('naive'), selected: false,
      note: '營業利益、淨利與 EPS 由營收與毛利率換算，營業費用、業外收支、稅率與股數用當季實際值（與其他模型相同的處理）。',
    },
    {
      id: 'guidance', name: '美光財測（對照基準）',
      description: '美光在上一季法說會公布的本季財測中值（營收、非 GAAP 毛利率、非 GAAP EPS）。這不是本站的模型，而是公司在季度開始時的判斷，用來衡量模型的誤差是大是小。',
      equations: ['預測值 = 上一季法說會公布的本季財測區間中值'],
      metrics: mt('guidance'), selected: false,
      note: `測試期 8 季中有 ${test.filter((p) => (ctx.by.get(p)!.guidance?.revenue ?? Infinity) < ctx.by.get(p)!.revenue).length} 季營收財測中值低於實際，價格上漲期間財測普遍偏保守。財測發布時公司還不知道當季實際的合約價與出貨，所以財測是事前預測；其他回測模型則代入當季實際的合約價或位元出貨，屬於「已知價格條件下」的誤差，兩者不完全可比。EPS 也不完全可比：其他模型換算 EPS 時，營業費用、業外收支、稅率與股數都用當季實際值，財測則要自己預估這些項目。要比較事前能力，請看「單位經濟＋HBM（改用 TrendForce 季初預測價）」。`,
    },
    {
      id: 'price-regression', name: '合約價迴歸',
      description: '直接用歷史資料迴歸：營收的季成長率與毛利率，對 DRAM 與 NAND 合約價的季變化做線性迴歸，不拆位元與成本。簡單，但毛利率是線性外推，價格大漲時會算出超過 100% 的毛利率。',
      equations: [
        `ln(營收_t ÷ 營收_t−1) × 100 = ${coef(regTr.rev[0]!, 2)} ${term(regTr.rev[1]!)} × DRAM 合約價季增率 ${term(regTr.rev[2]!)} × NAND 合約價季增率`,
        `毛利率_t = ${coef(regTr.gm[0]!, 2)} ${term(regTr.gm[1]!)} × 毛利率_t−1 ${term(regTr.gm[2]!)} × DRAM 合約價季增率 ${term(regTr.gm[3]!)} × NAND 合約價季增率`,
      ],
      metrics: mt('price-regression'), selected: false,
      note: `以 ${TRAIN_FROM}–${TRAIN_TO} 共 ${regTr.n} 季估計（一般型 DRAM 合約價）。測試期 FY2026 第二、三季預測毛利率超過 100%，顯示線性迴歸無法處理價格倍增時「成本占比被稀釋」的非線性。`,
    },
    {
      id: 'unit-cost', name: '單位經濟模型（位元 × 售價 − 位元 × 每位元成本）',
      description: '把營收拆成 DRAM 與 NAND 的「位元出貨 × 平均售價」，售價由 TrendForce 合約價換算；成本拆成隨位元變動、每季以固定速度下降的現金成本（製程微縮），加上一部分固定的折舊、稼動率不足與存貨跌價。毛利率由營收與成本相除得到，因此價格倍增時毛利率會趨近上限而不會超過 100%。',
      equations: eqUnit,
      metrics: mt('unit-cost'), selected: false,
      note: `以 ${TRAIN_FROM}–${TRAIN_TO} 估計：DRAM 售價季增率 = ${coef(unitTr.pd[0]!, 2)} ${term(unitTr.pd[1]!)} × 一般型 DRAM 合約價季增率；NAND 售價季增率 = ${coef(unitTr.pn[0]!, 2)} ${term(unitTr.pn[1]!)} × NAND 合約價季增率；θ = ${coef(unitTr.theta, 4)}；φ = ${unitTr.phi}；每位元現金成本趨勢 ${pct(annualRate(unitTr.g), 1)}／年（${addQ(TRAIN_TO, -(G_WINDOW - 1))}–${TRAIN_TO}）。位元出貨用當季實際（公司公布）值。`,
    },
    {
      id: 'unit-cost-hbm', name: '單位經濟＋HBM 組合',
      description: '在單位經濟模型上加入 HBM（高頻寬記憶體）：售價改用 TrendForce「含 HBM」的 DRAM 合約價；成本端把 DRAM 位元換算成「晶圓當量」，因為同樣位元數的 HBM 約需 DDR5 的 3 倍晶圓（美光 2024 年 3 月說法），HBM 比重上升會推高每位元成本。HBM 同時影響售價與成本，這個模型把兩邊都納入。',
      equations: [
        ...eqUnit.slice(0, 2),
        'DRAM 晶圓當量_t = DRAM 位元_t ×（1 +（交換比 − 1）× HBM 位元比重_t），交換比 = 3',
        '位元量指數改用 DRAM 晶圓當量計算；其餘與單位經濟模型相同',
        ...eqUnit.slice(3),
      ],
      metrics: mt('unit-cost-hbm'), selected: true,
      note: `以 ${TRAIN_FROM}–${TRAIN_TO} 估計：DRAM 售價季增率 = ${coef(hbmTr.pd[0]!, 2)} ${term(hbmTr.pd[1]!)} × 含 HBM 的 DRAM 合約價季增率；NAND 售價季增率 = ${coef(hbmTr.pn[0]!, 2)} ${term(hbmTr.pn[1]!)} × NAND 合約價季增率；θ = ${coef(hbmTr.theta, 4)}；φ = ${hbmTr.phi}；每位元現金成本趨勢 ${pct(annualRate(hbmTr.g), 1)}／年。HBM 位元比重假設由 FY2024Q2 的 0 升到 FY2025Q4 的 6%（美光引述的 2025 年產業比重），之後持平。revenueDynamic／grossMarginDynamic 為從 ${TRAIN_TO} 實際值出發、連續推 8 季且不用實際值重設的結果：營收 MAPE ${pct(M['unit-cost-hbm']!.revenueDynamic!.mape!, 2)}、毛利率 MAE ${round(M['unit-cost-hbm']!.grossMarginDynamic!.mae, 2)} 個百分點。選擇規則：在代入當季實際合約價、可用來預測的三個模型（合約價迴歸、單位經濟、單位經濟＋HBM）中，取「營收 MAPE（%）＋ 毛利率 MAE（個百分點）」最小者：本模型 ${round(score('unit-cost-hbm'), 2)}、單位經濟 ${round(score('unit-cost'), 2)}、合約價迴歸 ${round(score('price-regression'), 2)}。前兩者接近，但本模型的營業利益與 EPS 誤差較小（MAPE ${pct(mt('unit-cost-hbm').operatingIncome!.mape!, 1)}、${pct(mt('unit-cost-hbm').eps!.mape!, 1)}，單位經濟為 ${pct(mt('unit-cost').operatingIncome!.mape!, 1)}、${pct(mt('unit-cost').eps!.mape!, 1)}），而且能表達 2027 年 HBM 調價與晶圓交換比的變化。消融檢驗：同樣用含 HBM 的合約價、但不做晶圓當量調整時，營收 MAPE ${pct(MA.revenue.mape!, 2)}、毛利率 MAE ${MA.grossMargin.mae.toFixed(2)} 個百分點（分數 ${ablScore.toFixed(2)}），${ablScore < score('unit-cost-hbm') ? '略優於本模型，表示晶圓當量調整在回測期沒有提高準確度' : '不如本模型'}；差距在 8 季樣本中不顯著，FY2027 基準情境的預測也${Math.abs(ablY.eps - baseY.eps) < 0.01 ? '幾乎相同（EPS 差距不到 0.01 美元）' : `只差 EPS ${usd(ablY.eps - baseY.eps)}`}，保留它是為了表達交換比變化（保守情境）。日曆季度換算成會計季度的權重依月份重疊設為 1:2；只用訓練期資料檢驗，較早日曆季度的權重在 0、1/6、1/3、1/2、2/3、5/6、1 之中，以 ${['0', '1/6', '1/3', '1/2', '2/3', '5/6', '1'][W_GRID.indexOf(wCheck.best.w)]} 的價格傳導迴歸殘差最小。`,
    },
    {
      id: 'unit-cost-hbm-ex-ante', name: '單位經濟＋HBM（改用 TrendForce 季初預測價）',
      description: '與選定模型完全相同，但合約價改用 TrendForce 在季度開始前後公布的預測（事前可以取得的資訊），用來和美光財測公平比較事前預測能力。位元出貨仍用當季實際值。',
      equations: ['同「單位經濟＋HBM 組合」，合約價季增率改用 TrendForce 季初預測（含 HBM 的 DRAM 合約價沒有季初預測，改用一般型 DRAM 的季初預測）'],
      metrics: mt('unit-cost-hbm-ex-ante'), selected: false,
      note: '不參與模型選擇：參數與選定模型相同，只是輸入改成事前預測。每個會計季度重疊的兩個日曆季度改用季初預測，更早的季度用實現值；TrendForce 季初預測的發布日有時比美光財測晚 1–3 週。誤差集中在價格急轉的季度，例如 TrendForce 在 2025 年第四季初預測 DRAM 合約價季增 8–13%，事後約 45–50%。',
    },
    {
      id: 'unit-cost-reported', name: '單位經濟（代入美光公布的售價，診斷用）',
      description: '與選定模型相同的成本結構，但售價直接代入美光事後公布的 DRAM／NAND 平均售價季變化。它把「合約價換算售價」的誤差拿掉，剩下的誤差主要來自成本端，用來診斷模型哪一部分比較不準。',
      equations: ['同「單位經濟＋HBM 組合」，售價季增率 = 美光公布的區間文字換算值'],
      metrics: mt('unit-cost-reported'), selected: false,
      note: '不參與模型選擇：美光的售價季變化要到財報公布後才知道，無法用來預測。營收仍有約 1% 的誤差，來自公司以「低個位數」「約 20%」等區間描述、換算成中值時的進位。',
    },
  ];

  // ── backtest rows
  const backtest: ModelOutput['backtest'] = [];
  for (const id of ['unit-cost-hbm', 'unit-cost-hbm-ex-ante', 'unit-cost', 'unit-cost-reported', 'price-regression', 'naive', 'guidance']) {
    for (const m of METRICS) for (const p of test) {
      const x = preds[id]?.get(p)?.[field[m]];
      if (x === undefined) continue;
      const a = ctx.by.get(p)!;
      const g = m === 'revenue' ? a.guidance?.revenue : m === 'grossMargin' ? a.guidance?.grossMargin : m === 'eps' ? a.guidance?.eps : undefined;
      const d = m === 'grossMargin' || m === 'eps' ? 2 : 0;
      backtest.push({
        period: p, metric: m, actual: round(actualOf(a, m), d), predicted: round(x, d), candidate: id,
        ...(g !== undefined && id !== 'guidance' ? { benchmark: g, benchmarkLabel: '美光財測中值' } : {}),
      });
    }
  }

  // ── derived series
  const derived: ModelOutput['derived'] = [];
  type Pt = { period: string; value: number; status: 'estimate' | 'forecast' };
  {
    // implied blended cost per bit (COGS excluding one-offs ÷ revenue-weighted bit index), FY2016Q4 = 100
    let V = 100;
    let Vh = 100;
    const vol = new Map<string, number>();
    const volH = new Map<string, number>();
    ctx.rows.forEach((r, i) => {
      if (i > 0) { const q = ctx.rows[i - 1]!; V *= 1 + volGrowth(q, r.bD, r.bN, 1, 1); Vh *= 1 + volGrowth(q, r.bD, r.bN, hbmH(q.period, true), hbmH(r.period, true)); }
      vol.set(r.period, V); volH.set(r.period, Vh);
    });
    let Vf = V;
    let Vhf = Vh;
    const fvol = new Map<string, number>();
    const fvolH = new Map<string, number>();
    let pr: { dram: number; nand: number } = ctx.rows.at(-1)!;
    for (const r of base) { Vf *= 1 + volGrowth(pr, r.bD, r.bN, 1, 1); Vhf *= 1 + r.v; fvol.set(r.period, Vf); fvolH.set(r.period, Vhf); pr = r; }
    const B = 'FY2016Q4'; // 所有指數的基期
    const r0 = ctx.by.get(B)!;
    const c0 = (r0.cogs - r0.u - r0.w + r0.wb) / vol.get(B)! / 100;
    const x0 = (r0.cogs - full.phi * r0.da - r0.u - r0.w + r0.wb) / volH.get(B)! / 100;
    const v0 = vol.get(B)! / 100;
    derived.push({
      id: 'cost-per-bit', name: '隱含每位元銷貨成本指數（DRAM＋NAND 混合）', unit: '指數（FY2016Q4 = 100）',
      points: [
        ...ctx.rows.map((r) => ({ period: r.period, value: round(((r.cogs - r.u - r.w + r.wb) / vol.get(r.period)!) / c0, 1), status: 'estimate' as const })),
        ...base.map((r) => ({ period: r.period, value: round((r.cogs / fvol.get(r.period)!) / c0, 1), status: 'forecast' as const })),
      ],
      note: '非 GAAP 銷貨成本扣除稼動率不足費用與存貨跌價（加回已跌價存貨售出的成本降低），除以位元量指數（DRAM 與 NAND 位元季增率以上季營收比重加權）。美光未分產品揭露成本，這是混合指數；FY2027 為基準情境的模型值。FY2019Q1 起 DRAM／NAND 營收分類改變，權重略有跳動。FY2027Q1 的跳升來自依美光財測反推的成本墊高（獎金計入存貨等）。',
    });
    derived.push({
      id: 'cash-cost-per-bit', name: '每位元現金成本指數（扣除固定折舊，DRAM 以 HBM 晶圓當量計）', unit: '指數（FY2016Q4 = 100）',
      points: [
        ...ctx.rows.map((r) => ({ period: r.period, value: round(((r.cogs - full.phi * r.da - r.u - r.w + r.wb) / volH.get(r.period)!) / x0, 1), status: 'estimate' as const })),
        ...base.map((r) => ({ period: r.period, value: round((r.X / fvolH.get(r.period)!) / x0, 1), status: 'forecast' as const })),
      ],
      note: `選定模型內部的成本序列：銷貨成本扣除 φ（${full.phi}）× 折舊與一次性項目後，除以晶圓當量位元量指數。回測時假設它每季以固定速度 g 變動（全期估計 ${pct(annualRate(full.g), 1)}／年）；FY2027Q1 的跳升來自依美光財測反推的成本墊高 ${round((kCost - 1) * 100, 1)}%，第二季起依基準情境假設${baseSc.costAnnual === null ? '沿用歷史趨勢' : baseSc.costAnnual === 0 ? '持平' : `每年變動 ${signed(baseSc.costAnnual, 1)}`}。`,
    });
    const aspIdx = (key: 'aD' | 'aN', fk: 'aD' | 'aN') => {
      let v = 100;
      const pts = ctx.rows.map((r, i) => { if (i > 0) v *= 1 + r[key] / 100; return { period: r.period, value: v, status: 'estimate' as const }; });
      const b = pts.find((x) => x.period === 'FY2016Q4')!.value;
      const out: Pt[] = pts.map((x) => ({ ...x, value: round((x.value / b) * 100, 1) }));
      let f = v;
      for (const r of base) { f *= 1 + r[fk] / 100; out.push({ period: r.period, value: round((f / b) * 100, 1), status: 'forecast' as const }); }
      return out;
    };
    derived.push({ id: 'dram-asp-index', name: '美光 DRAM 平均售價指數', unit: '指數（FY2016Q4 = 100）', points: aspIdx('aD', 'aD'), note: '由美光每季公布的 DRAM 售價季變化（區間文字換算中值）連乘；FY2027 為基準情境的模型值（由合約價換算）。' });
    derived.push({ id: 'nand-asp-index', name: '美光 NAND 平均售價指數', unit: '指數（FY2016Q4 = 100）', points: aspIdx('aN', 'aN'), note: '同 DRAM；FY2016–FY2017 為 Trade NAND 口徑。' });
    const conIdx = (idx: Series, fIdx: Series) => {
      const b = fiscalLevel(idx, 'FY2016Q4')!;
      const pts: Pt[] = ctx.rows.flatMap((r) => { const l = fiscalLevel(idx, r.period); return l === undefined ? [] : [{ period: r.period, value: round((l / b) * 100, 1), status: 'estimate' as const }]; });
      for (const p of FORECAST) pts.push({ period: p, value: round((fiscalLevel(fIdx, p)! / b) * 100, 1), status: 'forecast' as const });
      return pts;
    };
    const dPath = Object.fromEntries(Object.entries(baseSc.dram).map(([k, v]) => [k, v + (baseSc.hbmAdd[k] ?? 0)]));
    derived.push({ id: 'dram-contract-index', name: 'TrendForce DRAM 合約價指數（含 HBM，換算成美光會計季度）', unit: '指數（FY2016Q4 = 100）', points: conIdx(ctx.idx.blend, calendarIndex(ctx.qoq.blend, dPath)), note: '2024 年第二季（日曆）以前為整體 DRAM、之後為含 HBM 的混合合約價；會計季度水準 =（1 個月重疊的日曆季度 + 2 × 2 個月重疊的日曆季度）÷ 3。FY2027 為基準情境假設（2026 年第四季為 TrendForce 預測）。' });
    derived.push({ id: 'nand-contract-index', name: 'TrendForce NAND 合約價指數（換算成美光會計季度）', unit: '指數（FY2016Q4 = 100）', points: conIdx(ctx.idx.nand, calendarIndex(ctx.qoq.nand, baseSc.nand)), note: '換算方式同 DRAM；2018 年第一季以前部分季度為 TrendForce 代表性品項的代理值。' });
    derived.push({
      id: 'depreciation-share', name: '折舊攤銷占銷貨成本比重', unit: '%',
      points: [
        ...ctx.rows.map((r) => ({ period: r.period, value: round((100 * r.da) / r.cogs, 1), status: 'estimate' as const })),
        ...base.map((r) => ({ period: r.period, value: round((100 * r.da) / r.cogs, 1), status: 'forecast' as const })),
      ],
      note: '全公司折舊攤銷 ÷ 非 GAAP 銷貨成本。有一部分折舊列在研發等營業費用，所以這是上限；FY2023 第二季含存貨跌價，比重被壓低。FY2027 折舊由資本支出計畫推算（第一季約 115 億美元、上半年約 250 億美元）。',
    });
    derived.push({
      id: 'bit-volume-index', name: '位元出貨量指數（DRAM＋NAND，以營收比重加權）', unit: '指數（FY2016Q4 = 100）',
      points: [
        ...ctx.rows.map((r) => ({ period: r.period, value: round(vol.get(r.period)! / v0, 1), status: 'estimate' as const })),
        ...base.map((r) => ({ period: r.period, value: round(fvol.get(r.period)! / v0, 1), status: 'forecast' as const })),
      ],
      note: '由美光公布的 DRAM、NAND 位元出貨季變化（區間文字換算中值）以上季營收比重加權連乘。14 週的季度（FY2020Q4、FY2026Q4）出貨較多，下一季會因週數減少而回落。',
    });
  }

  // ── parameters
  const fy25Actual = (() => {
    const d = derived.find((x) => x.id === 'cost-per-bit')!.points;
    const v = (p: string) => d.find((x) => x.period === p)!.value;
    return (v('FY2025Q4') / v('FY2024Q4') - 1) * 100;
  })();
  const fy25 = qRange('FY2025Q1', 'FY2025Q4').map((p) => ctx.by.get(p)!);
  const fy25wD = sum(fy25.map((r) => r.dram)) / sum(fy25.map((r) => r.dram + r.nand));
  const fy25Micron = fy25wD * -2 + (1 - fy25wD) * -12; // rm-fy2025q4：DRAM 含 HBM「低個位數」下降、NAND「約 low teens」下降，依 periodNote 的換算規則取 2 與 12
  const nonOp = nonOpImplied();
  const opex = opexPath();
  const parameters: ModelOutput['parameters'] = [
    { name: 'DRAM 價格傳導斜率（含 HBM 合約價 → 美光 DRAM 售價）', value: round(full.pd[1]!, 3), note: `全期 ${TRAIN_FROM}–${TEST_TO} 估計，截距 ${num(full.pd[0]!, 2)}；訓練期（至 ${TRAIN_TO}）為 ${round(hbmTr.pd[1]!, 3)}。合約價季增 10%，美光 DRAM 售價約增 ${num(full.pd[0]! + full.pd[1]! * 10, 1)}%。` },
    { name: 'NAND 價格傳導斜率（NAND 合約價 → 美光 NAND 售價）', value: round(full.pn[1]!, 3), note: `全期估計，截距 ${num(full.pn[0]!, 2)}；訓練期為 ${round(hbmTr.pn[1]!, 3)}。全期斜率${full.pn[1]! > 1 ? '大於 1' : '較高'}，反映 FY2026 資料中心 SSD 比重提高，美光 NAND 售價漲得比整體合約價多。` },
    { name: '折舊調整速度 θ', value: round(full.theta, 4), unit: '每季', note: `折舊每季向「前四季平均淨資本支出」靠近的比例；訓練期為 ${round(hbmTr.theta, 4)}。約相當於 ${round(1 / full.theta / 4, 1)} 年的調整期。` },
    { name: '折舊中視為固定成本的比重 φ', value: full.phi, note: `在 0–1 之間以 0.1 為間隔搜尋，取一季前預測銷貨成本平均誤差最小者（全期 ${round(full.phiErr, 2)}%；訓練期估計為 ${hbmTr.phi}）。其餘折舊隨位元（產能）一起成長，併入現金成本。這個比重在資料中辨識度不高：φ = 0 到 1 的誤差介於 ${round(Math.min(...full.phiErrs), 2)}% 與 ${round(Math.max(...full.phiErrs), 2)}% 之間。` },
    { name: '每位元現金成本趨勢（全期最近 12 季）', value: round(annualRate(full.g), 2), unit: '%／年', note: `${addQ(TEST_TO, -(G_WINDOW - 1))}–${TEST_TO} 的對數線性趨勢（DRAM 以 HBM 晶圓當量計）；訓練期（${addQ(TRAIN_TO, -(G_WINDOW - 1))}–${TRAIN_TO}）為 ${num(annualRate(hbmTr.g), 2)}%／年。FY2027Q1 三個情境都用這個趨勢再乘財測隱含的墊高；第二季起${SCENARIOS.map((s) => `${s.name}${s.costAnnual === null ? '沿用這個趨勢' : s.costAnnual === 0 ? '持平' : `每年 ${signed(s.costAnnual, 1)}`}`).join('、')}，因為美光表示新產品與綠地新廠會使混合 DRAM 每位元成本由目前水準上升（rm-fy2026q3），歷史趨勢未必延續。` },
    { name: '資料推算的 FY2025 混合每位元銷貨成本變化', value: round(fy25Actual, 2), unit: '%', note: `隱含每位元銷貨成本指數 FY2025Q4 相對 FY2024Q4（含折舊、未調整 HBM）。對照美光說法：FY2025 DRAM（不含 HBM）前段成本目標下降中到高個位數、NAND 下降 low to mid-teens（rm-fy2024q4）；實績 DRAM 含 HBM 只下降低個位數、NAND 約 low teens（rm-fy2025q4），依區間換算中值（−2%、−12%）與 FY2025 營收比重粗估混合約 ${num(fy25Micron, 1)}%；兩者口徑不同（全年平均對第四季對第四季、是否含折舊），只能看方向。` },
    { name: 'HBM 晶圓交換比', value: HBM_RATIO, unit: '倍', note: '同樣位元數的 HBM3E 約需 DDR5 的 3 倍晶圓（rm-fy2024q2）；HBM4E 將超過 4 比 1（rm-fy2025q2），保守情境在 FY2027 下半年改用 4。' },
    { name: 'HBM 占美光 DRAM 位元比重（FY2025Q4 起）', value: 6, unit: '%', note: '本模型假設：沿用美光引述的 2025 年產業 HBM 位元比重約 6%（rm-fy2024q4），FY2024Q2 的 0 線性升到 FY2025Q4，之後持平（美光未揭露自身比重）。美光預期產業 HBM 位元成長到 2028 年都快於一般型 DRAM（rm-fy2026q4），比重持平可能使模型低估每位元成本。' },
    { name: 'FY2027Q1 財測：營收中值', value: GUIDE.revenue, unit: '百萬美元', note: '615 億美元 ± 15 億美元（pr-fy2026q4）。' },
    { name: 'FY2027Q1 財測：非 GAAP 毛利率', value: GUIDE.gm, unit: '%', note: 'GAAP 約 85.95%（pr-fy2026q4）；美光表示第一季因 FY2026 第四季加發的獎金計入存貨，是 FY2027 毛利率的低點（rm-fy2026q4）。' },
    { name: 'FY2027Q1 財測：非 GAAP EPS', value: GUIDE.eps, unit: '美元', note: '± 1.00 美元，以約 11.5 億股計（pr-fy2026q4）。' },
    { name: 'FY2027Q1 模型（基準、成本未調整）營收', value: round(raw.rev, 0), unit: '百萬美元', note: `只用 TrendForce 價格預測、位元假設與歷史成本趨勢推算，與財測中值相差 ${signed((raw.rev / GUIDE.revenue - 1) * 100, 1)}。` },
    { name: 'FY2027Q1 模型（基準、成本未調整）非 GAAP 毛利率', value: round(raw.gm, 2), unit: '%', note: `比財測高 ${pp(raw.gm - GUIDE.gm, 2).replace('+', '')}：模型的成本趨勢不知道 FY2026Q4 加發的獎金已計入存貨、FY2027 獎金也較高（rm-fy2026q4）。` },
    { name: 'FY2027Q1 模型（基準、成本未調整）非 GAAP EPS', value: round(raw.eps, 2), unit: '美元', note: `與財測中值相差 ${usd(raw.eps - GUIDE.eps)}。` },
    { name: '財測隱含的每位元現金成本墊高', value: round((kCost - 1) * 100, 1), unit: '%', note: `財測隱含的銷貨成本 = 615 億 ×（1 − 86.25%）≈ ${yi1(guideCogs)}，模型未調整值為 ${yi1(raw.cogs)}；差額 ${yi1(guideCogs - raw.cogs)} 換算成現金成本墊高 ${round((kCost - 1) * 100, 1)}%，三個情境都自 FY2027Q1 起套用並延續（美光表示第二季起 FY2026 獎金的影響減少，但被 FY2027 較高的獎金抵銷）。` },
    { name: 'FY2027Q1 模型（基準、成本調整後）營收', value: round(q1.rev, 0), unit: '百萬美元', note: `財測中值 615 億美元；差距來自價格與位元假設。` },
    { name: 'FY2027Q1 模型（基準、成本調整後）非 GAAP 毛利率', value: round(q1.gm, 2), unit: '%', note: '財測約 86.25%。' },
    { name: 'FY2027Q1 模型（基準、成本調整後）非 GAAP EPS', value: round(q1.eps, 2), unit: '美元', note: `財測 38.15 美元；與財測中值相差 ${usd(q1.eps - GUIDE.eps)}，主要來自營收差距。` },
    { name: '業外收支（每季，由 FY2027Q1 財測反推）', value: round(nonOp, 0), unit: '百萬美元', note: `EPS 38.15 × 11.5 億股 ÷（1 − 15.5%）−（615 億 × 86.25% − 20.6 億）。美光季末現金與投資約 735 億美元（rm-fy2026q4），利息收入應是主要來源；但這是倒推的差額，也吸收了財測各項數字的進位（EPS ± 1 美元相當於業外收支 ± 約 ${yi(GUIDE.shares / (1 - GUIDE.tax / 100))}）。FY2027 各季假設不變。` },
    { name: 'FY2027 非 GAAP 營業費用（全年）', value: round(sum(opex), 0), unit: '百萬美元', note: `FY2026 非 GAAP 營業費用約 ${yi1(sum(OPEX_NG_FY2026))}（各季約 13、14、15、26 億美元，rm-fy2026q1–q4）加上美光預估的增加約 25 億美元（rm-fy2026q4）；第一季用財測 20.6 億美元，其餘三季平均分配（各約 ${yi1(opex[1]!)}）。` },
  ];

  // ── scenarios
  const scenarioOut: ModelOutput['scenarios'] = SCENARIOS.map((sc) => {
    const rows = fc[sc.id];
    const y = annual(rows);
    const blend = Object.fromEntries(Object.entries(sc.dram).map(([k, v]) => [k, v + (sc.hbmAdd[k] ?? 0)]));
    const assumptions: ModelOutput['scenarios'][number]['assumptions'] = [
      { name: '一般型 DRAM 合約價季變化', value: `${pathText(sc.dram)}（2026 年第四季為 TrendForce 9 月預測區間 10–15% 的${sc.id === 'base' ? '中值' : sc.id === 'bear' ? '下緣' : '上緣'}；2027 年各季為本模型假設，TrendForce 未公布各季數字）`, src: 'tf-20260930-13258' },
      { name: '含 HBM 的 DRAM 合約價季變化（模型實際使用）', value: `${pathText(blend)}（2026 年第四季為 TrendForce 預測區間 15–20%；2027 年第一季在一般型之上加 ${sc.hbmAdd['2027Q1'] ?? 0} 個百分點，代表 HBM 年度合約重新議價，幅度為本模型假設）`, src: 'tf-20260930-13258' },
      { name: 'HBM 2027 年價格（TrendForce）', value: 'TrendForce 2026 年 9 月預估 2027 年 HBM 平均售價年增 121%', src: 'tf-20260929-13255' },
      { name: 'HBM 2027 年合約（美光）', value: '美光表示 2027 年 HBM 位元供給絕大部分已完成協議，價格較前一年明顯上漲，HBM 與一般型 DRAM 的毛利率差距縮小', src: 'rm-fy2026q4' },
      { name: 'TrendForce 2027 年展望', value: '2027 年 DRAM 供給仍吃緊、價格續揚；NAND 供給成長高於需求，2027 下半年轉為寬鬆、價格面臨下行壓力；記憶體合約價大致維持高檔', src: 'tf-20260730-13158' },
      { name: 'NAND 合約價季變化', value: `${pathText(sc.nand)}（2026 年第四季為 TrendForce 預測區間 15–20% 的${sc.id === 'base' ? '中值' : sc.id === 'bear' ? '下緣' : '上緣'}；${sc.id === 'bull' ? '2027 年依美光「NAND 供給 2027–2028 年仍受限」的看法假設續漲' : '2027 年依 TrendForce「2027 下半年 NAND 供給轉寬鬆、價格面臨下行壓力」假設漲幅收斂轉跌'}）`, src: sc.id === 'bull' ? 'rm-fy2026q4' : 'tf-20260721-13148' },
      { name: '位元出貨', value: `DRAM 與 NAND 每季成長 ${sc.bits.dram}%（約當年增 ${num((Math.pow(1 + sc.bits.dram / 100, 4) - 1) * 100, 0)}%；美光預估 2027 年產業 DRAM 位元成長 low-20s%、NAND mid-20s%，三個情境相同）；FY2027Q1 只有 13 週（FY2026Q4 為 14 週），另乘 13/14`, src: 'rm-fy2026q4' },
      { name: '財測隱含的成本墊高', value: `FY2027Q1 起每位元現金成本一次墊高 ${round((kCost - 1) * 100, 1)}% 並延續：由美光財測隱含的銷貨成本（615 億 ×（1 − 86.25%）≈ ${yi1(guideCogs)}）反推，反映 FY2026Q4 加發獎金計入存貨、FY2027 獎金較高等模型趨勢看不到的成本`, src: 'rm-fy2026q4' },
      {
        name: '每位元現金成本（FY2027 第二季起）',
        value: sc.costAnnual === null
          ? `沿用資料估計的歷史趨勢 ${pct(annualRate(full.g), 1)}／年，代表製程轉換的成本下降延續；這與美光「新產品與綠地新廠會使混合 DRAM 每位元成本由目前水準上升」的說法相反，屬於樂觀假設`
          : sc.costAnnual === 0
            ? `持平（0%／年）。資料估計的歷史趨勢是 ${pct(annualRate(full.g), 1)}／年，但美光表示 LP6、DDR6 與新一代 HBM 等產品每位元成本較高，加上綠地新廠爬坡，混合 DRAM 每位元成本將由目前水準上升；持平是兩者之間的假設`
            : `每年上升 ${num(sc.costAnnual, 1)}%：依美光「混合 DRAM 每位元成本將由目前水準上升」的說法，幅度為本模型假設`,
        src: 'rm-fy2026q3',
      },
      {
        name: 'HBM 晶圓交換比與比重',
        value: `交換比 ${sc.ratio.join('、')}（FY2027Q1–Q4${sc.ratio.some((r) => r !== HBM_RATIO) ? '；下半年改用 4，代表 HBM4／HBM4E 比重提高，美光表示 HBM4E 的交換比將超過 4 比 1' : '，HBM3E 約 3 倍'}）；HBM 占 DRAM 位元比重維持 ${HBM_SHARE.at(-1)![1]}%（本模型假設）`,
        src: sc.ratio.some((r) => r !== HBM_RATIO) ? 'rm-fy2025q2' : 'rm-fy2024q2',
      },
      { name: '資本支出與折舊', value: `淨資本支出 FY2027 各季 ${CAPEX_FY2027.map((c) => yi(c)).join('、')}（第一季約 115 億、上半年約 250 億為美光說法，下半年每季 140 億為本模型假設），以 θ 推算折舊`, src: 'rm-fy2026q4' },
      { name: '營業費用、業外、稅率與股數', value: `非 GAAP 營業費用各季 ${opex.map((x) => yi1(x)).join('、')}；GAAP 營業費用再加 2.5 億美元、GAAP 毛利率比非 GAAP 低 0.3 個百分點（依 FY2027Q1 財測）；業外收支每季約 ${yi1(nonOp)}；稅率 15.5%；稀釋股數 11.5 億股`, src: 'pr-fy2026q4' },
      { name: '與美光 FY2027 展望對照', value: outlookText(rows), src: 'rm-fy2026q4' },
    ];
    const forecasts: ModelOutput['scenarios'][number]['forecasts'] = rows.map((r, i) => ({
      period: r.period,
      revenue: round(r.rev, 0), grossMargin: round(r.gm, 2), operatingIncome: round(r.oi, 0), netIncome: round(r.ni, 0), eps: round(r.eps, 2),
      known: [],
      note: `DRAM 售價 ${signed(r.aD)}、位元 ${signed(r.bD)}；NAND 售價 ${signed(r.aN)}、位元 ${signed(r.bN)}；折舊 ${yi1(r.da)}。${i === 0 && sc.id === 'base' ? `美光財測：營收 615 億美元（600–630 億）、非 GAAP 毛利率約 86.25%、非 GAAP EPS 38.15 美元。成本未調整時模型為營收 ${yi(raw.rev)}、毛利率 ${pct(raw.gm, 2)}、EPS ${round(raw.eps, 2)} 美元；依財測隱含成本調整後與財測相差：營收 ${signed((r.rev / GUIDE.revenue - 1) * 100, 1)}、毛利率 ${pp(r.gm - GUIDE.gm, 2)}、EPS ${usd(r.eps - GUIDE.eps)}。` : ''}`,
    }));
    forecasts.push({
      period: 'FY2027', revenue: round(y.rev, 0), grossMargin: round(y.gm, 2), operatingIncome: round(y.oi, 0), netIncome: round(y.ni, 0), eps: round(y.eps, 2), known: [],
      note: '四季加總；毛利率為全年毛利 ÷ 全年營收，EPS 為四季加總。營業利益與淨利為 GAAP，毛利率與 EPS 為非 GAAP。',
    });
    return { id: sc.id, name: sc.name, assumptions, forecasts };
  });

  const bear = annual(fc.bear);
  const bull = annual(fc.bull);
  const hm = M['unit-cost-hbm']!;
  const gd = M.guidance!;
  const ea = M['unit-cost-hbm-ex-ante']!;
  const summary = `選定模型是「單位經濟＋HBM 組合」：營收拆成 DRAM／NAND 的位元 × 售價（售價由 TrendForce 合約價換算），成本拆成隨位元變動、逐季下降的每位元現金成本加上折舊，HBM 以約 3 倍晶圓計。FY2025Q1–FY2026Q4 回測（代入當季實際合約價與位元出貨）營收平均誤差（MAPE）${pct(hm.revenue!.mape!, 1)}、非 GAAP 毛利率平均誤差 ${round(hm.grossMargin!.mae, 1)} 個百分點；美光財測同期為 ${pct(gd.revenue!.mape!, 1)} 與 ${round(gd.grossMargin!.mae, 1)} 個百分點，模型改用 TrendForce 季初預測價時為 ${pct(ea.revenue!.mape!, 1)} 與 ${round(ea.grossMargin!.mae, 1)} 個百分點。FY2027Q1 模型營收 ${yi(raw.rev)}、毛利率 ${pct(raw.gm, 1)}，美光財測為 615 億美元、86.25%；美光說明第一季毛利率受 FY2026 第四季加發獎金計入存貨影響，模型把差距視為成本墊高並據以調整三個情境，第二季起基準情境假設每位元成本持平。基準情境 FY2027 營收約 ${yi(baseY.rev)}、非 GAAP 毛利率 ${pct(baseY.gm, 1)}、非 GAAP EPS ${round(baseY.eps, 1)} 美元（保守至樂觀 ${yi(bear.rev)}–${yi(bull.rev)}、EPS ${round(bear.eps, 1)}–${round(bull.eps, 1)} 美元）。這是依假設推算的模型結果，不是投資建議。`;

  const limitations = [
    '美光只以「低個位數」「約 20%」等區間文字描述位元與售價的季變化，本模型換算成中值使用，單季可能有 2–3 個百分點的誤差；成本也沒有分 DRAM／NAND 揭露，每位元成本只能推算混合指數。',
    '回測代入當季實際的合約價與位元出貨，衡量的是「價格已知時」模型拆解營收與成本的能力；真正預測時價格本身難以預知（TrendForce 2025 年第四季初預測 DRAM 季增 8–13%，事後約 45–50%），事前誤差見「改用季初預測價」的對照模型。',
    'TrendForce 合約價是產業平均，美光的產品組合（HBM、資料中心 SSD）與長約（策略客戶協議多有價格上下限）使售價變動與合約價不同；價格傳導係數以 2016–2026 年資料估計，未來長約比重提高後可能改變。',
    `HBM 位元比重與晶圓交換比是依美光公開說法設定的假設（2025 年產業 HBM 位元約 6%、交換比約 3 倍），美光未揭露自身數字；HBM4／HBM4E 的交換比更高，可能使每位元成本上升得比模型快。${ablScore < score('unit-cost-hbm') ? '回測中晶圓當量調整沒有提高準確度（見選定模型說明的消融檢驗），這部分主要依美光說法，而不是資料驗證的結果。' : ''}`,
    `2027 年各季合約價是本模型假設：TrendForce 只公布 2026 年第四季的數字，2027 年只有方向性看法（DRAM 吃緊、NAND 下半年轉寬鬆、HBM 平均售價年增 121%）。保守與樂觀情境的差距（FY2027 營收 ${yi(bear.rev)}–${yi(bull.rev)}）主要來自這些假設。`,
    '折舊由資本支出以統計關係推算；FY2027 資本支出以廠房營建為主，廠房要完工啟用後才開始提列折舊，模型可能高估 FY2027 折舊。獎金、存貨跌價、14 週季度等一次性因素不在成本趨勢內；FY2027 的獎金等成本是由 FY2027Q1 財測反推後套用並假設延續，實際變化不同時毛利率會跟著偏離。',
    '營業費用、業外收支、稅率與股數依 FY2027Q1 財測與美光說法設定，並假設全年不變；美光現金部位持續增加，且表示 2026 年 12 月起提高股東回饋（rm-fy2026q4），利息收入與稀釋股數都可能改變，EPS 會跟著變動。',
  ];

  const sourceKeys = [
    'sec-companyfacts', 'pr-fy2026q4', 'rm-fy2026q4', 'rm-fy2026q3', 'rm-fy2026q2', 'rm-fy2026q1', 'rm-fy2025q4', 'rm-fy2025q2', 'rm-fy2024q4', 'rm-fy2024q2',
    'pr-fy2024q4', 'pr-fy2025q1', 'pr-fy2025q2', 'pr-fy2025q3', 'pr-fy2025q4', 'pr-fy2026q1', 'pr-fy2026q2', 'pr-fy2026q3',
    'tf-20260930-13258', 'tf-20260929-13255', 'tf-20260730-13158', 'tf-20260721-13148', 'tf-20260825-13198',
  ];

  return {
    company: 'micron',
    generatedBy: 'scripts/models/micron.ts',
    generatedOn: GENERATED_ON,
    asOf: inputs.asOf,
    currency: 'USD',
    amountUnit: 'million',
    periodLabel: '美光會計季度（約 9 月至隔年 8 月；FY2027Q1 為 2026-09-04 至 2026-12-03）',
    train: { from: TRAIN_FROM, to: TRAIN_TO },
    test: { from: TEST_FROM, to: TEST_TO },
    summary,
    candidates,
    parameters,
    derived,
    backtest,
    scenarios: scenarioOut,
    sensitivities,
    limitations,
    sourceKeys,
  };
}

/* ───────────── CLI ───────────── */

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dirArg = process.argv.indexOf('--dir');
  const dir = dirArg > 0 ? process.argv[dirArg + 1]! : 'src/data/memory/forecast';
  const inputs = companyInputs.parse(parse(readFileSync('src/data/memory/forecast/micron-inputs.yaml', 'utf8')));
  const prices = marketPrices.parse(parse(readFileSync('src/data/memory/forecast/market-prices.yaml', 'utf8')));
  const out = buildModel(inputs, prices);
  writeFileSync(resolve(dir, 'micron-model.json'), `${JSON.stringify(out, null, 2)}\n`);
  const sel = out.candidates.find((c) => c.selected)!;
  console.log(`micron-model.json written to ${dir}: selected ${sel.id}; ${out.candidates.map((c) => `${c.id} rev ${c.metrics.revenue?.mape ?? '-'}% gm ${c.metrics.grossMargin?.mae ?? '-'}pp`).join(' | ')}`);
}
