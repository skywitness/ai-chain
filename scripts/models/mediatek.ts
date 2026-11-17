// 聯發科（MediaTek）財報模型：用公司財測、匯率、全球手機出貨與產品線結構推估營收、毛利率與獲利。
//   npx tsx scripts/models/mediatek.ts [--dir <資料夾>]   → 寫出 <資料夾>/mediatek-model.json（預設 src/data/forecast）
// buildModel(inputs, prices, drivers) 是純函式（不讀檔、不取時間），scripts/check-forecast.ts 會重跑並比對輸出。
//
// 口徑：日曆季度、新台幣百萬元；毛利率為財報毛利率；淨利為歸屬母公司；EPS 為基本每股盈餘。
// 匯率一律用聯準會 H.10 的季平均（2016 年起完整，且有 2026Q4 季初至今的平均）；公司簡報的平均匯率差距多在 0.05 元以內。
// 回測：參數只用 2024Q4（含）以前的資料估計，2025Q1–2026Q3 逐季預測下一季。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { companyDrivers, companyInputs, marketPrices, type CompanyDrivers, type CompanyInputs, type MarketPrices, type ModelOutput } from '../../src/schemas/forecast';
import { addQ, chainIndex, mean, metrics, ols, qRange, round, seriesOf, sum, type Pair } from './lib';
import { bridge, driver, months, pnl, quantile, quarterTable, segUsd, slope0, usdOf, type Below, type MQ, type Pnl, type Seg } from './mediatek-lib';

const GENERATED_ON = '2026-11-17';
const TRAIN_FROM = '2016Q1';
const TRAIN_TO = '2024Q4';
const TEST_FROM = '2025Q1';
const TEST_TO = '2026Q3';
const NEXT = '2026Q4';
const Y2027 = ['2027Q1', '2027Q2', '2027Q3', '2027Q4'];
const SEG_FROM = '2021Q2'; // 產品線占比 2021Q1 起才有，季變化自 2021Q2
const RPU_FROM = '2021Q4'; // IDC 季出貨 2021Q3 起才有，每支手機營收的季變化自 2021Q4
const ELIGIBLE = ['guidance-adjusted', 'segment', 'segment-mix'];
const Q_LOW = 0.1; // 第 4 季情境區間：訓練期財測誤差的第 10／90 百分位
const Q_HIGH = 0.9;

/* ───────────── outside assumptions (sources in mediatek-inputs.yaml / -drivers.yaml / market-prices.yaml) ───────────── */

const IDC_2026_YOY = -16.7; // idc-2026-08：IDC 2026-08-26 預測 2026 年全球手機出貨年減 16.7%
const GM_FX_RULE = 0.2; // ir-2q25-call：新台幣每升值 1%，毛利率約減少 0.2 個百分點（預測期採用；回測只用訓練期估計）
const GM_FX_BASE = ['2026Q1', '2026Q2', '2026Q3']; // 非 ASIC 毛利率的基準：2026 年前三季
// 2026Q4 的聯準會 H.10 營業日：10/1–11/13 已有 30 日（fed-h10-tw，見 usd-ntd-avg-fed 的 2026Q4 註記），
// 11/16–12/31 尚有 32 日（扣除感恩節 11/26 與聖誕節 12/25）。保守情境只讓尚未發生的營業日回到財測匯率。
const FX_DAYS_KNOWN = 30;
const FX_DAYS_LEFT = 32;

interface Scenario {
  id: 'bear' | 'base' | 'bull';
  name: string;
  units: 'q4-implied' | 'q3-level' | 'flat-2026'; // 2027 年每季手機出貨水準
  rpu: number; // 每支全球手機帶給聯發科的營收（美元）2027 年年變化（%）
  edge: number; // 智慧邊緣平台（不含資料中心 ASIC）年增率（%）
  asic: number; // 2027 年資料中心 ASIC 營收（百萬美元）
  asicGm: 'low' | 'mid' | 'beat'; // ASIC 毛利率：由第四季財測的下緣、中值，或中值加上歷史上毛利率高於財測的平均幅度推算
  coreGm: number; // 非 ASIC 毛利率相對基準的調整（個百分點）
  fx: 'guidance' | 'qtd'; // 2026Q4 與 2027 年匯率：第四季財測假設，或 2026Q4 季初至今平均
  resid: 'low' | 'mid' | 'high'; // 2026Q4：財測誤差分位數
}
const SCENARIOS: Scenario[] = [
  { id: 'bear', name: '保守', units: 'q4-implied', rpu: -8, edge: 0, asic: 12000, asicGm: 'low', coreGm: -1, fx: 'guidance', resid: 'low' },
  { id: 'base', name: '基準', units: 'q3-level', rpu: 0, edge: 10, asic: 16000, asicGm: 'mid', coreGm: 0, fx: 'qtd', resid: 'mid' },
  { id: 'bull', name: '樂觀', units: 'flat-2026', rpu: 5, edge: 20, asic: 16000, asicGm: 'beat', coreGm: 0, fx: 'qtd', resid: 'high' },
];

/* ───────────── text helpers ───────────── */

/** 數字轉文字（千分位、負號用「−」）；fixed＝固定小數位數。 */
const num = (v: number, d = 2, fixed = false) => {
  const r = round(v, d);
  const s = Math.abs(r).toLocaleString('en-US', fixed ? { minimumFractionDigits: d, maximumFractionDigits: d } : { maximumFractionDigits: d });
  return `${r < 0 ? '−' : ''}${s}`;
};
const yi = (m: number, d = 0) => `${num(m / 100, d)} 億元`; // 新台幣百萬元 → 億元
const usdYi = (m: number, d = 0) => `${num(m / 100, d)} 億美元`; // 百萬美元 → 億美元
const pct = (v: number, d = 1) => `${num(v, d, true)}%`;
const signed = (v: number, d = 1, unit = '%') => (round(v, d) === 0 ? `0${unit}` : `${v > 0 ? '+' : '−'}${num(Math.abs(v), d, true)}${unit}`);
const pp = (v: number, d = 1) => (round(v, d) === 0 ? '0 個百分點' : `${v > 0 ? '+' : '−'}${num(Math.abs(v), d, true)} 個百分點`);
const ntd = (v: number, d = 2) => (round(v, d) === 0 ? '0 元' : `${v > 0 ? '+' : '−'}${num(Math.abs(v), d, true)} 元`);
/** 公式中的係數：「+ 0.794」「− 0.049」。 */
const term = (v: number, d = 3) => `${v < 0 ? '−' : '+'} ${num(Math.abs(v), d)}`;
/** 中文與英數字之間補半形空格（只處理字串接合處）。 */
const cat = (a: string, b: string) => (/[一-鿿）]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? `${a} ${b}` : a + b);

/* ───────────── context ───────────── */

interface Ctx {
  rows: MQ[];
  by: Map<string, MQ>;
  monthly: Map<string, number>;
  drivers: CompanyDrivers;
}
const R = (ctx: Ctx, p: string) => { const r = ctx.by.get(p); if (!r) throw new Error(`mediatek: ${p} missing`); return r; };
const seg = (ctx: Ctx, p: string): Seg => { const s = segUsd(R(ctx, p)); if (!s) throw new Error(`mediatek: segment shares ${p} missing`); return s; };
const rpu = (ctx: Ctx, p: string) => seg(ctx, p).m / R(ctx, p).idc!;
const mobileShare = (s: Seg) => (100 * s.m) / (s.m + s.e + s.p);
const lnFx = (a: number, b: number) => 100 * Math.log(a / b);

/* ───────────── fitting (only quarters ≤ TRAIN_TO) ───────────── */

interface Fit {
  // 財測校正
  beta: number; // 營收相對財測中值的平均對數偏差（已扣除匯率差）
  gmGamma: number; // 毛利率（排除一次性項目）減財測中值：訓練期平均
  gmKappaTr: number; // 只供說明：毛利率偏差對匯率差（%）的迴歸斜率（不顯著，模型不採用）
  gmKappaT: number; // 同上的 t 值
  opexBias: number; // 營業費用相對「財測費用率 × 財測營收」的平均對數偏差
  revResid: number[]; // 訓練期營收殘差（對數）
  gmResid: number[]; // 訓練期毛利率殘差（個百分點）
  // 天真與月營收
  seasonal: number[]; // 各季平均季增（對數），Q1..Q4
  firstMonth: number[]; // 各季第一個月營收占當季比重，Q1..Q4
  // 產品線模型
  cRpu: number; // 每支手機營收的平均季變化（對數）
  gEdge: number;
  gPower: number;
  kSeg: number; // 毛利率季變化對匯率季變化（%）的斜率（不含截距）
  mixB: number; // 產品線＋毛利組合：手機占比變化（個百分點）的係數
  mixK: number; // 同上，匯率季變化的係數
  nSeg: number;
  nRpu: number;
  nGm: number;
}

function fit(ctx: Ctx): Fit {
  const tr = qRange(TRAIN_FROM, TRAIN_TO);
  const g = (p: string) => R(ctx, p).guide!;
  const fxGap = (p: string) => lnFx(R(ctx, p).fx, g(p).fx);
  const lb = tr.map((p) => Math.log(R(ctx, p).revenue / g(p).rev) - fxGap(p) / 100);
  const beta = mean(lb);
  const gmY = tr.map((p) => R(ctx, p).gmEx - g(p).gm);
  // 毛利率偏差對匯率差的迴歸只用來檢驗：斜率不顯著（t 值遠小於 2），模型採較簡單的平均偏差
  const gmC = ols(tr.map((p) => [fxGap(p)]), gmY);
  const gx = tr.map(fxGap);
  const gxm = mean(gx);
  const sxx = sum(gx.map((v) => (v - gxm) ** 2));
  const s2 = sum(gmY.map((y, i) => (y - gmC[0]! - gmC[1]! * gx[i]!) ** 2)) / (tr.length - 2);
  const gmGamma = mean(gmY);
  const gmResid = gmY.map((y) => y - gmGamma);
  const opexBias = mean(tr.map((p) => Math.log(R(ctx, p).opex / ((g(p).opexRatio / 100) * g(p).rev))));
  const withPrev = tr.filter((p) => ctx.by.has(addQ(p, -1)));
  const seasonal = [1, 2, 3, 4].map((k) => mean(withPrev.filter((p) => p.endsWith(`Q${k}`)).map((p) => Math.log(R(ctx, p).revenue / R(ctx, addQ(p, -1)).revenue))));
  const firstMonth = [1, 2, 3, 4].map((k) => mean(tr.filter((p) => p.endsWith(`Q${k}`)).map((p) => ctx.monthly.get(months(p)[0]!)! / R(ctx, p).revenue)));
  const segTr = qRange(SEG_FROM, TRAIN_TO);
  const rpuTr = qRange(RPU_FROM, TRAIN_TO);
  const cRpu = mean(rpuTr.map((p) => Math.log(rpu(ctx, p) / rpu(ctx, addQ(p, -1)))));
  const gEdge = mean(segTr.map((p) => Math.log(seg(ctx, p).e / seg(ctx, addQ(p, -1)).e)));
  const gPower = mean(segTr.map((p) => Math.log(seg(ctx, p).p / seg(ctx, addQ(p, -1)).p)));
  const gmTr = withPrev;
  const kSeg = slope0(gmTr.map((p) => lnFx(R(ctx, p).fx, R(ctx, addQ(p, -1)).fx)), gmTr.map((p) => R(ctx, p).gmEx - R(ctx, addQ(p, -1)).gmEx));
  // 產品線＋毛利組合：Δ毛利率 = b × Δ手機占比 + k × Δ匯率（不含截距，2021Q2–2024Q4）
  const X = segTr.map((p) => [mobileShare(seg(ctx, p)) - mobileShare(seg(ctx, addQ(p, -1))), lnFx(R(ctx, p).fx, R(ctx, addQ(p, -1)).fx)]);
  const Y = segTr.map((p) => R(ctx, p).gmEx - R(ctx, addQ(p, -1)).gmEx);
  const A = [[0, 0], [0, 0]];
  const b = [0, 0];
  X.forEach((x, i) => { for (let r = 0; r < 2; r++) { b[r]! += x[r]! * Y[i]!; for (let c = 0; c < 2; c++) A[r]![c]! += x[r]! * x[c]!; } });
  const det = A[0]![0]! * A[1]![1]! - A[0]![1]! * A[1]![0]!;
  return {
    beta, gmGamma, gmKappaTr: gmC[1]!, gmKappaT: gmC[1]! / Math.sqrt(s2 / sxx), opexBias, revResid: lb.map((x) => x - beta), gmResid,
    seasonal, firstMonth, cRpu, gEdge, gPower, kSeg,
    mixB: (b[0]! * A[1]![1]! - b[1]! * A[0]![1]!) / det,
    mixK: (A[0]![0]! * b[1]! - A[1]![0]! * b[0]!) / det,
    nSeg: segTr.length, nRpu: rpuTr.length, nGm: gmTr.length,
  };
}

