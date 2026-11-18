// 輝達（NVIDIA）財報模型：用五大雲端業者的資本支出與「資料中心營收占資本支出的比例」推估資料中心營收，
// 用扣除存貨與採購承諾提列後的毛利率推估毛利率，再接上營業費用、業外、稅率與股數推估獲利；並和輝達每季的財測比較。
//   npx tsx scripts/models/nvidia.ts [--dir <dir>]   → 寫出 src/data/forecast/nvidia-model.json（--dir：讀寫另一個資料夾，例如暫存區）
// buildModel(inputs, prices, drivers) 是純函式（不讀檔、不取時間），scripts/check-forecast.ts 會重跑並比對輸出。
// prices（market-prices.yaml）用在兩處：DRAM 合約價對毛利率的檢定（訓練期，結果不顯著、不進入模型），以及 HBM 混合
// 合約價指數（推算序列，供頁面對照記憶體成本）。
//
// 口徑：輝達會計季度（FY2027 第三季為 2026-07-27 至 2026-10-25），百萬美元；毛利率、營業利益、淨利與 EPS 都是 GAAP。
// 輝達 FY(Y)Qn 對應日曆 (Y−1) 年第 n 季的雲端業者資本支出（約早一個月）。FY2027 為 53 週，第四季 14 週。
//
// 步驟
//  1. 候選模型：天真模型（上一季不變、延續上一季成長）、輝達財測、財測＋歷史偏差、雲端資本支出成長迴歸、
//     雲端資本支出比例模型（含事前版本）。FY2017Q2–FY2025Q4 估計，FY2026Q1–FY2027Q3 逐季回測（一季前）。
//     資本支出比例模型的回測代入當季實際的雲端業者資本支出與存貨提列（條件式）；事前版本只用上一季財報公布時已知的資料。
//  2. 選擇規則：在能延伸到 FY2028、不依賴財測的兩個結構模型中，取兩種回測（一季前逐季、從 TRAIN_TO 連續推估且不用
//     新財報）「營收 MAPE ＋ 毛利率 MAE」的平均最小者；差距在 TIE 以內取估計參數較少者。連續推估對應 FY2028 的用法。
//  3. 預測：FY2027Q4 以財測加上歷史財測誤差的百分位；FY2028 以情境假設的 2027 年雲端業者資本支出成長 × 資料中心營收
//     占資本支出的比例，毛利率以公司對 FY2028 的展望為錨；邊緣運算的情境年增率是全年（52 週）對 FY2027 扣除多出的一週；
//     業外收支用第三季非 GAAP 數字（不假設權益證券損益，NONOP_Q3）。資料更新到新的一季時，TEST_TO、NEXT、FY28、NONOP_Q3
//     與情境假設要跟著改。營業費用規則扣除一次性費用（OPEX_ONE_OFF）；淨利換算規則（CHAIN_RULES）以訓練期誤差選擇。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { companyDrivers, companyInputs, marketPrices, type CompanyDrivers, type CompanyInputs, type MarketPrices, type ModelOutput } from '../../src/schemas/forecast';
import { addQ, chainIndex, mean, metrics, qRange, round, seriesOf, sum, type Pair } from './lib';
import { calOf, captureRatio, coreGm, fq, growthForSum, median, n13, olsSE, pairedT, percentile, provRate, quarterTable, seriesPoint, tCrit, type NQ } from './nvidia-lib';

const GENERATED_ON = '2026-11-18';
const TRAIN_FROM = 'FY2017Q2'; // 第一個有上一季資料的季度
const TRAIN_TO = 'FY2025Q4';
const TEST_FROM = 'FY2026Q1';
const TEST_TO = 'FY2027Q3';
const NEXT = 'FY2027Q4'; // 已有財測的季度（14 週）
const FY28 = ['FY2028Q1', 'FY2028Q2', 'FY2028Q3', 'FY2028Q4'];
/** 資本支出規則在訓練期的共同比較區間：雲端業者資本支出從日曆 2017Q3（FY2018Q3）開始，事前版本需要 t−5。 */
const CAPEX_TRAIN_FROM = 'FY2019Q4';
const ELIGIBLE = ['capex-share', 'capex-regression'];
const SELECTED_EXPECTED = 'capex-share';
const TIE = 0.5; // 分數（「營收 MAPE ＋ 毛利率 MAE」兩種回測的平均）差距在 0.5 以內視為相近，取估計參數較少者

/** pr-fy2027q3（2026-11-17 新聞稿 Outlook，2026-11-18 讀取）：第四季 GAAP 營業費用約 110 億美元、FY2027 全年 GAAP 稅率 16–18%。 */
const Q4_OPEX_GUIDE = 11000;
const TAX_FY2027 = { low: 16, high: 18 };
const TAX = (TAX_FY2027.low + TAX_FY2027.high) / 2 / 100;
/**
 * cfo-fy2027q3（2026-11-17 財務長評論的 GAAP 與非 GAAP 調節表，2026-11-18 讀取）：第三季 GAAP 業外收支 14.97 億美元
 * ＝ 非 GAAP 業外收支 2.53 億美元（利息收支等）＋ 權益證券淨利益 17.67 億美元 − 其他 5.23 億美元（權益衍生性商品、權益法投資、
 * 可轉債等）。預測不假設權益證券的評價損益，業外收支用非 GAAP 數字。
 */
const NONOP_Q3 = { gaap: 1497, nonGaap: 253, equityGains: 1767, other: -523 };
/** 一次性營業費用：FY2023 第一季 13.53 億美元收購 Arm 終止費用（pr-fy2023q1；inputs periodNote），估計營業費用規則時扣除。 */
const OPEX_ONE_OFF: Record<string, number> = { FY2023Q1: 1353 };
/** 淨利的換算規則（業外收支與有效稅率）：上一季、最近四季合計或去年同季，以訓練期「已知營業利益時的淨利誤差」選擇。 */
type ChainRule = 'last' | 'avg4' | 'yoy';
const CHAIN_RULES: ChainRule[] = ['last', 'avg4', 'yoy'];
const CHAIN_NAME: Record<ChainRule, string> = { last: '上一季', avg4: '最近四季平均', yoy: '去年同季' };

/* ───────────── scenarios (assumptions; sources in nvidia-inputs.yaml / nvidia-drivers.yaml / market-prices.yaml) ───────────── */

type ScenId = 'bear' | 'base' | 'bull';
interface Scenario {
  id: ScenId;
  name: string;
  /** FY2027Q4：營收與毛利率取歷史財測誤差分布的百分位 */
  pct: number;
  /** 2027 年五大雲端業者資本支出年增率（%）；null＝輝達財務長引述的分析師預期（capex-top5-outlook） */
  capexG: number | null;
  /** FY2028 資料中心營收占資本支出比例相對最近四季的倍數 */
  captureMul: number;
  /** FY2028 邊緣運算（非資料中心）營收年增率（%） */
  edgeG: number;
  /** FY2028 毛利率相對公司 FY2028 展望（72–73%）的位置：下緣、中值或上緣，再加 gmAdd */
  gmAnchor: 'low' | 'mid' | 'high';
  gmAdd: number;
}
const SCENARIOS: Scenario[] = [
  { id: 'bear', name: '保守', pct: 0.1, capexG: 30, captureMul: 0.9, edgeG: -10, gmAnchor: 'low', gmAdd: -2 },
  { id: 'base', name: '基準', pct: 0.5, capexG: null, captureMul: 1, edgeG: 10, gmAnchor: 'mid', gmAdd: 0 },
  { id: 'bull', name: '樂觀', pct: 0.9, capexG: 80, captureMul: 1, edgeG: 25, gmAnchor: 'high', gmAdd: 1 },
];

/* ───────────── text helpers ───────────── */

const zero = (v: number, d: number) => round(v, d) === 0;
const fmtN = (v: number, d = 0) => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v: number, d = 2) => `${v < 0 && !zero(v, d) ? '−' : ''}${fmtN(v, d)}`;
const signed = (v: number, d = 1, unit = '%') => `${v < 0 && !zero(v, d) ? '−' : '+'}${fmtN(v, d)}${unit}`;
const pp = (v: number, d = 1) => `${v < 0 && !zero(v, d) ? '−' : '+'}${fmtN(v, d)} 個百分點`;
const usdYi = (m: number, d = 0) => `${num(m / 100, d)} 億美元`;
const pct = (v: number, d = 1) => `${num(v, d)}%`;
const term = (v: number, d = 3) => `${v < 0 ? '−' : '+'} ${fmtN(v, d)}`;
const usd = (v: number, d = 2) => `${num(v, d)} 美元`;
const ZHN = ['一', '二', '三', '四'];
/** 「FY2027 第三季」 */
const qText = (p: string) => `FY${p.slice(2, 6)} 第${ZHN[fq(p) - 1]}季`;
/** 「FY2017 第二季至 FY2025 第四季」 */
const span = (a: string, b: string) => `${qText(a)}至 ${qText(b)}`;

/* ───────────── model pieces ───────────── */

interface Pred { rev?: number | undefined; gm?: number | undefined; oi?: number | undefined; ni?: number | undefined; eps?: number | undefined; dc?: number | undefined }
interface OpexRule { e0: number; e1: number; se0: number; se1: number; n: number; s2: number }

/** 經常性營業費用：扣除一次性費用（OPEX_ONE_OFF）。 */
const opexCore = (r: NQ): number => r.opex - (OPEX_ONE_OFF[r.period] ?? 0);

/** 營業費用（每 13 週）的季變化對營收（每 13 週）季變化的彈性：log(費用_t ÷ 費用_t−1) = e0 + ε × log(營收_t ÷ 營收_t−1)。 */
function fitOpex(by: Map<string, NQ>, from: string, to: string): OpexRule {
  const ps = qRange(from, to);
  const r = olsSE(
    ps.map((p) => { const a = by.get(p)!; const q = by.get(addQ(p, -1))!; return [Math.log(n13(a.R, a) / n13(q.R, q))]; }),
    ps.map((p) => { const a = by.get(p)!; const q = by.get(addQ(p, -1))!; return Math.log(n13(opexCore(a), a) / n13(opexCore(q), q)); }),
  );
  return { e0: r.coef[0]!, e1: r.coef[1]!, se0: r.se[0]!, se1: r.se[1]!, n: r.n, s2: r.s2 };
}

/** 換算淨利用的業外收支與有效稅率（只用 t 以前的季度）。 */
function chainInputs(by: Map<string, NQ>, t: string, rule: ChainRule): { nonop: number; tau: number } {
  if (rule === 'last') { const q = by.get(addQ(t, -1))!; return { nonop: q.nonop, tau: q.tax / q.pretax }; }
  if (rule === 'yoy') { const q = by.get(addQ(t, -4))!; return { nonop: q.nonop, tau: q.tax / q.pretax }; }
  const qs = [1, 2, 3, 4].map((k) => by.get(addQ(t, -k))!);
  return { nonop: mean(qs.map((q) => q.nonop)), tau: sum(qs.map((q) => q.tax)) / sum(qs.map((q) => q.pretax)) };
}

/** 邊緣運算（非資料中心）營收的季節性：各會計季的平均對數季變化（每 13 週，含平均成長），與標準誤。 */
function fitSeason(by: Map<string, NQ>, from: string, to: string) {
  const buckets: number[][] = [[], [], [], []];
  for (const p of qRange(from, to)) { const a = by.get(p)!; const q = by.get(addQ(p, -1))!; buckets[fq(p) - 1]!.push(Math.log(n13(a.edge, a) / n13(q.edge, q))); }
  const f = buckets.map((b) => mean(b));
  const se = buckets.map((b, i) => Math.sqrt(sum(b.map((v) => (v - f[i]!) ** 2)) / (b.length - 1) / b.length));
  return { f, se, n: buckets.map((b) => b.length), trend: mean(f) };
}

/** 營收與毛利率已知時，以 t 以前的實際資料推算營業利益、淨利與 EPS（營業費用用彈性規則或指定值；業外與稅率依 rule）。 */
function chainPnl(by: Map<string, NQ>, t: string, R: number, gm: number, O: OpexRule, rule: ChainRule, opexGiven?: number): Pred {
  const a = by.get(t)!;
  const q = by.get(addQ(t, -1))!;
  const opex = opexGiven ?? (n13(opexCore(q), q) * Math.exp(O.e0 + O.e1 * Math.log(n13(R, a) / n13(q.R, q))) * a.weeks) / 13;
  const oi = (R * gm) / 100 - opex;
  const { nonop, tau } = chainInputs(by, t, rule);
  const ni = (oi + nonop) * (1 - tau);
  return { rev: R, gm, oi, ni, eps: ni / q.shares };
}

/* ───────────── build ───────────── */

