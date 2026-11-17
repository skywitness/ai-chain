// 台積電（TSMC）財報模型：用美元營收規模、匯率與新製程／海外廠稀釋推估毛利率，用晶圓出貨與製程組合拆解營收，
// 再接上營業費用、業外、稅率與股數推估獲利。
//   npx tsx scripts/models/tsmc.ts [--dir <dir>]   → 寫出 src/data/forecast/tsmc-model.json（--dir：讀寫另一個資料夾，例如暫存區）
// buildModel(inputs, prices, drivers) 是純函式（不讀檔、不取時間），scripts/check-forecast.ts 會重跑並比對輸出。
// prices（記憶體合約價）在這個模型沒有用到：台積電的成本與售價不直接受記憶體價格影響。
//
// 步驟
//  1. 營收規則（回測用）：美元營收 = 上季每片晶圓營收 × 本季晶圓出貨 × 製程組合單價變化 × e^δ；製程組合單價
//     H_t = Σ 製程營收比重 × e^(−γ × 世代)，γ 為每升一個世代的價差（對數）。新台幣營收 = 美元營收 × 平均匯率。
//  2. 毛利率候選：天真模型、公司財測、財測＋歷史偏差、折舊密度水準迴歸、毛利率橋接、成本彈性（含事前版本）。
//     毛利率、營業利益、淨利與 EPS 的回測以當季實際營收為條件（台積電每月 10 日前後公布月營收，季報前已知），
//     營收的回測則用各模型自己的規則。
//  3. 2016Q2–2024Q4 估計、2025Q1–2026Q3 逐季回測（一季前；稀釋只用該季財報公布前的公司說法，見 DILUTION.bt）；
//     在不依賴財測、能延伸到 2027 年的模型中，取「營收 MAPE ＋ 毛利率 MAE」最小者。
//  4. 以全部資料（至最新一季）重估連續參數（φ 沿用訓練期的選擇；美元成本比重 u 回測用 2017 年公司說法換算的值，
//     預測改用 2025 年說法的 0.25），2026Q4 依財測加上 2016–2026 年財測誤差的百分位，2027 年依平台需求、匯率與稀釋的
//     三種情境推算。資料更新到新的一季時，TEST_TO、NEXT、Y2027 與情境假設要跟著改（buildModel 會檢查最新一季）。
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { companyDrivers, companyInputs, marketPrices, type CompanyDrivers, type CompanyInputs, type MarketPrices, type ModelOutput } from '../../src/schemas/forecast';
import { addQ, mean, metrics, ols, predict, qIndex, qRange, round, sum, type Pair } from './lib';
import { fitNodeMix, fitWaferOnly, median, mixRevenue, nodeH, percentile, quarterTable, seasonalFactors, seriesPoint, type TQ } from './tsmc-lib';

const GENERATED_ON = '2026-11-17';
const TRAIN_FROM = '2016Q2'; // 第一個有上一季資料的季度
const TRAIN_TO = '2024Q4';
const TEST_FROM = '2025Q1';
const TEST_TO = '2026Q3';
const NEXT = '2026Q4'; // 已有財測與 10 月營收的季度
const Y2027 = ['2027Q1', '2027Q2', '2027Q3', '2027Q4'];
const ELIGIBLE = ['dr-level', 'margin-bridge', 'cost-elasticity'];
const SELECTED_EXPECTED = 'cost-elasticity';
const TIE = 0.05; // 分數差距在 0.05 以內視為同分，改看營業利益 MAPE

/** 公司說法：約 75% 的銷貨成本以新台幣計價（tr-2025q2），其餘 25% 視為美元成本，隨匯率變動。 */
const U_USD = 0.25;
/** 公司說法：新台幣每變動 1%，毛利率約變動 0.4 個百分點（tr-2017q2，2025 年 tr-2025q2 再次說明）。 */
const FX_RULE = 0.4;
const PHI_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

/**
 * 公司以季度、半年或全年說明的毛利率稀釋增量（個百分點，正值代表毛利率減少），在開始的季度一次計入。
 * pp：目前已知的最佳說法（含事後說明），用於全期重估、毛利率拆解與連續預測；
 * bt：回測用的事前值，只用該季財報公布前已有的說法（有季度或半年數字時用該數字；只有全年區間時，以全年中值作為
 *     還沒有季度數字之季度的稀釋水準）。沒有 bt 的項目在事前就已公布，兩者相同。
 */
interface Dil { period: string; pp: number; src: string; what: string; bt?: { pp: number; src: string; what: string } }
const DILUTION: Dil[] = [
  { period: '2017Q3', pp: 2.5, src: 'tr-2017q2', what: '10 奈米：2017 年下半年稀釋 2–3 個百分點' },
  { period: '2018Q3', pp: 1, src: 'tr-2018q2', what: '7 奈米：第三季略高於 1 個百分點' },
  { period: '2018Q4', pp: 1.5, src: 'tr-2018q2', what: '7 奈米：第四季約 2.5 個百分點（較第三季多 1.5）' },
  { period: '2020Q3', pp: 2.5, src: 'tr-2020q1', what: '5 奈米：2020 年下半年 2–3 個百分點' },
  { period: '2023Q3', pp: 2.5, src: 'tr-2023q2', what: '3 奈米：第三季 2–3 個百分點' },
  { period: '2023Q4', pp: 1, src: 'tr-2023q2', what: '3 奈米：第四季 3–4 個百分點（較第三季多 1）' },
  { period: '2024Q3', pp: 1.5, src: 'tr-2023q4', what: '下半年部分 5 奈米機台轉支援 3 奈米：另稀釋 1–2 個百分點' },
  { period: '2025Q1', pp: 0.5, src: 'tr-2024q4', what: '海外廠：第一季低於 1 個百分點（取 0.5）' },
  {
    period: '2025Q2', pp: 0.5, src: 'tr-2025q2', what: '海外廠：第二季略高於 1 個百分點（取 1，較第一季多 0.5；第二季財報時才說明）',
    bt: { pp: 2, src: 'tr-2025q1', what: '季報前的說法：2025 年全年 2–3 個百分點（取 2.5，較第一季的 0.5 多 2）' },
  },
  {
    period: '2025Q3', pp: 1, src: 'tr-2025q3', what: '海外廠：下半年接近 2 個百分點（較第二季多 1；第三季財報時才說明）',
    bt: { pp: 1.5, src: 'tr-2025q2', what: '季報前的說法：第二季實際略高於 1、全年仍為 2–3 個百分點（取 2.5，較第二季多 1.5）' },
  },
  { period: '2026Q3', pp: 3.5, src: 'tr-2026q2', what: '2 奈米：第三季與下半年 3–4 個百分點' },
];
const DIL = new Map(DILUTION.map((d) => [d.period, d.pp]));
/** 回測（測試期一季前）用的事前稀釋；訓練期與 DIL 相同。 */
const DIL_BT = new Map(DILUTION.map((d) => [d.period, d.bt?.pp ?? d.pp]));
/** 業外的一次性項目：2026Q2 處分與評價世界先進股票利益 632.0 億元（mr-2026q2），下一季的業外規則先扣除。 */
const ONE_OFF_NONOP = new Map([['2026Q2', 63200]]);

/* ───────────── scenarios (assumptions; sources in tsmc-inputs.yaml / tsmc-drivers.yaml) ───────────── */

type ScenId = 'bear' | 'base' | 'bull';
interface Scenario {
  id: ScenId;
  name: string;
  /** 2026Q4：財測誤差分布的百分位（美元營收與毛利率） */
  pct: number;
  /** 2027 年 HPC 美元營收每季成長（%） */
  hpcQoq: number;
  /** 2027 年非 HPC 平台（手機、物聯網、車用、消費性與其他）美元營收的年變化（%），另加歷史季節性 */
  nonAnnual: number;
  /** 2027 年平均匯率（新台幣／美元） */
  fx: number;
  /** 2027 年新增的毛利率稀釋（個百分點，計入該季） */
  dil: Record<string, number>;
}
const SCENARIOS: Scenario[] = [
  { id: 'bear', name: '保守', pct: 0.1, hpcQoq: 2, nonAnnual: -10, fx: 30, dil: { '2027Q1': 1, '2027Q3': 1 } },
  { id: 'base', name: '基準', pct: 0.5, hpcQoq: 6, nonAnnual: 0, fx: 31.8, dil: { '2027Q3': 0.5 } },
  { id: 'bull', name: '樂觀', pct: 0.9, hpcQoq: 10, nonAnnual: 5, fx: 32.9, dil: { '2027Q3': 0.5 } },
];

/* ───────────── text helpers ───────────── */