/* ───────────── one-step predictions ───────────── */

interface SegPred { rev: number; usd: number; s: Seg; share: number }
/** 產品線模型：手機＝全球手機出貨 × 上季每支手機營收 × e^c；智慧邊緣與電源管理 IC＝上季 × e^g；加總後乘以匯率。 */
function segStep(F: Fit, prev: Seg, prevRpu: number, idc: number, fx: number): SegPred {
  const s: Seg = { m: idc * prevRpu * Math.exp(F.cRpu), e: prev.e * Math.exp(F.gEdge), p: prev.p * Math.exp(F.gPower) };
  const usd = s.m + s.e + s.p;
  return { rev: usd * fx, usd, s, share: mobileShare(s) };
}

/* ───────────── 2026Q4 and 2027 forecast ───────────── */

interface Outlook {
  guide: { rev: number; low: number; high: number; gm: number; opexRatio: number; fx: number; src: string };
  fxQtd: number;
  fxQ4Low: number; // 保守情境的 2026Q4 季平均：已知 30 個營業日 + 其餘營業日回到財測匯率
  asicQ4: number; // 百萬美元
  asicQ4Low: number;
  units2026: number[]; // Q1..Q4（Q4 由 IDC 全年預測反推）
  idc2025: number;
  idc2026: number;
  oct: number;
  below: Below;
  opex2026: number[]; // Q1..Q4（Q4 為財測推算）
  opexGrowth: number; // 2016–2025 年營業費用年複合成長率（%）
  coreBase: number; // 2026 年前三季毛利率（%）
  coreFx: number; // 2026 年前三季平均匯率
  asicGm: { low: number; mid: number; beat: number };
  asicShareQ4: number;
}
interface Opts { asicAdd?: number; asicGmAdd?: number; unitsAdd?: number; rpuAdd?: number; edgeAdd?: number; fx?: number; coreGmAdd?: number; opexMul?: number; taxAdd?: number; q4Asic?: number }
interface FcRow extends Pnl { period: string; usd: number; asic: number; nonAsic: number; seg?: Seg | undefined; core: number; asicGm: number; fx: number }

const q4FxOf = (O: Outlook, sc: Scenario) => (sc.fx === 'qtd' ? O.fxQtd : O.fxQ4Low);
function q4Forecast(F: Fit, O: Outlook, sc: Scenario, o: Opts = {}): FcRow {
  const fx = o.fx ?? q4FxOf(O, sc);
  const rr = sc.resid === 'mid' ? 0 : quantile(F.revResid, sc.resid === 'low' ? Q_LOW : Q_HIGH);
  const gr = sc.resid === 'mid' ? 0 : quantile(F.gmResid, sc.resid === 'low' ? Q_LOW : Q_HIGH);
  const asicCut = ((O.asicQ4 - (o.q4Asic ?? O.asicQ4)) * fx);
  const rev = O.guide.rev * Math.exp(F.beta + rr) * (fx / O.guide.fx) - asicCut;
  const gm = O.guide.gm + F.gmGamma + gr;
  const opex = O.opex2026[3]! * (o.opexMul ?? 1);
  const b = { ...O.below, tax: O.below.tax + (o.taxAdd ?? 0) / 100 };
  const usd = rev / fx;
  const asic = o.q4Asic ?? O.asicQ4;
  return { period: NEXT, ...pnl(rev, gm, opex, b), usd, asic, nonAsic: usd - asic, core: NaN, asicGm: NaN, fx };
}

/** 2027 年：以 2026 年同季為基礎的產品線年增（手機＝出貨 × 每支手機營收），加上資料中心 ASIC；毛利率依 ASIC 比重加權。 */
function forecast2027(ctx: Ctx, F: Fit, O: Outlook, sc: Scenario, o: Opts = {}): { q4: FcRow; rows: FcRow[] } {
  const q4 = q4Forecast(F, O, sc, o);
  const fx = o.fx ?? (sc.fx === 'qtd' ? O.fxQtd : O.guide.fx);
  // 2026 年各季的非 ASIC 產品線（百萬美元）：前三季為實際，第四季＝預測營收 − ASIC，依第三季占比拆分
  const s3 = seg(ctx, '2026Q3');
  const t3 = s3.m + s3.e + s3.p;
  const base2026: Seg[] = [...GM_FX_BASE.map((p) => seg(ctx, p)), { m: (q4.nonAsic * s3.m) / t3, e: (q4.nonAsic * s3.e) / t3, p: (q4.nonAsic * s3.p) / t3 }];
  const level = sc.units === 'q4-implied' ? O.units2026[3]! : sc.units === 'q3-level' ? O.units2026[2]! : O.idc2026 / 4;
  const unitsLevel = level * (1 + (o.unitsAdd ?? 0) / 100);
  const rpuG = (sc.rpu + (o.rpuAdd ?? 0)) / 100;
  const edgeG = (sc.edge + (o.edgeAdd ?? 0)) / 100;
  const asicTotal = sc.asic + (o.asicAdd ?? 0);
  // ASIC 由 2026Q4 的季營收線性爬升到全年目標：x_k = Q4 + d × k，四季加總 = 目標
  const q4Asic = o.q4Asic ?? O.asicQ4;
  const d = (asicTotal - 4 * q4Asic) / 10;
  const asicQ = [1, 2, 3, 4].map((k) => q4Asic + d * k);
  const core = O.coreBase + GM_FX_RULE * lnFx(fx, O.coreFx) + sc.coreGm + (o.coreGmAdd ?? 0);
  const asicGm = O.asicGm[sc.asicGm] + (o.asicGmAdd ?? 0);
  const b = { ...O.below, tax: O.below.tax + (o.taxAdd ?? 0) / 100 };
  const opexG = 1 + O.opexGrowth / 100;
  const rows = Y2027.map((p, i) => {
    const s0 = base2026[i]!;
    const gMob = unitsLevel / O.units2026[i]! * (1 + rpuG) - 1;
    const s: Seg = { m: s0.m * (1 + gMob), e: s0.e * (1 + edgeG), p: s0.p * (1 + (gMob + edgeG) / 2) };
    const nonAsic = s.m + s.e + s.p;
    const usd = nonAsic + asicQ[i]!;
    const rev = usd * fx;
    const gmQ = (nonAsic * core + asicQ[i]! * asicGm) / usd;
    const opex = O.opex2026[i]! * opexG * (o.opexMul ?? 1);
    return { period: p, ...pnl(rev, gmQ, opex, b), usd, asic: asicQ[i]!, nonAsic, seg: s, core, asicGm, fx };
  });
  return { q4: { ...q4, seg: base2026[3], core, asicGm }, rows };
}
const annualOf = (rows: Pnl[]) => {
  const rev = sum(rows.map((r) => r.rev));
  return { rev, gm: (100 * sum(rows.map((r) => (r.rev * r.gm) / 100))) / rev, oi: sum(rows.map((r) => r.oi)), ni: sum(rows.map((r) => r.ni)), eps: sum(rows.map((r) => r.eps)), opex: sum(rows.map((r) => r.opex)) };
};

/* ───────────── build ───────────── */