export function buildModel(inputs: CompanyInputs, prices: MarketPrices | undefined, drivers: CompanyDrivers): ModelOutput {
  if (!drivers) throw new Error('nvidia model needs nvidia-drivers.yaml');
  if (!prices) throw new Error('nvidia model needs src/data/memory/forecast/market-prices.yaml (DRAM test, HBM index)');
  const rows = quarterTable(inputs, drivers);
  const by = new Map(rows.map((r) => [r.period, r]));
  const LAST = rows.at(-1)!.period;
  if (LAST !== TEST_TO) throw new Error(`nvidia inputs must end at ${TEST_TO} (got ${LAST}); move the windows and review the texts`);
  for (const p of qRange('FY2017Q1', LAST)) if (!by.has(p)) throw new Error(`nvidia inputs: ${p} missing`);
  for (const p of qRange('FY2018Q3', LAST)) if (by.get(p)!.K === undefined) throw new Error(`nvidia drivers: hyperscaler capex for ${calOf(p)} missing`);
  if (!/GAAP 營業費用約 110 億美元/.test(inputs.periodNote)) throw new Error('periodNote no longer states the FY2027Q4 opex guidance of 110 億美元; review Q4_OPEX_GUIDE');
  if (!/13\.53 億美元收購 Arm 終止費用/.test(inputs.periodNote)) throw new Error('periodNote no longer states the FY2023Q1 Arm termination charge; review OPEX_ONE_OFF');
  if (by.get(LAST)!.nonop !== NONOP_Q3.gaap || NONOP_Q3.nonGaap + NONOP_Q3.equityGains + NONOP_Q3.other !== NONOP_Q3.gaap) throw new Error('FY2027Q3 GAAP other income changed; review NONOP_Q3 (cfo-fy2027q3 reconciliation)');
  const row = (p: string) => by.get(p)!;
  const prev = (p: string) => row(addQ(p, -1));
  const test = qRange(TEST_FROM, TEST_TO);
  const trainK = qRange(CAPEX_TRAIN_FROM, TRAIN_TO);
  const last = row(LAST);
  const allQ = qRange('FY2017Q1', LAST);
  const allKeys = new Set([...Object.keys(inputs.sources), ...Object.keys(drivers.sources), ...Object.keys(prices.sources)]);

  /* ── fit on training data only ── */
  // 淨利換算規則：訓練期（FY2018 第一季起，去年同季與四季合計都有資料）已知營業利益時的淨利 MAPE 最小者
  const chainTrPs = qRange('FY2018Q1', TRAIN_TO);
  const chainErr = (rule: ChainRule, ps: string[]) => mean(ps.map((t) => { const { nonop, tau } = chainInputs(by, t, rule); return Math.abs(((row(t).oi + nonop) * (1 - tau)) / row(t).ni - 1) * 100; }));
  const chainTr = Object.fromEntries(CHAIN_RULES.map((r) => [r, chainErr(r, chainTrPs)])) as Record<ChainRule, number>;
  const chainTe = Object.fromEntries(CHAIN_RULES.map((r) => [r, chainErr(r, qRange(TEST_FROM, TEST_TO))])) as Record<ChainRule, number>;
  const RULE = [...CHAIN_RULES].sort((x, y) => chainTr[x] - chainTr[y])[0]!;
  const chain = (t: string, R: number, gm: number, O: OpexRule, opexGiven?: number) => chainPnl(by, t, R, gm, O, RULE, opexGiven);
  const opexTr = fitOpex(by, TRAIN_FROM, TRAIN_TO);
  const seasTr = fitSeason(by, TRAIN_FROM, TRAIN_TO);
  const edgeRule = (t: string, S = seasTr) => { const q = prev(t); return (n13(q.edge, q) * Math.exp(S.f[fq(t) - 1]!) * row(t).weeks) / 13; };
  // 資料中心營收成長 vs 資本支出成長（同一日曆季）：迴歸與標準誤
  const regFrom = 'FY2018Q4';
  const regPs = qRange(regFrom, TRAIN_TO);
  const dlogK = (p: string) => Math.log(row(p).K! / prev(p).K!);
  const dlogDC = (p: string) => Math.log(n13(row(p).dc, row(p)) / n13(prev(p).dc, prev(p)));
  const reg = olsSE(regPs.map((p) => [dlogK(p)]), regPs.map(dlogDC));
  const regLag = olsSE(qRange('FY2019Q1', TRAIN_TO).map((p) => [Math.log(prev(p).K! / prev(prev(p).period).K!)]), qRange('FY2019Q1', TRAIN_TO).map(dlogDC));
  // 核心毛利率（扣除提列前）對資料中心營收比重的水準迴歸
  const dcShare = (r: { dc: number; R: number }) => (r.dc / r.R) * 100;
  const mixPs = qRange('FY2017Q1', TRAIN_TO);
  const mix = olsSE(mixPs.map((p) => [dcShare(row(p))]), mixPs.map((p) => coreGm(row(p))));
  // DRAM 合約價（TrendForce，日曆季）對毛利率季變化的檢定：不顯著，不進入模型
  const dramS = prices.series.find((s) => s.id === 'dram-contract-qoq');
  if (!dramS) throw new Error('market-prices: dram-contract-qoq missing');
  const dram = seriesOf(dramS.points);
  const dramPs = qRange('FY2018Q1', TRAIN_TO).filter((p) => dram.has(calOf(p)) && dram.has(calOf(addQ(p, -1))));
  const dramReg = olsSE(dramPs.map((p) => [dram.get(calOf(p))!, dram.get(calOf(addQ(p, -1)))!]), dramPs.map((p) => row(p).gm - prev(p).gm));
  // 財測偏差（訓練期中位數）
  const beatR = (r: NQ) => (r.R / r.guide!.R - 1) * 100;
  const beatG = (r: NQ) => r.gm - r.guide!.gm;
  const beatO = (r: NQ) => (r.opex / r.guide!.opex - 1) * 100;
  const trG = qRange('FY2017Q1', TRAIN_TO);
  const bR = median(trG.map((p) => beatR(row(p))));
  const bG = median(trG.map((p) => beatG(row(p))));
  const bO = median(trG.map((p) => beatO(row(p))));
  const regBeat = olsSE(trainK.map((p) => [dlogK(p) * 100]), trainK.map((p) => beatR(row(p))));

  /** 提列率的事前估計：最近四個有揭露的季度提列率中位數（沒有揭露時為 0）。 */
  const provEx = (t: string) => {
    const xs = [1, 2, 3, 4].map((k) => row(addQ(t, -k))).filter((r) => r.provKind !== 'none').map(provRate);
    return xs.length ? median(xs) : 0;
  };
  /** 事前的資本支出：上一個日曆季 × 過去一年的平均季成長（上一季財報公布前，雲端業者都已公布）。 */
  const Kex = (t: string) => { const k1 = prev(t).K!; const k5 = row(addQ(t, -5)).K!; return k1 * Math.pow(k1 / k5, 1 / 4); };

  /* ── one-quarter-ahead predictions ── */
  const preds: Record<string, Map<string, Pred>> = {};
  const put = (id: string, p: string, x: Pred) => { (preds[id] ??= new Map()).set(p, x); };
  const capexShare = (t: string, exAnte: boolean, S = seasTr, O = opexTr): Pred => {
    const a = row(t);
    const q = prev(t);
    const c = captureRatio(by, t)!;
    const dc = (c * (exAnte ? Kex(t) : a.K!) * a.weeks) / 13;
    const R = dc + edgeRule(t, S);
    const gm = coreGm(q) - (exAnte ? provEx(t) : provRate(a));
    return { ...chain(t, R, gm, O), dc };
  };
  const capexReg = (t: string): Pred => {
    const a = row(t);
    const q = prev(t);
    const dc = (n13(q.dc, q) * Math.exp(reg.coef[0]! + reg.coef[1]! * dlogK(t)) * a.weeks) / 13;
    const R = dc + edgeRule(t);
    const gm = mix.coef[0]! + mix.coef[1]! * dcShare({ dc, R }) - provRate(a);
    return { ...chain(t, R, gm, opexTr), dc };
  };
  const naiveOf = (t: string): Pred => { const q = prev(t); return chain(t, (n13(q.R, q) * row(t).weeks) / 13, q.gm, opexTr); };
  const momentumOf = (t: string): Pred => { const q = prev(t); const q2 = prev(q.period); return chain(t, ((n13(q.R, q) ** 2 / n13(q2.R, q2)) * row(t).weeks) / 13, q.gm, opexTr); };
  const guidanceBiasOf = (t: string): Pred => { const g = row(t).guide!; return chain(t, g.R * (1 + bR / 100), g.gm + bG, opexTr, g.opex * (1 + bO / 100)); };
  for (const p of [...trainK, ...test]) {
    const a = row(p);
    const g = a.guide!;
    put('naive', p, naiveOf(p));
    put('naive-momentum', p, momentumOf(p));
    put('guidance', p, { rev: g.R, gm: g.gm, oi: (g.R * g.gm) / 100 - g.opex });
    put('guidance-bias', p, guidanceBiasOf(p));
    put('capex-regression', p, capexReg(p));
    put('capex-share', p, capexShare(p, false));
    put('capex-share-ex-ante', p, capexShare(p, true));
  }

  const METRICS = ['revenue', 'grossMargin', 'operatingIncome', 'netIncome', 'eps'] as const;
  type M = (typeof METRICS)[number];
  const field = { revenue: 'rev', grossMargin: 'gm', operatingIncome: 'oi', netIncome: 'ni', eps: 'eps' } as const;
  const actualOf = (a: NQ, m: M) => ({ revenue: a.R, grossMargin: a.gm, operatingIncome: a.oi, netIncome: a.ni, eps: a.eps })[m];
  const pairsIn = (ps: string[], id: string, m: M): Pair[] => ps.flatMap((p) => { const x = preds[id]?.get(p)?.[field[m]]; return x === undefined ? [] : [{ actual: actualOf(row(p), m), predicted: x }]; });
  const MT: Record<string, Record<string, ReturnType<typeof metrics>>> = {};
  for (const id of Object.keys(preds)) {
    const out: Record<string, ReturnType<typeof metrics>> = {};
    for (const m of METRICS) { const ps = pairsIn(test, id, m); if (ps.length) out[m] = metrics(ps, m !== 'grossMargin'); }
    MT[id] = out;
  }
  // 訓練期（FY2019Q4–FY2025Q4，一季前）營收與毛利率：資本支出規則的共同區間
  for (const id of ['capex-share', 'capex-regression', 'naive-momentum', 'naive']) {
    MT[id]!.revenueTrain = metrics(pairsIn(trainK, id, 'revenue'));
    MT[id]!.grossMarginTrain = metrics(pairsIn(trainK, id, 'grossMargin'), false);
  }
  // 選定模型的事前指標（與事前版本候選相同），頁面摘要讀 revenueExAnte
  for (const m of ['revenue', 'grossMargin', 'operatingIncome', 'eps'] as const) MT['capex-share']![`${m}ExAnte`] = MT['capex-share-ex-ante']![m]!;
  // 連續預測（FY2028 的用法）：從 TRAIN_TO 出發，參數與比例固定、不用新財報重設，只代入實際的資本支出與提列
  const c0 = captureRatio(by, TEST_FROM)!;
  const dyn: Record<string, { rev: Map<string, number>; gm: Map<string, number>; dcErr: number[] }> = {};
  for (const id of ELIGIBLE) {
    const d = { rev: new Map<string, number>(), gm: new Map<string, number>(), dcErr: [] as number[] };
    let edge13 = n13(row(TRAIN_TO).edge, row(TRAIN_TO));
    let dc13 = n13(row(TRAIN_TO).dc, row(TRAIN_TO));
    const core0 = coreGm(row(TRAIN_TO));
    for (const p of test) {
      const a = row(p);
      edge13 *= Math.exp(seasTr.f[fq(p) - 1]!);
      dc13 = id === 'capex-share' ? c0 * a.K! : dc13 * Math.exp(reg.coef[0]! + reg.coef[1]! * dlogK(p));
      d.rev.set(p, ((dc13 + edge13) * a.weeks) / 13);
      d.gm.set(p, (id === 'capex-share' ? core0 : mix.coef[0]! + mix.coef[1]! * (dc13 / (dc13 + edge13)) * 100) - provRate(a));
      d.dcErr.push(Math.abs(((dc13 * a.weeks) / 13 / a.dc - 1) * 100));
    }
    dyn[id] = d;
    MT[id]!.revenueDynamic = metrics(test.map((p) => ({ actual: row(p).R, predicted: d.rev.get(p)! })));
    MT[id]!.grossMarginDynamic = metrics(test.map((p) => ({ actual: row(p).gm, predicted: d.gm.get(p)! })), false);
  }
  const dynDcErr = dyn['capex-share']!.dcErr;
  // 對照（寫在說明中）：比例改用上一季單季值、只用上一個日曆季的資本支出
  const altLast = metrics(test.map((p) => { const a = row(p); const q = prev(p); return { actual: a.R, predicted: ((n13(q.dc, q) / q.K!) * a.K! * a.weeks) / 13 + edgeRule(p) }; }));
  const altLastTr = metrics(trainK.map((p) => { const a = row(p); const q = prev(p); return { actual: a.R, predicted: ((n13(q.dc, q) / q.K!) * a.K! * a.weeks) / 13 + edgeRule(p) }; }));
  const gmNoProv = metrics(test.map((p) => ({ actual: row(p).gm, predicted: coreGm(prev(p)) })), false);
  const gmWdOnly = metrics(test.map((p) => { const a = row(p); const q = prev(p); const wd = (r: NQ, x?: number) => ((x ?? 0) / r.R) * 100; return { actual: a.gm, predicted: q.gm + wd(q, inputs.quarters.find((z) => z.period === q.period)!.inventoryWritedown) - wd(a, inputs.quarters.find((z) => z.period === a.period)!.inventoryWritedown) }; }), false);

  /* ── selection ── */
  const score1 = (id: string) => MT[id]!.revenue!.mape! + MT[id]!.grossMargin!.mae;
  const scoreD = (id: string) => MT[id]!.revenueDynamic!.mape! + MT[id]!.grossMarginDynamic!.mae;
  const score = (id: string) => (score1(id) + scoreD(id)) / 2;
  const NPARAM: Record<string, number> = { 'capex-share': 4 + 2, 'capex-regression': 2 + 2 + 4 + 2 }; // 季節性 4 ＋ 營業費用 2；迴歸另加 4
  const pickBy = (sc: (id: string) => number) => [...ELIGIBLE].sort((x, y) => { const d = sc(x) - sc(y); return Math.abs(d) <= TIE ? NPARAM[x]! - NPARAM[y]! : d; })[0]!;
  const selected = pickBy(score);
  if (selected !== SELECTED_EXPECTED) throw new Error(`selection changed to ${selected}; review the forecast wiring and texts`);
  const runnerUp = ELIGIBLE.find((x) => x !== selected)!;
  const ape = (id: string, p: string) => Math.abs(preds[id]!.get(p)!.rev! / row(p).R - 1) * 100;
  const gmErr = (id: string, p: string) => Math.abs(preds[id]!.get(p)!.gm! - row(p).gm);
  const tRev = (a: string, b: string) => pairedT(test.map((p) => ape(a, p) - ape(b, p)));
  const tGm = (a: string, b: string) => pairedT(test.map((p) => gmErr(a, p) - gmErr(b, p)));
  const winsRev = (a: string, b: string) => test.filter((p) => ape(a, p) < ape(b, p)).length;
  const TC = tCrit(test.length - 1);
  // 單一季度對毛利率排名的影響：拿掉 H20 費用那一季
  const H20Q = 'FY2026Q1';
  const gmMaeWithout = (id: string, skip: string) => mean(test.filter((p) => p !== skip).map((p) => gmErr(id, p)));
  const topGmQ = (id: string) => test.reduce((a, p) => (gmErr(id, p) > gmErr(id, a) ? p : a));
  const score1Without = (id: string, skip: string) => mean(test.filter((p) => p !== skip).map((p) => ape(id, p))) + gmMaeWithout(id, skip);
  // 比例模型 FY2025 以來的區間（頁面文字用）
  const ratioQ = qRange('FY2025Q1', LAST).map((p) => (n13(row(p).dc, row(p)) / row(p).K!) * 100);
  const ratio4 = qRange('FY2025Q4', LAST).map((p) => captureRatio(by, addQ(p, 1))! * 100);
  const rng = (xs: number[]) => `${fmtN(Math.floor(Math.min(...xs)), 0)}–${fmtN(Math.ceil(Math.max(...xs)), 0)}%`;

  /* ── re-fit on all reported quarters ── */
  const opexFull = fitOpex(by, TRAIN_FROM, LAST);
  const seasFull = fitSeason(by, TRAIN_FROM, LAST);
  const regFull = olsSE(qRange(regFrom, LAST).map((p) => [dlogK(p)]), qRange(regFrom, LAST).map(dlogDC));
  const cLast = captureRatio(by, NEXT)!; // FY2026Q4–FY2027Q3 資料中心營收 ÷ 2025Q4–2026Q3 資本支出
  const annualRatio = (fy: number) => {
    const ps = qRange(`FY${fy}Q1`, `FY${fy}Q4`);
    return (sum(ps.map((p) => n13(row(p).dc, row(p)))) / sum(ps.map((p) => row(p).K!))) * 100;
  };
  // 對照：不扣除 Arm 收購終止費用時的營業費用規則
  const opexFullRaw = olsSE(
    qRange(TRAIN_FROM, LAST).map((p) => [Math.log(n13(row(p).R, row(p)) / n13(prev(p).R, prev(p)))]),
    qRange(TRAIN_FROM, LAST).map((p) => Math.log(n13(row(p).opex, row(p)) / n13(prev(p).opex, prev(p)))),
  );
  const opexFullS2 = opexFull.s2;
  const revBeats = allQ.map((p) => beatR(row(p)));
  const gmBeats = allQ.map((p) => beatG(row(p)));
  const opexBeats = allQ.map((p) => beatO(row(p)));
  const bOFull = median(opexBeats);
  const provMed = median([0, 1, 2, 3].map((k) => row(addQ(LAST, -k))).filter((r) => r.provKind !== 'none').map(provRate));

  // FY2027Q4 guidance (drivers; pr-fy2027q3) and other sourced anchors
  const gRev = seriesPoint(drivers, 'guidance-revenue', NEXT);
  const gGm = seriesPoint(drivers, 'guidance-gross-margin', NEXT);
  const gGm28 = seriesPoint(drivers, 'guidance-gross-margin-annual', 'FY2028');
  const top5 = { y26: seriesPoint(drivers, 'capex-top5-outlook', '2026'), y27: seriesPoint(drivers, 'capex-top5-outlook', '2027') };
  const capexBase = (top5.y27.value / top5.y26.value - 1) * 100;
  const chinaQ3 = seriesPoint(drivers, 'china-dc-hopper', LAST);
  const cowos = { y26: seriesPoint(drivers, 'cowos-capacity-tsmc-gs', '2026'), y27: seriesPoint(drivers, 'cowos-capacity-tsmc-gs', '2027') };
  const cowosG = (cowos.y27.value / cowos.y26.value - 1) * 100;
  const halfPct = ((gRev.high! - gRev.value) / gRev.value) * 100;
  if (Math.abs(halfPct - 3) > 1e-6) throw new Error(`FY2027Q4 guidance band is no longer ± 3% (${halfPct})`);
  const yearK = (y: number) => sum([1, 2, 3, 4].map((n) => drivers.series.find((s) => s.id === 'hyperscaler-capex-total')!.points.find((x) => x.period === `${y}Q${n}`)?.value ?? NaN));
  const capexHist = { y23: (yearK(2023) / yearK(2022) - 1) * 100, y24: (yearK(2024) / yearK(2023) - 1) * 100, y25: (yearK(2025) / yearK(2024) - 1) * 100 };
  const k26ytd = sum(['2026Q1', '2026Q2', '2026Q3'].map((c) => drivers.series.find((s) => s.id === 'hyperscaler-capex-total')!.points.find((x) => x.period === c)!.value));
  const k25ytd = sum(['2025Q1', '2025Q2', '2025Q3'].map((c) => drivers.series.find((s) => s.id === 'hyperscaler-capex-total')!.points.find((x) => x.period === c)!.value));
  const capex26Ytd = (k26ytd / k25ytd - 1) * 100;
  const fy27Edge = sum(qRange('FY2027Q1', LAST).map((p) => row(p).edge));
  const fy26EdgeYtd = sum(qRange('FY2026Q1', 'FY2026Q3').map((p) => row(p).edge));
  const edgeYtdG = (fy27Edge / fy26EdgeYtd - 1) * 100;
  const gm27ytd = qRange('FY2027Q1', LAST).map((p) => row(p).gm);
  const nonopYtd = mean(qRange('FY2027Q1', LAST).map((p) => row(p).nonop));
  const qoqTest = mean(test.map((p) => (row(p).R / prev(p).R - 1) * 100));
  const belowR = allQ.filter((p) => beatR(row(p)) < 0);
  const belowG = allQ.filter((p) => beatG(row(p)) <= -2);

  /* ── forecasts ── */
  interface FcRow { period: string; R: number; dc: number; edge: number; china: number; K?: number | undefined; gm: number; opex: number; oi: number; nonop: number; ni: number; eps: number }
  interface FcOpts { capexAdd?: number; captureAdd?: number; gmAdd?: number; cogsMul?: number; edgeAdd?: number; opexMul?: number; taxAdd?: number; nonop?: number; china?: number; sharesMul?: number }
  interface FcOut { rows: FcRow[]; Kq4: number; K26: number; K27: number; g: number; c28: number; G: number; gm28: number; xe: number; edge27w: number }
  const gm28Of = (sc: Scenario) => (sc.gmAnchor === 'low' ? gGm28.low! : sc.gmAnchor === 'high' ? gGm28.high! : gGm28.value) + sc.gmAdd;
  const q4R = (sc: Scenario) => gRev.value * (1 + percentile(revBeats, sc.pct) / 100);
  const q4Gm = (sc: Scenario) => gGm.value + percentile(gmBeats, sc.pct);
  const q4Opex = Q4_OPEX_GUIDE * (1 + bOFull / 100);
  const wQ4 = 14;
  function forecast(sc: Scenario, o: FcOpts = {}): FcOut {
    const out: FcRow[] = [];
    // FY2027Q4：財測 ×（1 + 歷史財測誤差百分位）；中國資料中心運算營收不在財測內（敏感度另加，不影響雲端資本支出的推算）
    const R4 = q4R(sc);
    const china = o.china ?? 0;
    const edge4 = (n13(last.edge, last) * Math.exp(seasFull.f[3]!) * wQ4) / 13;
    const dc4 = R4 - edge4;
    const gm4 = q4Gm(sc);
    const Rt4 = R4 + china;
    const oi4 = (Rt4 * gm4) / 100 - q4Opex;
    // 業外收支：第三季非 GAAP 業外收支（不假設權益證券的評價損益；cfo-fy2027q3）
    const nonop = o.nonop ?? NONOP_Q3.nonGaap;
    const ni4 = (oi4 + nonop) * (1 - TAX);
    out.push({ period: NEXT, R: Rt4, dc: dc4 + china, edge: edge4, china, gm: gm4, opex: q4Opex, oi: oi4, nonop, ni: ni4, eps: ni4 / last.shares });
    // FY2028：資料中心營收 = 比例 × 雲端業者資本支出；2026Q4 資本支出由第四季資料中心營收（13 週）÷ 比例反推
    const Kq4 = (dc4 * 13) / wQ4 / cLast;
    const K26 = k26ytd + Kq4;
    const G = (sc.capexG ?? capexBase) + (o.capexAdd ?? 0);
    const K27 = K26 * (1 + G / 100);
    const g = growthForSum(K27 / Kq4);
    const c28 = cLast * sc.captureMul + (o.captureAdd ?? 0) / 100;
    const gm28 = gm28Of(sc) + (o.gmAdd ?? 0);
    const gmUse = 100 - (100 - gm28) * (o.cogsMul ?? 1);
    const tax = TAX + (o.taxAdd ?? 0) / 100;
    const shares = last.shares * (o.sharesMul ?? 1);
    // 邊緣運算：FY2028 全年（52 週）＝ FY2027（扣除多出的一週）×（1 + 情境年增率），各季依歷史季節性（扣除平均成長）分配，
    // 再以固定季成長 xe 使全年合計符合
    const edge13 = (edge4 * 13) / wQ4;
    const edge27w = fy27Edge + edge13;
    const shape = [1, 2, 3, 4].map((n) => Math.exp(sum(seasFull.f.slice(0, n).map((v) => v - seasFull.trend))));
    const xe = growthForSum((edge27w * (1 + (sc.edgeG + (o.edgeAdd ?? 0)) / 100)) / edge13, shape);
    let prevR = (Rt4 * 13) / wQ4;
    let prevOpex = (q4Opex * 13) / wQ4;
    for (let n = 1; n <= 4; n++) {
      const p = FY28[n - 1]!;
      const K = Kq4 * (1 + g) ** n;
      const dc = c28 * K;
      const edge = edge13 * shape[n - 1]! * (1 + xe) ** n;
      const R = dc + edge;
      const opexBase = prevOpex * Math.exp(opexFull.e0 + opexFull.e1 * Math.log(R / prevR));
      const opex = opexBase * (o.opexMul ?? 1);
      const oi = (R * gmUse) / 100 - opex;
      const ni = (oi + nonop) * (1 - tax);
      out.push({ period: p, R, dc, edge, china: 0, K, gm: gmUse, opex, oi, nonop, ni, eps: ni / shares });
      prevR = R;
      prevOpex = opexBase;
    }
    return { rows: out, Kq4, K26, K27, g, c28, G, gm28: gmUse, xe, edge27w };
  }
  const annualOf = (rs: { R: number; gm: number; oi: number; ni: number; eps: number }[]) => {
    const R = sum(rs.map((r) => r.R));
    return { R, gm: (100 * sum(rs.map((r) => (r.R * r.gm) / 100))) / R, oi: sum(rs.map((r) => r.oi)), ni: sum(rs.map((r) => r.ni)), eps: sum(rs.map((r) => r.eps)) };
  };
  const ytd = qRange('FY2027Q1', LAST).map((p) => { const r = row(p); return { R: r.R, gm: r.gm, oi: r.oi, ni: r.ni, eps: r.eps, dc: r.dc }; });
  const fc = Object.fromEntries(SCENARIOS.map((s) => [s.id, forecast(s)])) as Record<ScenId, FcOut>;
  const y27 = (f: FcOut) => annualOf([...ytd, f.rows[0]!]);
  const y28 = (f: FcOut) => annualOf(f.rows.slice(1));
  const fy26 = annualOf(qRange('FY2026Q1', 'FY2026Q4').map((p) => { const r = row(p); return { R: r.R, gm: r.gm, oi: r.oi, ni: r.ni, eps: r.eps }; }));
  const base = fc.base;
  const baseY27 = y27(base);
  const baseY28 = y28(base);
  const g28 = (f: FcOut) => (y28(f).R / y27(f).R - 1) * 100;
  const g28w = (f: FcOut) => (y28(f).R / (y27(f).R - (f.rows[0]!.R / 14)) - 1) * 100; // 扣除 FY2027 多出的一週

  /* ── sensitivities (base, FY2028) ── */
  const baseSc = SCENARIOS.find((s) => s.id === 'base')!;
  const sens = (o: FcOpts) => { const f = forecast(baseSc, o); const y = y28(f); return { R: y.R - baseY28.R, Rp: (y.R / baseY28.R - 1) * 100, gm: y.gm - baseY28.gm, eps: y.eps - baseY28.eps }; };
  const sensText = (x: ReturnType<typeof sens>) => {
    const parts: string[] = [];
    if (Math.abs(x.R) >= 50) parts.push(`營收 ${x.R >= 0 ? '+' : '−'}${usdYi(Math.abs(x.R))}（${signed(x.Rp, 1)}）`);
    if (Math.abs(x.gm) >= 0.005) parts.push(`毛利率 ${pp(x.gm, 2)}`);
    parts.push(`EPS ${x.eps >= 0 ? '+' : '−'}${usd(Math.abs(x.eps))}`);
    return `FY2028 ${parts.join('、')}${Math.abs(x.R) < 50 ? '（營收不變）' : ''}`;
  };
  const chinaSens = (() => { const f = forecast(baseSc, { china: chinaQ3.value }); const a = y27(f); return { R: a.R - baseY27.R, eps: a.eps - baseY27.eps, q4: f.rows[0]!.R - base.rows[0]!.R }; })();
  const sensitivities: ModelOutput['sensitivities'] = [
    { driver: '2027 年五大雲端業者資本支出成長', change: '多 10 個百分點', effect: sensText(sens({ capexAdd: 10 })) },
    { driver: '2027 年五大雲端業者資本支出成長', change: '少 10 個百分點', effect: sensText(sens({ capexAdd: -10 })) },
    { driver: '資料中心營收占雲端業者資本支出的比例', change: `少 2 個百分點（${pct(cLast * 100, 1)} → ${pct(cLast * 100 - 2, 1)}）`, effect: sensText(sens({ captureAdd: -2 })) },
    { driver: 'FY2028 毛利率', change: '少 1 個百分點', effect: sensText(sens({ gmAdd: -1 })) },
    { driver: '記憶體（含 HBM）等銷貨成本', change: `FY2028 多 5%（毛利率約少 ${fmtN(((100 - baseY28.gm) * 5) / 100, 1)} 個百分點）`, effect: sensText(sens({ cogsMul: 1.05 })) },
    { driver: '邊緣運算營收（PC、遊戲、工作站、車用等）', change: 'FY2028 年增率少 10 個百分點', effect: sensText(sens({ edgeAdd: -10 })) },
    { driver: '營業費用', change: 'FY2028 多 10%', effect: sensText(sens({ opexMul: 1.1 })) },
    { driver: '有效稅率', change: '多 2 個百分點', effect: sensText(sens({ taxAdd: 2 })) },
    { driver: '業外收支（權益證券損益）', change: `每季維持第三季的 GAAP 數字 ${usdYi(last.nonop, 1)}（含權益證券淨利益 ${usdYi(NONOP_Q3.equityGains, 1)}；模型每季用非 GAAP 的 ${usdYi(NONOP_Q3.nonGaap, 1)}，cfo-fy2027q3）`, effect: sensText(sens({ nonop: last.nonop })) },
    { driver: '業外收支（權益證券損益）', change: `改用 FY2027 前三季 GAAP 平均（每季 ${usdYi(nonopYtd)}，主要是權益證券利益）`, effect: sensText(sens({ nonop: nonopYtd })) },
    { driver: '稀釋股數', change: '少 1%（買回庫藏股）', effect: sensText(sens({ sharesMul: 0.99 })) },
    { driver: `${qText(NEXT)}對中國的資料中心出貨`, change: `與第三季相同（${usdYi(chinaQ3.value)}，cfo-fy2027q3；財測不含中國資料中心運算營收）`, effect: `${qText(NEXT)}營收 +${usdYi(chinaSens.q4)}；FY2027 全年 EPS +${usd(chinaSens.eps)}（不影響 FY2028 的推算）` },
  ];

  /* ── candidates ── */
  const mt = (id: string) => MT[id]!;
  const S = mt(selected);
  const E = mt('capex-share-ex-ante');
  const G = mt('guidance');
  const B = mt('guidance-bias');
  const NM = mt('naive-momentum');
  const R2 = mt('capex-regression');
  // 事前（只用季初資訊）的方法：文字說財測＋歷史偏差在其中最準、兩個條件式結構模型的 EPS 誤差較小，這裡檢查
  const EX_ANTE = ['naive', 'naive-momentum', 'guidance', 'guidance-bias', 'capex-share-ex-ante'];
  const errOf = (id: string, m: 'revenue' | 'grossMargin' | 'eps') => { const x = MT[id]![m]; return x === undefined ? Infinity : m === 'grossMargin' ? x.mae : x.mape!; };
  const bestExAnte = (m: 'revenue' | 'grossMargin' | 'eps') => [...EX_ANTE].sort((a, b) => errOf(a, m) - errOf(b, m))[0]!;
  if (bestExAnte('revenue') !== 'guidance-bias' || bestExAnte('grossMargin') !== 'guidance-bias') throw new Error('guidance-bias is no longer the most accurate ex-ante method; review the texts');
  if (!(S.eps!.mape! < B.eps!.mape! && R2.eps!.mape! < B.eps!.mape!)) throw new Error('conditional models no longer have a smaller EPS error than guidance-bias; review the texts');
  const chainEq = [
    '營業費用_t（每 13 週）= 營業費用_t−1 × e^e0 ×（營收_t ÷ 營收_t−1）^ε；營業利益_t = 營收_t × 毛利率_t − 營業費用_t',
    RULE === 'last'
      ? '淨利_t =（營業利益_t + 業外收支_t−1）×（1 − 上一季有效稅率）；EPS_t = 淨利_t ÷ 稀釋股數_t−1'
      : RULE === 'avg4'
        ? '淨利_t =（營業利益_t + 最近四季平均業外收支）×（1 − 最近四季有效稅率）；EPS_t = 淨利_t ÷ 稀釋股數_t−1'
        : '淨利_t =（營業利益_t + 業外收支_t−4）×（1 − 去年同季有效稅率）；EPS_t = 淨利_t ÷ 稀釋股數_t−1',
  ];
  const edgeEq = '邊緣運算營收_t = 邊緣運算營收_t−1 × e^(s_q)，s_q 為訓練期各會計季的平均對數季變化（含成長）';
  const chainOrder = [...CHAIN_RULES].sort((x, y) => chainTr[x] - chainTr[y]);
  const chainNote = `營業費用規則以 ${span(TRAIN_FROM, TRAIN_TO)}共 ${opexTr.n} 季估計（FY2023 第一季扣除 13.53 億美元的 Arm 收購終止費用，pr-fy2023q1）：ε = ${num(opexTr.e1, 3)}（標準誤 ${num(opexTr.se1, 3)}）、e0 = ${signed(opexTr.e0 * 100, 2)}／季（標準誤 ${num(opexTr.se0 * 100, 2)}%）。${RULE === 'avg4' ? '業外收支用最近四季平均、有效稅率用最近四季的稅額 ÷ 稅前淨利' : `業外收支與有效稅率用${CHAIN_NAME[RULE]}的數字`}、股數用上一季的稀釋股數：已知營業利益時，${span(chainTrPs[0]!, TRAIN_TO)}的淨利 MAPE：${chainOrder.map((r) => `${CHAIN_NAME[r]} ${pct(chainTr[r], 2)}`).join('、')}，取最小者（測試期依序為 ${chainOrder.map((r) => pct(chainTe[r], 2)).join('、')}）。14 週的季度（FY2021 第四季）以每 13 週換算。`;
  const regNote = `資料中心營收季成長對同一日曆季資本支出季成長的斜率只有 ${num(reg.coef[1]!, 3)}（標準誤 ${num(reg.se[1]!, 3)}，t 值 ${num(reg.t[1]!, 2)}，${span(regFrom, TRAIN_TO)}共 ${reg.n} 季）；改用上一個日曆季為 ${num(regLag.coef[1]!, 3)}（標準誤 ${num(regLag.se[1]!, 3)}），都與 0 沒有顯著差異：逐季看，雲端業者資本支出的變化解釋不了輝達資料中心營收的變化（付款與出貨的時間差、雲端業者只占資料中心營收約一半）。全期（至 ${qText(LAST)}）估計為 ${num(regFull.coef[1]!, 3)}（標準誤 ${num(regFull.se[1]!, 3)}）。斜率不顯著，這個模型的營收規則實際上等於每季固定成長約 ${pct((Math.exp(reg.coef[0]!) - 1) * 100, 0)}（截距），用來推估 FY2028 時不會隨雲端業者資本支出的情境改變。`;
  const nTop = (id: string) => topGmQ(id);
  const candidates: ModelOutput['candidates'] = [
    {
      id: 'naive', name: '天真模型（上一季不變）',
      description: `假設本季營收與毛利率都和上一季一樣。這是最簡單的對照組；測試期輝達營收平均每季成長 ${pct(qoqTest, 0)}，這個模型在成長期會一直低估。`,
      equations: ['營收_t = 營收_t−1（每 13 週）', '毛利率_t = 毛利率_t−1', ...chainEq],
      metrics: mt('naive'), selected: false,
      note: '營業利益、淨利與 EPS 用與其他模型相同的營業費用、業外、稅率與股數規則換算。',
    },
    {
      id: 'naive-momentum', name: '天真模型（延續上一季成長）',
      description: '假設本季營收的季成長率和上一季一樣，毛利率和上一季一樣。對快速成長的公司，這是比「上一季不變」更公平的對照組：不需要任何驅動因子，只看營收自己的動能。',
      equations: ['營收_t = 營收_t−1 ×（營收_t−1 ÷ 營收_t−2）（每 13 週）', '毛利率_t = 毛利率_t−1', ...chainEq],
      metrics: mt('naive-momentum'), selected: false,
      note: `測試期營收 MAPE ${pct(NM.revenue!.mape!, 2)}，低於兩個結構模型；最大的誤差在 ${qText(test.reduce((a, p) => (ape('naive-momentum', p) > ape('naive-momentum', a) ? p : a)))}（${pct(ape('naive-momentum', test.reduce((a, p) => (ape('naive-momentum', p) > ape('naive-momentum', a) ? p : a))), 1)}）。訓練期（${span(CAPEX_TRAIN_FROM, TRAIN_TO)}）營收 MAPE ${pct(NM.revenueTrain!.mape!, 1)}：成長轉折時（例如 FY2024 第二季營收季增 ${pct((row('FY2024Q2').R / row('FY2024Q1').R - 1) * 100, 0)}）誤差很大。它不是結構模型，延伸到 FY2028 只會把最近一季的成長率一直複利下去，不參與模型選擇。`,
    },
    {
      id: 'guidance', name: '輝達財測（對照基準）',
      description: '輝達在上一季財報公布的本季財測中值：營收（中值 ± 2%，FY2027 第四季 ± 3%）、GAAP 毛利率與 GAAP 營業費用（營業利益 = 營收 × 毛利率 − 營業費用）。這不是本站的模型，而是公司在季度開始時的判斷。公司不給淨利與 EPS 財測。',
      equations: ['預測值 = 上一季新聞稿的本季財測中值', '營業利益 = 營收財測 × 毛利率財測 − 營業費用財測'],
      metrics: mt('guidance'), selected: false,
      note: `輝達的營收財測歷來偏保守：${qText(TRAIN_TO)}以前 ${trG.length} 季中有 ${trG.filter((p) => beatR(row(p)) > 0).length} 季實際營收高於中值，測試期 ${test.length} 季${test.every((p) => beatR(row(p)) > 0) ? '全部' : `有 ${test.filter((p) => beatR(row(p)) > 0).length} 季`}高於中值（平均高 ${pct(mean(test.map((p) => beatR(row(p)))), 1)}）。毛利率財測很準，測試期誤差幾乎全部來自 ${qText(H20Q)}：財測公布後，美國在 2025-04-09 要求 H20 出口中國須申請許可，公司當季認列 45 億美元 H20 相關費用（sec-8k-20250409、cfo-fy2026q1）；不計這一季，財測的毛利率 MAE 為 ${num(gmMaeWithout('guidance', H20Q), 2)} 個百分點。`,
    },
    {
      id: 'guidance-bias', name: '財測＋歷史偏差校正',
      description: `輝達財測中值加上 ${qText(TRAIN_TO)}以前財測誤差的中位數：營收乘以（1 ${term(bR, 2)}%）、毛利率 ${pp(bG, 2)}、營業費用乘以（1 ${term(bO, 2)}%），再用相同規則推算淨利與 EPS。只用季度開始時就有的資訊，是事前的預測。`,
      equations: [`營收_t = 營收財測中值 ×（1 ${term(bR, 2)}%）`, `毛利率_t = 毛利率財測中值 ${term(bG, 2)}`, `營業費用_t = 營業費用財測 ×（1 ${term(bO, 2)}%）`, '淨利、EPS 同其他模型'],
      metrics: mt('guidance-bias'), selected: false,
      note: `不參與模型選擇：它只能預測公司已給財測的下一季，無法延伸到 FY2028。測試期在只用季初資訊的事前方法中，它的營收、毛利率${bestExAnte('eps') === 'guidance-bias' ? '與 EPS ' : ''}誤差最小（營收 MAPE ${pct(B.revenue!.mape!, 2)}、毛利率 MAE ${num(B.grossMargin!.mae, 2)} 個百分點、EPS MAPE ${pct(B.eps!.mape!, 1)}；毛利率與財測本身（${num(G.grossMargin!.mae, 2)} 個百分點）幾乎相同）；代入當季實際資本支出與提列的兩個結構模型 EPS 誤差較小（${pct(S.eps!.mape!, 1)}、${pct(R2.eps!.mape!, 1)}），但那是條件式回測，不能直接比較。本站 ${qText(NEXT)}的預測也以財測加上歷史偏差為準：偏差改用 FY2017 第一季至 ${qText(LAST)}全部 ${allQ.length} 季的分布，三個情境分別取第 10、50、90 百分位。營收偏差和同季雲端業者資本支出成長沒有關係（斜率 ${num(regBeat.coef[1]!, 3)}，標準誤 ${num(regBeat.se[1]!, 3)}）。`,
    },
    {
      id: 'capex-regression', name: '雲端資本支出成長迴歸',
      description: '用迴歸估計兩個關係：資料中心營收的季成長率和五大雲端業者（微軟、Alphabet、亞馬遜、Meta、甲骨文）資本支出季成長率的關係；核心毛利率（扣除存貨與採購承諾提列前）和資料中心營收比重的關係（資料中心產品毛利率較高）。邊緣運算營收依季節性推算。',
      equations: [
        `log（資料中心營收_t ÷ 資料中心營收_t−1）= ${num(reg.coef[0]!, 3)} ${term(reg.coef[1]!, 3)} × log（資本支出_t ÷ 資本支出_t−1）`,
        edgeEq,
        `毛利率_t = ${num(mix.coef[0]!, 2)} ${term(mix.coef[1]!, 3)} × 資料中心營收比重_t（%）− 當季提列率_t`,
        ...chainEq,
      ],
      metrics: R2, selected: false,
      note: `${regNote}毛利率對資料中心比重的斜率 ${num(mix.coef[1]!, 3)}（標準誤 ${num(mix.se[1]!, 3)}，t 值 ${num(mix.t[1]!, 1)}，${span('FY2017Q1', TRAIN_TO)}共 ${mix.n} 季）在統計上顯著；資料中心比重 FY2025 以後已在 ${rng(qRange('FY2025Q1', LAST).map((p) => dcShare(row(p))))} 之間，所以測試期的毛利率預測幾乎是固定的核心毛利率減去當季提列，一季前的毛利率誤差（${num(R2.grossMargin!.mae, 2)} 個百分點）比選定模型小。回測代入當季實際的資本支出與提列。連續推估（從 ${qText(TRAIN_TO)}出發、不用新財報）的營收 MAPE ${pct(R2.revenueDynamic!.mape!, 2)}、資料中心營收平均誤差 ${pct(mean(dyn['capex-regression']!.dcErr), 1)}，比選定模型大。訓練期（${span(CAPEX_TRAIN_FROM, TRAIN_TO)}）營收 MAPE ${pct(R2.revenueTrain!.mape!, 1)}。營業費用與獲利的規則同選定模型。`,
    },
    {
      id: 'capex-share', name: '雲端資本支出比例模型',
      description: `把輝達的資料中心營收看成五大雲端業者資本支出的一個比例：過去四季資料中心營收合計 ÷ 同期資本支出合計（FY2025 以來約 ${rng(ratio4)}），乘上當季的資本支出；五大雲端業者只占資料中心營收約一半（tr-fy2026q4），所以這個比例也假設 AI 雲、產業與企業客戶（ACIE）跟著同一波投資成長。毛利率從上一季「扣除存貨與採購承諾提列前」的核心毛利率出發，再減去當季的提列。邊緣運算營收依季節性推算。`,
      equations: [
        '比例_t = Σ（資料中心營收_t−1…t−4）÷ Σ（資本支出_t−1…t−4）（每 13 週）',
        '資料中心營收_t = 比例_t × 五大雲端業者資本支出_t（同一日曆季，約早一個月）',
        edgeEq,
        '核心毛利率 = 毛利率 + 存貨與採購承諾提列 ÷ 營收；毛利率_t = 核心毛利率_t−1 − 提列_t ÷ 營收_t',
        ...chainEq,
      ],
      metrics: S, selected: true,
      note: `一季前的回測代入當季實際的雲端業者資本支出（雲端業者的季報在輝達財報之前公布）與當季提列（輝達財報時才公布），是條件式回測：營收 MAPE ${pct(S.revenue!.mape!, 2)}、毛利率 MAE ${num(S.grossMargin!.mae, 2)} 個百分點。營收不如延續上一季成長的天真模型（${pct(NM.revenue!.mape!, 2)}）與輝達財測（${pct(G.revenue!.mape!, 2)}），而且代入實際的資本支出並沒有比事前版本準（${pct(E.revenue!.mape!, 2)}）；毛利率比財測（${num(G.grossMargin!.mae, 2)} 個百分點）準，是因為已知 ${qText(H20Q)}的 H20 費用（不計這一季，本模型 ${num(gmMaeWithout(selected, H20Q), 2)}、財測 ${num(gmMaeWithout('guidance', H20Q), 2)} 個百分點）。這個模型的用途是多季推估：比例固定在 ${qText(TRAIN_TO)}為止的四季值（${pct(c0 * 100, 1)}）、往後 ${test.length} 季不用新財報、只代入實際資本支出與提列時（連續推估），資料中心營收的平均誤差 ${pct(mean(dynDcErr), 1)}、總營收 MAPE ${pct(S.revenueDynamic!.mape!, 2)}、毛利率 MAE ${num(S.grossMarginDynamic!.mae, 2)} 個百分點，FY2028 的推估就是這樣做的。比例用四季合計，是配合年度推估的口徑，不是由回測選出來的：改用上一季單季比例時，一季前的營收 MAPE 在訓練期較小（${pct(altLastTr.mape!, 1)}，四季合計 ${pct(S.revenueTrain!.mape!, 1)}），在測試期較大（${pct(altLast.mape!, 2)}）。訓練期誤差大，主要在 FY2024：生成式 AI 需求爆發，比例由約 10% 升到 40% 以上。毛利率若不扣當季提列（只用上一季核心毛利率）MAE 為 ${num(gmNoProv.mae, 2)}；若只用存貨跌價（XBRL，不含採購承諾）為 ${num(gmWdOnly.mae, 2)} 個百分點。選擇規則：在能延伸到 FY2028、不依賴財測的兩個結構模型中，取兩種回測（一季前、連續推估）「營收 MAPE（%）＋ 毛利率 MAE（個百分點）」的平均最小者，差距在 ${TIE} 以內取估計參數較少者：本模型 ${num(score(selected), 2)}（一季前 ${num(score1(selected), 2)}、連續 ${num(scoreD(selected), 2)}）、資本支出成長迴歸 ${num(score(runnerUp), 2)}（${num(score1(runnerUp), 2)}、${num(scoreD(runnerUp), 2)}）。只看一季前，迴歸${score1(runnerUp) < score1(selected) ? '略好' : '略差'}（毛利率較準），差距 ${num(Math.abs(score1(runnerUp) - score1(selected)), 2)}${pickBy(score1) === selected ? `，在 ${TIE} 以內，依同一規則仍選估計參數較少的本模型` : '，只看一季前會選迴歸'}；不計 ${qText(H20Q)}時為 ${num(score1Without(selected, H20Q), 2)} 與 ${num(score1Without(runnerUp, H20Q), 2)}。只看連續推估${pickBy(scoreD) === selected ? '也選本模型' : '會選迴歸'}，${pickBy(score1) === selected && pickBy(scoreD) === selected ? '所以選擇不隨兩種回測的權重改變，但本模型在一季前並沒有比較準' : '選擇主要由連續推估決定'}。一季前逐季誤差差距的配對 t 值：營收 ${num(tRev(selected, runnerUp), 2)}（${winsRev(selected, runnerUp)}／${test.length} 季較準）、毛利率 ${num(tGm(selected, runnerUp), 2)}，自由度 ${test.length - 1} 的 5% 臨界值為 ${num(TC, 2)}，${Math.abs(tGm(selected, runnerUp)) < TC && Math.abs(tRev(selected, runnerUp)) < TC ? `都不顯著；只有 ${test.length} 季，排名只能當作參考` : `部分差距顯著，但只有 ${test.length} 季`}。${chainNote}`,
    },
    {
      id: 'capex-share-ex-ante', name: '雲端資本支出比例模型（事前版本）',
      description: '與選定模型相同，但只用上一季財報公布時就知道的資訊：當季的雲端業者資本支出改用上一個日曆季的實際值乘上過去一年的平均季成長，當季提列改用最近四季提列率的中位數。用來和輝達財測做事前比較。',
      equations: ['資本支出_t（事前）= 資本支出_t−1 ×（資本支出_t−1 ÷ 資本支出_t−5）^(1/4)', '毛利率_t = 核心毛利率_t−1 − 最近四季提列率中位數', '其餘同「雲端資本支出比例模型」'],
      metrics: E, selected: false,
      note: `不參與模型選擇。測試期營收 MAPE ${pct(E.revenue!.mape!, 2)}、毛利率 MAE ${num(E.grossMargin!.mae, 2)} 個百分點，輝達財測為 ${pct(G.revenue!.mape!, 2)}、${num(G.grossMargin!.mae, 2)}，財測加歷史偏差為 ${pct(B.revenue!.mape!, 2)}、${num(B.grossMargin!.mae, 2)}；營收有 ${test.filter((p) => ape('capex-share-ex-ante', p) < Math.abs(row(p).guide!.R / row(p).R - 1) * 100).length}／${test.length} 季比財測中值準（配對 t 值 ${num(pairedT(test.map((p) => ape('capex-share-ex-ante', p) - Math.abs(row(p).guide!.R / row(p).R - 1) * 100)), 2)}）。毛利率誤差最大的是 ${qText(nTop('capex-share-ex-ante'))}（事前不知道 H20 費用，下一季又不知道費用不再發生）。同樣在季初做預測，本模型沒有比公司財測準。`,
    },
  ];

  /* ── backtest rows ── */
  const backtest: ModelOutput['backtest'] = [];
  for (const id of ['capex-share', 'capex-share-ex-ante', 'capex-regression', 'guidance-bias', 'naive-momentum', 'naive', 'guidance']) {
    for (const m of METRICS) for (const p of test) {
      const x = preds[id]?.get(p)?.[field[m]];
      if (x === undefined) continue;
      const a = row(p);
      const g = a.guide!;
      const bench = m === 'revenue' ? g.R : m === 'grossMargin' ? g.gm : m === 'operatingIncome' ? (g.R * g.gm) / 100 - g.opex : undefined;
      const d = m === 'grossMargin' || m === 'eps' ? 2 : 0;
      backtest.push({
        period: p, metric: m, actual: round(actualOf(a, m), d), predicted: round(x, d), candidate: id,
        ...(bench !== undefined && id !== 'guidance' ? { benchmark: round(bench, d), benchmarkLabel: '輝達財測中值' } : {}),
      });
    }
  }

  /* ── derived series ── */
  type St = 'estimate' | 'forecast' | 'actual';
  const derived: ModelOutput['derived'] = [];
  const kPs = qRange('FY2018Q3', LAST);
  derived.push({
    id: 'capture-ratio-quarter', name: '資料中心營收占五大雲端業者資本支出的比例（單季）', unit: '%',
    points: kPs.map((p) => ({ period: p, value: round((n13(row(p).dc, row(p)) / row(p).K!) * 100, 1), status: 'estimate' as St })),
    note: `輝達當季資料中心營收（每 13 週）÷ 對應日曆季的五大雲端業者資本支出（XBRL 現金購置不動產與設備，不含融資租賃；sec-xbrl-hyperscalers）。資本支出還包括土地、建築、電力與其他廠商的設備，所以這是「比例」而不是市占率。FY2024 生成式 AI 需求爆發時由約 10% 升到 40% 以上，FY2025 以來單季在 ${rng(ratioQ)} 之間。`,
  });
  derived.push({
    id: 'capture-ratio-4q', name: '資料中心營收占雲端業者資本支出的比例（四季合計，模型用）', unit: '%',
    points: [
      ...qRange('FY2019Q2', LAST).map((p) => ({ period: p, value: round(captureRatio(by, addQ(p, 1))! * 100, 1), status: 'estimate' as St })),
      ...FY28.map((p) => ({ period: p, value: round(base.c28 * 100, 1), status: 'forecast' as St })),
    ],
    note: `截至該季的四季資料中心營收合計 ÷ 同期資本支出合計；選定模型用上一季的值乘上當季資本支出。會計年度合計：FY2025 ${pct(annualRatio(2025), 1)}、FY2026 ${pct(annualRatio(2026), 1)}。FY2028 為基準情境（固定在 ${qText(LAST)}的 ${pct(cLast * 100, 1)}）。`,
  });
  derived.push({
    id: 'hyperscaler-capex-path', name: '五大雲端業者資本支出（日曆季；2026 年第四季起為基準情境）', unit: '百萬美元',
    points: [
      ...drivers.series.find((s) => s.id === 'hyperscaler-capex-total')!.points.filter((x) => x.period >= '2023Q1').map((x) => ({ period: x.period, value: x.value, status: 'actual' as St })),
      { period: '2026Q4', value: round(base.Kq4, 0), status: 'forecast' as St },
      ...[1, 2, 3, 4].map((n) => ({ period: `2027Q${n}`, value: round(base.Kq4 * (1 + base.g) ** n, 0), status: 'forecast' as St })),
    ],
    note: `2026 年第三季以前為五家公司 XBRL 資本支出合計（sec-xbrl-hyperscalers）。2026 年第四季為模型反推：基準情境的 ${qText(NEXT)}資料中心營收（換算 13 週）÷ 比例 ${pct(cLast * 100, 1)}，2026 全年因此約 ${usdYi(base.K26)}，與輝達財務長引述的前五大雲端業者 2026 年資本支出「接近 8,000 億美元」相近（tr-fy2027q2，口徑可能不同）。2027 年各季以固定季成長 ${pct(base.g * 100, 1)} 使全年較 2026 年成長 ${pct(base.G, 1)}（財務長引述的前五大雲端業者預期由接近 8,000 億增至 1.3 兆美元）。`,
  });
  derived.push({
    id: 'dc-revenue', name: '資料中心營收（FY2027 第四季起為基準情境）', unit: '百萬美元',
    points: [...qRange('FY2023Q1', LAST).map((p) => ({ period: p, value: row(p).dc, status: 'actual' as St })), ...base.rows.map((r) => ({ period: r.period, value: round(r.dc, 0), status: 'forecast' as St }))],
    note: `實際值取自市場平台營收（rev-fy2027q3 等）；兩套市場平台分類的資料中心營收相同。${qText(NEXT)}為營收預測減邊緣運算營收（季節性推算，含多出的一週），FY2028 為比例 × 雲端業者資本支出。`,
  });
  derived.push({
    id: 'edge-revenue', name: '邊緣運算（非資料中心）營收', unit: '百萬美元',
    points: [...qRange('FY2023Q1', LAST).map((p) => ({ period: p, value: row(p).edge, status: 'actual' as St })), ...base.rows.map((r) => ({ period: r.period, value: round(r.edge, 0), status: 'forecast' as St }))],
    note: `營收減資料中心營收：FY2026 以前等於遊戲、專業視覺化、車用與 OEM 及其他的合計，FY2025 起也等於公司新分類的「邊緣運算」（rev-fy2027q3）。FY2028 基準情境全年（52 週）較 FY2027（扣除多出的一週）年增 ${baseSc.edgeG}%，各季依歷史季節性分配。`,
  });
  derived.push({
    id: 'hyperscale-share-of-dc', name: '超大規模雲端客戶占資料中心營收', unit: '%',
    points: qRange('FY2025Q1', LAST).filter((p) => row(p).hyper !== undefined).map((p) => ({ period: p, value: round((row(p).hyper! / row(p).dc) * 100, 1), status: 'estimate' as St })),
    note: '資料中心－超大規模營收 ÷ 資料中心營收（FY2027 新分類，FY2025 起重編；rev-fy2027q3）；其餘為 ACIE（AI 雲、產業與企業）。比例固定的假設等於假設 ACIE 也跟著雲端業者的投資成長。',
  });
  const provPs = qRange('FY2023Q2', LAST);
  derived.push({
    id: 'provision-rate', name: '存貨與採購承諾提列占營收', unit: '%',
    points: provPs.filter((p) => row(p).provKind !== 'none').map((p) => ({ period: p, value: round(provRate(row(p)), 2), status: 'estimate' as St })),
    note: '10-Q 揭露的「存貨與超額採購承諾提列」÷ 營收；沒有揭露總額的季度（多為第四季與 FY2027 第三季）改用 XBRL 的存貨跌價（不含採購承諾，偏低），FY2023 第四季兩者都沒有，空白。FY2026 第一季的 12% 來自 H20 出口管制。',
  });
  derived.push({
    id: 'gm-core', name: '核心毛利率（扣除存貨與採購承諾提列前）', unit: '%',
    points: [
      ...provPs.filter((p) => row(p).provKind !== 'none').map((p) => ({ period: p, value: round(coreGm(row(p)), 2), status: 'estimate' as St })),
      ...base.rows.map((r) => ({ period: r.period, value: round(r.gm + provMed, 2), status: 'forecast' as St })),
    ],
    note: `毛利率 + 提列率。${qText(NEXT)}起為基準情境的毛利率加上最近四季提列率的中位數 ${num(provMed, 2)}%；${qText(NEXT)}比第三季低約 ${fmtN(coreGm(last) - (base.rows[0]!.gm + provMed), 1)} 個百分點，財務長說明記憶體價格漲幅超出預期，毛利率在第四季觸底（tr-fy2027q2）。`,
  });
  {
    const bp: { period: string; value: number; status: St }[] = [];
    const bc: { period: string; value: number; status: St }[] = [];
    for (const p of qRange('FY2024Q2', LAST)) {
      const a = row(p); const q = prev(p);
      if (a.provKind === 'none' || q.provKind === 'none') continue;
      bp.push({ period: p, value: round(-(provRate(a) - provRate(q)), 2), status: 'estimate' });
      bc.push({ period: p, value: round(coreGm(a) - coreGm(q), 2), status: 'estimate' });
    }
    let pc = coreGm(last); let pr = provRate(last);
    for (const r of base.rows) { const core = r.gm + provMed; bp.push({ period: r.period, value: round(-(provMed - pr), 2), status: 'forecast' }); bc.push({ period: r.period, value: round(core - pc, 2), status: 'forecast' }); pc = core; pr = provMed; }
    const common = '每季毛利率的變化拆成兩項，相加等於毛利率的季變化（個百分點）：提列的變化（提列減少時為正）與核心毛利率的變化（產品轉換與良率、記憶體等投入成本、售價與組合）。FY2027 第四季起為基準情境。';
    derived.push({ id: 'gm-bridge-provisions', name: '毛利率變動：存貨與採購承諾提列', unit: '個百分點', points: bp, note: `${common}FY2026 第一季 H20 費用使毛利率減少約 10 個百分點，下一季提列回到正常水準又加回來。` });
    derived.push({ id: 'gm-bridge-core', name: '毛利率變動：核心毛利率（產品轉換、記憶體成本、售價與組合）', unit: '個百分點', points: bc, note: `${common}FY2026 第三季毛利率年減，公司說明反映由 Hopper HGX 轉為 Blackwell 整櫃方案（cfo-fy2026q3）；FY2027 第四季的下降，財務長說明主因是記憶體漲價（tr-fy2027q2）。` });
  }
  const hbmS = prices.series.find((s) => s.id === 'dram-incl-hbm-contract-qoq');
  if (!hbmS) throw new Error('market-prices: dram-incl-hbm-contract-qoq missing');
  const hbmIdx = chainIndex(seriesOf(hbmS.points), '2024Q2', 100);
  const hbmStatus = new Map(hbmS.points.map((x) => [x.period, x.status]));
  derived.push({
    id: 'hbm-blended-price-index', name: 'DRAM 合約價指數（一般型與 HBM 混合，日曆季）', unit: '指數（2024 年第二季 = 100）',
    points: [...hbmIdx.entries()].filter(([p]) => p !== '2024Q2').map(([p, v]) => ({ period: p, value: round(v, 0), status: (hbmStatus.get(p) === 'forecast' ? 'forecast' : 'estimate') as St })),
    note: `由 TrendForce「HBM Blended」季變化（記憶體專題的價格資料，區間取中值）串成的指數；2026 年第四季為 TrendForce 9 月的預測（tf-20260930-13258）。HBM 多為年度議價，輝達也簽有多年期記憶體採購承諾（pr-fy2027q3），實際採購成本可能落後合約價；TrendForce 預估 2027 年 HBM 混合平均售價年增 121%（tf-20260929-13255）。訓練期檢定過一般型 DRAM 合約價對輝達毛利率季變化的影響：每漲 1%，毛利率變化 ${num(dramReg.coef[1]!, 3)} 個百分點（標準誤 ${num(dramReg.se[1]!, 3)}），不顯著，所以模型沒有用記憶體價格估計毛利率。`,
  });
  derived.push({
    id: 'guidance-beat-revenue', name: '營收相對財測中值', unit: '%',
    points: allQ.map((p) => ({ period: p, value: round(beatR(row(p)), 2), status: 'estimate' as St })),
    note: `（實際營收 ÷ 上一季新聞稿的營收財測中值 − 1）× 100；正值代表實際高於財測。FY2017 以來 ${allQ.length} 季中只有 ${belowR.length} 季低於財測：${belowR.map((p) => `${qText(p)}（${signed(beatR(row(p)), 1)}）`).join('、')}；FY2019 第四季與 FY2023 第二季公司在季末前就預告營收低於財測（sec-8k-20190128、sec-8k-20220808）。`,
  });
  derived.push({
    id: 'guidance-beat-gross-margin', name: '毛利率相對財測中值', unit: '個百分點',
    points: allQ.map((p) => ({ period: p, value: round(beatG(row(p)), 2), status: 'estimate' as St })),
    note: `實際 GAAP 毛利率 − 上一季新聞稿的 GAAP 毛利率財測中值；正值代表實際高於財測。低於財測 2 個百分點以上的季度：${belowG.map((p) => `${qText(p)}（${pp(beatG(row(p)), 1)}）`).join('、')}；其中 FY2019 第四季、FY2023 第二季與 FY2026 第一季的存貨或出口管制費用見大事記。`,
  });
  derived.push({
    id: 'supply-commitment-cover', name: '供應與產能承諾相當於幾季營收', unit: '季',
    points: allQ.filter((p) => row(p).supply !== undefined).map((p) => ({ period: p, value: round(row(p).supply! / row(p).R, 2), status: 'estimate' as St })),
    note: '期末尚未履行的存貨採購與供應、產能承諾 ÷ 當季營收（FY2022 第一季以前只有存貨採購義務，之後加入長期供應與產能義務；不含雲端服務合約與投資承諾；FY2026 第二季公司只揭露含非存貨義務的總額，沒有可比數字）。FY2027 第二季起大增，公司說明主要是多年期記憶體採購（tr-fy2027q2、pr-fy2027q3）；承諾越大，需求轉弱時的存貨與採購承諾提列風險也越大。',
  });

  /* ── parameters ── */
  const seasNames = ['第一季', '第二季', '第三季', '第四季'];
  const parameters: ModelOutput['parameters'] = [
    { name: `${NEXT} 財測：營收中值`, value: gRev.value, unit: '百萬美元', note: `${usdYi(gRev.value, 0)} ± 3%，即 ${num(gRev.low! / 100, 0)}–${usdYi(gRev.high!, 0)}（pr-fy2027q3）；本季多一週（14 週），財測不含中國資料中心運算營收。` },
    { name: `${NEXT} 財測：毛利率中值`, value: gGm.value, unit: '%', note: `GAAP 與非 GAAP 毛利率都是 ${num(gGm.low!, 1)}–${num(gGm.high!, 1)}%（pr-fy2027q3）；財務長 8 月表示記憶體價格漲幅超出預期，毛利率在第四季觸底（tr-fy2027q2）。` },
    { name: `${NEXT} 財測：營業費用`, value: Q4_OPEX_GUIDE, unit: '百萬美元', note: 'GAAP 營業費用約 110 億美元（含多出的一週；pr-fy2027q3）。' },
    { name: '有效稅率（預測期）', value: round(TAX * 100, 1), unit: '%', note: `公司預估 FY2027 全年 GAAP 稅率 ${TAX_FY2027.low}–${TAX_FY2027.high}%（pr-fy2027q3），取中值；FY2027 前三季實際為 ${pct((sum(ytd.map((_, i) => row(qRange('FY2027Q1', LAST)[i]!).tax)) / sum(qRange('FY2027Q1', LAST).map((p) => row(p).pretax))) * 100, 2)}。FY2028 沿用（公司尚未給 FY2028 稅率）。` },
    { name: '資料中心營收占雲端業者資本支出的比例（最近四季）', value: round(cLast * 100, 2), unit: '%', note: `FY2026 第四季至 FY2027 第三季資料中心營收 ${usdYi(sum(qRange('FY2026Q4', LAST).map((p) => row(p).dc)))} ÷ 2025 年第四季至 2026 年第三季五大雲端業者資本支出 ${usdYi(sum(['2025Q4', '2026Q1', '2026Q2', '2026Q3'].map((c) => drivers.series.find((s) => s.id === 'hyperscaler-capex-total')!.points.find((x) => x.period === c)!.value)))}（sec-xbrl-hyperscalers）。會計年度：FY2025 ${pct(annualRatio(2025), 1)}、FY2026 ${pct(annualRatio(2026), 1)}；回測期第一季用的值（${qText(TRAIN_TO)}為止的四季）為 ${pct(c0 * 100, 1)}。這是計算值，不是迴歸估計。` },
    { name: '資料中心營收季成長對資本支出季成長的斜率', value: round(reg.coef[1]!, 3), note: `${span(regFrom, TRAIN_TO)}共 ${reg.n} 季估計，標準誤 ${num(reg.se[1]!, 3)}、t 值 ${num(reg.t[1]!, 2)}，與 0 沒有顯著差異；截距 ${signed(reg.coef[0]! * 100, 1)}／季（對數，標準誤 ${num(reg.se[0]! * 100, 1)}%）。選定模型因此不用季成長的關係，而用四季合計的比例。` },
    { name: '核心毛利率對資料中心營收比重的斜率', value: round(mix.coef[1]!, 3), unit: '個百分點／個百分點', note: `FY2017 第一季至 ${qText(TRAIN_TO)}共 ${mix.n} 季，標準誤 ${num(mix.se[1]!, 3)}（t 值 ${num(mix.t[1]!, 1)}）；截距 ${num(mix.coef[0]!, 2)}%。資料中心比重每高 10 個百分點，核心毛利率約高 ${fmtN(mix.coef[1]! * 10, 1)} 個百分點（資本支出成長迴歸用）。` },
    { name: 'DRAM 合約價季變化對毛利率季變化的影響（檢定，未採用）', value: round(dramReg.coef[1]!, 3), unit: '個百分點／1%', note: `TrendForce 一般型 DRAM 合約價季變化（同一日曆季，記憶體專題的價格資料），${dramReg.n} 季，標準誤 ${num(dramReg.se[1]!, 3)}；上一季合約價的係數 ${num(dramReg.coef[2]!, 3)}（標準誤 ${num(dramReg.se[2]!, 3)}）。都不顯著：歷史上記憶體合約價的季變化沒有直接反映在輝達的毛利率。` },
    ...seasNames.map((nm, i) => ({ name: `邊緣運算營收季節性：${nm}`, value: round((Math.exp(seasFull.f[i]!) - 1) * 100, 1), unit: '%', note: `${nm}相對上一季的平均變化（每 13 週，含平均成長），全期 ${span(TRAIN_FROM, LAST)}共 ${seasFull.n[i]} 個樣本，對數平均的標準誤 ${num(seasFull.se[i]! * 100, 1)}%；訓練期為 ${signed((Math.exp(seasTr.f[i]!) - 1) * 100, 1)}。FY2028 扣除平均成長 ${signed((Math.exp(seasFull.trend) - 1) * 100, 1)}／季後只取季節性，成長改用情境假設。` })),
    { name: '營業費用對營收的彈性 ε', value: round(opexFull.e1, 3), note: `全期 ${span(TRAIN_FROM, LAST)}估計（FY2023 第一季扣除 13.53 億美元的 Arm 收購終止費用；未扣除時 ε 為 ${num(opexFullRaw.coef[1]!, 3)}、迴歸殘差的標準差大 ${pct((Math.sqrt(opexFullRaw.s2 / opexFullS2) - 1) * 100, 0)}），標準誤 ${num(opexFull.se1, 3)}；另有每季 ${signed(opexFull.e0 * 100, 2)} 的趨勢（標準誤 ${num(opexFull.se0 * 100, 2)}%）。訓練期為 ε = ${num(opexTr.e1, 3)}（標準誤 ${num(opexTr.se1, 3)}）${Math.abs(opexTr.e1 / opexTr.se1) < tCrit(opexTr.n - 2) ? '，與 0 沒有顯著差異，營業費用主要跟著趨勢成長' : ''}。` },
    { name: '財測偏差：營收（訓練期中位數）', value: round(bR, 2), unit: '%', note: `FY2017 第一季至 ${qText(TRAIN_TO)}共 ${trG.length} 季；全部 ${allQ.length} 季的第 10、50、90 百分位為 ${signed(percentile(revBeats, 0.1), 2)}、${signed(percentile(revBeats, 0.5), 2)}、${signed(percentile(revBeats, 0.9), 2)}（${qText(NEXT)}三個情境用）。` },
    { name: '財測偏差：毛利率（訓練期中位數）', value: round(bG, 2), unit: '個百分點', note: `全部 ${allQ.length} 季的第 10、50、90 百分位為 ${pp(percentile(gmBeats, 0.1), 2)}、${pp(percentile(gmBeats, 0.5), 2)}、${pp(percentile(gmBeats, 0.9), 2)}。` },
    { name: '財測偏差：營業費用（訓練期中位數）', value: round(bO, 2), unit: '%', note: `全部 ${allQ.length} 季的中位數 ${signed(bOFull, 2)}（${qText(NEXT)}用）；測試期 ${test.length} 季平均 ${signed(mean(test.map((p) => beatO(row(p)))), 1)}。` },
    { name: '提列率（預測期）', value: round(provMed, 2), unit: '%', note: `${qText(addQ(LAST, -3))}至 ${qText(LAST)}的中位數，只用於核心毛利率的推算序列；預測的毛利率本身已含正常水準的提列。` },
    { name: '2026 年第四季雲端業者資本支出（基準情境反推）', value: round(base.Kq4, 0), unit: '百萬美元', note: `${qText(NEXT)}資料中心營收（換算 13 週）÷ 比例；加上 2026 年前三季實際 ${usdYi(k26ytd)}，全年約 ${usdYi(base.K26)}（輝達引述的前五大雲端業者 2026 年預期接近 8,000 億美元，tr-fy2027q2）。保守、樂觀情境分別為 ${usdYi(fc.bear.Kq4)}、${usdYi(fc.bull.Kq4)}。` },
    { name: '2027 年雲端業者資本支出的季成長（基準情境）', value: round(base.g * 100, 2), unit: '%／季', note: `使 2027 年全年較 2026 年成長 ${pct(base.G, 1)} 的固定季成長；保守 ${pct(fc.bear.g * 100, 1)}、樂觀 ${pct(fc.bull.g * 100, 1)}。` },
    { name: 'FY2028 營收年增率（基準情境）', value: round(g28(base), 1), unit: '%', note: `扣除 FY2027 多出的一週後為 ${pct(g28w(base), 1)}。財務長在 2026-08-26 初步預期 FY2028 營收年增約 70%，屬供給受限的展望（tr-fy2027q2）；本模型基準情境較低，因為假設比例不變、資本支出成長採財務長引述的預期。` },
  ];

  /* ── scenarios ── */
  const scenarios: ModelOutput['scenarios'] = SCENARIOS.map((sc) => {
    const f = fc[sc.id];
    const q4 = f.rows[0]!;
    const a27 = y27(f);
    const a28 = y28(f);
    const dc28 = sum(f.rows.slice(1).map((r) => r.dc));
    const dc27 = sum(ytd.map((r) => r.dc)) + q4.dc;
    const dcG = (dc28 / (dc27 - q4.dc / 14) - 1) * 100;
    const assumptions: ModelOutput['scenarios'][number]['assumptions'] = [
      { name: `${qText(NEXT)}營收`, value: `${usdYi(q4.R, 0)}：財測中值 ${usdYi(gRev.value)}（± 3%，14 週，不含中國資料中心運算營收）×（1 ${term(percentile(revBeats, sc.pct), 2)}%），後者為 FY2017 第一季以來 ${allQ.length} 季實際營收相對財測中值的第 ${num(sc.pct * 100, 0)} 百分位`, src: 'pr-fy2027q3' },
      { name: `${qText(NEXT)}毛利率`, value: `${pct(q4.gm, 2)}：財測中值 ${num(gGm.value, 1)}%（${num(gGm.low!, 1)}–${num(gGm.high!, 1)}%）${term(percentile(gmBeats, sc.pct), 2)} 個百分點（歷史毛利率偏差的第 ${num(sc.pct * 100, 0)} 百分位）`, src: 'pr-fy2027q3' },
      { name: `${qText(NEXT)}營業費用、業外與稅率`, value: `營業費用 ${usdYi(q4.opex, 1)}（財測約 110 億美元 ×（1 ${term(bOFull, 2)}%）歷史偏差中位數）；業外收支 ${usdYi(q4.nonop, 1)}（第三季的非 GAAP 業外收支，不假設權益證券的評價損益；cfo-fy2027q3）；有效稅率 ${num(TAX * 100, 0)}%（公司預估 FY2027 全年 ${TAX_FY2027.low}–${TAX_FY2027.high}%）`, src: 'pr-fy2027q3' },
      { name: '中國資料中心營收', value: `${qText(NEXT)}與 FY2028 都不另外加計（與財測口徑相同）；${qText(LAST)}對中國的資料中心 Hopper 出貨為 ${usdYi(chinaQ3.value)}，若第四季再出貨相同金額，見敏感度`, src: 'cfo-fy2027q3' },
      {
        name: '2027 年五大雲端業者資本支出',
        value: sc.capexG === null
          ? `年增 ${pct(f.G, 1)}：輝達財務長引述前五大雲端業者資本支出預期由 2026 年接近 8,000 億美元增至 2027 年 1.3 兆美元（tr-fy2027q2；該次未說明來源，先前兩次法說會稱這類數字為分析師預期，tr-fy2026q4、tr-fy2027q1）`
          : sc.id === 'bear'
            ? `年增 ${pct(f.G, 0)}（本模型假設，約為財務長引述的預期 ${pct(capexBase, 1)} 的一半，tr-fy2027q2）：五家公司 XBRL 資本支出 2023 年 ${signed(capexHist.y23, 0)}、2024 年 ${signed(capexHist.y24, 0)}、2025 年 ${signed(capexHist.y25, 0)}，假設 2027 年投資明顯放緩`
            : `年增 ${pct(f.G, 0)}（本模型假設）：高於財務長引述的預期 ${pct(capexBase, 1)}（tr-fy2027q2），仍低於五家公司 2026 年前三季的年增 ${pct(capex26Ytd, 0)}；Alphabet 表示 2027 年資本支出將大幅增加，但未給數字（ap-googl-20261028）`,
        src: sc.capexG === null ? 'tr-fy2027q2' : 'sec-xbrl-hyperscalers',
      },
      { name: '2026 年第四季雲端業者資本支出（模型反推）', value: `${usdYi(f.Kq4)}：${qText(NEXT)}資料中心營收（換算 13 週）÷ 比例 ${pct(cLast * 100, 1)}；2026 全年約 ${usdYi(f.K26)}，2027 年各季固定成長 ${pct(f.g * 100, 1)}／季`, src: 'sec-xbrl-hyperscalers' },
      {
        name: 'FY2028 資料中心營收占資本支出的比例',
        value: sc.captureMul === 1
          ? `${pct(f.c28 * 100, 1)}：維持最近四季的值（FY2025、FY2026 會計年度分別為 ${pct(annualRatio(2025), 1)}、${pct(annualRatio(2026), 1)}；資料中心營收取自 rev-fy2027q3）`
          : `${pct(f.c28 * 100, 1)}：較最近四季低一成（本模型假設：雲端業者自研晶片與其他供應商的比重提高，或記憶體等其他設備吃掉更多預算）`,
        src: 'sec-xbrl-hyperscalers',
      },
      { name: 'FY2028 邊緣運算營收', value: `${usdYi(sum(f.rows.slice(1).map((r) => r.edge)))}，全年（52 週）較 FY2027（扣除多出的一週，${usdYi(f.edge27w)}）年增 ${signed(sc.edgeG, 0)}（本模型假設），各季依歷史季節性分配（隱含每季 ${signed(f.xe * 100, 1)} 的成長）：FY2027 前三季年增 ${pct(edgeYtdG, 0)}（rev-fy2027q3）；TrendForce 指出 PC 品牌因成品庫存偏高，下修 2027 年初的記憶體採購（tf-20261111-13303）`, src: 'rev-fy2027q3' },
      {
        name: 'FY2028 毛利率',
        value: sc.gmAnchor === 'mid'
          ? `${pct(f.gm28, 1)}：財務長在 2026-08-26 預期毛利率在 ${qText(NEXT)}觸底，FY2028 約 ${num(gGm28.low!, 0)}–${num(gGm28.high!, 0)}%（已執行的漲價自 FY2028 第一季生效），取中值；第三季的財務長評論只更新第四季財測（cfo-fy2027q3）`
          : sc.gmAnchor === 'low'
            ? `${pct(f.gm28, 1)}：比公司 FY2028 展望下緣（${num(gGm28.low!, 0)}%，tr-fy2027q2）低 ${fmtN(-sc.gmAdd, 0)} 個百分點（本模型假設：記憶體漲價多於產品漲價；TrendForce 預估 2027 年 HBM 混合平均售價年增 121%，tf-20260929-13255）`
            : `${pct(f.gm28, 1)}：比公司 FY2028 展望上緣（${num(gGm28.high!, 0)}%，tr-fy2027q2）高 ${fmtN(sc.gmAdd, 0)} 個百分點（本模型假設：記憶體價格趨穩、漲價效果完整；仍低於 FY2027 前三季的 ${num(Math.min(...gm27ytd), 1)}–${num(Math.max(...gm27ytd), 1)}%，sec-companyfacts、pr-fy2027q3）`,
        src: sc.gmAnchor === 'low' ? 'tf-20260929-13255' : 'tr-fy2027q2',
      },
      { name: '營業費用、業外、稅率與股數', value: `FY2028 營業費用依彈性規則隨營收成長（ε = ${num(opexFull.e1, 3)}、趨勢 ${signed(opexFull.e0 * 100, 1)}／季，從第四季換算 13 週後的水準出發）；業外收支每季 ${usdYi(NONOP_Q3.nonGaap, 1)}（${qText(LAST)}的非 GAAP 業外收支，不假設權益證券的評價損益；同季 GAAP 為 ${usdYi(last.nonop, 1)}，含權益證券淨利益 ${usdYi(NONOP_Q3.equityGains, 1)}，cfo-fy2027q3）；有效稅率 ${num(TAX * 100, 0)}%；稀釋股數 ${fmtN(last.shares, 0)} 百萬股（pr-fy2027q3）`, src: 'cfo-fy2027q3' },
      { name: '隱含的營收成長與供給', value: `FY2028 營收年增 ${pct(g28(f), 1)}（扣除 FY2027 多出的一週為 ${pct(g28w(f), 1)}），資料中心營收年增約 ${pct(dcG, 0)}；財務長 8 月初步預期 FY2028 營收年增約 70%，並說供給瓶頸至少延續到 FY2028 年底（tr-fy2027q2）。高盛估台積電 CoWoS 2027 年產能年增 ${pct(cowosG, 0)}（tf-cowos-20261027，外部估計），輝達預期測試產能 2027 年倍增（nv-supply-20261021）`, src: 'tr-fy2027q2' },
    ];
    const forecasts: ModelOutput['scenarios'][number]['forecasts'] = f.rows.map((r, i) => ({
      period: r.period,
      revenue: round(r.R, 0), grossMargin: round(r.gm, 2), operatingIncome: round(r.oi, 0), netIncome: round(r.ni, 0), eps: round(r.eps, 2),
      known: [],
      note: i === 0
        ? `14 週。資料中心 ${usdYi(r.dc)}、邊緣運算 ${usdYi(r.edge)}；財測：營收 ${num(gRev.low! / 100, 0)}–${usdYi(gRev.high!)}、毛利率 ${num(gGm.low!, 1)}–${num(gGm.high!, 1)}%、營業費用約 110 億美元；本情境營業利益率 ${pct((r.oi / r.R) * 100, 1)}。`
        : `資料中心 ${usdYi(r.dc)}（比例 ${pct(f.c28 * 100, 1)} × 對應日曆季資本支出 ${usdYi(r.K!)}）、邊緣運算 ${usdYi(r.edge)}；營業利益率 ${pct((r.oi / r.R) * 100, 1)}。`,
    }));
    forecasts.push({
      period: 'FY2027', revenue: round(a27.R, 0), grossMargin: round(a27.gm, 2), operatingIncome: round(a27.oi, 0), netIncome: round(a27.ni, 0), eps: round(a27.eps, 2), known: [],
      note: `前三季實際加上第四季預測（53 週）；營收年增 ${signed((a27.R / fy26.R - 1) * 100, 1)}。`,
    });
    forecasts.push({
      period: 'FY2028', revenue: round(a28.R, 0), grossMargin: round(a28.gm, 2), operatingIncome: round(a28.oi, 0), netIncome: round(a28.ni, 0), eps: round(a28.eps, 2), known: [],
      note: `四季加總（52 週）；營收年增 ${signed(g28(f), 1)}，毛利率為全年毛利 ÷ 全年營收，EPS 為四季加總。`,
    });
    return { id: sc.id, name: sc.name, assumptions, forecasts };
  });

  /* ── summary & limitations ── */
  const q4b = base.rows[0]!;
  const bearY = y28(fc.bear);
  const bullY = y28(fc.bull);
  const summary1 = `選定模型是「雲端資本支出比例模型」：資料中心營收約等於五大雲端業者資本支出的 ${pct(cLast * 100, 0)}（最近四季），毛利率從扣除存貨提列的核心毛利率推算。${span(TEST_FROM, TEST_TO)}共 ${test.length} 季代入當季實際資本支出與提列的一季前回測，營收誤差 ${pct(S.revenue!.mape!, 1)}、毛利率 ${num(S.grossMargin!.mae, 1)} 個百分點，營收不如延續上季成長的天真模型（${pct(NM.revenue!.mape!, 1)}）與輝達財測（${pct(G.revenue!.mape!, 1)}）；改成事前預測時為 ${pct(E.revenue!.mape!, 1)}、${num(E.grossMargin!.mae, 1)} 個百分點，也不如財測；同樣只用季初資訊的方法中，最準的是財測加上歷史偏差（${pct(B.revenue!.mape!, 1)}、${num(B.grossMargin!.mae, 1)} 個百分點）。`;
  const summary2 = `基準情境 ${qText(NEXT)}營收約 ${usdYi(q4b.R)}、毛利率 ${pct(q4b.gm, 1)}；FY2028 營收約 ${usdYi(baseY28.R)}（年增 ${pct(g28(base), 0)}，扣除 FY2027 多出的一週為 ${pct(g28w(base), 0)}；財務長 8 月的初步展望約 70%）、毛利率 ${pct(baseY28.gm, 1)}、EPS ${usd(baseY28.eps)}，保守至樂觀為營收 ${num(bearY.R / 100, 0)}–${usdYi(bullY.R)}、EPS ${num(bearY.eps, 2)}–${usd(bullY.eps)}。這是依假設推算的模型結果，不是投資建議。`;
  const summary = `${summary1}${summary2}`;

  const limitations = [
    `回測代入當季實際的雲端業者資本支出與存貨提列，衡量的是「這些已知時」模型的能力；即使如此，營收誤差（${pct(S.revenue!.mape!, 1)}）仍大於延續上季成長的天真模型（${pct(NM.revenue!.mape!, 1)}）與公司財測（${pct(G.revenue!.mape!, 1)}）。事前版本營收 ${pct(E.revenue!.mape!, 1)}、毛利率 ${num(E.grossMargin!.mae, 1)} 個百分點，同樣不如財測。回測只有 ${test.length} 季：毛利率與財測的比較主要由 ${qText(H20Q)}（H20 費用）一季決定，兩個結構模型的選擇主要由連續推估決定${Math.abs(tGm(selected, runnerUp)) < TC && Math.abs(tRev(selected, runnerUp)) < TC ? "，逐季的差距在統計上都不顯著" : ""}。`,
    `「資料中心營收 ≈ 雲端業者資本支出 × 固定比例」只在 FY2025 以後穩定：FY2024 生成式 AI 需求爆發時比例由約 10% 跳到 40% 以上，逐季的資本支出成長也解釋不了資料中心營收的成長（斜率 ${num(reg.coef[1]!, 2)}，標準誤 ${num(reg.se[1]!, 2)}）。五大雲端業者只占資料中心營收約一半（tr-fy2026q4），AI 雲、產業與企業客戶（ACIE）若成長得更快或更慢，比例就會改變；雲端業者自研晶片（TPU、Trainium 等）與其他供應商的比重也會影響比例。`,
    '資本支出序列是五家公司 XBRL 的現金購置不動產與設備，不含融資租賃（微軟、Meta 自己公布的數字含融資租賃），微軟與甲骨文以會計季度對應日曆季；資本支出也包括土地、建築與電力。輝達財務長引述的「前五大雲端業者」資本支出預期（接近 8,000 億、1.3 兆美元；tr-fy2027q2 未說明來源，先前兩次法說會稱這類數字為分析師預期）口徑與本序列可能不同，所以模型只借用它的成長率。',
    `毛利率沒有用記憶體價格估計：訓練期一般型 DRAM 合約價對毛利率的影響不顯著（${num(dramReg.coef[1]!, 3)} 個百分點／1%，標準誤 ${num(dramReg.se[1]!, 3)}），HBM 混合價 2024 年下半年才有，輝達又簽有多年期記憶體採購承諾（pr-fy2027q3）。FY2028 毛利率以公司 8 月的展望（${num(gGm28.low!, 0)}–${num(gGm28.high!, 0)}%）為錨，記憶體漲價、產品漲價與 Vera Rubin 量產良率只透過情境假設反映；H20 這類一次性的存貨與採購承諾費用無法事前預測，而期末供應承諾已達 ${usdYi(last.supply!)}（約 ${num(last.supply! / last.R, 1)} 季營收）。`,
    '公司與政策事件沒有量化：2026-11-11 黃仁勳辭去總裁、執行長與董事職務，財務長 Colette Kress 代理執行長並續任財務長（sec-8k-20261111）；獨立董事委任外部律師進行調查（nv-board-20261110）；董事會新設國家安全與出口管制監督委員會（nv-natsec-20261117）。財測與本模型都不含中國資料中心運算營收，出口管制的變化（2022、2023、2025 年都曾發生）可能使營收與存貨提列大幅偏離。',
    `供給限制只作對照：公司表示 FY2028 的展望受供給限制（tr-fy2027q2），CoWoS 產能只有外部估計（tf-cowos-20261027 等）；若記憶體、載板或封裝產能不足，即使雲端業者的預算更高，營收也不會跟著成長。GAAP 業外收支以權益證券的評價損益為主（FY2027 各季在 ${num(Math.min(...qRange('FY2027Q1', LAST).map((p) => row(p).nonop)) / 100, 0)}–${usdYi(Math.max(...qRange('FY2027Q1', LAST).map((p) => row(p).nonop)))}之間），回測沿用歷史數字，預測則不假設這類損益（每季用第三季非 GAAP 業外收支 ${usdYi(NONOP_Q3.nonGaap, 1)}，cfo-fy2027q3），所以 GAAP EPS 可能因投資損益大幅偏離；稅率與股數採簡化規則；FY2027 為 53 週，年增率要扣除多出的一週再比較。第三季法說會（2026-11-17）的逐字稿在 2026-11-18 尚未公布，FY2028 的營收與毛利率展望都採 8 月法說會的說法（tr-fy2027q2）。`,
  ];

  const sourceKeys = [...new Set([
    'sec-companyfacts', 'sec-xbrl-hyperscalers', 'rev-fy2027q3', 'supp-fy2027q3', 'pres-fy2027q3',
    ...allQ.map((p) => row(p).guide!.src),
    'pr-fy2027q3', 'cfo-fy2027q3', 'cfo-fy2026q1', 'cfo-fy2026q3', 'tr-fy2026q4', 'tr-fy2027q2', 'sec-8k-20250409',
    'tf-cowos-20261027', 'nv-supply-20261021', 'ap-googl-20261028', 'tf-20260929-13255', 'tf-20260930-13258', 'tf-20261111-13303',
    'sec-8k-20261111', 'nv-board-20261110', 'nv-natsec-20261117',
  ])];
  for (const k of sourceKeys) if (!allKeys.has(k)) throw new Error(`source key ${k} not in the inputs, drivers or market-prices files`);
  for (const s of scenarios) for (const a of s.assumptions) if (a.src && !allKeys.has(a.src)) throw new Error(`scenario ${s.id}: unknown src ${a.src}`);

  return {
    company: 'nvidia',
    generatedBy: 'scripts/models/nvidia.ts',
    generatedOn: GENERATED_ON,
    asOf: inputs.asOf,
    currency: 'USD',
    amountUnit: 'million',
    periodLabel: '輝達會計季度（會計年度約為前一年 2 月至當年 1 月，FY2027 為 53 週）',
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
  const inputs = companyInputs.parse(parse(readFileSync(pick('nvidia-inputs.yaml'), 'utf8')));
  const drivers = companyDrivers.parse(parse(readFileSync(pick('nvidia-drivers.yaml'), 'utf8')));
  const pricesPath = existsSync(join(dir, 'market-prices.yaml')) ? join(dir, 'market-prices.yaml') : 'src/data/memory/forecast/market-prices.yaml';
  const prices = marketPrices.parse(parse(readFileSync(pricesPath, 'utf8')));
  const out = buildModel(inputs, prices, drivers);
  writeFileSync(resolve(dir, 'nvidia-model.json'), `${JSON.stringify(out, null, 2)}\n`);
  const sel = out.candidates.find((c) => c.selected)!;
  console.log(`nvidia-model.json written to ${dir}: selected ${sel.id}`);
  for (const c of out.candidates) console.log(`  ${c.selected ? '*' : ' '} ${c.id.padEnd(22)} rev ${c.metrics.revenue?.mape ?? '-'}%  gm ${c.metrics.grossMargin?.mae ?? '-'}pp  oi ${c.metrics.operatingIncome?.mape ?? '-'}%  eps ${c.metrics.eps?.mape ?? '-'}%`);
  for (const s of out.scenarios) console.log(`  ${s.id}: ${s.forecasts.map((f) => `${f.period} ${Math.round(f.revenue / 100)}億 ${f.grossMargin}% EPS ${f.eps}`).join(' | ')}`);
}