const fmtN = (v: number, d = 0) => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v: number, d = 2) => `${v < 0 ? '−' : ''}${fmtN(v, d)}`;
const signed = (v: number, d = 1, unit = '%') => `${v >= 0 ? '+' : '−'}${fmtN(v, d)}${unit}`;
const pp = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${fmtN(v, d)} 個百分點`;
const yi = (m: number, d = 0) => `${num(m / 100, d)} 億元`;
const usdYi = (m: number, d = 0) => `${num(m / 100, d)} 億美元`;
const pct = (v: number, d = 1) => `${num(v, d)}%`;
const term = (v: number, d = 3) => `${v < 0 ? '−' : '+'} ${fmtN(v, d)}`;
const yuan = (v: number, d = 2) => `${num(v, d)} 元`;
/** 新台幣金額（百萬元）：1 兆以上用「兆元」，否則用「億元」。 */
const twd = (m: number) => (Math.abs(m) >= 1e6 ? `${num(m / 1e6, 2)} 兆元` : yi(m));
const qText = (p: string) => `${p.slice(0, 4)} 年第${['一', '二', '三', '四'][Number(p.slice(5)) - 1]}季`;
/** 中文與英文、數字相接時加半形空格。 */
const cjk = (a: string, b: string) => (/[一-鿿]$/.test(a) && /^[A-Za-z0-9+−-]/.test(b) ? `${a} ${b}` : `${a}${b}`);

/* ───────────── model pieces ───────────── */

interface CostParams { phi: number; u: number; g: number; kappa: number; n: number; seG?: number; seKappa?: number }
interface CostState { C: number; D: number; Ru: number; fx: number }
interface CostDrivers { Ru: number; fx: number; R: number; D: number; d: number }

/** 一季的成本彈性計算：現金成本 X = C − φD 隨美元營收（彈性 κ）、匯率（美元成本比重 u）與趨勢 g 變動，加上稀釋。 */
function costStep(prev: CostState, x: CostDrivers, P: CostParams, kappaAdd = 0) {
  const X = (prev.C - P.phi * prev.D) * Math.exp(P.g + (P.kappa + kappaAdd) * Math.log(x.Ru / prev.Ru) + P.u * Math.log(x.fx / prev.fx)) + (x.d / 100) * x.R;
  const C = P.phi * x.D + X;
  return { C, gm: (1 - C / x.R) * 100 };
}
const stateOf = (r: TQ): CostState => ({ C: r.C, D: r.D, Ru: r.Ru, fx: r.fx });

function fitCost(by: Map<string, TQ>, from: string, to: string, phi: number, u: number): CostParams {
  const ps = qRange(from, to);
  const X = (r: TQ) => r.C - phi * r.D;
  const y = ps.map((p) => { const r = by.get(p)!; const q = by.get(addQ(p, -1))!; return Math.log((X(r) - ((DIL.get(p) ?? 0) / 100) * r.R) / X(q)) - u * Math.log(r.fx / q.fx); });
  const x = ps.map((p) => Math.log(by.get(p)!.Ru / by.get(addQ(p, -1))!.Ru));
  const c = ols(x.map((v) => [v]), y);
  // 標準誤（單一解釋變數的 OLS）
  const mx = mean(x);
  const sxx = sum(x.map((v) => (v - mx) ** 2));
  const s2 = sum(y.map((v, i) => (v - c[0]! - c[1]! * x[i]!) ** 2)) / (ps.length - 2);
  return { phi, u, g: c[0]!, kappa: c[1]!, n: ps.length, seG: Math.sqrt(s2 * (1 / ps.length + (mx * mx) / sxx)), seKappa: Math.sqrt(s2 / sxx) };
}
/** 以訓練期一季前毛利率 MAE 選 φ（同分取較小的 φ）。 */
function chooseCost(by: Map<string, TQ>, from: string, to: string, u: number) {
  const ps = qRange(from, to);
  const rows = PHI_GRID.map((phi) => {
    const P = fitCost(by, from, to, phi, u);
    const errs = ps.map((p) => { const r = by.get(p)!; const q = by.get(addQ(p, -1))!; return costStep(stateOf(q), { Ru: r.Ru, fx: r.fx, R: r.R, D: r.D, d: DIL.get(p) ?? 0 }, P).gm - r.gm; });
    return { P, mae: mean(errs.map(Math.abs)) };
  });
  const best = rows.reduce((a, b) => (b.mae < a.mae - 1e-12 ? b : a));
  return { best: best.P, grid: rows.map((r) => ({ phi: r.P.phi, mae: r.mae })) };
}

interface Bridge { a: number; b: number; n: number }
const dDR = (r: { D: number; R: number }, q: { D: number; R: number }) => (r.D / r.R - q.D / q.R) * 100;
const dFX = (r: { fx: number }, q: { fx: number }) => (r.fx / q.fx - 1) * 100;
function fitBridge(by: Map<string, TQ>, from: string, to: string): Bridge {
  const ps = qRange(from, to);
  const c = ols(
    ps.map((p) => [dDR(by.get(p)!, by.get(addQ(p, -1))!)]),
    ps.map((p) => { const r = by.get(p)!; const q = by.get(addQ(p, -1))!; return r.gm - q.gm + (DIL.get(p) ?? 0) - FX_RULE * dFX(r, q); }),
  );
  return { a: c[0]!, b: c[1]!, n: ps.length };
}
const bridgeGm = (q: TQ, x: { D: number; R: number; fx: number; d: number }, B: Bridge) => q.gm + B.a + B.b * dDR(x, q) + FX_RULE * dFX(x, q) - x.d;

function fitLevel(by: Map<string, TQ>, from: string, to: string) {
  const ps = qRange(from, to);
  const c = ols(ps.map((p) => [(by.get(p)!.D / by.get(p)!.R) * 100]), ps.map((p) => by.get(p)!.gm));
  return { a: c[0]!, b: c[1]!, n: ps.length };
}

interface OpexRule { e0: number; e1: number; n: number }
function fitOpex(by: Map<string, TQ>, from: string, to: string): OpexRule {
  const ps = qRange(from, to);
  const c = ols(ps.map((p) => [Math.log(by.get(p)!.R / by.get(addQ(p, -1))!.R)]), ps.map((p) => Math.log(by.get(p)!.opex / by.get(addQ(p, -1))!.opex)));
  return { e0: c[0]!, e1: c[1]!, n: ps.length };
}

interface Pnl { rev: number; gm: number; oi: number; ni: number; eps: number; opex: number; nonop: number; tau: number }
/** 營收 R 與毛利率 gm 已知時，用 t−1（稅率用 t−4）的實際資料推算營業利益、淨利與 EPS。 */
function pnlBacktest(by: Map<string, TQ>, t: string, R: number, gm: number, O: OpexRule): Pnl {
  const q = by.get(addQ(t, -1))!;
  const q4 = by.get(addQ(t, -4))!;
  const opex = q.opex * Math.exp(O.e0 + O.e1 * Math.log(R / q.R));
  const oi = (R * gm) / 100 - opex;
  const nonop = q.nonop - (ONE_OFF_NONOP.get(q.period) ?? 0);
  const tau = q4.tax / q4.pretax;
  const attrib = q.ni / (q.pretax - q.tax);
  const ni = (oi + nonop) * (1 - tau) * attrib;
  return { rev: R, gm, oi, ni, eps: ni / q.shares, opex, nonop, tau };
}

/* ───────────── build ───────────── */

export function buildModel(inputs: CompanyInputs, _prices: MarketPrices | undefined, drivers: CompanyDrivers): ModelOutput {
  if (!drivers) throw new Error('tsmc model needs tsmc-drivers.yaml');
  const rows = quarterTable(inputs, drivers);
  const by = new Map(rows.map((r) => [r.period, r]));
  const LAST = rows.at(-1)!.period;
  if (LAST !== TEST_TO) throw new Error(`tsmc inputs must end at ${TEST_TO} (got ${LAST}); move the windows and review the texts`);
  for (const p of qRange('2016Q1', LAST)) if (!by.has(p)) throw new Error(`tsmc inputs: ${p} missing`);
  const test = qRange(TEST_FROM, TEST_TO);
  const train = qRange(TRAIN_FROM, TRAIN_TO);
  const row = (p: string) => by.get(p)!;
  // 事前與事後稀釋只能在測試期不同，訓練期的估計因此不受事後說法影響
  for (const d of DILUTION) if (d.bt && qIndex(d.period) < qIndex(TEST_FROM)) throw new Error(`DILUTION ${d.period}: ex-ante override must be in the test window`);
  const dilBt = (p: string) => DIL_BT.get(p) ?? 0;

  /* ── fit on training data only ── */
  const mixTr = fitNodeMix(by, TRAIN_FROM, TRAIN_TO);
  const wafTr = fitWaferOnly(by, TRAIN_FROM, TRAIN_TO);
  // 美元成本比重 u：回測用估計當時已有的公司說法——2017 年「匯率每變動 1%、毛利率約 0.4 個百分點」在 2017Q2 成本率下換算
  // （0.4 = 成本率 ×（1 − u））；預測用 2025 年「約 75% 的銷貨成本以新台幣計價」（u = 0.25）
  const u2017 = 1 - FX_RULE / ((100 - row('2017Q2').gm) / 100);
  const costSel = chooseCost(by, TRAIN_FROM, TRAIN_TO, u2017);
  const costTr = costSel.best;
  const costTrU25 = fitCost(by, TRAIN_FROM, TRAIN_TO, costTr.phi, U_USD); // 對照：回測也用 2025 年的說法
  const bridgeTr = fitBridge(by, TRAIN_FROM, TRAIN_TO);
  const levelTr = fitLevel(by, TRAIN_FROM, TRAIN_TO);
  const opexTr = fitOpex(by, TRAIN_FROM, TRAIN_TO);
  // 財測偏差（訓練期中位數）
  const usdBeat = (r: TQ) => r.Ru / r.guide!.usd! - 1;
  const hasUsd = (p: string) => row(p).guide?.usd !== undefined;
  const trUsd = qRange('2016Q1', TRAIN_TO).filter(hasUsd);
  const bR = median(trUsd.map((p) => usdBeat(row(p))));
  const bGM = median(qRange('2016Q1', TRAIN_TO).map((p) => row(p).gm - row(p).guide!.gm));
  const omOf = (r: TQ) => (r.oi / r.R) * 100;
  const bOM = median(qRange('2016Q1', TRAIN_TO).map((p) => omOf(row(p)) - row(p).guide!.om!));
  /** 財測隱含的營業費用率（毛利率 − 營業利益率）減去實際值：正值代表實際費用率低於財測 */
  const gapBeat = (r: TQ) => (r.guide!.gm - r.guide!.om!) - (r.gm - omOf(r));

  /* ── one-quarter-ahead predictions in the test window ── */
  type Pred = { rev?: number | undefined; gm?: number | undefined; oi?: number | undefined; ni?: number | undefined; eps?: number | undefined };
  const preds: Record<string, Map<string, Pred>> = {};
  const put = (id: string, p: string, x: Pred) => { (preds[id] ??= new Map()).set(p, x); };
  const mixRevTwd = (p: string, mix = mixTr) => { const r = row(p); const q = row(addQ(p, -1)); return mixRevenue(r, q, mix.gamma, mix.delta) * r.fx; };
  const costOf = (p: string, P: CostParams) => { const r = row(p); return costStep(stateOf(row(addQ(p, -1))), { Ru: r.Ru, fx: r.fx, R: r.R, D: r.D, d: dilBt(p) }, P).gm; };
  for (const p of test) {
    const a = row(p);
    const q = row(addQ(p, -1));
    const g = a.guide!;
    const withPnl = (rev: number, gm: number): Pred => { const x = pnlBacktest(by, p, a.R, gm, opexTr); return { rev, gm, oi: x.oi, ni: x.ni, eps: x.eps }; };
    put('naive', p, withPnl(q.R, q.gm));
    put('guidance', p, { rev: g.R, gm: g.gm, oi: (g.R * g.om!) / 100 });
    const Rb = g.usd! * (1 + bR) * g.fx!;
    put('guidance-bias', p, { rev: Rb, gm: g.gm + bGM, oi: (Rb * (g.om! + bOM)) / 100 });
    const revMix = mixRevTwd(p);
    put('dr-level', p, withPnl(revMix, levelTr.a + levelTr.b * (a.D / a.R) * 100));
    put('margin-bridge', p, withPnl(revMix, bridgeGm(q, { D: a.D, R: a.R, fx: a.fx, d: dilBt(p) }, bridgeTr)));
    put('cost-elasticity', p, withPnl(revMix, costOf(p, costTr)));
    // 事前：營收與匯率改用財測（美元營收中值、匯率假設），獲利也以財測營收推算
    const gmEx = costStep(stateOf(q), { Ru: g.usd!, fx: g.fx!, R: g.R, D: a.D, d: dilBt(p) }, costTr).gm;
    const xe = pnlBacktest(by, p, g.R, gmEx, opexTr);
    put('cost-elasticity-ex-ante', p, { rev: g.R, gm: gmEx, oi: xe.oi, ni: xe.ni, eps: xe.eps });
  }

  const METRICS = ['revenue', 'grossMargin', 'operatingIncome', 'netIncome', 'eps'] as const;
  type M = (typeof METRICS)[number];
  const field = { revenue: 'rev', grossMargin: 'gm', operatingIncome: 'oi', netIncome: 'ni', eps: 'eps' } as const;
  const actualOf = (a: TQ, m: M) => ({ revenue: a.R, grossMargin: a.gm, operatingIncome: a.oi, netIncome: a.ni, eps: a.eps })[m];
  const pairs = (id: string, m: M): Pair[] => test.flatMap((p) => { const x = preds[id]?.get(p)?.[field[m]]; return x === undefined ? [] : [{ actual: actualOf(row(p), m), predicted: x }]; });
  const MT: Record<string, Record<string, ReturnType<typeof metrics>>> = {};
  for (const id of Object.keys(preds)) {
    const out: Record<string, ReturnType<typeof metrics>> = {};
    for (const m of METRICS) { const ps = pairs(id, m); if (ps.length) out[m] = metrics(ps, m !== 'grossMargin'); }
    MT[id] = out;
  }
  // 訓練期樣本內（一季前）毛利率誤差
  const trainGm = (f: (p: string) => number) => metrics(train.map((p) => ({ actual: row(p).gm, predicted: f(p) })), false);
  MT['cost-elasticity']!.grossMarginTrain = trainGm((p) => costOf(p, costTr));
  MT['margin-bridge']!.grossMarginTrain = trainGm((p) => { const r = row(p); return bridgeGm(row(addQ(p, -1)), { D: r.D, R: r.R, fx: r.fx, d: DIL.get(p) ?? 0 }, bridgeTr); });
  MT['dr-level']!.grossMarginTrain = trainGm((p) => levelTr.a + levelTr.b * (row(p).D / row(p).R) * 100);
  MT['naive']!.grossMarginTrain = trainGm((p) => row(addQ(p, -1)).gm);
  // 連續預測：從 TRAIN_TO 出發推 7 季，代入實際美元營收、匯率與稀釋，但不用新財報的毛利率重設
  const dyn = new Map<string, number>();
  {
    let st = stateOf(row(TRAIN_TO));
    for (const p of test) { const r = row(p); const s = costStep(st, { Ru: r.Ru, fx: r.fx, R: r.R, D: r.D, d: DIL.get(p) ?? 0 }, costTr); dyn.set(p, s.gm); st = { C: s.C, D: r.D, Ru: r.Ru, fx: r.fx }; }
  }
  MT['cost-elasticity']!.grossMarginDynamic = metrics(test.map((p) => ({ actual: row(p).gm, predicted: dyn.get(p)! })), false);
  const dynBridge = new Map<string, number>();
  {
    let prev = row(TRAIN_TO);
    let gm = prev.gm;
    for (const p of test) { const r = row(p); gm = gm + bridgeTr.a + bridgeTr.b * dDR(r, prev) + FX_RULE * dFX(r, prev) - (DIL.get(p) ?? 0); dynBridge.set(p, gm); prev = r; }
  }
  MT['margin-bridge']!.grossMarginDynamic = metrics(test.map((p) => ({ actual: row(p).gm, predicted: dynBridge.get(p)! })), false);

  // ablations and checks (reported in notes)
  const revWaferOnly = metrics(test.map((p) => { const r = row(p); const q = row(addQ(p, -1)); return { actual: r.R, predicted: (q.Ru / q.W) * r.W * Math.exp(wafTr) * r.fx }; }));
  const gmU25 = metrics(test.map((p) => ({ actual: row(p).gm, predicted: costOf(p, costTrU25) })), false);
  const gmNoDil = metrics(test.map((p) => { const r = row(p); return { actual: r.gm, predicted: costStep(stateOf(row(addQ(p, -1))), { Ru: r.Ru, fx: r.fx, R: r.R, D: r.D, d: 0 }, costTr).gm }; }), false);
  // 對照：回測若改用事後才公布的稀釋說法（會偷看），毛利率誤差是多少
  const gmExPostDil = metrics(test.map((p) => { const r = row(p); return { actual: r.gm, predicted: costStep(stateOf(row(addQ(p, -1))), { Ru: r.Ru, fx: r.fx, R: r.R, D: r.D, d: DIL.get(p) ?? 0 }, costTr).gm }; }), false);
  const btDiffers = DILUTION.filter((d) => d.bt);
  const guideFx = {
    rev: metrics(test.map((p) => { const r = row(p); return { actual: r.R, predicted: r.guide!.usd! * r.fx }; })),
    gm: metrics(test.map((p) => { const r = row(p); return { actual: r.gm, predicted: r.guide!.gm + FX_RULE * dFX(r, { fx: r.guide!.fx! }) }; }), false),
  };
  const bridgeFree = (() => {
    const ps = train;
    const c = ols(ps.map((p) => { const r = row(p); const q = row(addQ(p, -1)); return [dDR(r, q), dFX(r, q)]; }), ps.map((p) => { const r = row(p); const q = row(addQ(p, -1)); return r.gm - q.gm + (DIL.get(p) ?? 0); }));
    const m = metrics(test.map((p) => { const r = row(p); const q = row(addQ(p, -1)); return { actual: r.gm, predicted: q.gm + predict(c, [dDR(r, q), dFX(r, q)]) - dilBt(p) }; }), false);
    return { fxCoef: c[2]!, mae: m.mae };
  })();

  /* ── selection ── */
  const score = (id: string) => MT[id]!.revenue!.mape! + MT[id]!.grossMargin!.mae;
  const selected = [...ELIGIBLE].sort((x, y) => {
    const d = score(x) - score(y);
    return Math.abs(d) <= TIE ? MT[x]!.operatingIncome!.mape! - MT[y]!.operatingIncome!.mape! : d;
  })[0]!;
  if (selected !== SELECTED_EXPECTED) throw new Error(`selection changed to ${selected}; review the forecast wiring and texts`);
  // 與次佳結構模型逐季毛利率絕對誤差的配對比較（7 季樣本小，只作說明，不改變選擇）
  const ELIGIBLE_NAME: Record<string, string> = { 'dr-level': '折舊密度水準迴歸', 'margin-bridge': '毛利率橋接模型', 'cost-elasticity': '成本彈性模型' };
  const runnerUp = ELIGIBLE.filter((x) => x !== selected).sort((x, y) => score(x) - score(y))[0]!;
  const absGmErr = (id: string) => test.map((p) => Math.abs(preds[id]!.get(p)!.gm! - row(p).gm));
  const gmDiff = absGmErr(selected).map((v, i) => v - absGmErr(runnerUp)[i]!);
  const gmDiffMean = mean(gmDiff);
  const gmDiffT = gmDiffMean / (Math.sqrt(sum(gmDiff.map((v) => (v - gmDiffMean) ** 2)) / (gmDiff.length - 1)) / Math.sqrt(gmDiff.length));
  const gmWins = gmDiff.filter((v) => v < 0).length;

  /* ── re-fit on all reported quarters ── */
  const costFull = fitCost(by, TRAIN_FROM, LAST, costTr.phi, U_USD);
  if (costFull.phi !== 0) throw new Error('φ > 0 needs a depreciation path for the forecast');
  const opexFull = fitOpex(by, TRAIN_FROM, LAST);
  const mixFull = fitNodeMix(by, TRAIN_FROM, LAST);
  const last = row(LAST);
  const allUsd = qRange('2016Q1', LAST).filter(hasUsd);
  const revBeats = allUsd.map((p) => usdBeat(row(p)) * 100);
  const gmBeats = qRange('2016Q1', LAST).map((p) => row(p).gm - row(p).guide!.gm);

  // 2026Q4 guidance (tsmc-drivers.yaml)
  const gRev = seriesPoint(drivers, 'guidance-revenue-usd', NEXT);
  const gGm = seriesPoint(drivers, 'guidance-gross-margin', NEXT);
  const gOm = seriesPoint(drivers, 'guidance-operating-margin', NEXT);
  const gFx = seriesPoint(drivers, 'fx-guidance', NEXT).value;
  const taxGuide = seriesPoint(drivers, 'effective-tax-rate-guidance', NEXT.slice(0, 4));
  const TAX = taxGuide.value / 100;
  const october = inputs.monthly.find((m) => m.period === `${NEXT.slice(0, 4)}-10`);
  if (!october) throw new Error('October revenue missing');
  const monthly = new Map(inputs.monthly.map((m) => [m.period, m.revenue]));
  const q4Ratios = qRange('2016Q4', LAST).filter((p) => p.endsWith('Q4')).map((p) => row(p).R / monthly.get(`${p.slice(0, 4)}-10`)!);
  const rawQ4 = costStep(stateOf(last), { Ru: gRev.value, fx: gFx, R: gRev.value * gFx, D: last.D, d: 0 }, costFull);
  /** 2026Q4 美元營收：財測中值 ×（1 + 財測誤差百分位）。 */
  const q4Ru = (sc: Scenario) => gRev.value * (1 + percentile(revBeats, sc.pct) / 100);

  // seasonal pattern of non-HPC USD revenue (2018Q1 起有平台別資料)
  const nonHpc = new Map(rows.filter((r) => r.hpc !== undefined).map((r) => [r.period, r.Ru * (1 - r.hpc! / 100)]));
  const hpcRev = new Map(rows.filter((r) => r.hpc !== undefined).map((r) => [r.period, (r.Ru * r.hpc!) / 100]));
  const seas = seasonalFactors(nonHpc, '2018Q2', LAST);
  const hpcShare = last.hpc! / 100;

  interface FcRow { period: string; Ru: number; fx: number; R: number; C: number; gm: number; opex: number; oi: number; nonop: number; ni: number; eps: number; hpc: number; non: number; d: number }
  interface FcOpts { hpcAdd?: number; nonAdd?: number; fxAdd?: number; dilAdd?: number; kappaAdd?: number; params?: CostParams; opexMul?: number; taxAdd?: number; extraD?: number }
  const attrib = last.ni / (last.pretax - last.tax);
  const nonopBase = last.nonop - (ONE_OFF_NONOP.get(LAST) ?? 0);
  /**
   * 2026Q4 額外稀釋：以該情境的第四季美元營收與匯率假設算出的模型未調整毛利率 −（財測中值 + 歷史毛利率偏差百分位），
   * 不低於 0。歷史毛利率偏差已包含營收高於財測的效果，因此用情境營收重算，使第四季毛利率等於目標、不重複計算。
   */
  const q4Target = (sc: Scenario) => gGm.value + percentile(gmBeats, sc.pct);
  const q4RawOf = (sc: Scenario, P: CostParams = costFull, kappaAdd = 0) => costStep(stateOf(last), { Ru: q4Ru(sc), fx: gFx, R: q4Ru(sc) * gFx, D: last.D, d: 0 }, P, kappaAdd).gm;
  const q4Dil = (sc: Scenario, P: CostParams = costFull, kappaAdd = 0) => Math.max(0, q4RawOf(sc, P, kappaAdd) - q4Target(sc));
  /** 2026Q4 營業費用率：財測隱含的費用率（毛利率中值 − 營業利益率中值）減去歷史上實際費用率低於財測的中位數。 */
  const gapBeats = qRange('2016Q1', LAST).map((p) => gapBeat(row(p)));
  const q4OpexRatio = gGm.value - gOm.value - median(gapBeats);
  function forecast(sc: Scenario, o: FcOpts = {}): FcRow[] {
    const P = o.params ?? costFull;
    const tax = TAX + (o.taxAdd ?? 0) / 100;
    const out: FcRow[] = [];
    let st: CostState = stateOf(last);
    let prevR = last.R;
    let prevOpex = last.opex; // 未乘敏感度倍數的營業費用
    // 2026Q4：財測美元營收 ×（1 + 財測誤差百分位）、匯率假設；毛利率的額外稀釋由財測（加誤差百分位）反推。
    // 敏感度改用其他成本參數時也重新反推，使第四季仍錨定財測，差異只來自 2027 年。
    const Ru4 = q4Ru(sc);
    const plan: { period: string; Ru: number; fx: number; d: number; hpc: number; non: number }[] = [{ period: NEXT, Ru: Ru4, fx: gFx, d: q4Dil(sc, P, o.kappaAdd ?? 0), hpc: Ru4 * hpcShare, non: Ru4 * (1 - hpcShare) }];
    let h = Ru4 * hpcShare;
    let n = Ru4 * (1 - hpcShare);
    for (const p of Y2027) {
      h *= 1 + (sc.hpcQoq + (o.hpcAdd ?? 0)) / 100;
      n *= Math.exp(seas.factors[qIndex(p) % 4]! + Math.log(1 + (sc.nonAnnual + (o.nonAdd ?? 0)) / 100) / 4);
      plan.push({ period: p, Ru: h + n, fx: sc.fx + (o.fxAdd ?? 0), d: (sc.dil[p] ?? 0) + (p === Y2027[0] ? o.dilAdd ?? 0 : 0), hpc: h, non: n });
    }
    for (const x of plan) {
      const R = x.Ru * x.fx;
      const s0 = costStep(st, { Ru: x.Ru, fx: x.fx, R, D: st.D, d: x.d }, P, o.kappaAdd ?? 0);
      // 敏感度：2027 年每季多出的折舊（以 2026Q3 折舊的比例計），只影響當季成本，不進入下一季的成本基礎
      const extra = x.period === NEXT ? 0 : (o.extraD ?? 0) * last.D;
      const s = { C: s0.C + extra, gm: (1 - (s0.C + extra) / R) * 100 };
      const opexBase = x.period === NEXT ? (R * q4OpexRatio) / 100 : prevOpex * Math.exp(opexFull.e0 + opexFull.e1 * Math.log(R / prevR));
      const opex = opexBase * (x.period === NEXT ? 1 : o.opexMul ?? 1);
      const oi = (R * s.gm) / 100 - opex;
      const ni = (oi + nonopBase) * (1 - tax) * attrib;
      out.push({ period: x.period, Ru: x.Ru, fx: x.fx, R, C: s.C, gm: s.gm, opex, oi, nonop: nonopBase, ni, eps: ni / last.shares, hpc: x.hpc, non: x.non, d: x.d });
      st = { C: s0.C, D: st.D, Ru: x.Ru, fx: x.fx };
      prevR = R;
      prevOpex = opexBase;
    }
    return out;
  }
  const annualOf = (rs: { R: number; gm: number; oi: number; ni: number; eps: number; Ru: number }[]) => {
    const R = sum(rs.map((r) => r.R));
    return { R, Ru: sum(rs.map((r) => r.Ru)), gm: (100 * sum(rs.map((r) => (r.R * r.gm) / 100))) / R, oi: sum(rs.map((r) => r.oi)), ni: sum(rs.map((r) => r.ni)), eps: sum(rs.map((r) => r.eps)) };
  };
  const ytd = qRange(`${NEXT.slice(0, 4)}Q1`, LAST).map((p) => { const r = row(p); return { R: r.R, Ru: r.Ru, gm: r.gm, oi: r.oi, ni: r.ni, eps: r.eps }; });
  const fc = Object.fromEntries(SCENARIOS.map((s) => [s.id, forecast(s)])) as Record<ScenId, FcRow[]>;
  const y26 = (id: ScenId) => annualOf([...ytd, fc[id][0]!]);
  const y27 = (id: ScenId) => annualOf(fc[id].slice(1));
  const base = fc.base;
  const baseY = y27('base');
  const usd2026 = (id: ScenId) => y26(id).Ru;
  const usd2025 = sum(qRange('2025Q1', '2025Q4').map((p) => row(p).Ru));

  /* ── sensitivities (base, 2027) ── */
  const baseSc = SCENARIOS.find((s) => s.id === 'base')!;
  const sens = (o: FcOpts) => { const y = annualOf(forecast(baseSc, o).slice(1)); return { R: y.R - baseY.R, Rp: (y.R / baseY.R - 1) * 100, gm: y.gm - baseY.gm, eps: y.eps - baseY.eps }; };
  const sensText = (x: ReturnType<typeof sens>) => {
    const parts: string[] = [];
    if (Math.abs(x.R) >= 50) parts.push(`營收 ${x.R >= 0 ? '+' : '−'}${yi(Math.abs(x.R))}（${signed(x.Rp, 1)}）`);
    if (Math.abs(x.gm) >= 0.005) parts.push(`毛利率 ${pp(x.gm, 2)}`);
    parts.push(`EPS ${x.eps >= 0 ? '+' : '−'}${yuan(Math.abs(x.eps))}`);
    return `${cjk('2027 年', parts.join('、'))}${Math.abs(x.R) < 50 ? '（營收不變）' : ''}`;
  };
  const sensitivities: ModelOutput['sensitivities'] = [
    { driver: 'HPC（高效能運算）美元營收季成長', change: '2027 年每季多 2 個百分點', effect: sensText(sens({ hpcAdd: 2 })) },
    { driver: 'HPC（高效能運算）美元營收季成長', change: '2027 年每季少 2 個百分點', effect: sensText(sens({ hpcAdd: -2 })) },
    { driver: '非 HPC 平台（手機、物聯網、車用等）美元營收', change: '2027 年少 10 個百分點', effect: sensText(sens({ nonAdd: -10 })) },
    { driver: '新台幣兌美元匯率（2027 年）', change: '新台幣升值 1 元（31.8 → 30.8）', effect: sensText(sens({ fxAdd: -1 })) },
    { driver: '新台幣兌美元匯率（2027 年）', change: '新台幣貶值 1 元（31.8 → 32.8）', effect: sensText(sens({ fxAdd: 1 })) },
    { driver: '新製程與海外廠稀釋', change: '2027 年第一季起多 1 個百分點', effect: sensText(sens({ dilAdd: 1 })) },
    { driver: '成本對美元營收的彈性 κ', change: `多 0.1（${num(costFull.kappa, 2)} → ${num(costFull.kappa + 0.1, 2)}）`, effect: sensText(sens({ kappaAdd: 0.1 })) },
    { driver: '折舊（選定模型沒有單獨建模）', change: `2027 年每季比模型多出 ${qText(LAST)}折舊的 10%（約 ${yi(0.1 * last.D)}）`, effect: sensText(sens({ extraD: 0.1 })) },
    { driver: '成本趨勢 g', change: `設為 0（全期估計 ${signed(costFull.g * 100, 2)}／季，標準誤 ${num(costFull.seG! * 100, 2)}%）`, effect: sensText(sens({ params: { ...costFull, g: 0 } })) },
    { driver: `成本參數改用訓練期估計（${TRAIN_FROM}–${TRAIN_TO}，同樣 u = ${U_USD}）`, change: `κ ${num(costFull.kappa, 3)} → ${num(costTrU25.kappa, 3)}、成本趨勢 ${signed(costFull.g * 100, 2)} → ${signed(costTrU25.g * 100, 2)}／季`, effect: sensText(sens({ params: costTrU25 })) },
    { driver: '營業費用', change: '2027 年多 10%', effect: sensText(sens({ opexMul: 1.1 })) },
    { driver: '有效稅率', change: '多 2 個百分點', effect: sensText(sens({ taxAdd: 2 })) },
  ];

  /* ── candidates ── */
  const mt = (id: string) => MT[id]!;
  const revEq = [
    `美元營收_t = 美元營收_t−1 ÷ 晶圓出貨_t−1 × 晶圓出貨_t × e^δ × H_t−1 ÷ H_t；H_t = Σ 各製程晶圓營收比重 × e^(−γ × 世代)，世代：90 奈米以上 = 0 … 2 奈米 = 9`,
    '營收_t（新台幣）= 美元營收_t × 平均匯率_t',
  ];
  const chainEq = [
    '營業費用_t = 營業費用_t−1 × e^e0 ×（營收_t ÷ 營收_t−1）^ε；營業利益_t = 營收_t × 毛利率_t − 營業費用_t',
    '淨利_t =（營業利益_t + 業外收支_t−1）×（1 − 去年同季稅率）× 歸屬母公司比重_t−1；EPS_t = 淨利_t ÷ 稀釋股數_t−1',
  ];
  const revNote = `營收規則以 ${TRAIN_FROM}–${TRAIN_TO} 估計：γ = ${num(mixTr.gamma, 2)}（每升一個製程世代，每片晶圓單價約高 ${num((Math.exp(mixTr.gamma) - 1) * 100, 0)}%）、δ = ${signed(mixTr.delta * 100, 2)}／季；回測代入當季實際的晶圓出貨、製程組合與匯率（公司在季報時才公布），營收 MAPE ${pct(mt(selected).revenue!.mape!, 2)}。不考慮製程組合（只用晶圓出貨與平均單價趨勢）時為 ${pct(revWaferOnly.mape!, 2)}。`;
  const chainNote = `毛利率、營業利益、淨利與 EPS 的回測以當季實際營收為條件（月營收在季報前已公布）。營業費用規則 ε = ${num(opexTr.e1, 3)}、e0 = ${signed(opexTr.e0 * 100, 2)}／季（訓練期估計）；業外收支沿用上一季（扣除 2026 年第二季處分世界先進股票的一次性利益 632.0 億元）；稅率用去年同季（第二季有未分配盈餘加徵）。`;
  const nBeatTest = test.filter((p) => usdBeat(row(p)) > 0).length;
  const nBeatGmTest = test.filter((p) => row(p).gm > row(p).guide!.gm).length;
  const nBeatTrain = trUsd.filter((p) => usdBeat(row(p)) > 0).length;
  const candidates: ModelOutput['candidates'] = [
    {
      id: 'naive', name: '天真模型（上一季不變）',
      description: '假設本季營收與毛利率都和上一季一樣。這是最簡單的對照組：任何模型如果贏不了它，就沒有存在的價值。',
      equations: ['營收_t = 營收_t−1', '毛利率_t = 毛利率_t−1'],
      metrics: mt('naive'), selected: false,
      note: '營業利益、淨利與 EPS 以當季實際營收乘上上一季毛利率，再用與其他模型相同的營業費用、業外、稅率與股數規則換算。',
    },
    {
      id: 'guidance', name: '台積電財測（對照基準）',
      description: '台積電在上一季法說會公布的本季財測中值：營收（美元區間中值乘以公司的匯率假設）、毛利率與營業利益率（營業利益 = 財測營收 × 營業利益率中值）。這不是本站的模型，而是公司在季度開始時的判斷，用來衡量模型誤差的大小。公司不給淨利與 EPS 財測。',
      equations: ['預測值 = 上一季法說會公布的本季財測區間中值'],
      metrics: mt('guidance'), selected: false,
      note: `台積電財測歷來偏保守：測試期 ${test.length} 季中有 ${nBeatTest} 季美元營收、${nBeatGmTest} 季毛利率高於財測中值；訓練期（2017 年第三季起以美元公布）${trUsd.length} 季中有 ${nBeatTrain} 季營收高於中值。財測是事前預測，結構模型的回測則代入當季實際的匯率、晶圓出貨或營收，兩者不完全可比。財測營收改用實際匯率換算、毛利率依公司「匯率每變動 1%、毛利率約 0.4 個百分點」調整後，測試期誤差為營收 ${pct(guideFx.rev.mape!, 2)}、毛利率 ${num(guideFx.gm.mae, 2)} 個百分點，與未調整幾乎相同，表示這段期間財測的誤差主要不是匯率造成。`,
    },
    {
      id: 'guidance-bias', name: '財測＋歷史偏差校正',
      description: `台積電財測中值加上訓練期（${TRAIN_TO} 以前）財測誤差的中位數：美元營收乘以（1 ${term(bR * 100, 2)}%）、毛利率 ${pp(bGM, 2)}、營業利益率 ${pp(bOM, 2)}，匯率仍用公司假設。只用季度開始時就有的資訊。`,
      equations: [`營收_t = 美元營收財測中值 ×（1 ${term(bR * 100, 2)}%）× 匯率假設`, `毛利率_t = 毛利率財測中值 ${term(bGM, 2)}`, `營業利益_t = 營收_t ×（營業利益率財測中值 ${term(bOM, 2)}）`],
      metrics: mt('guidance-bias'), selected: false,
      note: `不參與模型選擇：它只能預測公司已給財測的下一季，無法延伸到 2027 年。測試期它是一季前預測最準的方法（營收 MAPE ${pct(mt('guidance-bias').revenue!.mape!, 2)}、毛利率 MAE ${num(mt('guidance-bias').grossMargin!.mae, 2)} 個百分點），本站 ${qText(NEXT)}的營收與毛利率也以財測加上歷史偏差為目標，偏差改用至 ${qText(LAST)}的全部資料（營收自 ${qText(allUsd[0]!)}起、毛利率自 2016 年第一季起）的分布，三個情境分別取第 10、50、90 百分位。`,
    },
    {
      id: 'dr-level', name: '折舊密度水準迴歸',
      description: '毛利率直接對「折舊占營收比重」做線性迴歸：台積電的成本有很大一部分是折舊，營收成長時折舊被攤薄、毛利率上升。簡單直覺，但不考慮匯率、新製程稀釋與售價變化。',
      equations: [...revEq, `毛利率_t = ${num(levelTr.a, 2)} ${term(levelTr.b, 3)} × 折舊_t ÷ 營收_t × 100`, ...chainEq],
      metrics: mt('dr-level'), selected: false,
      note: `以 ${TRAIN_FROM}–${TRAIN_TO} 共 ${levelTr.n} 季估計。回測代入當季實際的折舊（季報時才公布），對這個模型有利。測試期平均低估毛利率 ${num(-mt('dr-level').grossMargin!.bias, 2)} 個百分點：2025–2026 年毛利率升到 66% 以上，超出訓練期折舊密度能解釋的範圍。${revNote}`,
    },
    {
      id: 'margin-bridge', name: '毛利率橋接模型（折舊密度、匯率、稀釋）',
      description: '從上一季毛利率出發逐項加減：折舊占營收比重的變化（營收成長攤薄固定成本）、匯率（依公司說法，新台幣每貶值 1%、毛利率約增加 0.4 個百分點）、公司說明的新製程與海外廠稀釋，以及一個平均的季變化（常數）。',
      equations: [...revEq, `毛利率_t = 毛利率_t−1 ${term(bridgeTr.a, 3)} ${term(bridgeTr.b, 3)} × Δ（折舊 ÷ 營收 × 100）_t + 0.4 × 匯率季變化率_t（%）− 稀釋_t`, ...chainEq],
      metrics: mt('margin-bridge'), selected: false,
      note: `以 ${TRAIN_FROM}–${TRAIN_TO} 共 ${bridgeTr.n} 季估計，匯率係數固定為公司說法的 0.4（tr-2017q2）。若匯率係數也由資料估計，訓練期只得到 ${num(bridgeFree.fxCoef, 3)}（匯率的影響大多已經透過新台幣營收進入折舊密度），測試期毛利率 MAE 變為 ${num(bridgeFree.mae, 2)} 個百分點。回測代入當季實際的折舊（季報時才公布），對這個模型有利；稀釋與選定模型相同，只用季報前的公司說法。grossMarginDynamic 為從 ${TRAIN_TO} 出發、連續推 ${test.length} 季且不用新財報重設的結果（代入實際的折舊、匯率與公司事後說明的稀釋）。`,
    },
    {
      id: 'cost-elasticity', name: '成本彈性模型（美元營收規模、匯率、稀釋）',
      description: '把銷貨成本（新台幣）看成會跟著美元營收成長、但成長得比營收慢的成本：美元營收每成長 1%，成本約成長 κ%，κ 小於 1 就是營運槓桿（固定成本被攤薄、漲價不增加成本）。約兩成到四分之一的成本以美元計價，新台幣貶值時全部以美元計價的營收增加得比成本多；新製程與海外廠開始量產的季度，再依公司說明的稀釋幅度墊高成本。毛利率 = 1 − 成本 ÷ 營收。',
      equations: [
        ...revEq,
        `銷貨成本_t = 銷貨成本_t−1 × e^g ×（美元營收_t ÷ 美元營收_t−1）^κ ×（匯率_t ÷ 匯率_t−1）^u + 稀釋_t × 營收_t；u 為成本中以美元計價的比重`,
        '毛利率_t = 1 − 銷貨成本_t ÷ 營收_t',
        ...chainEq,
      ],
      metrics: mt('cost-elasticity'), selected: true,
      note: `以 ${TRAIN_FROM}–${TRAIN_TO} 共 ${costTr.n} 季估計：κ = ${num(costTr.kappa, 3)}、g = ${signed(costTr.g * 100, 2)}／季。成本中以美元計價的比重 u 用估計當時已有的公司說法：回測用 2017 年「匯率每變動 1%、毛利率約 0.4 個百分點」（tr-2017q2）在當時成本率下換算的 ${num(u2017, 2)}，預測用 2025 年「約 75% 的銷貨成本以新台幣計價」（tr-2025q2）的 0.25；回測若也用 0.25，測試期毛利率 MAE 為 ${num(gmU25.mae, 2)} 個百分點（本模型 ${num(mt(selected).grossMargin!.mae, 2)}）。也試過把折舊當固定成本（銷貨成本 = φ × 折舊 + 其餘成本，φ 以 0.1 為間隔在 0–1 搜尋），訓練期一季前誤差以 φ = ${costTr.phi} 最小（${num(costSel.grid[0]!.mae, 3)}；φ = 0.5 為 ${num(costSel.grid[5]!.mae, 3)}、φ = 1 為 ${num(costSel.grid[10]!.mae, 3)} 個百分點），表示在這段資料中把折舊單獨當固定成本並沒有比整體的成本彈性更準，折舊的影響併入 κ。不計稀釋時測試期毛利率 MAE 為 ${num(gmNoDil.mae, 2)} 個百分點。回測的稀釋只用該季財報公布前已有的公司說法：${btDiffers.map((d) => `${qText(d.period)}的增量取 ${num(d.bt!.pp, 1)}（${d.bt!.src}）`).join('、')}，由當時「2025 年全年 2–3 個百分點」的說法換算，而不是季報時才公布的 ${btDiffers.map((d) => num(d.pp, 1)).join('、')}；若改用事後的說法，測試期毛利率 MAE 為 ${num(gmExPostDil.mae, 2)} 個百分點（用到季報後才有的資訊，只作對照）。選擇規則：在不依賴財測、能延伸到 2027 年的三個結構模型（折舊密度水準迴歸、毛利率橋接、成本彈性）中，取「營收 MAPE（%）＋毛利率 MAE（個百分點）」最小者，差距在 ${TIE} 以內看營業利益 MAPE；三者營收規則相同，因此由毛利率決定：本模型 ${num(score('cost-elasticity'), 2)}、毛利率橋接 ${num(score('margin-bridge'), 2)}、折舊密度水準迴歸 ${num(score('dr-level'), 2)}。與次佳的${ELIGIBLE_NAME[runnerUp]}相比，${test.length} 季中有 ${gmWins} 季毛利率較準，逐季誤差差距的配對 t 值為 ${num(gmDiffT, 2)}${Math.abs(gmDiffT) < 2 ? '，樣本太少、差距並不顯著，選擇只是依照事先訂好的規則' : ''}。grossMarginDynamic 是從 ${TRAIN_TO} 出發、連續推 ${test.length} 季且不用新財報重設的結果（代入實際的美元營收、匯率與公司事後說明的稀釋；MAE ${num(MT['cost-elasticity']!.grossMarginDynamic!.mae, 2)} 個百分點，${qText(TEST_TO)}低估 ${num(row(TEST_TO).gm - dyn.get(TEST_TO)!, 1)} 個百分點）：2025–2026 年毛利率的上升比歷史營運槓桿能解釋的多，逐季重設可以吸收，但多季預測會偏低。${revNote}${chainNote}`,
    },
    {
      id: 'cost-elasticity-ex-ante', name: '成本彈性模型（改用季初的財測營收與匯率假設）',
      description: '與選定模型相同，但營收與匯率改用季度開始時就知道的資訊：台積電的美元營收財測中值與匯率假設（新台幣營收 = 兩者相乘），稀釋幅度沿用公司說法，營業利益、淨利與 EPS 也以財測營收推算。用來和公司的毛利率財測做事前比較。',
      equations: ['同「成本彈性模型」，美元營收 = 財測中值、匯率 = 財測匯率假設'],
      metrics: mt('cost-elasticity-ex-ante'), selected: false,
      note: `不參與模型選擇：參數與選定模型相同，只是輸入改成季初資訊；營收即為財測中值，因此營收誤差與財測相同。毛利率 MAE ${num(mt('cost-elasticity-ex-ante').grossMargin!.mae, 2)} 個百分點，與公司財測（${num(mt('guidance').grossMargin!.mae, 2)}）${Math.abs(mt('cost-elasticity-ex-ante').grossMargin!.mae - mt('guidance').grossMargin!.mae) < 0.1 ? '相當' : mt('cost-elasticity-ex-ante').grossMargin!.mae < mt('guidance').grossMargin!.mae ? '相比略好' : '相比較差'}；選定模型在回測中的優勢，大部分來自已知當季實際營收與匯率。`,
    },
  ];

  /* ── backtest rows ── */
  const backtest: ModelOutput['backtest'] = [];
  for (const id of ['cost-elasticity', 'cost-elasticity-ex-ante', 'margin-bridge', 'dr-level', 'guidance-bias', 'naive', 'guidance']) {
    for (const m of METRICS) for (const p of test) {
      const x = preds[id]?.get(p)?.[field[m]];
      if (x === undefined) continue;
      const a = row(p);
      const g = a.guide!;
      const bench = m === 'revenue' ? g.R : m === 'grossMargin' ? g.gm : m === 'operatingIncome' ? (g.R * g.om!) / 100 : undefined;
      const d = m === 'grossMargin' || m === 'eps' ? 2 : 0;
      backtest.push({
        period: p, metric: m, actual: round(actualOf(a, m), d), predicted: round(x, d), candidate: id,
        ...(bench !== undefined && id !== 'guidance' ? { benchmark: round(bench, d), benchmarkLabel: '台積電財測中值' } : {}),
      });
    }
  }

  /* ── derived series ── */
  type St = 'estimate' | 'forecast';
  const derived: ModelOutput['derived'] = [];
  derived.push({
    id: 'usd-per-wafer', name: '每片晶圓平均營收（美元營收 ÷ 12 吋約當晶圓出貨）', unit: '美元／片',
    points: rows.map((r) => ({ period: r.period, value: round((r.Ru / r.W) * 1000, 0), status: 'estimate' as St })),
    note: '美元營收（含先進封裝、光罩等非晶圓營收）除以 12 吋約當晶圓出貨，是混合的「每片營收」，不是公司公布的單價。2025–2026 年的上升來自先進製程比重提高、漲價與先進封裝。',
  });
  const h0 = nodeH(rows[0]!, mixFull.gamma);
  derived.push({
    id: 'node-mix-price-index', name: '製程組合單價指數（只反映製程組合變化）', unit: `指數（${rows[0]!.period} = 100）`,
    points: rows.map((r) => ({ period: r.period, value: round((h0 / nodeH(r, mixFull.gamma)) * 100, 1), status: 'estimate' as St })),
    note: `假設各製程每片單價固定、每升一個世代貴 ${num((Math.exp(mixFull.gamma) - 1) * 100, 0)}%（γ = ${num(mixFull.gamma, 2)}，全期 ${TRAIN_FROM}–${LAST} 估計），只隨各製程晶圓營收比重變動的平均單價。與每片晶圓平均營收的差距，代表同一製程的價格變化與非晶圓營收。`,
  });
  derived.push({
    id: 'depreciation-intensity', name: '折舊占營收比重', unit: '%',
    points: rows.map((r) => ({ period: r.period, value: round((r.D / r.R) * 100, 1), status: 'estimate' as St })),
    note: '折舊及攤銷（現金流量表）÷ 營收。營收成長時比重下降，是毛利率上升的主因之一；毛利率橋接模型與折舊密度水準迴歸用這個序列。',
  });
  derived.push({
    id: 'hpc-revenue-usd', name: 'HPC（高效能運算）美元營收', unit: '百萬美元',
    points: [
      ...[...hpcRev.entries()].map(([p, v]) => ({ period: p, value: round(v, 0), status: 'estimate' as St })),
      ...base.map((r) => ({ period: r.period, value: round(r.hpc, 0), status: 'forecast' as St })),
    ],
    note: `美元營收 × HPC 營收比重（管理報告的整數百分比，推算值）。${qText(NEXT)}起為基準情境：${qText(NEXT)}沿用第三季的 HPC 比重 ${num(last.hpc!, 0)}%，2027 年每季成長 ${baseSc.hpcQoq}%。`,
  });
  derived.push({
    id: 'non-hpc-revenue-usd', name: '非 HPC 平台（手機、物聯網、車用、消費性與其他）美元營收', unit: '百萬美元',
    points: [
      ...[...nonHpc.entries()].map(([p, v]) => ({ period: p, value: round(v, 0), status: 'estimate' as St })),
      ...base.map((r) => ({ period: r.period, value: round(r.non, 0), status: 'forecast' as St })),
    ],
    note: `美元營收 ×（1 − HPC 比重）。2027 年為基準情境：依 2018–2026 年各季平均季節性（第一季 ${signed((Math.exp(seas.factors[0]!) - 1) * 100, 1)}、第二季 ${signed((Math.exp(seas.factors[1]!) - 1) * 100, 1)}、第三季 ${signed((Math.exp(seas.factors[2]!) - 1) * 100, 1)}、第四季 ${signed((Math.exp(seas.factors[3]!) - 1) * 100, 1)}，已扣除平均成長）加上年變化 ${signed(baseSc.nonAnnual, 0)}。`,
  });
  // 毛利率變動的拆解（成本彈性模型，全期參數；預測期為基準情境）
  {
    const comps: Record<'scale' | 'fx' | 'trend' | 'dil' | 'other', { period: string; value: number; status: St }[]> = { scale: [], fx: [], trend: [], dil: [], other: [] };
    const P = costFull;
    const push = (period: string, status: St, prev: { C: number; R: number; Ru: number; fx: number }, cur: { Ru: number; fx: number; R: number; d: number; Cact?: number }) => {
      const c0 = prev.C / prev.R;
      const c1 = c0 * Math.exp(P.g);
      const c2 = c1 * Math.exp((P.kappa - 1) * Math.log(cur.Ru / prev.Ru));
      const c3 = c2 * Math.exp((P.u - 1) * Math.log(cur.fx / prev.fx));
      const c4 = c3 + cur.d / 100;
      const cA = cur.Cact !== undefined ? cur.Cact / cur.R : c4;
      comps.trend.push({ period, value: round(-(c1 - c0) * 100, 2), status });
      comps.scale.push({ period, value: round(-(c2 - c1) * 100, 2), status });
      comps.fx.push({ period, value: round(-(c3 - c2) * 100, 2), status });
      comps.dil.push({ period, value: round(-(c4 - c3) * 100, 2), status });
      comps.other.push({ period, value: round(-(cA - c4) * 100, 2), status });
    };
    for (const p of qRange(TRAIN_FROM, LAST)) { const r = row(p); const q = row(addQ(p, -1)); push(p, 'estimate', q, { Ru: r.Ru, fx: r.fx, R: r.R, d: DIL.get(p) ?? 0, Cact: r.C }); }
    let prev = { C: last.C, R: last.R, Ru: last.Ru, fx: last.fx };
    for (const r of base) { push(r.period, 'forecast', prev, { Ru: r.Ru, fx: r.fx, R: r.R, d: r.d }); prev = { C: r.C, R: r.R, Ru: r.Ru, fx: r.fx }; }
    const common = `成本彈性模型以全期參數（κ = ${num(P.kappa, 3)}、g = ${signed(P.g * 100, 2)}／季）把每季毛利率的變化拆成五項，五項相加等於毛利率的季變化（個百分點）；${qText(NEXT)}起為基準情境（其他 = 0）。`;
    derived.push({ id: 'gm-bridge-scale', name: '毛利率變動：美元營收規模（營運槓桿）', unit: '個百分點', points: comps.scale, note: `${common}美元營收成長時，成本只成長 κ 倍，毛利率上升。` });
    derived.push({ id: 'gm-bridge-fx', name: '毛利率變動：匯率', unit: '個百分點', points: comps.fx, note: `${common}新台幣貶值使營收（美元計價）增加得比成本（約 25% 美元計價）多。` });
    derived.push({ id: 'gm-bridge-trend', name: '毛利率變動：成本趨勢', unit: '個百分點', points: comps.trend, note: `${common}成本每季的平均變化 g（營收不變時）。` });
    derived.push({ id: 'gm-bridge-dilution', name: '毛利率變動：新製程與海外廠稀釋', unit: '個百分點', points: comps.dil, note: `${common}公司說明的稀釋（開始的季度一次計入，之後由成本基礎延續）；${qText(NEXT)}為依財測反推的額外稀釋。` });
    derived.push({ id: 'gm-bridge-other', name: '毛利率變動：其他（模型未解釋）', unit: '個百分點', points: comps.other, note: `${common}實際毛利率與模型的差距，包含漲價、產品組合、產能利用率、一次性事件（地震、電價）與稀釋幅度的進位誤差。` });
  }
  derived.push({
    id: 'guidance-beat-revenue', name: '美元營收相對財測中值', unit: '%',
    points: allUsd.map((p) => ({ period: p, value: round(usdBeat(row(p)) * 100, 2), status: 'estimate' as St })),
    note: '（實際美元營收 ÷ 上一季法說會的美元營收財測中值 − 1）× 100；正值代表實際高於財測。2017 年第三季起公司以美元公布營收財測。',
  });
  derived.push({
    id: 'guidance-beat-gross-margin', name: '毛利率相對財測中值', unit: '個百分點',
    points: qRange('2016Q1', LAST).map((p) => ({ period: p, value: round(row(p).gm - row(p).guide!.gm, 2), status: 'estimate' as St })),
    note: '實際毛利率 − 上一季法說會的毛利率財測中值；正值代表實際高於財測。',
  });

  /* ── parameters ── */
  const fxSens = (r: { C: number; R: number }) => (r.C / r.R) * (1 - U_USD); // 個百分點／1%
  const q4Share = (october.revenue / (gRev.value * gFx)) * 100;
  const parameters: ModelOutput['parameters'] = [
    { name: '成本對美元營收的彈性 κ', value: round(costFull.kappa, 3), note: `全期 ${TRAIN_FROM}–${LAST} 共 ${costFull.n} 季估計（u = ${U_USD}），標準誤 ${num(costFull.seKappa!, 3)}；訓練期（至 ${TRAIN_TO}，同樣 u = ${U_USD}）為 ${num(costTrU25.kappa, 3)}。美元營收成長 10%，銷貨成本（匯率不變）約成長 ${num((Math.pow(1.1, costFull.kappa) * Math.exp(costFull.g) - 1) * 100, 1)}%（含成本趨勢）。` },
    { name: '成本趨勢 g', value: round(costFull.g * 100, 3), unit: '%／季', note: `營收與匯率不變時成本每季的平均變化（全期估計），標準誤 ${num(costFull.seG! * 100, 2)}%／季，統計上${Math.abs(costFull.g) < 2 * costFull.seG! ? '與 0 沒有顯著差異（見敏感度「成本趨勢 g 設為 0」）' : '顯著不為 0'}；訓練期（同樣 u = ${U_USD}）為 ${num(costTrU25.g * 100, 3)}%／季。全期估計較${costFull.g < costTrU25.g ? '低' : '高'}，反映 2025–2026 年毛利率上升得比訓練期的關係多。` },
    { name: '銷貨成本中以美元計價的比重 u（預測用）', value: U_USD, note: `公司說法：約 75% 的銷貨成本以新台幣計價（tr-2025q2）；營收全部視為美元計價。回測用 2017 年說法換算的 ${num(u2017, 2)}（見選定模型說明）。` },
    { name: '模型隱含的匯率敏感度（2026 年第三季成本率）', value: round(fxSens(last), 2), unit: '個百分點／1%', note: `新台幣每貶值 1%，毛利率約增加 ${num(fxSens(last), 2)} 個百分點（= 成本率 ${num((last.C / last.R) * 100, 1)}% × 0.75）。公司說法約 0.4 個百分點（tr-2025q2）；毛利率越高、成本率越低，同樣的匯率變動影響越小。` },
    { name: '折舊中視為固定成本的比重 φ', value: costTr.phi, note: `在 0–1 之間以 0.1 為間隔搜尋，取訓練期一季前毛利率誤差最小者（φ = 0：${num(costSel.grid[0]!.mae, 3)}、φ = 0.3：${num(costSel.grid[3]!.mae, 3)}、φ = 1：${num(costSel.grid[10]!.mae, 3)} 個百分點）。` },
    { name: '製程世代價差 γ', value: round(mixFull.gamma, 2), note: `每片晶圓單價隨製程世代的對數價差（全期估計，訓練期 ${num(mixTr.gamma, 2)}）：每升一個世代約貴 ${num((Math.exp(mixFull.gamma) - 1) * 100, 0)}%，2 奈米約為 90 奈米以上製程的 ${num(Math.exp(mixFull.gamma * 9), 0)} 倍。這是由營收比重與晶圓出貨反推的統計值，不是公司公布的價格。` },
    { name: '每片晶圓營收的其餘季變化 δ', value: round(mixFull.delta * 100, 2), unit: '%／季', note: `扣除製程組合後，每片晶圓營收每季的平均變化（全期估計；訓練期 ${signed(mixTr.delta * 100, 2)}）。` },
    { name: '營業費用對營收的彈性 ε', value: round(opexFull.e1, 3), note: `全期估計（訓練期 ${num(opexTr.e1, 3)}）；另有每季 ${signed(opexFull.e0 * 100, 2)} 的趨勢。營業費用 = 毛利 − 營業利益（研發、管銷再扣除其他營業收支淨額）。` },
    { name: '財測偏差：美元營收（訓練期中位數）', value: round(bR * 100, 2), unit: '%', note: `${trUsd[0]}–${TRAIN_TO} 共 ${trUsd.length} 季，實際美元營收相對財測中值的中位數；${qText(allUsd[0]!)}至 ${qText(LAST)}全期為 ${num(median(revBeats), 2)}%（第 10、90 百分位 ${num(percentile(revBeats, 0.1), 2)}%、${num(percentile(revBeats, 0.9), 2)}%）。` },
    { name: '財測偏差：毛利率（訓練期中位數）', value: round(bGM, 2), unit: '個百分點', note: `2016Q1–${TRAIN_TO} 共 ${qRange('2016Q1', TRAIN_TO).length} 季；全期為 ${num(median(gmBeats), 2)}（第 10、90 百分位 ${num(percentile(gmBeats, 0.1), 2)}、${num(percentile(gmBeats, 0.9), 2)}）。` },
    { name: '財測偏差：營業利益率（訓練期中位數）', value: round(bOM, 2), unit: '個百分點', note: `2016Q1–${TRAIN_TO}，實際營業利益率減財測中值；比毛利率偏差大，表示實際營業費用率通常也低於財測隱含的水準（全期中位數低 ${num(median(gapBeats), 2)} 個百分點）。` },
    { name: `${qText(NEXT)}營業費用率`, value: round(q4OpexRatio, 2), unit: '%', note: `財測隱含的營業費用率（毛利率中值 ${gGm.value}% − 營業利益率中值 ${gOm.value}%）減去歷史上實際低於財測的中位數 ${num(median(gapBeats), 2)} 個百分點；2027 年再依營業費用彈性規則隨營收變動。` },
    { name: `${qText(NEXT)}財測：美元營收中值`, value: gRev.value, unit: '百萬美元', note: `${usdYi(gRev.low!)}–${usdYi(gRev.high!)}，匯率假設 ${gFx}（er-2026q3）。` },
    { name: `${qText(NEXT)}財測：毛利率中值`, value: gGm.value, unit: '%', note: `${gGm.low}–${gGm.high}%；營業利益率 ${gOm.low}–${gOm.high}%（er-2026q3）。公司說明毛利率中值比第三季低，主因 2 奈米持續放量與海外廠稀釋（tr-2026q3）。` },
    { name: `${qText(NEXT)}模型（未調整）毛利率`, value: round(rawQ4.gm, 2), unit: '%', note: `以財測美元營收中值、匯率 ${gFx}、不加新的稀釋推算；比財測中值${rawQ4.gm >= gGm.value ? '高' : '低'} ${fmtN(rawQ4.gm - gGm.value, 2)} 個百分點。差距視為財測隱含的額外稀釋（公司說明為 2 奈米放量與海外廠），再扣掉財測歷來的保守程度（毛利率偏差的第 10、50、90 百分位）：各情境以自己的第四季美元營收重算未調整毛利率後反推，三個情境的額外稀釋分別為 ${SCENARIOS.map((s) => `${s.name} ${num(q4Dil(s), 2)}`).join('、')} 個百分點（不低於 0），第四季毛利率因此等於財測中值加上該百分位的偏差。` },
    { name: `${qText(NEXT)}：10 月營收占財測中值`, value: round(q4Share, 1), unit: '%', note: `10 月營收 ${yi(october.revenue)}（tsmc-monthly）÷ 財測中值換算的新台幣營收 ${yi(gRev.value * gFx)}。2016–2025 年第四季營收是 10 月的 ${num(Math.min(...q4Ratios), 2)}–${num(Math.max(...q4Ratios), 2)} 倍（中位數 ${num(median(q4Ratios), 2)}），即 10 月約占第四季的 ${num(100 / Math.max(...q4Ratios), 0)}–${num(100 / Math.min(...q4Ratios), 0)}%；10 月營收與財測一致，但單月資訊範圍太寬，本模型不另行調整。` },
    { name: '有效稅率（預測期）', value: taxGuide.value, unit: '%', note: `公司 2026 年全年預估 ${taxGuide.low}–${taxGuide.high}%（tr-2025q4、tr-2026q1 重申）；2027 年沿用。` },
  ];

  /* ── scenarios ── */
  const growth27 = (id: ScenId) => (y27(id).Ru / usd2026(id) - 1) * 100;
  const scenarios: ModelOutput['scenarios'] = SCENARIOS.map((sc) => {
    const rs = fc[sc.id];
    const q4 = rs[0]!;
    const a26 = y26(sc.id);
    const a27 = y27(sc.id);
    const fxMove = (sc.fx / gFx - 1) * 100; // 正值 = 新台幣貶值（每美元換更多新台幣）
    const hpcAvg = (Math.pow(hpcRev.get(LAST)! / hpcRev.get('2024Q4')!, 1 / test.length) - 1) * 100;
    const hpcDrop = [hpcRev.get('2023Q1')! / hpcRev.get('2022Q4')! - 1, hpcRev.get('2023Q2')! / hpcRev.get('2023Q1')! - 1].map((x) => fmtN(x * 100, 0));
    const assumptions: ModelOutput['scenarios'][number]['assumptions'] = [
      { name: `${qText(NEXT)}美元營收`, value: `${usdYi(q4.Ru, 1)}：財測中值 ${usdYi(gRev.value)}（${num(gRev.low! / 100, 0)}–${usdYi(gRev.high!)}）×（1 ${term(percentile(revBeats, sc.pct), 2)}%），後者為 2017 年第三季以來實際美元營收相對財測中值的第 ${num(sc.pct * 100, 0)} 百分位`, src: 'er-2026q3' },
      { name: `${qText(NEXT)}匯率`, value: `${gFx} 元（公司財測假設，三個情境相同）`, src: 'er-2026q3' },
      {
        name: `${qText(NEXT)}毛利率`,
        value: q4Dil(sc) > 0
          ? `以本情境營收推算的模型未調整毛利率為 ${pct(q4RawOf(sc), 2)}；以財測中值 ${gGm.value}% 加上歷史毛利率偏差第 ${num(sc.pct * 100, 0)} 百分位（${pp(percentile(gmBeats, sc.pct), 2)}）為目標，反推第四季額外稀釋 ${num(q4Dil(sc), 2)} 個百分點並延續到 2027 年；公司說明第四季毛利率因 2 奈米放量與海外廠稀釋而比第三季低`
          : `以本情境營收推算的模型未調整毛利率為 ${pct(q4RawOf(sc), 2)}，已低於財測中值 ${gGm.value}% 加上歷史毛利率偏差第 ${num(sc.pct * 100, 0)} 百分位（${pp(percentile(gmBeats, sc.pct), 2)}），不另加額外稀釋`,
        src: 'tr-2026q3',
      },
      { name: `${qText(NEXT)}營業費用`, value: `營業費用率 ${pct(q4OpexRatio, 2)}：財測隱含的 ${fmtN(gGm.value - gOm.value, 1)}%（毛利率中值減營業利益率中值）減去歷史上實際低於財測的中位數`, src: 'er-2026q3' },
      { name: '10 月營收', value: `${yi(october.revenue)}，占本情境第四季營收的 ${num((october.revenue / q4.R) * 100, 1)}%（2016–2025 年第四季中 10 月占 ${num(100 / Math.max(...q4Ratios), 0)}–${num(100 / Math.min(...q4Ratios), 0)}%）`, src: 'tsmc-monthly' },
      {
        name: '2027 年 HPC 美元營收',
        value: `每季成長 ${sc.hpcQoq}%（約當年化 ${num((Math.pow(1 + sc.hpcQoq / 100, 4) - 1) * 100, 0)}%；2025 年第一季至 2026 年第三季實際平均每季 ${signed(hpcAvg, 1)}，約當年化 ${num((Math.pow(1 + hpcAvg / 100, 4) - 1) * 100, 0)}%）。${
          sc.id === 'bear'
            ? `AI 需求成長放緩的假設；2023 年第一、二季 HPC 美元營收曾連續季減 ${hpcDrop[0]}% 與 ${hpcDrop[1]}%`
            : sc.id === 'base'
              ? '接近公司對整體營收「2024–2029 年複合成長接近 25%（美元）」的長期說法；HPC 近兩年成長得比整體快，這個假設低於近兩年實績'
              : '仍低於近兩年實績與公司對 AI 加速器營收「2024–2029 年複合成長 50% 中高段」的說法（HPC 另含成長較慢的 CPU 等產品）'
        }；${qText(NEXT)}沿用第三季 HPC 比重 ${num(last.hpc!, 0)}%（本模型假設）`,
        src: sc.id === 'bear' ? 'mr-2023q2' : 'tr-2025q4',
      },
      { name: '2027 年非 HPC 平台美元營收', value: `${sc.nonAnnual === 0 ? '年變化持平' : `年變化 ${signed(sc.nonAnnual, 0)}`}，加上 2018–2026 年的平均季節性（第一季淡、第三季旺）。公司表示消費性與價格敏感市場受零組件漲價影響，對 2027 年規劃審慎${sc.id === 'bull' ? '；樂觀情境假設影響有限' : ''}`, src: 'tr-2026q3' },
      {
        name: '2027 年匯率',
        value: `${sc.fx} 元${
          sc.id === 'bear'
            ? `：新台幣升值約 ${fmtN(-fxMove, 0)}%，接近 2025 年第三季的平均匯率 ${row('2025Q3').fx}（當時公司說明新台幣升值使毛利率明顯下降）`
            : sc.id === 'bull'
              ? `：新台幣貶值約 ${fmtN(fxMove, 0)}%，接近 2025 年第一季的平均匯率 ${row('2025Q1').fx}`
              : '：沿用第四季財測假設'
        }`,
        src: sc.id === 'bear' ? 'fs-2025q3' : sc.id === 'bull' ? 'fs-2025q1' : 'er-2026q3',
      },
      { name: '2027 年 2 奈米稀釋', value: sc.dil['2027Q1'] ? `第一季多 ${sc.dil['2027Q1']} 個百分點：公司預估 2 奈米家族產能 2027 年增加一倍以上，放量期間稀釋擴大（幅度為本模型假設）` : '不再增加：比照 3 奈米，量產第二年（2024 年全年 3–4 個百分點）與第一年第四季的稀釋相當', src: sc.dil['2027Q1'] ? 'tr-2026q3' : 'tr-2023q4' },
      { name: '2027 年海外廠稀釋', value: sc.dil['2027Q3'] ? `第三季多 ${sc.dil['2027Q3']} 個百分點：亞利桑那第二座廠 2027 年第三季量產，公司表示海外廠稀釋未來幾年會由接近 2 擴大到 3–4 個百分點（幅度與時點為本模型假設）` : '維持接近 2 個百分點：規模擴大吸收新廠成本（2025 年公司曾因整體規模較大而下修海外廠稀釋）', src: sc.dil['2027Q3'] ? 'tr-2026q3' : 'tr-2025q3' },
      { name: '成本彈性與趨勢', value: `κ = ${num(costFull.kappa, 3)}、g = ${signed(costFull.g * 100, 2)}／季（${TRAIN_FROM}–${LAST} 全期估計）；不另外假設 2027 年的漲價或折舊增加（見敏感度）` },
      { name: '營業費用、業外、稅率與股數', value: `2027 年營業費用依彈性規則隨營收成長（ε = ${num(opexFull.e1, 3)}）；業外收支每季維持 ${qText(LAST)}的 ${yi(nonopBase)}；有效稅率 ${taxGuide.value}%（公司 2026 年預估 ${taxGuide.low}–${taxGuide.high}%，2027 年沿用）；稀釋股數 ${fmtN(last.shares, 0)} 百萬股`, src: 'tr-2025q4' },
      { name: '隱含的美元營收成長', value: `2026 年 ${signed((usd2026(sc.id) / usd2025 - 1) * 100, 1)}（公司 10 月預估約 44%）、2027 年 ${signed(growth27(sc.id), 1)}；${qText(NEXT)}的營收水準已比 2026 年平均高約 ${fmtN((q4.Ru * 4 / usd2026(sc.id) - 1) * 100, 0)}%，即使 2027 年各季持平，全年也會成長`, src: 'tr-2026q3' },
    ];
    const forecasts: ModelOutput['scenarios'][number]['forecasts'] = rs.map((r, i) => ({
      period: r.period,
      revenue: round(r.R, 0), grossMargin: round(r.gm, 2), operatingIncome: round(r.oi, 0), netIncome: round(r.ni, 0), eps: round(r.eps, 2),
      known: [],
      note: i === 0
        ? `美元營收 ${usdYi(r.Ru, 1)} × 匯率 ${r.fx}；10 月營收 ${yi(october.revenue)}已公布，其餘兩個月與毛利率為模型推估。財測：營收 ${num(gRev.low! / 100, 0)}–${usdYi(gRev.high!)}（中值換算新台幣約 ${yi(gRev.value * gFx)}）、毛利率 ${gGm.low}–${gGm.high}%、營業利益率 ${gOm.low}–${gOm.high}%；本情境營業利益率 ${pct((r.oi / r.R) * 100, 1)}。`
        : `美元營收 ${usdYi(r.Ru, 1)}（HPC ${usdYi(r.hpc, 0)}、其他平台 ${usdYi(r.non, 0)}）× 匯率 ${r.fx}${r.d ? `；新增稀釋 ${r.d} 個百分點` : ''}；營業利益率 ${pct((r.oi / r.R) * 100, 1)}。`,
    }));
    forecasts.push({
      period: NEXT.slice(0, 4), revenue: round(a26.R, 0), grossMargin: round(a26.gm, 2), operatingIncome: round(a26.oi, 0), netIncome: round(a26.ni, 0), eps: round(a26.eps, 2), known: [],
      note: `前三季實際加上第四季預測；美元營收 ${usdYi(a26.Ru, 0)}（年增 ${signed((a26.Ru / usd2025 - 1) * 100, 1)}）。`,
    });
    forecasts.push({
      period: '2027', revenue: round(a27.R, 0), grossMargin: round(a27.gm, 2), operatingIncome: round(a27.oi, 0), netIncome: round(a27.ni, 0), eps: round(a27.eps, 2), known: [],
      note: `四季加總；美元營收 ${usdYi(a27.Ru, 0)}（年增 ${signed(growth27(sc.id), 1)}），毛利率為全年毛利 ÷ 全年營收，EPS 為四季加總。`,
    });
    return { id: sc.id, name: sc.name, assumptions, forecasts };
  });

  /* ── summary & limitations ── */
  const S = mt(selected);
  const G = mt('guidance');
  const N = mt('naive');
  const B = mt('guidance-bias');
  const E = mt('cost-elasticity-ex-ante');
  const q4b = fc.base[0]!;
  const bearY = y27('bear');
  const bullY = y27('bull');
  const exVsG = E.grossMargin!.mae - G.grossMargin!.mae;
  const summary = `選定模型是「成本彈性模型」：銷貨成本隨美元營收成長但成長得較慢（κ = ${num(costTr.kappa, 2)}），再計入匯率與公司事先說明的新製程、海外廠稀釋；營收由晶圓出貨與製程組合拆解。${TEST_FROM}–${TEST_TO} 逐季回測代入當季實際的營收、匯率、晶圓出貨與製程組合，毛利率誤差 ${num(S.grossMargin!.mae, 2)} 個百分點（天真模型 ${num(N.grossMargin!.mae, 2)}）、營收拆解誤差 ${pct(S.revenue!.mape!, 1)}；這是已知當季營收下的條件式回測，不能直接和事前的台積電財測（營收 ${pct(G.revenue!.mape!, 1)}、毛利率 ${num(G.grossMargin!.mae, 2)}）比較。改用季初的財測營收與匯率時毛利率誤差為 ${num(E.grossMargin!.mae, 2)}，${Math.abs(exVsG) < 0.1 ? '與財測相當' : exVsG < 0 ? '只略優於財測' : '不如財測'}；一季前最準的是財測加上歷史偏差（${pct(B.revenue!.mape!, 1)}、${num(B.grossMargin!.mae, 2)}）。基準情境 ${qText(NEXT)}營收約 ${twd(q4b.R)}、毛利率 ${pct(q4b.gm, 1)}；2027 年營收約 ${twd(baseY.R)}、毛利率 ${pct(baseY.gm, 1)}、EPS ${num(baseY.eps, 1)} 元（保守至樂觀：營收 ${num(bearY.R / 1e6, 2)}–${twd(bullY.R)}、EPS ${num(bearY.eps, 1)}–${num(bullY.eps, 1)} 元）。這是依假設推算的模型結果，不是投資建議。`;

  const limitations = [
    `回測代入當季實際的營收、匯率、晶圓出貨與製程組合，衡量的是「這些因素已知時」模型拆解營收與毛利率的能力；真正預測時這些都要先猜。改用季初的財測營收與匯率時，毛利率誤差（${num(E.grossMargin!.mae, 2)} 個百分點）${Math.abs(exVsG) < 0.1 ? `與公司財測（${num(G.grossMargin!.mae, 2)}）相當，沒有明顯優勢` : exVsG < 0 ? `只比公司財測（${num(G.grossMargin!.mae, 2)}）略好` : `比公司財測（${num(G.grossMargin!.mae, 2)}）差`}。`,
    `2025–2026 年毛利率由 59% 左右升到 66% 以上，比歷史的營運槓桿能解釋的多（從 ${TRAIN_TO} 連續推 ${test.length} 季、不用新財報重設時，${qText(TEST_TO)}低估 ${num(row(TEST_TO).gm - dyn.get(TEST_TO)!, 1)} 個百分點）。漲價、先進封裝與產品組合沒有單獨建模：營收成長來自漲價時成本幾乎不增加，來自產能擴充時成本增加較多，模型用同一個彈性 κ 處理，2027 年若漲價幅度不同，毛利率會偏離。`,
    '稀釋幅度取自公司法說會的區間說法並換算成中值（例如「低於 1 個百分點」取 0.5、「3–4 個百分點」取 3.5），只計入新製程與海外廠：全期估計與預測用目前已知的季度或半年說法（含事後說明），回測只用該季財報公布前的說法，只有全年區間時以全年中值當作稀釋水準；2025 年電價等通膨成本、2 奈米量產準備、地震等一次性事件都沒有計入，會出現在「其他」。',
    `折舊沒有單獨建模（φ = ${costTr.phi}）：台積電 2026 年資本預算 600–640 億美元、比 2025 年多約五成，新廠折舊在 2027 年以後才陸續增加；若折舊成長明顯快於營收，毛利率會比模型低。毛利率橋接模型直接使用折舊密度，可作為對照。`,
    '2027 年各季營收是本模型的情境假設：公司沒有 2027 年財測，只有長期複合成長（營收接近 25%、AI 加速器 50% 中高段）與產能說法；HPC 與其他平台的比重用管理報告的整數百分比推算，第四季平台比重沿用第三季。',
    '營業費用、業外收支、稅率與股數採簡化規則：業外收支維持最近一季水準（2026 年第二季的處分世界先進股票利益已排除）、稅率用公司 2026 年預估並沿用到 2027 年；第二季因未分配盈餘加徵稅率通常較高，單季淨利與 EPS 的分配會因此和模型不同。回測中 2026 年第二季的一次性業外利益也使所有模型的淨利與 EPS 低估。',
  ];

  const sourceKeys = [...new Set([
    ...[...qRange('2016Q1', LAST)].map((p) => `fs-${p.toLowerCase()}`),
    ...[...qRange('2016Q1', LAST)].map((p) => `mr-${p.toLowerCase()}`),
    ...DILUTION.flatMap((d) => (d.bt ? [d.src, d.bt.src] : [d.src])),
    'er-2026q3', 'tr-2026q3', 'tr-2025q4', 'tr-2026q1', 'tr-2025q2', 'tr-2025q3', 'tr-2023q4', 'tsmc-monthly', 'fs-2025q1',
  ])];

  return {
    company: 'tsmc',
    generatedBy: 'scripts/models/tsmc.ts',
    generatedOn: GENERATED_ON,
    asOf: inputs.asOf,
    currency: 'TWD',
    amountUnit: 'million',
    periodLabel: '日曆季度（第一季為 1–3 月）',
    train: { from: TRAIN_FROM, to: TRAIN_TO },
    test: { from: TEST_FROM, to: TEST_TO },
    lastReported: LAST,
    summary,
    candidates,
    parameters,
    derived,
    backtest,
    scenarios,
    sensitivities,
    limitations,
    sourceKeys,
  };
}

/* ───────────── CLI ───────────── */

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dirArg = process.argv.indexOf('--dir');
  const dir = dirArg > 0 ? process.argv[dirArg + 1]! : 'src/data/forecast';
  const pick = (f: string) => (existsSync(join(dir, f)) ? join(dir, f) : join('src/data/forecast', f));
  const inputs = companyInputs.parse(parse(readFileSync(pick('tsmc-inputs.yaml'), 'utf8')));
  const drivers = companyDrivers.parse(parse(readFileSync(pick('tsmc-drivers.yaml'), 'utf8')));
  const pricesPath = 'src/data/memory/forecast/market-prices.yaml';
  const prices = existsSync(pricesPath) ? marketPrices.parse(parse(readFileSync(pricesPath, 'utf8'))) : undefined;
  const out = buildModel(inputs, prices, drivers);
  writeFileSync(resolve(dir, 'tsmc-model.json'), `${JSON.stringify(out, null, 2)}\n`);
  const sel = out.candidates.find((c) => c.selected)!;
  console.log(`tsmc-model.json written to ${dir}: selected ${sel.id}; ${out.candidates.map((c) => `${c.id} rev ${c.metrics.revenue?.mape ?? '-'}% gm ${c.metrics.grossMargin?.mae ?? '-'}pp`).join(' | ')}`);
}