export function buildModel(inputs: CompanyInputs, prices: MarketPrices, drivers: CompanyDrivers): ModelOutput {
  if (!drivers) throw new Error('mediatek model needs mediatek-drivers.yaml');
  const rows = quarterTable(inputs, drivers);
  const ctx: Ctx = { rows, by: new Map(rows.map((r) => [r.period, r])), monthly: new Map(inputs.monthly.map((m) => [m.period, m.revenue])), drivers };
  if (rows.at(-1)!.period !== TEST_TO) throw new Error(`mediatek inputs must end at ${TEST_TO}`);
  for (const p of qRange(TRAIN_FROM, TEST_TO)) if (!R(ctx, p).guide) throw new Error(`mediatek: guidance ${p} missing`);
  const test = qRange(TEST_FROM, TEST_TO);
  const F = fit(ctx);

  // ── one-step-ahead predictions in the test window
  type Pred = Pnl & { share?: number };
  const preds: Record<string, Map<string, Pred>> = {};
  const put = (id: string, p: string, x: Pred) => { (preds[id] ??= new Map()).set(p, x); };
  const extra: Record<string, Record<string, Pair[]>> = {};
  const push = (id: string, m: string, x: Pair) => { ((extra[id] ??= {})[m] ??= []).push(x); };
  const hits = { inside: 0, above: 0, below: 0 };
  const q4Way: Pair[] = [];
  for (const p of test) {
    const a = R(ctx, p);
    const q = R(ctx, addQ(p, -1));
    const g = a.guide!;
    const k = Number(p.slice(5)) - 1;
    if (a.revenue > g.high) hits.above++; else if (a.revenue < g.low) hits.below++; else hits.inside++;
    put('naive', p, bridge(a, q.revenue, q.gm));
    put('seasonal-naive', p, bridge(a, q.revenue * Math.exp(F.seasonal[k]!), q.gm));
    const m1 = ctx.monthly.get(months(p)[0]!);
    if (m1 !== undefined) put('first-month', p, bridge(a, m1 / F.firstMonth[k]!, q.gm));
    // 公司財測：營業利益用公司財測的營業費用率（業外、稅率與股數用當季實際）
    const gOi = (g.rev * (g.gm - g.opexRatio)) / 100;
    put('guidance', p, bridge(a, g.rev, g.gm, (g.rev * g.gm) / 100 - gOi));
    // 財測校正（當季實際匯率已知）與事前版本（匯率用財測假設）
    const revA = g.rev * Math.exp(F.beta) * (a.fx / g.fx);
    const gmA = g.gm + F.gmGamma;
    put('guidance-adjusted', p, bridge(a, revA, gmA));
    const revE = g.rev * Math.exp(F.beta);
    const gmE = gmA; // 毛利率不含匯率項，事前與條件式相同
    const opexE = (g.opexRatio / 100) * g.rev * Math.exp(F.opexBias);
    const ea = bridge(a, revE, gmE, opexE);
    // 2026Q4 預測採用的組合：營收用實際匯率、營業費用用財測推算（只在說明文字中引用）
    q4Way.push({ actual: a.eps, predicted: bridge(a, revA, gmA, opexE).eps });
    push('guidance-adjusted', 'revenueExAnte', { actual: a.revenue, predicted: revE });
    push('guidance-adjusted', 'grossMarginExAnte', { actual: a.gm, predicted: gmE });
    push('guidance-adjusted', 'operatingIncomeExAnte', { actual: a.oi, predicted: ea.oi });
    push('guidance-adjusted', 'epsExAnte', { actual: a.eps, predicted: ea.eps });
    // 產品線模型（代入當季實際的 IDC 出貨與匯率）
    const sp = segStep(F, seg(ctx, q.period), rpu(ctx, q.period), a.idc!, a.fx);
    const gmS = q.gmEx + F.kSeg * lnFx(a.fx, q.fx);
    put('segment', p, { ...bridge(a, sp.rev, gmS), share: sp.share });
    const gmM = q.gmEx + F.mixB * (sp.share - mobileShare(seg(ctx, q.period))) + F.mixK * lnFx(a.fx, q.fx);
    put('segment-mix', p, { ...bridge(a, sp.rev, gmM), share: sp.share });
    // 事前版本：出貨沿用最近一季的年增率（IDC_t ≈ IDC_t−4 × IDC_t−1 ÷ IDC_t−5），匯率用財測假設
    const idcEA = (R(ctx, addQ(p, -4)).idc! * q.idc!) / R(ctx, addQ(p, -5)).idc!;
    const se = segStep(F, seg(ctx, q.period), rpu(ctx, q.period), idcEA, g.fx);
    const gmSE = q.gmEx + F.kSeg * lnFx(g.fx, q.fx);
    push('segment', 'revenueExAnte', { actual: a.revenue, predicted: se.rev });
    push('segment', 'grossMarginExAnte', { actual: a.gm, predicted: gmSE });
    push('segment-mix', 'revenueExAnte', { actual: a.revenue, predicted: se.rev });
    push('segment-mix', 'grossMarginExAnte', { actual: a.gm, predicted: q.gmEx + F.mixB * (se.share - mobileShare(seg(ctx, q.period))) + F.mixK * lnFx(g.fx, q.fx) });
  }
  // 產品線模型連續推 7 季（由 2024Q4 出發，只代入實際的 IDC 出貨與匯率，不用實際營收重設）
  const dyn = new Map<string, { rev: number; gm: number }>();
  {
    let s = seg(ctx, TRAIN_TO);
    let r = rpu(ctx, TRAIN_TO);
    const g0 = R(ctx, TRAIN_TO);
    for (const p of test) {
      const a = R(ctx, p);
      const x = segStep(F, s, r, a.idc!, a.fx);
      s = x.s;
      r = (r * Math.exp(F.cRpu));
      dyn.set(p, { rev: x.rev, gm: g0.gmEx + F.kSeg * lnFx(a.fx, g0.fx) });
    }
    for (const p of test) push('segment', 'revenueDynamic', { actual: R(ctx, p).revenue, predicted: dyn.get(p)!.rev });
    for (const p of test) push('segment', 'grossMarginDynamic', { actual: R(ctx, p).gm, predicted: dyn.get(p)!.gm });
  }
  // 訓練期的財測表現（對照用）
  const trQ = qRange(TRAIN_FROM, TRAIN_TO);
  for (const p of trQ) {
    const a = R(ctx, p);
    const g = a.guide!;
    push('guidance', 'revenueTrain', { actual: a.revenue, predicted: g.rev });
    push('guidance', 'grossMarginTrain', { actual: a.gm, predicted: g.gm });
    push('guidance-adjusted', 'revenueTrain', { actual: a.revenue, predicted: g.rev * Math.exp(F.beta) * (a.fx / g.fx) });
    push('guidance-adjusted', 'grossMarginTrain', { actual: a.gm, predicted: g.gm + F.gmGamma });
  }
  const trHits = { inside: 0, above: 0, below: 0 };
  for (const p of trQ) { const a = R(ctx, p); if (a.revenue > a.guide!.high) trHits.above++; else if (a.revenue < a.guide!.low) trHits.below++; else trHits.inside++; }

  const METRICS = ['revenue', 'grossMargin', 'operatingIncome', 'netIncome', 'eps'] as const;
  type Metric = (typeof METRICS)[number];
  const field = { revenue: 'rev', grossMargin: 'gm', operatingIncome: 'oi', netIncome: 'ni', eps: 'eps' } as const;
  const actualOf = (a: MQ, m: Metric) => ({ revenue: a.revenue, grossMargin: a.gm, operatingIncome: a.oi, netIncome: a.ni, eps: a.eps })[m];
  const REV_ONLY = new Set(['first-month']);
  const pairs = (id: string, m: Metric): Pair[] =>
    test.flatMap((p) => { const x = preds[id]?.get(p)?.[field[m]]; return x === undefined ? [] : [{ actual: actualOf(R(ctx, p), m), predicted: x }]; });
  const M: Record<string, Record<string, ReturnType<typeof metrics>>> = {};
  for (const id of Object.keys(preds)) {
    const out: Record<string, ReturnType<typeof metrics>> = {};
    for (const m of METRICS) { if (REV_ONLY.has(id) && m !== 'revenue') continue; const ps = pairs(id, m); if (ps.length) out[m] = metrics(ps, m !== 'grossMargin'); }
    for (const [k, ps] of Object.entries(extra[id] ?? {})) out[k] = metrics(ps, !k.startsWith('grossMargin'));
    M[id] = out;
  }
  const score = (id: string) => M[id]!.revenue!.mape! + M[id]!.grossMargin!.mae;
  const selected = [...ELIGIBLE].sort((x, y) => score(x) - score(y))[0]!;
  if (selected !== 'guidance-adjusted') throw new Error(`selection changed to ${selected}; review the forecast wiring and texts`);
  const sel = M['guidance-adjusted']!;
  const gd = M.guidance!;
  const nv = M.naive!;
  const sg = M.segment!;
  const q4WayEps = metrics(q4Way);
  // 事前版本（匯率只用財測假設）下的選擇分數，檢查選擇結果是否依賴「已知匯率」
  const scoreEA = (id: string) => M[id]!.revenueExAnte!.mape! + M[id]!.grossMarginExAnte!.mae;

  // ── outlook inputs (2026Q4 guidance, FX, ASIC, IDC, below-the-line items)
  const gRev = driver(drivers, 'guidance-revenue').get(NEXT)!;
  const gGm = driver(drivers, 'guidance-gross-margin').get(NEXT)!;
  const gOpex = driver(drivers, 'guidance-opex-ratio').get(NEXT)!;
  const gFx = driver(drivers, 'guidance-fx').get(NEXT)!;
  const fxQ4 = driver(drivers, 'usd-ntd-avg-fed').get(NEXT)!;
  const asic = driver(drivers, 'datacenter-asic-revenue');
  const asic26 = asic.get('2026')!;
  const asic27 = asic.get('2027')!;
  const idc = driver(drivers, 'smartphone-shipments-idc');
  const idc2025 = sum(qRange('2025Q1', '2025Q4').map((p) => idc.get(p)!.value));
  const idc2026 = idc2025 * (1 + IDC_2026_YOY / 100);
  const units2026 = [...GM_FX_BASE.map((p) => idc.get(p)!.value)];
  units2026.push(idc2026 - sum(units2026));
  const last4 = qRange(addQ(TEST_TO, -3), TEST_TO).map((p) => R(ctx, p));
  const below: Below = {
    nonop: mean(last4.map((r) => r.nonop)),
    tax: sum(last4.map((r) => r.tax)) / sum(last4.map((r) => r.pretax)),
    minority: sum(last4.map((r) => r.ni)) / sum(last4.map((r) => r.niTotal)),
    shares: R(ctx, TEST_TO).shares,
  };
  const guide = { rev: gRev.value, low: gRev.low!, high: gRev.high!, gm: gGm.value, opexRatio: gOpex.value, fx: gFx.value, src: gRev.src };
  const opexQ4 = (guide.opexRatio / 100) * guide.rev * Math.exp(F.opexBias);
  const annualOpex = (y: number) => sum(qRange(`${y}Q1`, `${y}Q4`).map((p) => R(ctx, p).opex));
  const opexGrowth = (Math.pow(annualOpex(2025) / annualOpex(2016), 1 / 9) - 1) * 100;
  const coreRows = GM_FX_BASE.map((p) => R(ctx, p));
  const coreBase = (100 * sum(coreRows.map((r) => r.gp))) / sum(coreRows.map((r) => r.revenue));
  const coreFx = mean(coreRows.map((r) => r.fx));
  // 第四季財測隱含的 ASIC 毛利率：財測毛利率 =（1 − s）× 非 ASIC 毛利率 + s × ASIC 毛利率，s = ASIC 營收 ÷ 財測營收（以財測匯率換算）
  const sQ4 = (asic26.value * guide.fx) / guide.rev;
  const coreAtGuide = coreBase + GM_FX_RULE * lnFx(guide.fx, coreFx);
  const impliedAsic = (gm: number) => (gm - coreAtGuide * (1 - sQ4)) / sQ4;
  const O: Outlook = {
    guide, fxQtd: fxQ4.value, fxQ4Low: (FX_DAYS_KNOWN * fxQ4.value + FX_DAYS_LEFT * guide.fx) / (FX_DAYS_KNOWN + FX_DAYS_LEFT), asicQ4: asic26.value, asicQ4Low: asic26.low ?? asic26.value, units2026, idc2025, idc2026,
    oct: ctx.monthly.get(`${NEXT.slice(0, 4)}-10`)!, below,
    opex2026: [...GM_FX_BASE.map((p) => R(ctx, p).opex), opexQ4], opexGrowth, coreBase, coreFx,
    asicGm: { low: impliedAsic(guide.gm - 1.5), mid: impliedAsic(guide.gm), beat: impliedAsic(guide.gm + F.gmGamma) },
    asicShareQ4: sQ4,
  };
  if (O.oct === undefined) throw new Error('mediatek: 2026-10 monthly revenue missing');

  const fc = Object.fromEntries(SCENARIOS.map((s) => [s.id, forecast2027(ctx, F, O, s)])) as Record<Scenario['id'], ReturnType<typeof forecast2027>>;
  const baseSc = SCENARIOS.find((s) => s.id === 'base')!;
  const base = fc.base;
  const ytd = GM_FX_BASE.map((p) => R(ctx, p));
  const ytdPnl: Pnl[] = ytd.map((r) => ({ rev: r.revenue, gm: r.gm, oi: r.oi, ni: r.ni, eps: r.eps, opex: r.opex }));
  const y2026 = (q4: Pnl) => annualOf([...ytdPnl, q4]);
  const baseY27 = annualOf(base.rows);
  const y2025 = annualOf(qRange('2025Q1', '2025Q4').map((p) => { const r = R(ctx, p); return { rev: r.revenue, gm: r.gm, oi: r.oi, ni: r.ni, eps: r.eps, opex: r.opex }; }));
  const fmNow = O.oct / F.firstMonth[3]!;
  const needNovDec = (base.q4.rev - O.oct) / 2;
  const octShares = Array.from({ length: 10 }, (_, i) => 2016 + i).map((y) => ({ y, v: (100 * ctx.monthly.get(`${y}-10`)!) / R(ctx, `${y}Q4`).revenue }));
  const octMean = mean(octShares.map((x) => x.v));

  // ── sensitivities (2027 base unless noted)
  const sens = (o: Opts) => { const r = forecast2027(ctx, F, O, baseSc, o); const y = annualOf(r.rows); return { rev: y.rev - baseY27.rev, revPct: (y.rev / baseY27.rev - 1) * 100, gm: y.gm - baseY27.gm, eps: y.eps - baseY27.eps, q4: r.q4 }; };
  const sensText = (x: ReturnType<typeof sens>) => {
    const parts: string[] = [];
    if (Math.abs(x.rev) >= 50) parts.push(`營收 ${x.rev >= 0 ? '+' : '−'}${yi(Math.abs(x.rev))}（${signed(x.revPct, 1)}）`);
    if (Math.abs(x.gm) >= 0.005) parts.push(`毛利率 ${pp(x.gm, 2)}`);
    parts.push(`EPS ${ntd(x.eps)}`);
    return `${cat('2027 年', parts.join('、'))}${Math.abs(x.rev) < 50 ? '（營收不變）' : ''}`;
  };
  const q4AsicLow = sens({ q4Asic: O.asicQ4Low });
  const sensitivities: ModelOutput['sensitivities'] = [
    { driver: '2027 年資料中心 ASIC 營收', change: '少 20 億美元（160 → 140 億美元）', effect: sensText(sens({ asicAdd: -2000 })) },
    { driver: '資料中心 ASIC 毛利率', change: '低 5 個百分點', effect: sensText(sens({ asicGmAdd: -5 })) },
    { driver: '非 ASIC 產品毛利率', change: '低 1 個百分點', effect: sensText(sens({ coreGmAdd: -1 })) },
    { driver: '手機營收（全球手機出貨或每支手機帶給聯發科的營收）', change: '2027 年少 5%', effect: `${sensText(sens({ unitsAdd: -5 }))}（出貨與每支手機營收相乘，兩者各少 5% 的效果相同）` },
    { driver: '智慧邊緣平台（不含 ASIC）年增率', change: '少 10 個百分點', effect: sensText(sens({ edgeAdd: -10 })) },
    { driver: '美元兌新台幣匯率（2026Q4 與 2027 年）', change: `新台幣升值 1 元（${num(O.fxQtd, 2)} → ${num(O.fxQtd - 1, 2)}）`, effect: `${sensText(sens({ fx: O.fxQtd - 1 }))}；含公司說明的匯率對毛利率影響（每 1% 約 0.2 個百分點）` },
    { driver: '營業費用', change: '2026Q4 與 2027 年各季多 10%', effect: sensText(sens({ opexMul: 1.1 })) },
    { driver: '有效稅率', change: '多 2 個百分點', effect: sensText(sens({ taxAdd: 2 })) },
    {
      driver: '2026Q4 資料中心 ASIC 營收', change: `${usdYi(O.asicQ4)} → ${usdYi(O.asicQ4Low)}（公司 2026 年 4 月的說法）`,
      effect: `2026Q4 營收 −${yi(base.q4.rev - q4AsicLow.q4.rev)}、EPS ${ntd(q4AsicLow.q4.eps - base.q4.eps)}（假設其他產品不變、營業費用不變；2027 年 ASIC 由較低的起點爬升到相同的全年目標）`,
    },
  ];

  // ── candidates
  const mt = (id: string) => M[id]!;
  const coef = (v: number, d = 3) => num(v, d);
  const ann = (c: number) => (Math.exp(4 * c) - 1) * 100;
  const testHitText = `測試期 ${test.length} 季中，實際營收落在財測區間內 ${hits.inside} 季、高於上緣 ${hits.above} 季、低於下緣 ${hits.below} 季；訓練期 ${trQ.length} 季為 ${trHits.inside}、${trHits.above}、${trHits.below} 季`;
  const candidates: ModelOutput['candidates'] = [
    {
      id: 'naive', name: '天真模型（上一季不變）',
      description: '假設本季營收與毛利率都和上一季一樣。這是最簡單的對照組：任何模型如果贏不了它，就沒有存在的價值。',
      equations: ['營收_t = 營收_t−1', '毛利率_t = 毛利率_t−1'],
      metrics: mt('naive'), selected: false,
      note: '營業利益、淨利與 EPS 由營收與毛利率換算，營業費用、業外收支、稅率與股數用當季實際值（除公司財測外，所有模型都這樣處理）。',
    },
    {
      id: 'seasonal-naive', name: '季節性天真模型',
      description: `上一季營收乘以過去同一季的平均季增幅度（例如第二季平均比第一季高約 ${num((Math.exp(F.seasonal[1]!) - 1) * 100, 0)}%），毛利率沿用上一季。用來檢查「只靠季節性」能做到多好。`,
      equations: [`營收_t = 營收_t−1 × e^(s_q)，s_q 為 ${TRAIN_FROM}–${TRAIN_TO} 同一季的平均對數季增：第一至四季分別約 ${F.seasonal.map((v) => signed((Math.exp(v) - 1) * 100, 1)).join('、')}`, '毛利率_t = 毛利率_t−1'],
      metrics: mt('seasonal-naive'), selected: false,
      note: '聯發科的季節性並不穩定（新品發表時間、庫存調整與 2025 年起的關稅提前拉貨都會改變季節型態），所以這個對照組比單純沿用上一季更差。',
    },
    {
      id: 'first-month', name: '首月營收推估（只預測營收）',
      description: '聯發科每月 10 日前公布上月營收。季度第一個月的營收公布後，用過去同一季「第一個月占全季」的平均比重放大成全季營收。財測在季度第一個月月底的法說會發布，首月營收約在 10 天後公布，所以這個做法比財測多一點資訊，但只有營收、沒有毛利率。',
      equations: [`營收_t = 第一個月營收 ÷ φ_q，φ_q 為 ${TRAIN_FROM}–${TRAIN_TO} 同一季第一個月的平均占比：第一至四季分別約 ${F.firstMonth.map((v) => pct(v * 100, 1)).join('、')}`],
      metrics: mt('first-month'), selected: false,
      note: `不參與模型選擇（只預測營收）。用在 2026Q4：10 月營收 ${yi(O.oct)}，依第四季首月平均占比 ${pct(F.firstMonth[3]! * 100, 1)} 放大為約 ${yi(fmNow)}，遠低於財測區間 ${num(O.guide.low / 100, 0)}–${yi(O.guide.high)}；公司說明資料中心 ASIC 9 月才開始初期出貨、第四季約 ${usdYi(O.asicQ4)}，出貨集中在 11–12 月時首月比重就不適用，這是本推估在第四季最大的缺點。`,
    },
    {
      id: 'guidance', name: '聯發科財測（對照基準）',
      description: '聯發科在上一季法說會公布的本季財測中值：營收區間中值、毛利率中值與營業費用率中值（可換算營業利益）。這不是本站的模型，而是公司在季度開始時的判斷，用來衡量模型的誤差是大是小。',
      equations: ['營收 = 財測區間中值', '毛利率 = 財測毛利率中值', '營業利益 = 營收 ×（毛利率 − 財測營業費用率）'],
      metrics: mt('guidance'), selected: false,
      note: `${testHitText}。營收財測中值平均低於實際 ${pct(-gd.revenue!.bias / mean(test.map((p) => R(ctx, p).revenue)) * 100, 1)}，財測偏保守。淨利與 EPS 由財測的營業利益加上當季實際的業外收支、稅率與股數換算（公司不提供 EPS 財測）。revenueTrain／grossMarginTrain 為 ${TRAIN_FROM}–${TRAIN_TO} 的財測誤差。`,
    },
    {
      id: 'guidance-adjusted', name: '財測校正模型（歷史偏差＋實際匯率）',
      description: '以公司財測中值為起點，加上兩個用訓練期資料估計的校正：一是聯發科營收過去平均略高於財測中值（財測偏保守），二是財測假設的匯率與實際匯率的差距。聯發科的營收大多以美元計價，新台幣貶值 1% 時新台幣營收約多 1%。毛利率則加上過去平均高於財測中值的幅度。',
      equations: [
        `營收_t = 財測中值_t × e^β ×（實際匯率_t ÷ 財測假設匯率_t），β = ${coef(F.beta, 4)}（約 ${signed((Math.exp(F.beta) - 1) * 100, 2)}）`,
        `毛利率_t = 財測毛利率_t ${term(F.gmGamma, 3)}`,
      ],
      metrics: sel, selected: true,
      note: `以 ${TRAIN_FROM}–${TRAIN_TO} 共 ${trQ.length} 季估計；訓練期毛利率先扣除公司說明的一次性項目（2024Q1 的成本迴轉約 4.5 個百分點）。匯率對營收的彈性固定為 1（美元計價的會計關係；訓練期以迴歸估計約 ${round(ols(trQ.map((p) => [lnFx(R(ctx, p).fx, R(ctx, p).guide!.fx) / 100]), trQ.map((p) => Math.log(R(ctx, p).revenue / R(ctx, p).guide!.rev)))[1]!, 2)}，但財測匯率與實際匯率的差距多在 ±3% 內，資料辨識度低）。毛利率不加匯率項：訓練期毛利率偏差對匯率差的迴歸斜率只有每 1% ${num(F.gmKappaTr, 3)} 個百分點（t 值 ${num(F.gmKappaT, 2)}），不顯著，所以採較簡單的平均偏差。當季實際匯率要到季末才完全確定，所以營收是「已知匯率」的條件式預測；revenueExAnte／operatingIncomeExAnte／epsExAnte 為事前版本：匯率改用財測假設、營業費用改用財測費用率 × 財測營收 × e^${coef(F.opexBias, 4)}（訓練期營業費用平均高於財測 ${pct((Math.exp(F.opexBias) - 1) * 100, 1)}），季度開始時就能算出（grossMarginExAnte 與條件式相同）；事前版本營收 MAPE ${pct(sel.revenueExAnte!.mape!, 2)}，仍低於公司財測的 ${pct(gd.revenue!.mape!, 2)}。2026Q4 的預測營收用季初至今的匯率、營業費用用財測推算，這個組合在測試期的 EPS MAPE 為 ${pct(q4WayEps.mape!, 2)}，比事前版本大，主要來自匯率與財測假設差距大的季度（例如 2025Q2 新台幣比財測假設升值約 5%）：營收依實際匯率調整，營業費用卻沒有跟著調整，而聯發科也有部分營業費用以外幣支付。選擇規則：在可用來預測的三個模型（財測校正、產品線、產品線＋毛利組合）中，取測試期「營收 MAPE（%）＋ 毛利率 MAE（個百分點）」最小者：本模型 ${round(score('guidance-adjusted'), 2)}、產品線 ${round(score('segment'), 2)}、產品線＋毛利組合 ${round(score('segment-mix'), 2)}；三者都改用事前版本時為 ${round(scoreEA('guidance-adjusted'), 2)}、${round(scoreEA('segment'), 2)}、${round(scoreEA('segment-mix'), 2)}，排名不變。對照：公司財測 ${round(gd.revenue!.mape! + gd.grossMargin!.mae, 2)}、天真模型 ${round(nv.revenue!.mape! + nv.grossMargin!.mae, 2)}。本模型的營收誤差最小，但毛利率誤差（${round(sel.grossMargin!.mae, 2)} 個百分點）略大於公司財測（${round(gd.grossMargin!.mae, 2)}）與天真模型（${round(nv.grossMargin!.mae, 2)}）：2025Q4 起毛利率貼近財測中值，訓練期的 +${round(F.gmGamma, 2)} 個百分點偏差在測試期縮小為 ${pp(mean(test.map((p) => R(ctx, p).gmEx - R(ctx, p).guide!.gm)), 2)}。`,
    },
    {
      id: 'segment', name: '產品線模型（手機出貨 × 每支手機營收）',
      description: '把營收拆成三條產品線（以美元計）：手機營收 = 全球智慧型手機出貨（IDC 估計）× 每支全球手機帶給聯發科的營收；智慧邊緣平台與電源管理 IC 依訓練期的平均季增率延續；三者加總後乘以當季匯率。毛利率沿用上一季（排除一次性項目）並加上匯率影響。這是用公開的驅動因子拆解營收，不依賴公司財測。',
      equations: [
        `手機營收_t（美元）= IDC 出貨_t × 每支手機營收_t−1 × e^c，c = ${coef(F.cRpu, 4)}（約 ${signed(ann(F.cRpu), 1)}／年）`,
        `智慧邊緣平台_t = 智慧邊緣平台_t−1 × e^g，g = ${coef(F.gEdge, 4)}；電源管理 IC_t = 電源管理 IC_t−1 × e^h，h = ${coef(F.gPower, 4)}`,
        '營收_t（新台幣）=（手機 + 智慧邊緣平台 + 電源管理 IC）× 美元兌新台幣平均匯率_t',
        `毛利率_t = 毛利率_t−1（排除一次性項目）${term(F.kSeg, 3)} × 100 × ln(匯率_t ÷ 匯率_t−1)`,
      ],
      metrics: sg, selected: false,
      note: `產品線營收 = 公司簡報的整數占比（正規化到 100%）× 美元營收。c 以 ${RPU_FROM}–${TRAIN_TO} 共 ${F.nRpu} 季、g 與 h 以 ${SEG_FROM}–${TRAIN_TO} 共 ${F.nSeg} 季估計，匯率係數以 2016Q2–${TRAIN_TO} 共 ${F.nGm} 季估計（不含截距；公司 2025 年 7 月說明新台幣每升值 1% 毛利率約減 0.2 個百分點，但訓練期資料看不到這個關係）。回測代入當季實際的 IDC 出貨與匯率（條件式）：營收 MAPE ${pct(sg.revenue!.mape!, 2)}，比天真模型（${pct(nv.revenue!.mape!, 2)}）還差。事前版本（revenueExAnte）改用「出貨沿用最近一季年增率」與財測匯率，營收 MAPE 反而降到 ${pct(sg.revenueExAnte!.mape!, 2)}：聯發科的手機晶片比手機早一季出貨，又受客戶庫存調整放大，同一季的 IDC 出貨對它的解釋力很低。revenueDynamic 為從 ${TRAIN_TO} 出發連續推 ${test.length} 季、不用實際營收重設的結果（營收 MAPE ${pct(sg.revenueDynamic!.mape!, 2)}），反映 2026 年智慧邊緣平台（含資料中心 ASIC）大幅成長，而模型只延續訓練期的平均成長。毛利率誤差（${round(sg.grossMargin!.mae, 2)} 個百分點）是各模型中最小，主要因為把 2025Q2 的一次性項目排除後再沿用。`,
    },
    {
      id: 'segment-mix', name: '產品線＋毛利組合模型',
      description: '營收與產品線模型相同；毛利率改用產品組合解釋：手機占比變動與匯率變動對毛利率季變化的迴歸。用來檢驗「手機與智慧邊緣平台毛利率不同，所以產品組合會推動毛利率」這個直覺。',
      equations: [
        '營收：同產品線模型',
        `毛利率_t = 毛利率_t−1（排除一次性項目）${term(F.mixB, 4)} ×（預測手機占比_t − 手機占比_t−1）${term(F.mixK, 3)} × 100 × ln(匯率_t ÷ 匯率_t−1)`,
      ],
      metrics: mt('segment-mix'), selected: false,
      note: `以 ${SEG_FROM}–${TRAIN_TO} 共 ${F.nSeg} 季估計（不含截距），測試期的手機占比用模型預測值。手機占比每變動 10 個百分點，毛利率只變動 ${num(F.mixB * 10, 2)} 個百分點，訓練期幾乎看不到組合效果：聯發科長期以全公司毛利率目標（例如 2024 年的 47% ± 1 個百分點）定價，各產品線毛利率接近。因此 2026Q4 起資料中心 ASIC 拉低毛利率是新現象，歷史資料無法估計，預測時改由公司第四季財測推算（見參數）。`,
    },
  ];

  // ── backtest rows
  const backtest: ModelOutput['backtest'] = [];
  for (const id of ['guidance-adjusted', 'segment', 'segment-mix', 'first-month', 'seasonal-naive', 'naive', 'guidance']) {
    for (const m of METRICS) for (const p of test) {
      const x = preds[id]?.get(p)?.[field[m]];
      if (x === undefined || (REV_ONLY.has(id) && m !== 'revenue')) continue;
      const a = R(ctx, p);
      const g = a.guide!;
      const bench = m === 'revenue' ? g.rev : m === 'grossMargin' ? g.gm : m === 'operatingIncome' ? (g.rev * (g.gm - g.opexRatio)) / 100 : undefined;
      const d = m === 'grossMargin' || m === 'eps' ? 2 : 0;
      backtest.push({
        period: p, metric: m, actual: round(actualOf(a, m), d), predicted: round(x, d), candidate: id,
        ...(bench !== undefined && id !== 'guidance' ? { benchmark: round(bench, d), benchmarkLabel: '聯發科財測中值' } : {}),
      });
    }
  }

  // ── derived series
  const derived: ModelOutput['derived'] = [];
  type St = 'actual' | 'estimate' | 'forecast' | 'guidance';
  const pt = (period: string, value: number, status: St, d = 2) => ({ period, value: round(value, d), status });
  derived.push({
    id: 'guidance-beat', name: '實際營收相對財測中值', unit: '%',
    points: rows.filter((r) => r.guide).map((r) => pt(r.period, (r.revenue / r.guide!.rev - 1) * 100, 'actual')),
    note: `（實際營收 ÷ 上一季法說會公布的營收財測中值 − 1）× 100。${TRAIN_FROM}–${TEST_TO} 共 ${rows.length} 季，平均 ${signed(mean(rows.map((r) => (r.revenue / r.guide!.rev - 1) * 100)), 2)}；一部分來自匯率與財測假設不同（見 fx-gap）。`,
  });
  derived.push({
    id: 'guidance-gm-gap', name: '實際毛利率減財測中值', unit: '個百分點',
    points: rows.map((r) => pt(r.period, r.gm - r.guide!.gm, 'actual')),
    note: '財報毛利率減財測毛利率中值（財測區間一律 ±1.5 個百分點）。2024Q1（+5.4）含約 4.5 個百分點的一次性成本迴轉，2025Q2（+2.1）含約 1.9 個百分點與先前長期供貨協議有關的一次性項目。',
  });
  derived.push({
    id: 'fx-gap', name: '實際匯率相對財測假設匯率', unit: '%',
    points: rows.map((r) => pt(r.period, (r.fx / r.guide!.fx - 1) * 100, 'actual')),
    note: '（當季美元兌新台幣平均匯率 ÷ 財測假設匯率 − 1）× 100；正值代表新台幣比財測假設弱、新台幣營收因此偏高。平均匯率用聯準會 H.10。2026Q4 季初至 11 月 13 日的平均為 ' + num(O.fxQtd, 3) + ' 元，比財測假設 ' + num(O.guide.fx, 1) + ' 元弱 ' + pct((O.fxQtd / O.guide.fx - 1) * 100, 1) + '。',
  });
  derived.push({
    id: 'revenue-usd', name: '營收（美元）', unit: '百萬美元',
    points: [...rows.map((r) => pt(r.period, usdOf(r), 'estimate', 0)), pt(NEXT, base.q4.usd, 'forecast', 0), ...base.rows.map((r) => pt(r.period, r.usd, 'forecast', 0))],
    note: '新台幣營收 ÷ 聯準會 H.10 季平均匯率（公司簡報的美元營收以公司匯率換算，差距很小）。2026Q4 起為基準情境。',
  });
  const segSeries = (key: keyof Seg, id: string, name: string) => {
    const hist = rows.filter((r) => r.share).map((r) => pt(r.period, segUsd(r)![key] * r.fx, 'estimate', 0));
    const fq4 = pt(NEXT, base.q4.seg![key] * base.q4.fx, 'forecast', 0);
    return { id, name, unit: '百萬元', points: [...hist, fq4, ...base.rows.map((r) => pt(r.period, r.seg![key] * r.fx, 'forecast', 0))] };
  };
  derived.push({ ...segSeries('m', 'segment-revenue-mobile', '手機營收'), note: '合併營收 × 公司簡報的手機占比（整數，正規化到 100%）。2026Q4 起為基準情境：第四季的非 ASIC 營收依第三季占比拆分，2027 年為全球手機出貨 × 每支手機營收的年變化。' });
  derived.push({ ...segSeries('e', 'segment-revenue-smart-edge', '智慧邊緣平台營收（預測期不含資料中心 ASIC）'), note: '歷史值含公司歸在智慧邊緣平台的資料中心 ASIC（2026 年 9 月開始初期出貨，第三季金額未揭露）；2026Q4 起的預測值不含 ASIC，ASIC 另列於 datacenter-asic-revenue。' });
  derived.push({ ...segSeries('p', 'segment-revenue-power-ic', '電源管理 IC 營收'), note: '合併營收 × 公司簡報的電源管理 IC 占比。2027 年假設與手機、智慧邊緣平台的平均成長率相同。' });
  derived.push({
    id: 'datacenter-asic-revenue', name: '資料中心 AI 加速器 ASIC 營收（基準情境）', unit: '百萬元',
    points: [pt(NEXT, base.q4.asic * base.q4.fx, 'forecast', 0), ...base.rows.map((r) => pt(r.period, r.asic * r.fx, 'forecast', 0))],
    note: `2026Q4 為公司說法（約 ${usdYi(O.asicQ4)}），2027 年依公司目標約 ${usdYi(baseSc.asic)}、由第四季的水準線性爬升（${base.rows.map((r) => usdYi(r.asic, 1)).join('、')}），以基準匯率換算新台幣。各季分配是本模型假設，公司只給全年數字。`,
  });
  derived.push({
    id: 'revenue-per-smartphone', name: '每支全球手機帶給聯發科的營收', unit: '美元／支',
    points: rows.filter((r) => r.share && r.idc).map((r) => pt(r.period, segUsd(r)!.m / r.idc!, 'estimate')),
    note: '手機營收（美元）÷ IDC 全球智慧型手機出貨，相當於「聯發科的市占 × 每支手機的晶片價值」。IDC 為第三方估計，且聯發科的晶片比手機早出貨，單季比值會受庫存調整影響（例如 2023 年上半年）。',
  });
  derived.push({
    id: 'opex-ratio', name: '營業費用率', unit: '%',
    points: [...rows.map((r) => pt(r.period, (100 * r.opex) / r.revenue, 'actual', 1)), pt(NEXT, (100 * base.q4.opex) / base.q4.rev, 'forecast', 1), ...base.rows.map((r) => pt(r.period, (100 * r.opex) / r.rev, 'forecast', 1))],
    note: `營業費用 ÷ 營收。2026Q4 的營業費用依財測費用率 ${pct(O.guide.opexRatio, 0)} × 財測營收中值，再乘上訓練期平均高於財測的幅度（${signed((Math.exp(F.opexBias) - 1) * 100, 1)}）；2027 年各季為 2026 年同季 ×（1 + ${pct(O.opexGrowth, 1)}）（2016–2025 年營業費用的年複合成長率）。研發費用約占營業費用的八成，主要隨人力與先進製程投入成長，不隨營收同比例變動，所以營收大增時費用率下降。`,
  });
  derived.push({
    id: 'gm-core-nonasic', name: '非 ASIC 產品毛利率（基準情境）', unit: '%',
    points: [pt(NEXT, coreAtGuide, 'estimate'), ...base.rows.map((r) => pt(r.period, r.core, 'forecast'))],
    note: `2026 年前三季毛利率 ${pct(O.coreBase, 2)}（平均匯率 ${num(O.coreFx, 2)} 元），再依公司說明的匯率影響（新台幣每貶值 1%，毛利率約 +0.2 個百分點）換算到各期匯率。2026Q4 這一點是以財測假設匯率換算、用來推算 ASIC 毛利率的值。`,
  });
  derived.push({
    id: 'gm-asic-drag', name: '資料中心 ASIC 對毛利率的影響（基準情境）', unit: '個百分點',
    points: [pt(NEXT, O.guide.gm - coreAtGuide, 'guidance'), ...base.rows.map((r) => pt(r.period, r.gm - r.core, 'forecast'))],
    note: `合併毛利率 − 非 ASIC 毛利率。2026Q4 為公司財測（${pct(O.guide.gm, 0)}）隱含的影響：ASIC 約占第四季財測營收 ${pct(O.asicShareQ4 * 100, 1)}，推算 ASIC 毛利率約 ${pct(O.asicGm.mid, 1)}。2027 年 ASIC 比重升高，影響隨之擴大。`,
  });
  derived.push({
    id: 'october-share-of-q4', name: '10 月營收占第四季營收比重', unit: '%',
    points: [...octShares.map((x) => pt(String(x.y), x.v, 'actual', 1)), pt('2026', (100 * O.oct) / base.q4.rev, 'forecast', 1)],
    note: `2016–2025 年平均 ${pct(octMean, 1)}。2026 年為 10 月營收 ${yi(O.oct)} ÷ 基準情境的第四季營收 ${yi(base.q4.rev)}：要達到基準，11–12 月平均每月需約 ${yi(needNovDec)}（2026 年單月最高為 8 月的 ${yi(ctx.monthly.get('2026-08')!)}）。`,
  });
  {
    const dram = prices?.series.find((s) => s.id === 'dram-contract-qoq');
    if (dram) {
      const qoq = seriesOf(dram.points.filter((x) => x.period >= '2021Q1' && x.period <= '2026Q4'));
      const idx = chainIndex(new Map([...qoq].filter(([k]) => k !== '2021Q1')), '2021Q1', 100);
      const st = new Map(dram.points.map((x) => [x.period, x.status]));
      derived.push({
        id: 'dram-contract-index', name: 'DRAM 合約價指數（TrendForce，一般型）', unit: '指數（2021Q1 = 100）',
        points: [...idx.entries()].filter(([k]) => k >= '2021Q1').map(([k, v]) => pt(k, v, st.get(k) === 'forecast' ? 'forecast' : 'estimate', 1)),
        note: '由 TrendForce DRAM 合約價季變化（2024Q3 起為一般型、不含 HBM）連乘，2026Q4 為 TrendForce 9 月預測。記憶體漲價推升手機物料成本、壓抑出貨，也推高聯發科電視晶片（含記憶體）的售價；本模型沒有直接用它預測，只作為解讀背景。',
      });
    }
  }

  // ── parameters
  const parameters: ModelOutput['parameters'] = [
    { name: '營收相對財測中值的平均偏差（已扣除匯率差）', value: round((Math.exp(F.beta) - 1) * 100, 2), unit: '%', note: `${TRAIN_FROM}–${TRAIN_TO} 共 ${trQ.length} 季的平均；第 10／90 百分位為 ${signed((Math.exp(F.beta + quantile(F.revResid, Q_LOW)) - 1) * 100, 1)}／${signed((Math.exp(F.beta + quantile(F.revResid, Q_HIGH)) - 1) * 100, 1)}，用來設定 2026Q4 的保守／樂觀情境。` },
    { name: '毛利率相對財測中值的平均偏差（排除一次性項目）', value: round(F.gmGamma, 2), unit: '個百分點', note: `${TRAIN_FROM}–${TRAIN_TO} 的平均；毛利率偏差對匯率差的迴歸斜率每 1% 只有 ${num(F.gmKappaTr, 3)} 個百分點（t 值 ${num(F.gmKappaT, 2)}），不顯著，所以模型不加匯率項。測試期平均偏差為 ${pp(mean(test.map((p) => R(ctx, p).gmEx - R(ctx, p).guide!.gm)), 2)}。第 10／90 百分位為 ${pp(quantile(F.gmResid, Q_LOW), 2)}／${pp(quantile(F.gmResid, Q_HIGH), 2)}。` },
    { name: '營業費用相對財測的平均偏差', value: round((Math.exp(F.opexBias) - 1) * 100, 2), unit: '%', note: '實際營業費用 ÷（財測費用率中值 × 財測營收中值）的平均（訓練期）；營收超出財測時，獎金與研發費用通常也跟著增加。' },
    { name: '2026Q4 財測：營收中值', value: O.guide.rev, unit: '百萬元', note: `${num(O.guide.low / 100, 0)}–${yi(O.guide.high)}（季增 25%–32%），2026-10-30 發布。` },
    { name: '2026Q4 財測：毛利率中值', value: O.guide.gm, unit: '%', note: '± 1.5 個百分點；公司說明資料中心業務毛利率低於公司平均，所以財測調低 1 個百分點。' },
    { name: '2026Q4 財測：營業費用率中值', value: O.guide.opexRatio, unit: '%', note: '± 2 個百分點。' },
    { name: '2026Q4 財測：假設匯率', value: O.guide.fx, unit: '新台幣／美元' },
    { name: '2026Q4 季初至 11 月 13 日平均匯率', value: O.fxQtd, unit: '新台幣／美元', note: `聯準會 H.10 的 30 個營業日平均；比財測假設弱 ${pct((O.fxQtd / O.guide.fx - 1) * 100, 1)}。基準與樂觀情境假設 2026Q4 與 2027 年維持這個水準；保守情境假設其餘 ${FX_DAYS_LEFT} 個營業日回到財測假設 ${num(O.guide.fx, 1)} 元（第四季平均約 ${num(O.fxQ4Low, 2)} 元），2027 年維持 ${num(O.guide.fx, 1)} 元。` },
    { name: '2026 年 10 月營收', value: O.oct, unit: '百萬元', note: `約占財測中值的 ${pct((100 * O.oct) / O.guide.rev, 1)}、基準情境的 ${pct((100 * O.oct) / base.q4.rev, 1)}；2016–2025 年 10 月平均占第四季 ${pct(octMean, 1)}。依首月營收模型（${TRAIN_FROM}–${TRAIN_TO} 第四季首月平均占比 ${pct(F.firstMonth[3]! * 100, 1)}）放大只有約 ${yi(fmNow)}；要達到基準情境，11–12 月平均每月需約 ${yi(needNovDec)}。` },
    { name: '2026Q4 資料中心 ASIC 營收（公司說法）', value: O.asicQ4, unit: '百萬美元', note: `2026-10-30 法說會：首款 AI 加速器 ASIC 9 月開始初期出貨，第四季約 ${usdYi(O.asicQ4)}（2026 年 4 月時說約 ${usdYi(O.asicQ4Low)}）。約占第四季財測營收的 ${pct(O.asicShareQ4 * 100, 1)}。` },
    { name: '第四季財測隱含的 ASIC 毛利率', value: round(O.asicGm.mid, 2), unit: '%', note: `假設非 ASIC 產品毛利率維持 2026 年前三季的 ${pct(O.coreBase, 2)}（換算到財測匯率為 ${pct(coreAtGuide, 2)}），由財測毛利率 ${pct(O.guide.gm, 0)} 反推：（${num(O.guide.gm, 1)} − ${num(coreAtGuide, 2)} × ${num(1 - O.asicShareQ4, 3)}）÷ ${num(O.asicShareQ4, 3)}。財測下緣 ${pct(O.guide.gm - 1.5, 1)} 對應 ${pct(O.asicGm.low, 1)}（保守情境），財測中值加歷史偏差 ${pct(O.guide.gm + F.gmGamma, 2)} 對應 ${pct(O.asicGm.beat, 1)}（樂觀情境）。這是推算值，公司未揭露 ASIC 毛利率。` },
    { name: '每支全球手機營收的趨勢（訓練期）', value: round(ann(F.cRpu), 2), unit: '%／年', note: `${RPU_FROM}–${TRAIN_TO}；2026 年前三季為 ${num(sum(GM_FX_BASE.map((p) => seg(ctx, p).m)) / sum(units2026.slice(0, 3)), 2)} 美元／支，2025 年同期為 ${num(sum(['2025Q1', '2025Q2', '2025Q3'].map((p) => seg(ctx, p).m)) / sum(['2025Q1', '2025Q2', '2025Q3'].map((p) => idc.get(p)!.value)), 2)} 美元／支（以低階機種為主的 Android 品牌受記憶體漲價衝擊最大）。` },
    { name: 'IDC 2026 年全球手機出貨（推算）', value: round(O.idc2026, 1), unit: '百萬支', note: `2025 年 IDC 四季合計 ${num(O.idc2025, 1)} 百萬支 ×（1 − 16.7%）（IDC 2026 年 8 月預測）；扣除前三季後，第四季約 ${num(O.units2026[3]!, 1)} 百萬支（年減 ${pct((1 - O.units2026[3]! / idc.get('2025Q4')!.value) * 100, 1)}）。IDC 的 8 月預測早於第三季年減 22% 的初估，第四季的推算值只用於情境設定。` },
    { name: '2027 年營業費用成長率', value: round(O.opexGrowth, 2), unit: '%', note: '2016–2025 年營業費用的年複合成長率，三個情境相同；2026 年前三季年增約 ' + pct((sum(GM_FX_BASE.map((p) => R(ctx, p).opex)) / sum(['2025Q1', '2025Q2', '2025Q3'].map((p) => R(ctx, p).opex)) - 1) * 100, 1) + '。' },
    { name: '業外收支（每季）', value: round(O.below.nonop, 0), unit: '百萬元', note: `最近四季（${addQ(TEST_TO, -3)}–${TEST_TO}）平均，主要是利息收入；2026 年 10 月發行 39 億美元海外可轉換公司債，利息與可能的轉換都未納入。` },
    { name: '有效稅率', value: round(O.below.tax * 100, 2), unit: '%', note: '最近四季所得稅費用 ÷ 稅前淨利。' },
    { name: '基本 EPS 股數', value: round(O.below.shares, 1), unit: '百萬股', note: `${TEST_TO} 歸屬母公司淨利 ÷ 基本 EPS 推算，預測期不變；淨利歸屬母公司比例 ${pct(O.below.minority * 100, 2)}（最近四季）。` },
  ];

  // ── scenarios
  const usd2025 = sum(qRange('2025Q1', '2025Q4').map((p) => usdOf(R(ctx, p))));
  const usd26 = (q: FcRow) => sum(GM_FX_BASE.map((p) => usdOf(R(ctx, p)))) + q.usd;
  const yoyM = (p: string) => (seg(ctx, p).m / seg(ctx, addQ(p, -4)).m - 1) * 100;
  const yoyI = (p: string) => (R(ctx, p).idc! / R(ctx, addQ(p, -4)).idc! - 1) * 100;
  const bullwhip = `2023 年第一、二季手機營收（美元）年減 ${num(-yoyM('2023Q1'), 0)}%、${num(-yoyM('2023Q2'), 0)}%，同期 IDC 出貨只年減 ${num(-yoyI('2023Q1'), 1)}%、${num(-yoyI('2023Q2'), 1)}%`;
  const rpuOf = (ps: string[]) => sum(ps.map((p) => seg(ctx, p).m)) / sum(ps.map((p) => R(ctx, p).idc!));
  const rpuChg = (rpuOf(GM_FX_BASE) / rpuOf(['2025Q1', '2025Q2', '2025Q3']) - 1) * 100;
  const unitsText = (sc: Scenario) => sc.units === 'q4-implied'
    ? `2027 年每季維持 2026 年第四季的推算水準約 ${num(O.units2026[3]!, 1)} 百萬支`
    : sc.units === 'q3-level' ? `2027 年每季維持 2026 年第三季的 ${num(O.units2026[2]!, 1)} 百萬支` : `2027 年回到 2026 年全年水準（每季約 ${num(O.idc2026 / 4, 1)} 百萬支）`;
  const scenarioOut: ModelOutput['scenarios'] = SCENARIOS.map((sc) => {
    const f = fc[sc.id];
    const units27 = 4 * (sc.units === 'q4-implied' ? O.units2026[3]! : sc.units === 'q3-level' ? O.units2026[2]! : O.idc2026 / 4);
    const fxq4 = q4FxOf(O, sc);
    const resid = sc.resid === 'mid' ? '' : `，再加上訓練期財測誤差的第 ${sc.resid === 'low' ? 10 : 90} 百分位（營收 ${signed((Math.exp(quantile(F.revResid, sc.resid === 'low' ? Q_LOW : Q_HIGH)) - 1) * 100, 1)}、毛利率 ${pp(quantile(F.gmResid, sc.resid === 'low' ? Q_LOW : Q_HIGH), 2)}）`;
    const assumptions: ModelOutput['scenarios'][number]['assumptions'] = [
      { name: '2026Q4 營收與毛利率', value: `財測校正模型：營收 = 財測中值 ${yi(O.guide.rev)} × ${num(Math.exp(F.beta), 4)}（歷史偏差）×（${num(fxq4, sc.fx === 'qtd' ? 3 : 2)} ÷ ${num(O.guide.fx, 1)}）（匯率），毛利率 = 財測 ${pct(O.guide.gm, 0)} 加 ${num(F.gmGamma, 2)} 個百分點（歷史偏差）${resid}`, src: O.guide.src },
      sc.fx === 'qtd'
        ? { name: '匯率（2026Q4 與 2027 年）', value: `${num(O.fxQtd, 3)} 元（2026Q4 季初至 11 月 13 日共 ${FX_DAYS_KNOWN} 個營業日的平均，假設之後不變）`, src: 'fed-h10-tw' }
        : { name: '匯率（2026Q4 與 2027 年）', value: `2026Q4 約 ${num(O.fxQ4Low, 2)} 元：季初至 11 月 13 日的 ${FX_DAYS_KNOWN} 個營業日平均 ${num(O.fxQtd, 3)} 元已知，其餘 ${FX_DAYS_LEFT} 個營業日假設新台幣升值回到第四季財測假設 ${num(O.guide.fx, 1)} 元；2027 年 ${num(O.guide.fx, 1)} 元`, src: 'ir-3q26-deck' },
      { name: '全球手機出貨（2027 年）', value: `${unitsText(sc)}，全年約 ${num(units27, 0)} 百萬支（${Math.abs(units27 / O.idc2026 - 1) < 0.0005 ? '與 2026 年推算值持平' : `較 2026 年推算值 ${signed((units27 / O.idc2026 - 1) * 100, 1)}`}）。IDC 預估 2026 年年減 16.7%、第三季年減 22%，並認為市場到 2027 年仍受記憶體成本壓抑，最快 2028 年復甦（本模型假設）`, src: 'idc-3q26' },
      { name: '記憶體價格（2026 年第四季）', value: 'TrendForce 預測一般型 DRAM 合約價再漲 10–15%，消費性需求持續承壓', src: 'tf-20260930-13258' },
      { name: '記憶體供需（2027 年）', value: 'TrendForce 預期 2027 年 DRAM 供給仍吃緊，手機的記憶體成本壓力延續', src: 'tf-20260730-13158' },
      { name: '每支全球手機帶給聯發科的營收（2027 年）', value: `${sc.rpu ? `${signed(sc.rpu, 0)}：` : ''}${sc.rpu < 0 ? `延續 2026 年前三季的下滑（較 2025 年同期 ${signed(rpuChg, 1)}；以低階機種為主的 Android 品牌受記憶體漲價衝擊最大）` : sc.rpu === 0 ? '持平：公司調漲售價反映供應鏈成本、旗艦市占擴大，抵銷低階機種的流失' : '公司調漲售價、2 奈米旗艦晶片擴大市占的效果大於低階機種流失'}（本模型假設）`, src: sc.rpu < 0 ? 'idc-2026-02' : 'ir-3q26-call' },
      { name: '智慧邊緣平台（不含資料中心 ASIC）', value: `2027 年${sc.edge ? `年增 ${signed(sc.edge, 0)}` : '持平'}（公司預期 2026 年雙位數成長，部分來自電視晶片反映 DRAM 成本的售價調升；2027 年為本模型假設）`, src: 'ir-1q26-call' },
      { name: '電源管理 IC', value: '與手機、智慧邊緣平台的平均年增率相同（本模型假設）' },
      { name: '資料中心 ASIC 營收', value: `2026Q4 約 ${usdYi(O.asicQ4)}；2027 年 ${usdYi(sc.asic)}，由第四季水準線性爬升（${f.rows.map((r) => usdYi(r.asic, 1)).join('、')}）。${sc.asic < asic27.value ? `公司 2026 年 7 月的目標區間下緣（可服務市場 800 億美元 × 市占 15%）` : '公司 2026 年 10 月的說法：達目標區間上緣、約 160 億美元'}`, src: sc.asic < asic27.value ? 'ir-2q26-call' : 'ir-3q26-call' },
      { name: '資料中心 ASIC 毛利率（2027 年）', value: `${pct(f.q4.asicGm, 1)}：由第四季毛利率財測${sc.asicGm === 'low' ? '下緣' : sc.asicGm === 'mid' ? '中值' : '中值加上歷史平均偏差'}推算（公司表示資料中心業務毛利率低於公司平均）。2026Q4 的毛利率仍由財測校正模型估計，不另套用這個假設`, src: 'ir-3q26-call' },
      { name: '非 ASIC 產品毛利率', value: `${pct(f.q4.core, 2)}：2026 年前三季 ${pct(O.coreBase, 2)}，依公司說明的匯率影響換算${sc.coreGm ? `，再 ${pp(sc.coreGm, 0)}（記憶體與供應鏈成本上升未能完全轉嫁）` : ''}`, src: 'ir-2q25-call' },
      { name: '營業費用、業外、稅率與股數', value: `2026Q4 營業費用 ${yi(O.opex2026[3]!)}（財測費用率 × 財測營收 × 歷史偏差），2027 年各季為 2026 年同季 ×（1 + ${pct(O.opexGrowth, 1)}）；業外收支每季 ${yi(O.below.nonop, 1)}、有效稅率 ${pct(O.below.tax * 100, 1)}、股數 ${num(O.below.shares, 0)} 百萬股（最近四季）`, src: 'mops-is' },
    ];
    const q = f.q4;
    const fq4: ModelOutput['scenarios'][number]['forecasts'][number] = {
      period: NEXT, revenue: round(q.rev, 0), grossMargin: round(q.gm, 2), operatingIncome: round(q.oi, 0), netIncome: round(q.ni, 0), eps: round(q.eps, 2), known: [],
      note: `10 月營收 ${yi(O.oct)}已公布，占本情境的 ${pct((100 * O.oct) / q.rev, 1)}（過去十年 10 月平均占第四季 ${pct(octMean, 1)}）。公司財測 ${num(O.guide.low / 100, 0)}–${yi(O.guide.high)}、毛利率 ${pct(O.guide.gm, 0)} ± 1.5 個百分點（假設匯率 ${num(O.guide.fx, 1)} 元）；本情境與財測中值相差營收 ${signed((q.rev / O.guide.rev - 1) * 100, 1)}、毛利率 ${pp(q.gm - O.guide.gm, 2)}。${sc.id === 'base' ? `財測校正模型的回測營收誤差約 ${pct(sel.revenue!.mape!, 1)}（匯率已知）至 ${pct(sel.revenueExAnte!.mape!, 1)}（只用財測假設匯率）、毛利率 ${num(sel.grossMargin!.mae, 2, true)} 個百分點。` : ''}`,
    };
    const y26 = y2026(q);
    const y27 = annualOf(f.rows);
    const forecasts: ModelOutput['scenarios'][number]['forecasts'] = [
      fq4,
      ...f.rows.map((r) => ({
        period: r.period, revenue: round(r.rev, 0), grossMargin: round(r.gm, 2), operatingIncome: round(r.oi, 0), netIncome: round(r.ni, 0), eps: round(r.eps, 2), known: [],
        note: `資料中心 ASIC ${usdYi(r.asic, 1)}（占營收 ${pct((100 * r.asic) / r.usd, 0)}）、非 ASIC ${usdYi(r.nonAsic, 1)}；毛利率 = 非 ASIC ${pct(r.core, 1)} 與 ASIC ${pct(r.asicGm, 1)} 的加權。`,
      })),
      { period: '2026', revenue: round(y26.rev, 0), grossMargin: round(y26.gm, 2), operatingIncome: round(y26.oi, 0), netIncome: round(y26.ni, 0), eps: round(y26.eps, 2), known: [], note: `2026Q1–Q3 為財報實際數，2026Q4 為本情境推估；全年營收較 2025 年 ${signed((y26.rev / y2025.rev - 1) * 100, 1)}（以美元計 ${signed((usd26(q) / usd2025 - 1) * 100, 1)}，公司 2026 年 10 月表示全年以美元計的成長將超過高個位數），EPS 為四季加總。` },
      { period: '2027', revenue: round(y27.rev, 0), grossMargin: round(y27.gm, 2), operatingIncome: round(y27.oi, 0), netIncome: round(y27.ni, 0), eps: round(y27.eps, 2), known: [], note: `四季加總；資料中心 ASIC ${usdYi(sc.asic)}、占營收約 ${pct((100 * sum(f.rows.map((r) => r.asic))) / sum(f.rows.map((r) => r.usd)), 0)}。2027 年沒有公司財測，由產品線結構與情境假設推算；產品線模型逐季回測的營收誤差約 ${pct(sg.revenue!.mape!, 1)}，從 ${TRAIN_TO} 連續推 ${test.length} 季時約 ${pct(sg.revenueDynamic!.mape!, 1)}，多季的預測誤差應以後者看待；2027 年的不確定性主要來自 ASIC 營收與毛利率假設。` },
    ];
    return { id: sc.id, name: sc.name, assumptions, forecasts };
  });

  const bear27 = annualOf(fc.bear.rows);
  const bull27 = annualOf(fc.bull.rows);
  const summary = `選定模型是「財測校正模型」：以聯發科的營收與毛利率財測中值為起點，加上過去財測偏保守的平均幅度（營收約 ${signed((Math.exp(F.beta) - 1) * 100, 1)}、毛利率 ${pp(F.gmGamma, 1)}）與實際匯率的差距。2025Q1–2026Q3 回測營收平均誤差 ${pct(sel.revenue!.mape!, 1)}（匯率只用財測假設的事前版本為 ${pct(sel.revenueExAnte!.mape!, 1)}）、毛利率 ${num(sel.grossMargin!.mae, 2, true)} 個百分點；公司財測本身為 ${pct(gd.revenue!.mape!, 1)}、${num(gd.grossMargin!.mae, 2, true)} 個百分點，天真模型為 ${pct(nv.revenue!.mape!, 1)}、${num(nv.grossMargin!.mae, 2, true)} 個百分點，所以本模型只在營收上勝出，毛利率略遜；照 2026Q4 預測的做法（營收依實際匯率換算、營業費用由財測推算）回測，EPS 平均誤差 ${pct(q4WayEps.mape!, 1)}（匯率與營業費用都只用財測資訊時為 ${pct(sel.epsExAnte!.mape!, 1)}）；完全不用財測、以手機出貨拆解的產品線模型營收誤差 ${pct(sg.revenue!.mape!, 1)}，比天真模型還差。基準情境 2026Q4 營收約 ${yi(base.q4.rev)}（保守至樂觀 ${num(fc.bear.q4.rev / 100, 0)}–${yi(fc.bull.q4.rev)}）、毛利率 ${pct(base.q4.gm, 1)}，但 10 月營收只占 ${pct((100 * O.oct) / base.q4.rev, 0)}，要靠 11–12 月資料中心 ASIC 出貨放量。2027 年依公司資料中心 ASIC 目標約 ${usdYi(baseSc.asic)}推算，營收約 ${yi(baseY27.rev)}、毛利率 ${pct(baseY27.gm, 1)}、EPS ${num(baseY27.eps, 1, true)} 元（保守至樂觀 EPS ${num(bear27.eps, 1, true)}–${num(bull27.eps, 1, true)} 元），這是依假設推算的模型結果，不是投資建議。`;

  const limitations = [
    `逐季預測的準確度主要來自公司財測本身：公司掌握訂單與客戶庫存，公開的驅動因子（IDC 手機出貨、匯率）在同一季的解釋力很低。產品線模型代入當季實際 IDC 出貨時營收誤差 ${pct(sg.revenue!.mape!, 1)}，比天真模型的 ${pct(nv.revenue!.mape!, 1)} 還差，因為聯發科的晶片比手機早一季出貨，又會被客戶的庫存調整放大（${bullwhip}）。IDC 的歷史出貨採最新修正值，與當時的初估略有不同（例如 2025Q3 初估 322.7 百萬支、修正後 327.3 百萬支）。`,
    `2027 年沒有公司財測，數字主要由情境假設決定：資料中心 ASIC 營收（公司目標約 160 億美元、單一未具名客戶、首款產品，第二款與第二家客戶要到 2028 年）、ASIC 毛利率（由第四季財測反推，公司未揭露）、全球手機出貨與每支手機營收、智慧邊緣平台成長率。ASIC 少 20 億美元或毛利率低 5 個百分點，對 2027 年 EPS 的影響見敏感度。2027 年各季以 2026 年同季為基礎：基準情境的第四季營收扣除約 ${usdYi(O.asicQ4)}的 ASIC 後，非 ASIC 營收（美元）比第三季全部營收少約 ${pct((1 - base.q4.nonAsic / usdOf(R(ctx, TEST_TO))) * 100, 0)}，這個低基期與 2026 年每支手機營收逐季下滑的走勢都會延續到 2027 年各季（例如 2027Q1 營收較 2026Q4 ${signed((base.rows[0]!.rev / base.q4.rev - 1) * 100, 0)}），年度合計比單季走勢可靠。`,
    '產品線營收由公司簡報的整數占比換算，每條產品線有約 ±0.5 個百分點的進位誤差；資料中心 ASIC 歸在智慧邊緣平台，2026 年第三季的 ASIC 金額未揭露，本模型把它留在 2026 年的智慧邊緣平台基數中，2027 年第三季可能因此略為重複計算。',
    `財測校正的偏差是 ${TRAIN_FROM}–${TRAIN_TO} 的平均：測試期毛利率已貼近財測中值，訓練期 +${round(F.gmGamma, 2)} 個百分點的偏差可能不再成立；第四季的財測已含 ASIC 拉低毛利率約 1 個百分點的判斷，模型的毛利率仍以財測為準。10 月營收只占基準情境的 ${pct((100 * O.oct) / base.q4.rev, 0)}，若 ASIC 出貨遞延，第四季營收可能低於保守情境。`,
    `匯率假設維持 2026Q4 季初至今的 ${num(O.fxQtd, 2)} 元（保守情境 2026Q4 約 ${num(O.fxQ4Low, 2)} 元、2027 年 ${num(O.guide.fx, 1)} 元），新台幣每升值 1%，新台幣營收約減 1%、毛利率約減 0.2 個百分點（公司說法；訓練期資料看不到毛利率的匯率效果，所以 2026Q4 的毛利率沿用財測校正模型、不含匯率項，2027 年的非 ASIC 毛利率才採用公司說法）。業外收支、稅率與股數依最近四季設定；2026 年 10 月發行的 39 億美元可轉換公司債若轉換，會稀釋 EPS，模型未納入。營業費用依 2016–2025 年的平均成長推估，沒有隨 2027 年獲利大增而額外提高；獎金與員工酬勞通常跟著獲利增加，營業費用多 10% 時 2027 年 EPS 約 ${ntd(sens({ opexMul: 1.1 }).eps)}。`,
    `回測期只有 ${test.length} 季，模型之間的差距（例如毛利率誤差差 0.1–0.4 個百分點）在統計上不顯著；選擇規則以營收誤差為主，毛利率方面排除一次性項目後沿用上一季（${round(sg.grossMargin!.mae, 2)} 個百分點）其實比財測校正（${round(sel.grossMargin!.mae, 2)}）更準。`,
  ];

  // ── source keys used by the model and its texts
  const keys = new Set<string>(['mops-is', 'mops-bs', 'mops-monthly', 'ir-3q26-pr', 'ir-3q26-call', 'ir-3q26-deck', 'ir-2q26-call', 'ir-1q26-call', 'ir-4q25-call', 'ir-2q25-call', 'ir-3q25-call', 'ir-4q24-call', 'ir-1q24-call', 'idc-2026-02', 'idc-2026-08', 'idc-promo', 'idc-3q26', 'fed-h10-tw', 'tf-20260930-13258', 'tf-20260730-13158']);
  for (const r of rows) { keys.add(r.src); if (r.guide) keys.add(r.guide.src); }
  for (const id of ['revenue-share-mobile', 'revenue-share-smart-edge', 'revenue-share-power-ic', 'smartphone-shipments-idc', 'datacenter-asic-revenue', 'guidance-revenue', 'guidance-gross-margin', 'guidance-opex-ratio', 'guidance-fx']) for (const p of driver(drivers, id).values()) keys.add(p.src);
  for (const m of inputs.monthly) keys.add(m.src);
  const dramS = prices?.series.find((s) => s.id === 'dram-contract-qoq');
  if (dramS) for (const p of dramS.points) if (p.period >= '2021Q2') keys.add(p.src);
  const allowed = new Set([...Object.keys(inputs.sources), ...Object.keys(drivers.sources), ...Object.keys(prices?.sources ?? {})]);
  const sourceKeys = [...keys].filter((k) => allowed.has(k)).sort();
  for (const k of keys) if (!allowed.has(k) && !k.startsWith('tf-')) throw new Error(`mediatek: source key ${k} not found`);

  return {
    company: 'mediatek',
    generatedBy: 'scripts/models/mediatek.ts',
    generatedOn: GENERATED_ON,
    asOf: inputs.asOf,
    currency: 'TWD',
    amountUnit: 'million',
    periodLabel: '日曆季度（第一季為 1–3 月），新台幣',
    train: { from: TRAIN_FROM, to: TRAIN_TO },
    test: { from: TEST_FROM, to: TEST_TO },
    lastReported: TEST_TO,
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
  const dir = dirArg > 0 ? process.argv[dirArg + 1]! : 'src/data/forecast';
  const inputs = companyInputs.parse(parse(readFileSync(resolve(dir, 'mediatek-inputs.yaml'), 'utf8')));
  const drivers = companyDrivers.parse(parse(readFileSync(resolve(dir, 'mediatek-drivers.yaml'), 'utf8')));
  const prices = marketPrices.parse(parse(readFileSync('src/data/memory/forecast/market-prices.yaml', 'utf8')));
  const out = buildModel(inputs, prices, drivers);
  writeFileSync(resolve(dir, 'mediatek-model.json'), `${JSON.stringify(out, null, 2)}\n`);
  const sel = out.candidates.find((c) => c.selected)!;
  console.log(`mediatek-model.json written to ${dir}: selected ${sel.id}`);
  for (const c of out.candidates) console.log(`  ${c.id.padEnd(18)} rev MAPE ${c.metrics.revenue?.mape ?? '-'}%  gm MAE ${c.metrics.grossMargin?.mae ?? '-'}pp  eps MAPE ${c.metrics.eps?.mape ?? '-'}%`);
  for (const s of out.scenarios) console.log(`  ${s.id}: ${s.forecasts.map((f) => `${f.period} ${Math.round(f.revenue / 100)}億 ${f.grossMargin}% EPS ${f.eps}`).join(' | ')}`);
}
