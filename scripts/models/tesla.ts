// 特斯拉（Tesla）財報模型：用交車量、每輛車售價與成本、監管積分、儲能部署與服務營收，逐段重建營收與毛利。
//   npx tsx scripts/models/tesla.ts [--dir <資料夾>]   → 寫出 src/data/forecast/tesla-model.json（--dir：改讀寫該資料夾，例如暫存區）
// buildModel(inputs, prices, drivers) 是純函式（不讀檔、不取時間），scripts/check-forecast.ts 會重跑並比對輸出。
//
// 口徑：US GAAP，日曆季度，百萬美元；EPS 為 GAAP 稀釋 EPS（2022 年分割後股數）。
// 特斯拉不提供營收、毛利率或 EPS 財測，所以沒有「財測」對照組；交車與儲能部署在季末約 2 天後的產銷報告公布，
// 比財報早約 3 週。回測代入當季實際交車與部署（＝產銷報告公布後、財報公布前的推估），另列事前版本。
// market-prices.yaml（記憶體合約價）沒有使用：特斯拉沒有揭露記憶體成本對每輛車成本的影響，找不到可量化的關係。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { companyDrivers, companyInputs, marketPrices, type CompanyDrivers, type CompanyInputs, type MarketPrices, type ModelOutput } from '../../src/schemas/forecast';
import { addQ, mean, metrics, predict, qIndex, qRange, round, sum, type Pair } from './lib';
import { BASIC, driver, driverMap, drvOf, fitRegression, fitUnit, histTo, quarterTable, rulesAt, seasonalGuess, step, type Drv, type DriverMap, type Over, type TQ, type UnitParams } from './tesla-lib';

const GENERATED_ON = '2026-11-17';
const FIRST = '2018Q3'; // 第一個有監管積分、租賃交車與季度儲能部署的季度
const TRAIN_FROM = '2018Q4'; // 第一個能算出季變化的季度
const TRAIN_TO = '2024Q4';
const TEST_FROM = '2025Q1';
const TEST_TO = '2026Q3';
const LAST = '2026Q3'; // 最新一季財報（2026-10-21）
const FORECAST = ['2026Q4', '2027Q1', '2027Q2', '2027Q3', '2027Q4'];
const SEASON_YEARS = ['2023', '2024', '2025']; // 2027 年各季分配比重的參考年度
const ELIGIBLE = ['regression', 'unit-basic', 'unit-model'];

/* ───────────── scenarios（來源見 tesla-inputs.yaml／tesla-drivers.yaml） ───────────── */

interface Scenario {
  id: 'bear' | 'base' | 'bull';
  name: string;
  deliv: number; // 交車量相對公司彙整分析師共識的倍數
  storage: 'run-rate' | 'mid' | 'consensus'; // 儲能部署：2026Q3 水準延續／兩者中間／共識
  aspAdd: number; // 每輛車售價：在模型趨勢之外每季多變動（%）
  cpvAdd: number; // 每輛車成本：在模型趨勢之外每季多變動（%）
  credits: 'halve' | 'flat' | 'avg'; // 監管積分：每季減半／維持 2026Q3／回到 2026 年前三季平均
  enGmAdd: number; // 能源毛利率：相對模型規則（個百分點）
  svMult: number; // 服務及其他營收成長：模型趨勢的倍數
}
const SCENARIOS: Scenario[] = [
  { id: 'bear', name: '保守', deliv: 0.9, storage: 'run-rate', aspAdd: -0.5, cpvAdd: 0.5, credits: 'halve', enGmAdd: -5, svMult: 0 },
  { id: 'base', name: '基準', deliv: 1, storage: 'mid', aspAdd: 0, cpvAdd: 0, credits: 'flat', enGmAdd: 0, svMult: 1 },
  { id: 'bull', name: '樂觀', deliv: 1.1, storage: 'consensus', aspAdd: 0.5, cpvAdd: -0.5, credits: 'avg', enGmAdd: 5, svMult: 1 },
];

/* ───────────── context ───────────── */

interface Ctx { rows: TQ[]; by: Map<string, TQ>; dm: DriverMap }
interface Pred { rev: number; gm: number; oi: number; ni: number; eps: number }

/** 回測的獲利換算：營業費用、業外收支、稅與少數股權比例、股數用當季實際值，差異只來自營收與毛利。 */
function bridge(a: TQ, rev: number, gm: number): Pred {
  const k = a.pretax > 0 ? Math.min(Math.max(a.ni / a.pretax, 0.5), 1) : 0.8;
  const oi = (rev * gm) / 100 - a.opex;
  const ni = a.ni + (oi - a.oi) * k;
  return { rev, gm, oi, ni, eps: a.eps + (ni - a.ni) / a.shares };
}
/** 季度開始前就知道的獲利規則（事前版本與情境預測共用）。 */
interface Below { opexLast: number; opexInc8: number; nonOp: number; niRatio: number; shares: number }
function belowAt(by: Map<string, TQ>, last: string): Below {
  const q = (k: number) => by.get(addQ(last, -k))!;
  const l4 = [0, 1, 2, 3].map(q);
  const ratio = sum(l4.map((r) => r.ni)) / sum(l4.map((r) => r.pretax));
  return {
    opexLast: q(0).opex,
    opexInc8: (q(0).opex - q(8).opex) / 8,
    nonOp: mean(l4.map((r) => r.nonOp)),
    niRatio: Math.min(Math.max(ratio, 0.5), 1),
    shares: q(0).shares,
  };
}
/** 事前版本：營業費用沿用上季（訓練期一季前誤差最小的規則）、業外收支取前四季平均、淨利 ÷ 稅前取前四季比例。 */
function exAnteBelow(b: Below, rev: number, gm: number): Pred {
  const oi = (rev * gm) / 100 - b.opexLast;
  const ni = (oi + b.nonOp) * b.niRatio;
  return { rev, gm, oi, ni, eps: ni / b.shares };
}

/* ───────────── forecast ───────────── */

interface FcRow extends TQ { opexF: number; oiF: number; niF: number; epsF: number }
interface Mod { opexMult?: number; delivPct?: number; aspLvl?: number; cpvLvl?: number; creditsZero?: boolean; gwhAdd?: number; enGmAdd?: number; svFlat?: boolean; opexAdd?: number }
interface Paths { D: Record<Scenario['id'], number[]>; G: Record<Scenario['id'], number[]>; leaseShare: number; sO: number; implied: { dQ4: number; gQ4: number; d2027: number; g2027: number; dShares: number[]; gShares: number[] } }

function seasonShares(ctx: Ctx, f: (r: TQ) => number): number[] {
  const per = SEASON_YEARS.map((y) => { const qs = [1, 2, 3, 4].map((k) => f(ctx.by.get(`${y}Q${k}`)!)); const t = sum(qs); return qs.map((v) => v / t); });
  return [0, 1, 2, 3].map((k) => mean(per.map((s) => s[k]!)));
}
function paths(ctx: Ctx): Paths {
  const consQ = driver(ctx.dm, 'deliveries-consensus');
  const consY = driver(ctx.dm, 'deliveries-consensus-annual');
  const sConsQ = driver(ctx.dm, 'storage-consensus');
  const sConsY = driver(ctx.dm, 'storage-consensus-annual');
  const r = (p: string) => ctx.by.get(p)!;
  // 2026-09-29 公布的全年共識含上半年實際與第三季共識，減去後即為當時隱含的第四季
  const dQ4 = consY.get('2026')! - r('2026Q1').D - r('2026Q2').D - consQ.get('2026Q3')!;
  const gQ4 = sConsY.get('2026')! - r('2026Q1').gwh - r('2026Q2').gwh - sConsQ.get('2026Q3')!;
  const d2027 = consY.get('2027')!;
  const g2027 = sConsY.get('2027')!;
  const dShares = seasonShares(ctx, (x) => x.D);
  const gShares = seasonShares(ctx, (x) => x.gwh);
  const last = r(LAST);
  const l4 = [0, 1, 2, 3].map((k) => r(addQ(LAST, -k)));
  const leaseShare = sum(l4.map((x) => x.L)) / sum(l4.map((x) => x.D));
  const D = Object.fromEntries(SCENARIOS.map((s) => [s.id, [dQ4, ...dShares.map((w) => w * d2027)].map((v) => v * s.deliv)])) as Paths['D'];
  const runRate = [last.gwh, ...gShares.map((w) => w * 4 * last.gwh)];
  const cons = [gQ4, ...gShares.map((w) => w * g2027)];
  const G = {
    bear: runRate,
    base: runRate.map((v, i) => (v + cons[i]!) / 2),
    bull: cons,
  };
  return { D, G, leaseShare, sO: last.sO, implied: { dQ4, gQ4, d2027, g2027, dShares, gShares } };
}

function forecast(ctx: Ctx, P: UnitParams, pa: Paths, sc: Scenario, mod: Mod = {}): FcRow[] {
  const last = ctx.rows.at(-1)!;
  const r0 = rulesAt(ctx.rows, P);
  const rules = { enGm: r0.enGm + sc.enGmAdd + (mod.enGmAdd ?? 0), svGm: r0.svGm, svG: mod.svFlat ? 0 : r0.svG * sc.svMult };
  const b = belowAt(ctx.by, LAST);
  const credits0 = last.credits;
  const avg3 = mean(qRange('2026Q1', '2026Q3').map((p) => ctx.by.get(p)!.credits));
  let prev: TQ = last;
  let opexT = b.opexLast;
  const out: FcRow[] = [];
  FORECAST.forEach((p, i) => {
    const D = pa.D[sc.id][i]! * (1 + (mod.delivPct ?? 0) / 100);
    const d: Drv = { period: p, D, L: D * pa.leaseShare, sO: pa.sO, gwh: pa.G[sc.id][i]! + (mod.gwhAdd ?? 0) / 4 };
    const credits = mod.creditsZero ? 0 : sc.credits === 'flat' ? credits0 : sc.credits === 'avg' ? avg3 : credits0 * 0.5 ** (i + 1);
    const o: Over = {
      aspAdd: Math.log(1 + sc.aspAdd / 100) + (i === 0 ? Math.log(1 + (mod.aspLvl ?? 0) / 100) : 0),
      cpvAdd: Math.log(1 + sc.cpvAdd / 100) + (i === 0 ? Math.log(1 + (mod.cpvLvl ?? 0) / 100) : 0),
      credits,
    };
    const s = step(prev, d, P, rules, o);
    opexT += b.opexInc8 * (mod.opexMult ?? 1);
    const opexF = opexT + (mod.opexAdd ?? 0) / 4;
    const oiF = s.gp - opexF;
    const niF = (oiF + b.nonOp) * b.niRatio;
    out.push({ ...s, opexF, oiF, niF, epsF: niF / b.shares });
    prev = s;
  });
  return out;
}
interface Year { rev: number; gp: number; gm: number; oi: number; ni: number; eps: number; D: number; gwh: number }
function yearOf(ctx: Ctx, rows: FcRow[], y: string): Year {
  const act = qRange(`${y}Q1`, `${y}Q4`).flatMap((p) => { const r = ctx.by.get(p); return r ? [r] : []; });
  const fc = rows.filter((r) => r.period.startsWith(y));
  const rev = sum(act.map((r) => r.rev)) + sum(fc.map((r) => r.rev));
  const gp = sum(act.map((r) => r.gp)) + sum(fc.map((r) => r.gp));
  return {
    rev, gp, gm: (100 * gp) / rev,
    oi: sum(act.map((r) => r.oi)) + sum(fc.map((r) => r.oiF)),
    ni: sum(act.map((r) => r.ni)) + sum(fc.map((r) => r.niF)),
    eps: sum(act.map((r) => r.eps)) + sum(fc.map((r) => r.epsF)),
    D: sum(act.map((r) => r.D)) + sum(fc.map((r) => r.D)),
    gwh: sum(act.map((r) => r.gwh)) + sum(fc.map((r) => r.gwh)),
  };
}

/* ───────────── text helpers ───────────── */

/** 固定小數位、千分位；負號用全形減號「−」，四捨五入後為 0 時不加負號。 */
const num = (v: number, d = 2) => { const r = round(v, d); return `${r < 0 ? '−' : ''}${Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`; };
const yi = (m: number) => `${num(m / 100, 0)} 億美元`;
const yi1 = (m: number) => `${num(m / 100, 1)} 億美元`;
const pct = (v: number, d = 1) => `${num(v, d)}%`;
const signed = (v: number, d = 1, unit = '%') => `${round(v, d) >= 0 ? '+' : '−'}${num(Math.abs(v), d)}${unit}`;
const pp = (v: number, d = 1) => `${signed(v, d, '')} 個百分點`;
const usd = (v: number, d = 2) => `${signed(v, d, '')} 美元`;
const veh = (v: number) => `${num(v, 0)} 輛`;
const annualPct = (gq: number) => (Math.exp(4 * gq) - 1) * 100;
const yiSigned = (m: number) => `${signed(m / 100, 1, '')} 億美元`;

/* ───────────── build ───────────── */

/** prices（market-prices.yaml）不使用：特斯拉沒有揭露記憶體成本對每輛車成本的影響。保留參數是為了與 check-forecast 的呼叫方式一致。 */
export function buildModel(inputs: CompanyInputs, _prices: MarketPrices | undefined, drivers: CompanyDrivers | undefined): ModelOutput {
  if (!drivers) throw new Error('tesla model needs tesla-drivers.yaml');
  const dm = driverMap(drivers);
  const rows = quarterTable(inputs, dm, FIRST);
  const ctx: Ctx = { rows, by: new Map(rows.map((r) => [r.period, r])), dm };
  if (rows.at(-1)!.period !== LAST) throw new Error(`tesla inputs must end at ${LAST}`);
  const test = qRange(TEST_FROM, TEST_TO);
  const A = (p: string) => ctx.by.get(p)!;

  // ── fit on training data only
  const unitTr = fitUnit(ctx.by, TRAIN_FROM, TRAIN_TO);
  const regTr = fitRegression(ctx.by, TRAIN_FROM, TRAIN_TO);
  const consD = driver(dm, 'deliveries-consensus');
  const consG = driver(dm, 'storage-consensus');

  // ── one-quarter-ahead predictions in the test window
  const preds: Record<string, Map<string, Pred>> = {};
  const put = (id: string, p: string, x: Pred) => { (preds[id] ??= new Map()).set(p, x); };
  const pureNaive: Pair[] = [];
  const guess = new Map<string, { D: number; G: number }>();
  for (const p of test) {
    const a = A(p);
    const q = A(addQ(p, -1));
    const hist = histTo(ctx.by, addQ(p, -1));
    put('naive', p, bridge(a, q.rev, q.gm));
    pureNaive.push({ actual: a.eps, predicted: q.eps });
    const x = [Math.log(a.D / q.D), Math.log(a.gwh / q.gwh)];
    put('regression', p, bridge(a, q.rev * Math.exp(predict(regTr.rev, x)), predict(regTr.gm, [q.gm, x[0]!])));
    const sb = step(q, { period: p, D: a.D, L: a.L, sO: a.sO, gwh: a.gwh }, BASIC, rulesAt(hist, BASIC));
    put('unit-basic', p, bridge(a, sb.rev, sb.gm));
    const su = step(q, { period: p, D: a.D, L: a.L, sO: a.sO, gwh: a.gwh }, unitTr.P, rulesAt(hist, unitTr.P));
    put('unit-model', p, bridge(a, su.rev, su.gm));
    // 事前版本：交車與部署用「去年同季 × 前四季年增率」，租賃比例與車款組合沿用上季
    const Dg = seasonalGuess((k) => A(k).D, p);
    const Gg = seasonalGuess((k) => A(k).gwh, p);
    guess.set(p, { D: Dg, G: Gg });
    const b = belowAt(ctx.by, addQ(p, -1));
    const se = step(q, { period: p, D: Dg, L: (Dg * q.L) / q.D, sO: q.sO, gwh: Gg }, unitTr.P, rulesAt(hist, unitTr.P));
    put('unit-model-ex-ante', p, exAnteBelow(b, se.rev, se.gm));
    const cd = consD.get(p);
    const cg = consG.get(p);
    if (cd !== undefined && cg !== undefined) {
      const sc = step(q, { period: p, D: cd, L: (cd * q.L) / q.D, sO: q.sO, gwh: cg }, unitTr.P, rulesAt(hist, unitTr.P));
      put('unit-model-consensus', p, exAnteBelow(b, sc.rev, sc.gm));
    }
  }
  const consPeriods = test.filter((p) => preds['unit-model-consensus']?.has(p));

  const METRICS = ['revenue', 'grossMargin', 'operatingIncome', 'netIncome', 'eps'] as const;
  type Metric = (typeof METRICS)[number];
  const field = { revenue: 'rev', grossMargin: 'gm', operatingIncome: 'oi', netIncome: 'ni', eps: 'eps' } as const;
  const actualOf = (a: TQ, m: Metric) => ({ revenue: a.rev, grossMargin: a.gm, operatingIncome: a.oi, netIncome: a.ni, eps: a.eps })[m];
  const pairs = (id: string, m: Metric, only?: string[]): Pair[] =>
    (only ?? test).flatMap((p) => { const x = preds[id]?.get(p)?.[field[m]]; return x === undefined ? [] : [{ actual: actualOf(A(p), m), predicted: x }]; });
  const metricSet = (id: string, only?: string[]) => {
    const out: Record<string, ReturnType<typeof metrics>> = {};
    for (const m of METRICS) { const ps = pairs(id, m, only); if (ps.length) out[m] = metrics(ps, m !== 'grossMargin'); }
    return out;
  };
  const M: Record<string, Record<string, ReturnType<typeof metrics>>> = {};
  for (const id of Object.keys(preds)) M[id] = metricSet(id);
  // 交車與部署本身的事前誤差
  M['unit-model-ex-ante']!.deliveries = metrics(test.map((p) => ({ actual: A(p).D, predicted: guess.get(p)!.D })));
  M['unit-model-ex-ante']!.storage = metrics(test.map((p) => ({ actual: A(p).gwh, predicted: guess.get(p)!.G })));
  M['unit-model-consensus']!.deliveries = metrics(consPeriods.map((p) => ({ actual: A(p).D, predicted: consD.get(p)! })));
  M['unit-model-consensus']!.storage = metrics(consPeriods.map((p) => ({ actual: A(p).gwh, predicted: consG.get(p)! })));
  M.naive!.epsPure = metrics(pureNaive);
  const score = (id: string) => M[id]!.revenue!.mape! + M[id]!.grossMargin!.mae;
  const selected = [...ELIGIBLE].sort((x, y) => score(x) - score(y))[0]!;
  if (selected !== 'unit-model') throw new Error(`selection changed to ${selected}; review the forecast wiring and texts`);
  const sel = M['unit-model']!;
  const nv = M.naive!;
  const ea = M['unit-model-ex-ante']!;
  const cs = M['unit-model-consensus']!;
  const sub = (id: string, m: Metric) => metrics(pairs(id, m, consPeriods), m !== 'grossMargin');
  const beatsGm = sel.grossMargin!.mae < nv.grossMargin!.mae;

  // 與不估計參數的「上季單價直接放大」逐季比較（一季前），以及代入實際交車、往前 2–4 季的多季回測：
  // 檢查估計的參數在較長的預測期間是否仍有幫助（參數只用訓練期估計，起點之後的資料只用當季交車與部署）。
  const ape = (id: string, p: string) => Math.abs(preds[id]!.get(p)!.rev / A(p).rev - 1) * 100;
  const gaps = test.map((p) => ({ p, d: ape('unit-basic', p) - ape('unit-model', p) }));
  const wins = gaps.filter((x) => x.d > 0.5).length;
  const losses = gaps.filter((x) => x.d < -0.5).length;
  const top = [...gaps].sort((x, y) => y.d - x.d)[0]!; // 本模型領先最多的一季
  const sumGap = sum(gaps.map((x) => x.d));
  // 成對 t 值：逐季誤差差距的平均 ÷ 標準誤（|t| < 2 視為不顯著）
  const gapSd = Math.sqrt(sum(gaps.map((x) => (x.d - sumGap / gaps.length) ** 2)) / (gaps.length - 1));
  const gapT = sumGap / gaps.length / (gapSd / Math.sqrt(gaps.length));
  const gapSig = Math.abs(gapT) >= 2;
  const topStep = step(A(addQ(top.p, -1)), drvOf(A(top.p)), unitTr.P, rulesAt(histTo(ctx.by, addQ(top.p, -1)), unitTr.P));
  const topAuto = topStep.autoSales - A(top.p).autoSales;
  const topEn = topStep.en - A(top.p).en;
  const multi = (P: UnitParams) => {
    const rev: number[] = [];
    const gm: number[] = [];
    const sv4: number[] = [];
    for (const o of qRange(TRAIN_TO, addQ(TEST_TO, -2))) {
      const r = rulesAt(histTo(ctx.by, o), P);
      let prev = A(o);
      for (let h = 1; h <= 4 && qIndex(addQ(o, h)) <= qIndex(TEST_TO); h++) {
        const a = A(addQ(o, h));
        const s = step(prev, drvOf(a), P, r);
        if (h >= 2) { rev.push(Math.abs(s.rev / a.rev - 1) * 100); gm.push(Math.abs(s.gm - a.gm)); }
        if (h === 4) sv4.push(Math.abs(s.sv - a.sv));
        prev = s;
      }
    }
    return { rev: mean(rev), gm: mean(gm), sv4: mean(sv4), n: rev.length };
  };
  const msU = multi(unitTr.P);
  const msB = multi(BASIC);
  const lo = (v: number) => (v < 0 ? '低' : '高');
  const vsBasic = `與不估計參數的「上季單價直接放大」相比，${test.length} 季中本模型營收誤差明顯較小（差 0.5 個百分點以上）的有 ${wins} 季、明顯較大的 ${losses} 季、其餘 ${test.length - wins - losses} 季相近；${sumGap > 0 && top.d >= 0.5 * sumGap ? '平均誤差的差距主要來自' : '本模型領先最多的是'} ${top.p}（本模型 ${pct(ape('unit-model', top.p))}、上季單價放大 ${pct(ape('unit-basic', top.p))}；該季本模型的汽車銷售營收${lo(topAuto)}估 ${num(Math.abs(topAuto), 0)}、能源營收${lo(topEn)}估 ${num(Math.abs(topEn), 0)} 百萬美元${Math.sign(topAuto) !== Math.sign(topEn) ? '，部分互相抵銷' : ''}）。逐季差距的成對 t 值（差距平均 ÷ 標準誤，絕對值小於 2 通常視為不顯著）為 ${num(gapT, 1)}，${gapSig ? '差距在統計上顯著' : '差距在統計上不顯著'}。`;
  const vsBasicMulti = `代入實際交車、往前 2–4 季的多季回測（起點 ${TRAIN_TO}–${addQ(TEST_TO, -2)}，共 ${msU.n} 組、彼此重疊）：營收誤差本模型 ${pct(msU.rev)}、上季單價放大 ${pct(msB.rev)}；毛利率誤差 ${num(msU.gm, 2)} 對 ${num(msB.gm, 2)} 個百分點${msU.gm > msB.gm ? '，本模型較差' : ''}；服務及其他營收按前八季趨勢成長的部分在多季時明顯較準（往前 4 季的服務營收平均誤差 ${num(msU.sv4, 0)} 百萬美元，不成長為 ${num(msB.sv4, 0)} 百萬美元），所以基準與樂觀情境保留這個成長規則。`;

  // 營業費用規則：訓練期與測試期的一季前誤差（上季不變 vs 近八季平均增加額）
  const opexRule = (from: string, to: string) => {
    const ps = qRange(from, to);
    const ox = (p: string) => A(p).opex;
    return {
      naive: metrics(ps.map((p) => ({ actual: ox(p), predicted: ox(addQ(p, -1)) }))),
      lin8: metrics(ps.map((p) => ({ actual: ox(p), predicted: ox(addQ(p, -1)) + (ox(addQ(p, -1)) - ox(addQ(p, -9))) / 8 }))),
    };
  };
  const oxTr = opexRule('2020Q4', TRAIN_TO);
  const oxTe = opexRule(TEST_FROM, TEST_TO);

  // ── re-fit on all reported quarters and forecast
  const full = fitUnit(ctx.by, TRAIN_FROM, LAST);
  const pa = paths(ctx);
  const fc = Object.fromEntries(SCENARIOS.map((s) => [s.id, forecast(ctx, full.P, pa, s)])) as Record<Scenario['id'], FcRow[]>;
  const base = fc.base;
  const baseSc = SCENARIOS.find((s) => s.id === 'base')!;
  const Y = (id: Scenario['id'], y: string) => yearOf(ctx, fc[id], y);
  const b27 = Y('base', '2027');
  const r0 = rulesAt(ctx.rows, full.P);
  const below = belowAt(ctx.by, LAST);
  const last = A(LAST);
  // 文字中引用的實際值區間（由資料計算，避免手寫數字）
  const y26q = qRange('2026Q1', LAST).map(A);
  const l4q = qRange(addQ(LAST, -3), LAST).map(A);
  const range = (xs: number[], d = 1, unit = '%') => `${num(Math.min(...xs), d)}${unit}–${num(Math.max(...xs), d)}${unit}`;
  const enGmRange = range(y26q.map((r) => 100 * (1 - r.enC / r.en)));
  const gmRange = range(y26q.map((r) => r.gm));
  const creditsList = y26q.map((r) => num(r.credits, 0)).join('、');
  const fsd = driver(dm, 'fsd-subscriptions').get(LAST);
  const capex25 = qRange('2025Q1', '2025Q4').map((p) => A(p).capex / 100);
  const capex26 = qRange('2026Q2', LAST).map((p) => num(A(p).capex / 100, 0)).join('、');
  const margin1 = 100 * (last.cpv / last.asp) * (1 - 1 / 1.01); // 售價高 1% 時汽車銷售毛利率的變動（個百分點）

  // ── sensitivities on 2027 (base)
  const sens = (mod: Mod) => { const y = yearOf(ctx, forecast(ctx, full.P, pa, baseSc, mod), '2027'); return { rev: y.rev - b27.rev, revPct: (y.rev / b27.rev - 1) * 100, gm: y.gm - b27.gm, oi: y.oi - b27.oi, eps: y.eps - b27.eps }; };
  const sensText = (x: ReturnType<typeof sens>) => {
    const parts: string[] = [];
    if (Math.abs(x.rev) >= 5) parts.push(`營收 ${yiSigned(x.rev)}（${signed(x.revPct, 1)}）`);
    if (Math.abs(x.gm) >= 0.005) parts.push(`毛利率 ${pp(x.gm, 2)}`);
    parts.push(`營業利益 ${yiSigned(x.oi)}`, `EPS ${usd(x.eps)}`);
    return `2027 年${parts.join('、')}${Math.abs(x.rev) < 5 ? '（營收不變）' : ''}`;
  };
  const sensitivities = [
    { driver: '交車量（2026Q4–2027Q4）', change: '每季多 5%', effect: sensText(sens({ delivPct: 5 })) },
    { driver: '交車量（2026Q4–2027Q4）', change: '每季少 5%', effect: sensText(sens({ delivPct: -5 })) },
    { driver: '每輛車平均售價', change: `自 2026Q4 起低 1%（約 ${num(last.asp / 100, 0)} 美元）`, effect: sensText(sens({ aspLvl: -1 })) },
    { driver: '每輛車銷貨成本', change: `自 2026Q4 起高 1%（約 ${num(last.cpv / 100, 0)} 美元，例如關稅、原物料或晶片等零組件漲價）`, effect: sensText(sens({ cpvLvl: 1 })) },
    { driver: '監管積分營收', change: '自 2026Q4 起歸零', effect: sensText(sens({ creditsZero: true })) },
    { driver: '儲能部署', change: '每年多 10 GWh', effect: sensText(sens({ gwhAdd: 10 })) },
    { driver: '能源毛利率', change: '低 5 個百分點', effect: sensText(sens({ enGmAdd: -5 })) },
    { driver: '服務及其他營收', change: '不再成長（維持 2026Q3 水準）', effect: sensText(sens({ svFlat: true })) },
    { driver: '營業費用', change: '全年多 10 億美元', effect: sensText(sens({ opexAdd: 1000 })) },
    { driver: '營業費用', change: `不再增加（維持 ${LAST} 水準，訓練期一季前誤差最小的規則）`, effect: sensText(sens({ opexMult: 0 })) },
  ];

  // ── candidates
  const mt = (id: string) => M[id]!;
  const coef = (v: number, d = 3) => num(v, d);
  const eqUnit = [
    '汽車銷售營收_t = 非租賃交車_t × 每輛車售價_t；汽車銷售成本_t = 非租賃交車_t × 每輛車成本_t（非租賃交車 = 總交車 − 適用營業租賃會計的交車）',
    'ln(每輛車售價_t ÷ 每輛車售價_t−1) = a0 + a1 × Δ其他車款占比_t',
    'ln(每輛車成本_t ÷ 每輛車成本_t−1) = c0 + c1 × ln(非租賃交車_t ÷ 非租賃交車_t−1) + c2 × Δ其他車款占比_t',
    'ln(能源營收_t ÷ 能源營收_t−1) = e0 + e1 × ln(儲能部署_t ÷ 儲能部署_t−1)；能源成本 = 能源營收 ×（1 − 能源毛利率規則）',
    '服務及其他營收_t = 服務及其他營收_t−1 × e^(前八季平均對數成長)；毛利率沿用上季',
    '監管積分、汽車租賃營收與租賃毛利率沿用上季',
    '毛利率_t =（各段營收 − 各段成本）÷ 營收_t',
  ];
  const fitNote = (f: typeof unitTr) =>
    `每輛車售價 a0 = ${coef(f.P.a0, 4)}（約 ${pct(annualPct(f.P.a0), 1)}／年）、a1 = ${coef(f.P.aMix, 2)}；每輛車成本 c0 = ${coef(f.P.c0, 4)}（約 ${pct(annualPct(f.P.c0), 1)}／年）、c1 = ${coef(f.P.cVol, 3)}、c2 = ${coef(f.P.cMix, 2)}；能源營收 e0 = ${coef(f.P.e0, 4)}、e1 = ${coef(f.P.e1, 2)}；能源毛利率規則「${f.P.enRule === 'last' ? '上季' : '前四季平均'}」、服務毛利率規則「${f.P.svRule === 'last' ? '上季' : '前四季平均'}」（R² 售價 ${round(f.r2.asp, 2)}、成本 ${round(f.r2.cpv, 2)}、能源 ${round(f.r2.en, 2)}）`;
  const candidates: ModelOutput['candidates'] = [
    {
      id: 'naive', name: '天真模型（上一季不變）',
      description: '假設本季營收與毛利率都和上一季一樣。這是最簡單的對照組：模型如果贏不了它，就表示那一部分沒有額外的解釋力。特斯拉不提供營收與毛利率財測，所以沒有公司財測可以當對照。其他代入當季實際交車的模型比它多知道當季交車，比較營收時也要看不估計參數的「上季單價直接放大」。',
      equations: ['營收_t = 營收_t−1', '毛利率_t = 毛利率_t−1'],
      metrics: mt('naive'), selected: false,
      note: `營業利益、淨利與 EPS 由營收與毛利率換算，營業費用、業外收支、稅與少數股權比例、股數用當季實際值（與其他代入實際交車的模型相同）。若連 EPS 也直接沿用上季（完全事前），EPS 的 MAPE 為 ${pct(nv.epsPure!.mape!, 1)}（epsPure）。`,
    },
    {
      id: 'regression', name: '交車與部署迴歸',
      description: '不拆業務，直接用歷史資料迴歸：營收的季成長率對交車量與儲能部署的季成長率，毛利率對上季毛利率與交車成長率。簡單，但把售價、成本與產品組合的變化都壓進固定係數。',
      equations: [
        `ln(營收_t ÷ 營收_t−1) = ${coef(regTr.rev[0]!, 4)} ${regTr.rev[1]! < 0 ? '−' : '+'} ${coef(Math.abs(regTr.rev[1]!), 3)} × ln(交車_t ÷ 交車_t−1) ${regTr.rev[2]! < 0 ? '−' : '+'} ${coef(Math.abs(regTr.rev[2]!), 3)} × ln(儲能部署_t ÷ 儲能部署_t−1)`,
        `毛利率_t = ${coef(regTr.gm[0]!, 2)} ${regTr.gm[1]! < 0 ? '−' : '+'} ${coef(Math.abs(regTr.gm[1]!), 3)} × 毛利率_t−1 ${regTr.gm[2]! < 0 ? '−' : '+'} ${coef(Math.abs(regTr.gm[2]!), 2)} × ln(交車_t ÷ 交車_t−1)`,
      ],
      metrics: mt('regression'), selected: false,
      note: `以 ${TRAIN_FROM}–${TRAIN_TO} 共 ${regTr.n} 季估計，交車與部署代入當季實際值。`,
    },
    {
      id: 'unit-basic', name: '單位經濟（上季單價直接放大）',
      description: '把營收拆成汽車銷售、監管積分、汽車租賃、能源、服務及其他五段。汽車銷售＝非租賃交車 × 上季每輛車售價，成本＝非租賃交車 × 上季每輛車成本；能源營收按上季每 kWh 營收乘以本季部署量；其他各段與各段毛利率沿用上季。沒有任何估計參數，用來檢驗「只用交車量放大上季單價」能做到多好。',
      equations: [eqUnit[0]!, '每輛車售價_t = 每輛車售價_t−1；每輛車成本_t = 每輛車成本_t−1', '能源營收_t = 儲能部署_t ×（能源營收_t−1 ÷ 儲能部署_t−1）', '監管積分、租賃、服務及其他營收與各段毛利率沿用上季'],
      metrics: mt('unit-basic'), selected: false,
      note: '交車量（含租賃交車、車款組合）與儲能部署代入當季實際值。',
    },
    {
      id: 'unit-model', name: '交車驅動的單位經濟模型',
      description: '在「上季單價直接放大」之上，用訓練期資料估計售價與成本的變化：每輛車售價有長期趨勢，並隨高價車款（Model S／X、Cybertruck）占比上升而提高；每輛車成本除了趨勢與車款組合，還有「量大時固定成本被攤薄」的效果；能源營收對儲能部署的彈性小於 1（營收含太陽能等不隨部署變動的部分）；服務及其他營收按前八季平均成長率成長。監管積分幾乎沒有成本，直接墊高毛利率，所以單獨處理。',
      equations: eqUnit,
      metrics: mt('unit-model'), selected: true,
      note: `以 ${TRAIN_FROM}–${TRAIN_TO} 共 ${unitTr.n} 季估計：${fitNote(unitTr)}。毛利率規則依訓練期一季前的分段毛利誤差選擇（能源：上季 ${num(unitTr.ruleErr.en.last, 0)}、前四季平均 ${num(unitTr.ruleErr.en.ttm, 0)} 百萬美元；服務：${num(unitTr.ruleErr.sv.last, 0)}、${num(unitTr.ruleErr.sv.ttm, 0)} 百萬美元）。選擇規則：在代入當季實際交車與部署的三個模型（交車與部署迴歸、單位經濟上季單價放大、本模型）中，取「營收 MAPE（%）＋ 毛利率 MAE（個百分點）」最小者：本模型 ${num(score('unit-model'), 2)}、上季單價放大 ${num(score('unit-basic'), 2)}、迴歸 ${num(score('regression'), 2)}。${vsBasic}${vsBasicMulti}${beatsGm ? '' : `本模型的營收誤差遠小於天真模型（${pct(sel.revenue!.mape!, 1)} 對 ${pct(nv.revenue!.mape!, 1)}），但毛利率誤差 ${num(sel.grossMargin!.mae, 2)} 個百分點並沒有比天真模型（${num(nv.grossMargin!.mae, 2)} 個百分點）小：特斯拉的毛利率常被保固費用、關稅相關利益與退款等一次性項目推動，模型沿用上季的每輛車成本與分段毛利率，會把上季的一次性項目帶進下一季。`}`,
    },
    {
      id: 'unit-model-ex-ante', name: '單位經濟模型（事前版本：交車與部署也要預測）',
      description: '與選定模型完全相同，但交車量與儲能部署改用季度開始前就能算出的規則：去年同季 × 前四季的年增率；租賃交車比例與車款組合沿用上季。營業利益、淨利與 EPS 也改用事前規則：營業費用沿用上季、業外收支取前四季平均、淨利對稅前淨利的比例取前四季。這相當於上一季財報公布後（本季開始約 3–4 週）就能做的完整預測。情境預測用同樣的分段結構，但營業費用改用近八季平均增加額（見參數）。',
      equations: ['交車_t（預測）= 交車_t−4 ×（交車_t−1 至 t−4 合計 ÷ 交車_t−5 至 t−8 合計）；儲能部署同理', '其餘同「交車驅動的單位經濟模型」', '營業利益 = 毛利 − 上季營業費用；淨利 =（營業利益 + 前四季平均業外收支）× 前四季淨利 ÷ 稅前淨利'],
      metrics: mt('unit-model-ex-ante'), selected: false,
      note: `不參與模型選擇：參數與選定模型相同。交車量本身的事前誤差（deliveries）MAPE ${pct(ea.deliveries!.mape!, 1)}、儲能部署（storage）MAPE ${pct(ea.storage!.mape!, 1)}，是營收誤差由 ${pct(sel.revenue!.mape!, 1)} 升到 ${pct(ea.revenue!.mape!, 1)} 的主因；毛利率誤差 ${num(ea.grossMargin!.mae, 2)} 個百分點，和代入實際交車時（${num(sel.grossMargin!.mae, 2)} 個百分點）差不多，表示毛利率的誤差主要不是來自交車量。營業費用沿用上季是訓練期一季前誤差最小的規則（MAPE ${pct(oxTr.naive.mape!, 1)}，近八季平均增加額為 ${pct(oxTr.lin8.mape!, 1)}）；測試期營業費用每季增加，這個規則的 MAPE 為 ${pct(oxTe.naive.mape!, 1)}、平均每季低估約 ${yi1(-oxTe.naive.bias)}。`,
    },
    {
      id: 'unit-model-consensus', name: '單位經濟模型（交車與部署改用公司彙整的分析師共識，診斷用）',
      description: `與事前版本相同，但交車與儲能部署改用特斯拉投資人關係網站在季末前公布的分析師共識（第三方估計，公司不背書）。共識只有 ${consPeriods.length} 季（${consPeriods[0]}–${consPeriods.at(-1)}），樣本太少，只用來對照事前版本。`,
      equations: ['交車_t、儲能部署_t = 季末前公布的共識平均值；其餘同事前版本'],
      metrics: mt('unit-model-consensus'), selected: false,
      note: `不參與模型選擇。同樣 ${consPeriods.length} 季：共識交車 MAPE ${pct(cs.deliveries!.mape!, 1)}、儲能部署 MAPE ${pct(cs.storage!.mape!, 1)}；營收 MAPE ${pct(cs.revenue!.mape!, 1)}，事前版本 ${pct(sub('unit-model-ex-ante', 'revenue').mape!, 1)}、代入實際交車 ${pct(sub('unit-model', 'revenue').mape!, 1)}、天真模型 ${pct(sub('naive', 'revenue').mape!, 1)}。`,
    },
  ];

  // ── backtest rows
  const backtest: ModelOutput['backtest'] = [];
  for (const id of ['unit-model', 'unit-model-ex-ante', 'unit-model-consensus', 'unit-basic', 'regression', 'naive']) {
    for (const m of METRICS) for (const p of test) {
      const x = preds[id]?.get(p)?.[field[m]];
      if (x === undefined) continue;
      const d = m === 'grossMargin' || m === 'eps' ? 2 : 0;
      const bm = preds.naive!.get(p)![field[m]];
      backtest.push({
        period: p, metric: m, actual: round(actualOf(A(p), m), d), predicted: round(x, d), candidate: id,
        ...(id !== 'naive' ? { benchmark: round(bm, d), benchmarkLabel: '天真模型（上季不變）' } : {}),
      });
    }
  }

  // ── derived series
  type Status = 'actual' | 'estimate' | 'forecast';
  const series = (f: (r: TQ) => number, d: number, hist: Status = 'estimate') => [
    ...rows.map((r) => ({ period: r.period, value: round(f(r), d), status: hist })),
    ...base.map((r) => ({ period: r.period, value: round(f(r), d), status: 'forecast' as const })),
  ];
  const contrib = (f: (r: TQ) => number) => series((r) => (100 * f(r)) / r.rev, 2);
  const derived: ModelOutput['derived'] = [
    { id: 'asp-per-vehicle', name: '每輛車平均售價（推算）', unit: '美元／輛', points: series((r) => r.asp, 0), note: '汽車銷售營收（不含監管積分與租賃，含 FSD 等附加銷售與匯率影響）÷ 非租賃交車。' + `${FORECAST[0]} 起為基準情境的模型值。` },
    { id: 'cost-per-vehicle', name: '每輛車銷貨成本（推算）', unit: '美元／輛', points: series((r) => r.cpv, 0), note: '汽車銷售成本 ÷ 非租賃交車（公司定義的「每輛車銷貨成本」）。' + `${FORECAST[0]} 起為基準情境的模型值。` },
    { id: 'auto-sales-margin', name: '汽車銷售毛利率（不含監管積分與租賃）', unit: '%', points: series((r) => 100 * (1 - r.cpv / r.asp), 2), note: '（每輛車售價 − 每輛車成本）÷ 每輛車售價；比公司的「汽車毛利率（不含積分）」少了租賃，兩者差距多在 1 個百分點內。' },
    { id: 'gm-contrib-auto-sales', name: '毛利率組成：汽車銷售', unit: '個百分點', points: contrib((r) => r.autoSales - r.autoSalesC), note: '各段毛利 ÷ 總營收；五段相加等於總毛利率。' },
    { id: 'gm-contrib-credits', name: '毛利率組成：監管積分', unit: '個百分點', points: contrib((r) => r.credits), note: '監管積分幾乎沒有對應成本，整筆計入毛利。' },
    { id: 'gm-contrib-leasing', name: '毛利率組成：汽車租賃', unit: '個百分點', points: contrib((r) => r.lease - r.leaseC) },
    { id: 'gm-contrib-energy', name: '毛利率組成：能源發電與儲能', unit: '個百分點', points: contrib((r) => r.en - r.enC) },
    { id: 'gm-contrib-services', name: '毛利率組成：服務及其他', unit: '個百分點', points: contrib((r) => r.sv - r.svC) },
    { id: 'energy-revenue-per-kwh', name: '能源營收 ÷ 儲能部署', unit: '美元／kWh', points: series((r) => r.en / r.gwh, 0), note: '能源發電與儲能營收（含太陽能與服務）÷ 當季儲能部署量，不是儲能產品的售價；部署量小的季度會被不隨部署變動的營收墊高。' },
    { id: 'energy-gross-margin', name: '能源發電與儲能毛利率', unit: '%', points: series((r) => 100 * (1 - r.enC / r.en), 1, 'actual'), note: `${FORECAST[0]} 起為基準情境假設（${pct(r0.enGm, 1)}，${full.P.enRule === 'ttm' ? '前四季平均' : '上季'}）。` },
    { id: 'credits-revenue', name: '監管積分營收', unit: '百萬美元', points: series((r) => r.credits, 0, 'actual'), note: `${FORECAST[0]} 起為基準情境假設（維持 ${LAST} 水準）。` },
    {
      id: 'operating-expenses', name: '營業費用', unit: '百萬美元',
      points: [...rows.map((r) => ({ period: r.period, value: r.opex, status: 'actual' as const })), ...base.map((r) => ({ period: r.period, value: round(r.opexF, 0), status: 'forecast' as const }))],
      note: `含研發、銷管與重組費用。${FORECAST[0]} 起為三個情境共用的假設：每季增加近八季平均增加額（約 ${yi1(below.opexInc8)}）。`,
    },
    { id: 'rd-to-revenue', name: '研發費用占營收比重', unit: '%', points: rows.map((r) => ({ period: r.period, value: round((100 * r.rd) / r.rev, 2), status: 'actual' as const })), note: '研發費用 ÷ 總營收（實際值）。' },
  ];

  // ── parameters
  const mixShare = (p: string) => A(p).sO * 100;
  const parameters: ModelOutput['parameters'] = [
    { name: '每輛車售價趨勢 a0（全期估計）', value: round(annualPct(full.P.a0), 2), unit: '%／年', note: `${TRAIN_FROM}–${LAST} 估計；訓練期（至 ${TRAIN_TO}）為 ${num(annualPct(unitTr.P.a0), 2)}%／年，反映 2023–2024 年的降價。2025 年起售價大致持平。` },
    { name: '其他車款占比對售價的影響 a1', value: round(full.P.aMix, 3), note: `其他車款（Model S／X、Cybertruck）占交車比重每增加 1 個百分點，每輛車售價約增 ${num(full.P.aMix, 2)}%。占比由 2018Q3 的 ${num(mixShare('2018Q3'), 1)}% 降到 ${LAST} 的 ${num(mixShare(LAST), 1)}%（Fremont 的 Model S／X 產線已停用，ex-q2-2026），之後這個因子的影響很小。` },
    { name: '每輛車成本趨勢 c0（全期估計）', value: round(annualPct(full.P.c0), 2), unit: '%／年', note: `訓練期為 ${num(annualPct(unitTr.P.c0), 2)}%／年。` },
    { name: '量的攤提效果 c1（成本對交車量的彈性）', value: round(full.P.cVol, 3), note: `非租賃交車季增 10%，每輛車成本約${full.P.cVol < 0 ? '降' : '升'} ${num(Math.abs(full.P.cVol) * 10, 2)}%；訓練期為 ${num(unitTr.P.cVol, 3)}。效果不大，表示汽車成本大多隨量變動。` },
    { name: '其他車款占比對成本的影響 c2', value: round(full.P.cMix, 3), note: `訓練期為 ${num(unitTr.P.cMix, 3)}；與售價係數 a1 接近，高價車款的售價與成本一起高。` },
    { name: '能源營收對儲能部署的彈性 e1', value: round(full.P.e1, 3), note: `部署增加 10%，能源營收約增 ${num(full.P.e1 * 10, 1)}%；訓練期為 ${num(unitTr.P.e1, 3)}。彈性小於 1，因為能源營收也含太陽能與服務等不隨部署變動的部分，部署量與營收認列的時點也可能不同。` },
    { name: '能源毛利率（情境起點）', value: round(r0.enGm, 2), unit: '%', note: `全期資料下，一季前的能源毛利誤差以「${full.P.enRule === 'ttm' ? '前四季平均' : '上季'}」較小（上季 ${num(full.ruleErr.en.last, 0)}、前四季平均 ${num(full.ruleErr.en.ttm, 0)} 百萬美元；訓練期選的是「${unitTr.P.enRule === 'ttm' ? '前四季平均' : '上季'}」），情境預測採 ${full.P.enRule === 'ttm' ? `${addQ(LAST, -3)}–${LAST} 平均` : `${LAST} 的值`}。2026 年前三季能源毛利率在 ${enGmRange} 之間：第一季有保固與關稅相關的一次性利益（ex-q1-2026）、第二季有供應商電芯問題的保固費用（ex-q2-2026）。` },
    { name: '服務及其他營收成長（前八季平均）', value: round(annualPct(r0.svG), 1), unit: '%／年', note: `每季約 ${pct((Math.exp(r0.svG) - 1) * 100, 1)}（${addQ(LAST, -8)}–${LAST}）；成長並不平均：${addQ(LAST, -1)} 季增 ${pct((A(addQ(LAST, -1)).sv / A(addQ(LAST, -2)).sv - 1) * 100, 1)}、${LAST} 季增 ${pct((last.sv / A(addQ(LAST, -1)).sv - 1) * 100, 1)}。特斯拉表示車隊擴大與效率改善會讓服務獲利持續成長（ex-q2-2026），但沒有給數字；毛利率沿用 ${LAST} 的 ${pct(r0.svGm, 1)}。` },
    { name: '公司彙整共識隱含的 2026Q4 交車', value: round(pa.implied.dQ4, 0), unit: '輛', note: `2026-09-29 公布的全年共識 ${veh(driver(dm, 'deliveries-consensus-annual').get('2026')!)}減去第一、二季實際與第三季共識 ${veh(consD.get('2026Q3')!)}（第三方估計，consensus-q3-2026）。實際第三季交車 ${veh(A('2026Q3').D)}，比共識多 ${pct((A('2026Q3').D / consD.get('2026Q3')! - 1) * 100, 1)}。` },
    { name: '公司彙整的 2027 年交車共識', value: round(pa.implied.d2027, 0), unit: '輛', note: `2026-09-29 公布（第三方估計，consensus-q3-2026-dtc；報導只寫到萬輛，約 ${num(pa.implied.d2027 / 1e4, 0)} 萬輛），在 ${LAST} 交車公布之前；6 月公布的 2027 年共識較低，當時 2026 年共識還沒上修。2027 年交車約比基準情境的 2026 年多 ${pct((pa.implied.d2027 / (sum(qRange('2026Q1', LAST).map((p) => A(p).D)) + pa.implied.dQ4) - 1) * 100, 1)}。各季依 2023–2025 年平均季節比重分配（第一至第四季 ` + pa.implied.dShares.map((v) => pct(v * 100, 1)).join('、') + '）。' },
    { name: '公司彙整共識隱含的 2026Q4 儲能部署', value: round(pa.implied.gQ4, 1), unit: 'GWh', note: `全年共識 ${num(driver(dm, 'storage-consensus-annual').get('2026')!, 1)} GWh 減第一、二季實際與第三季共識（consensus-q3-2026）。2026 年三季的共識都高於實際（實際比共識少 ${consPeriods.map((p) => pct((1 - A(p).gwh / consG.get(p)!) * 100, 0)).join('、')}），所以基準情境取共識與 ${LAST} 水準（${num(last.gwh, 1)} GWh）的中間。` },
    { name: '租賃交車占比（前四季）', value: round(pa.leaseShare * 100, 2), unit: '%', note: '適用營業租賃會計的交車占總交車比重，2025Q4–2026Q3 合計；預測期三個情境相同。' },
    { name: '營業費用每季增加額（近八季平均）', value: round(below.opexInc8, 0), unit: '百萬美元', note: `${addQ(LAST, -8)} 到 ${LAST} 的營業費用增加額 ÷ 8。訓練期（2020Q4–${TRAIN_TO}）一季前誤差以「上季不變」較小（MAPE ${pct(oxTr.naive.mape!, 1)}，這個規則 ${pct(oxTr.lin8.mape!, 1)}）；測試期營業費用每季增加，這個規則較準（MAPE ${pct(oxTe.lin8.mape!, 1)}，上季不變 ${pct(oxTe.naive.mape!, 1)}），而且特斯拉表示 SI 研發與股份基礎給付推高費用、年底前把 SI 訓練運算擴大到 400 MW（ex-q3-2026），所以三個情境都採這個規則（看過測試期後的選擇，在此揭露）；維持 ${LAST} 水準的影響見敏感度。` },
    { name: '業外收支（每季，前四季平均）', value: round(below.nonOp, 0), unit: '百萬美元', note: `含利息收支、匯兌與數位資產公允價值變動，波動大；${addQ(LAST, -3)}–${LAST} 各季為 ${l4q.map((r) => num(r.nonOp, 0)).join('、')} 百萬美元。` },
    { name: '歸屬普通股股東淨利 ÷ 稅前淨利（前四季）', value: round(below.niRatio, 3), note: '反映所得稅與少數股權；三個情境相同。' },
    { name: '稀釋股數', value: below.shares, unit: '百萬股', note: `${LAST} 的稀釋加權平均股數，預測期不變。` },
  ];

  // ── scenarios
  const creditsText = (s: Scenario) =>
    s.credits === 'flat' ? `維持 ${LAST} 的 ${num(last.credits, 0)} 百萬美元` : s.credits === 'avg' ? `回到 2026 年前三季平均約 ${num(mean(qRange('2026Q1', '2026Q3').map((p) => A(p).credits)), 0)} 百萬美元` : `每季減半（2026Q4 約 ${num(last.credits / 2, 0)} 百萬美元，2027Q4 約 ${num(last.credits / 32, 0)} 百萬美元）`;
  const scenarioOut: ModelOutput['scenarios'] = SCENARIOS.map((sc) => {
    const rowsF = fc[sc.id];
    const y26 = Y(sc.id, '2026');
    const y27 = Y(sc.id, '2027');
    const g27 = sum(rowsF.slice(1).map((r) => r.gwh));
    const d27 = sum(rowsF.slice(1).map((r) => r.D));
    const devText = consPeriods.map((p) => signed((A(p).D / consD.get(p)! - 1) * 100, 0)).join('、');
    const scaleText = sc.deliv === 1 ? '採公司彙整的分析師共識' : `比公司彙整的分析師共識${sc.deliv > 1 ? '多' : '少'} ${num(Math.abs(sc.deliv - 1) * 100, 0)}%`;
    const storageQ4 = sc.storage === 'run-rate'
      ? `維持 ${LAST} 的 ${num(last.gwh, 1)} GWh；2026 年三季的共識都高於實際，保守情境假設不再成長`
      : sc.storage === 'consensus'
        ? `${num(pa.implied.gQ4, 1)} GWh：2026-09-29 公布的全年共識 ${num(driver(dm, 'storage-consensus-annual').get('2026')!, 1)} GWh 減第一、二季實際與第三季共識（第三方估計）`
        : `${num(rowsF[0]!.gwh, 1)} GWh：取 ${LAST} 水準（${num(last.gwh, 1)} GWh）與共識隱含值（${num(pa.implied.gQ4, 1)} GWh）的中間，因為 2026 年三季的共識都高於實際`;
    const storage27 = sc.storage === 'run-rate'
      ? `${num(g27, 1)} GWh（${LAST} 水準 × 4）；德州 Megafactory 已開始生產（規劃 50 GWh），保守情境假設新產能在 2027 年沒有轉成更多部署`
      : sc.storage === 'consensus'
        ? `${num(g27, 1)} GWh，採 2026-09-29 公布的全年共識（第三方估計）`
        : `${num(g27, 1)} GWh，取 ${LAST} 水準 × 4 與全年共識 ${num(pa.implied.g2027, 1)} GWh（第三方估計）的中間；德州 Megafactory 已開始生產（規劃 50 GWh）`;
    const assumptions: ModelOutput['scenarios'][number]['assumptions'] = [
      {
        name: '2026 年第四季交車',
        value: `${veh(rowsF[0]!.D)}：${scaleText}（2026-09-29 公布的全年共識 ${veh(driver(dm, 'deliveries-consensus-annual').get('2026')!)}減第一、二季實際與第三季共識，隱含 ${veh(pa.implied.dQ4)}；第三方估計，公司不背書）。2026 年前三季實際交車比季末前的共識 ${devText}，因此以 ±10% 作為保守與樂觀的範圍`,
        src: 'consensus-q3-2026',
      },
      {
        name: '2027 年交車',
        value: `${veh(d27)}：${scaleText}（2026-09-29 公布的 2027 年共識約 ${num(pa.implied.d2027 / 1e4, 0)} 萬輛，報導只寫到萬輛；第三季實際交車高於共識的部分沒有反映；第三方估計，公司不背書）`,
        src: 'consensus-q3-2026-dtc',
      },
      { name: '交車的季節分配與組合', value: `2027 年各季依 2023–2025 年平均季節比重分配；租賃交車占 ${pct(pa.leaseShare * 100, 1)}、其他車款占 ${pct(pa.sO * 100, 1)}（${LAST} 水準，Model S／X 產線已停用）`, src: 'ex-q2-2026' },
      {
        name: '每輛車售價',
        value: sc.aspAdd === 0
          ? `依模型趨勢（約 ${pct(annualPct(full.P.a0), 1)}／年，幾乎持平），由 ${LAST} 的約 ${num(last.asp, 0)} 美元出發`
          : `模型趨勢之外每季${sc.aspAdd > 0 ? '多漲' : '多降'} ${num(Math.abs(sc.aspAdd), 1)}%（本模型假設）：${sc.aspAdd < 0 ? '較便宜的 Standard 車款（2025 年 10 月推出）比重提高，或以銷售優惠支撐需求' : `FSD 改為只提供訂閱後訂閱數成長（${LAST} 有效訂閱 ${num((fsd ?? 0) * 100, 0)} 萬），附加銷售增加`}`,
        src: sc.aspAdd < 0 ? 'ex-q3-2025' : 'ex-q3-2026',
      },
      {
        name: '每輛車銷貨成本',
        value: sc.cpvAdd === 0
          ? `依模型趨勢（約 ${pct(annualPct(full.P.c0), 1)}／年）與量的攤提效果，由 ${LAST} 的約 ${num(last.cpv, 0)} 美元出發`
          : sc.cpvAdd > 0
            ? `模型趨勢之外每季多升 ${num(sc.cpvAdd, 1)}%（本模型假設）：關稅與固定成本分攤曾使每輛車成本上升（ex-q3-2025、ex-q4-2025）；特斯拉提到要確保記憶體等晶片的長期供應，但沒有說明成本影響`
            : `模型趨勢之外每季多降 ${num(Math.abs(sc.cpvAdd), 1)}%（本模型假設）：材料成本下降（ex-q1-2026）、BNEF 估計 2025 年電動車電池包均價降到每 kWh 99 美元並預期續降（第三方估計）`,
        src: sc.cpvAdd > 0 ? 'ex-q4-2025' : sc.cpvAdd < 0 ? 'bnef-2025' : 'ex-q3-2026',
      },
      { name: '監管積分營收', value: `${creditsText(sc)}；2026 年各季為 ${creditsList} 百萬美元，持續下降`, src: 'ex-q3-2026' },
      { name: '2026 年第四季儲能部署', value: storageQ4, src: sc.storage === 'run-rate' ? 'ex-q3-2026' : 'consensus-q3-2026' },
      { name: '2027 年儲能部署', value: storage27, src: sc.storage === 'run-rate' ? 'ex-q3-2026' : 'consensus-q3-2026-dtc' },
      { name: '能源毛利率', value: `${pct(r0.enGm + sc.enGmAdd, 1)}（${full.P.enRule === 'ttm' ? '前四季平均' : '上季'}${sc.enGmAdd === 0 ? '' : ` ${pp(sc.enGmAdd, 0)}`}）；2026 年前三季在 ${enGmRange} 之間，含一次性保固費用與關稅相關的客戶退款`, src: 'ex-q3-2026' },
      { name: '服務及其他營收', value: sc.svMult === 0 ? `維持 ${LAST} 的 ${yi(last.sv)}／季` : `每季成長約 ${pct((Math.exp(r0.svG * sc.svMult) - 1) * 100, 1)}（前八季平均），毛利率 ${pct(r0.svGm, 1)}`, src: 'ex-q3-2026' },
      { name: '營業費用（三個情境相同）', value: `每季增加約 ${yi1(below.opexInc8)}（近八季平均增加額），2027 年合計約 ${yi(sum(rowsF.slice(1).map((r) => r.opexF)))}；維持 ${LAST} 水準的影響見敏感度；特斯拉表示 SI 研發、股份基礎給付與銷管費用推高營業費用，並計畫在年底前把 SI 訓練運算擴大到 400 MW`, src: 'ex-q3-2026' },
      { name: '業外、稅與股數', value: `業外收支每季約 ${yi1(below.nonOp)}（前四季平均）；淨利 ÷ 稅前淨利 ${num(below.niRatio, 3)}（前四季）；稀釋股數 ${num(below.shares, 0)} 百萬股`, src: 'ex-q3-2026' },
    ];
    const forecasts: ModelOutput['scenarios'][number]['forecasts'] = rowsF.map((r) => ({
      period: r.period,
      revenue: round(r.rev, 0), grossMargin: round(r.gm, 2), operatingIncome: round(r.oiF, 0), netIncome: round(r.niF, 0), eps: round(r.epsF, 2),
      known: [],
      note: `交車 ${veh(r.D)}、每輛車售價 ${num(r.asp, 0)} 美元、成本 ${num(r.cpv, 0)} 美元；汽車營收 ${yi(r.autoSales + r.credits + r.lease)}（監管積分 ${num(r.credits, 0)} 百萬美元）、能源 ${yi(r.en)}（部署 ${num(r.gwh, 1)} GWh）、服務及其他 ${yi(r.sv)}；營業費用 ${yi(r.opexF)}。`,
    }));
    forecasts.push(
      { period: '2026', revenue: round(y26.rev, 0), grossMargin: round(y26.gm, 2), operatingIncome: round(y26.oi, 0), netIncome: round(y26.ni, 0), eps: round(y26.eps, 2), known: [], note: `第一至第三季為實際值，第四季為模型值；全年交車 ${veh(y26.D)}、儲能部署 ${num(y26.gwh, 1)} GWh。EPS 為四季加總。` },
      { period: '2027', revenue: round(y27.rev, 0), grossMargin: round(y27.gm, 2), operatingIncome: round(y27.oi, 0), netIncome: round(y27.ni, 0), eps: round(y27.eps, 2), known: [], note: `四季加總；毛利率為全年毛利 ÷ 全年營收。全年交車 ${veh(y27.D)}、儲能部署 ${num(y27.gwh, 1)} GWh。` },
    );
    return { id: sc.id, name: sc.name, assumptions, forecasts };
  });

  const bear27 = Y('bear', '2027');
  const bull27 = Y('bull', '2027');
  const q4 = base[0]!;
  const opexFlat = sens({ opexMult: 0 });
  const summary = `選定模型是「交車驅動的單位經濟模型」：汽車銷售營收＝非租賃交車 × 每輛車售價、成本＝非租賃交車 × 每輛車成本，再加上監管積分、租賃、隨儲能部署變動的能源營收與服務營收。${TEST_FROM}–${TEST_TO} 回測代入當季實際交車與部署（產銷報告公布後、財報公布前的推估），營收平均誤差（MAPE）${pct(sel.revenue!.mape!, 1)}；不估計參數、只把上季每輛車售價與成本乘上當季交車的版本為 ${pct(M['unit-basic']!.revenue!.mape!, 1)}，${gapSig ? '差距顯著' : '差距在統計上不顯著'}；不知道交車的天真模型為 ${pct(nv.revenue!.mape!, 1)}。毛利率平均誤差 ${num(sel.grossMargin!.mae, 1)} 個百分點，${beatsGm ? `優於天真模型的 ${num(nv.grossMargin!.mae, 1)} 個百分點` : `沒有比天真模型（${num(nv.grossMargin!.mae, 1)} 個百分點）好`}；交車也要事前預測時，營收誤差升到 ${pct(ea.revenue!.mape!, 1)}。基準情境（交車採公司彙整的分析師共識：2026 年第四季隱含約 ${num(pa.implied.dQ4 / 1e4, 1)} 萬輛、2027 年約 ${num(pa.implied.d2027 / 1e4, 0)} 萬輛；營業費用照近八季平均增幅延續）2026 年第四季營收約 ${yi(q4.rev)}、毛利率 ${pct(q4.gm, 1)}；2027 年營收約 ${yi(b27.rev)}（保守至樂觀 ${num(bear27.rev / 100, 0)}–${yi(bull27.rev)}）、毛利率 ${pct(b27.gm, 1)}、營業利益約 ${yi(b27.oi)}（${num(bear27.oi / 100, 0)} 至 ${yi(bull27.oi)}），營業費用若維持 ${LAST} 水準，營業利益多約 ${yi(opexFlat.oi)}。這是依假設推算的模型結果，不是投資建議。`;

  const limitations = [
    `回測代入當季實際的交車量與儲能部署，衡量的是「交車已知時」模型拆解營收與毛利的能力；特斯拉在季末約 2 天後公布產銷報告，比財報早約 3 週，所以這相當於財報前的推估。交車也要事前預測的版本（上一季財報公布後就能做），營收誤差是 ${pct(ea.revenue!.mape!, 1)}（交車本身誤差 ${pct(ea.deliveries!.mape!, 1)}）。選定模型和不估計參數的「上季單價直接放大」差距${gapSig ? '雖然顯著，但樣本只有 7 季' : '在統計上不顯著'}；往前 2–4 季的多季回測中，後者的毛利率誤差${msB.gm < msU.gm ? '反而較小' : '較大'}（${num(msB.gm, 2)} 對 ${num(msU.gm, 2)} 個百分點），估計的售價、成本與能源參數對較長期預測的幫助有限。`,
    `毛利率的回測誤差（${num(sel.grossMargin!.mae, 1)} 個百分點）${beatsGm ? '只略小於' : '沒有小於'}天真模型：${LAST} 每輛車售價與成本只差約 ${num(last.asp - last.cpv, 0)} 美元，售價差 1%，汽車銷售毛利率就差約 ${num(margin1, 1)} 個百分點；2026 年前三季總毛利率在 ${gmRange} 之間跳動，其中有保固費用、關稅相關利益與退款等一次性項目，模型無法事先知道。測試期只有 ${test.length} 季，指標的不確定性很大。`,
    '每輛車售價與成本是由汽車銷售營收、銷貨成本除以非租賃交車推算的近似值：營收含 FSD 等附加銷售與匯率影響，也不分車款；特斯拉不揭露各車款的售價與成本，高價車款的影響只能用「其他車款占比」粗略估計。',
    `情境的交車量與儲能部署以特斯拉投資人關係網站彙整的分析師共識為基準（第三方估計，公司不背書）；2027 年的共識在 2026-09-29 公布，轉載報導只寫到萬輛（交車約 ${num(pa.implied.d2027 / 1e4, 0)} 萬輛、儲能 ${num(pa.implied.g2027, 1)} GWh），${LAST} 實際交車高於共識的部分與之後的政策變化都沒有反映。各情境的售價、成本、能源毛利率與服務成長都是本模型假設，保守與樂觀之間的差距主要來自交車、售價與成本的假設；營業費用三個情境相同。`,
    `能源營收以 ${LAST} 為起點，該季能源營收部分受關稅相關的客戶退款影響（ex-q3-2026），每 kWh 部署對應的能源營收約 ${num(last.en / last.gwh, 0)} 美元，${addQ(LAST, -3)}–${addQ(LAST, -1)} 為 ${range(qRange(addQ(LAST, -3), addQ(LAST, -1)).map((p) => A(p).en / A(p).gwh), 0, '')} 美元；模型的能源營收對部署彈性約 ${num(full.P.e1, 2)}，部署增加時每 kWh 營收還會下降。退款若只是一次性的，情境的能源營收可能偏低；儲能電池價格下跌（bnef-2025）則可能讓售價續降。`,
    `營業費用是獲利預測中影響最大的假設：近八季平均每季增加約 ${yi1(below.opexInc8)}，三個情境都假設延續，2027 年營業費用約 ${yi(sum(base.slice(1).map((r) => r.opexF)))}。資本支出由 2025 年每季約 ${num(Math.min(...capex25), 0)}–${num(Math.max(...capex25), 0)} 億美元升到 2026 年第二、三季的 ${capex26} 億美元，之後的折舊會逐步進入銷貨成本或營業費用，模型沒有單獨推算折舊。`,
    `Robotaxi、Cybercab、Semi、Optimus 等新業務還沒有單獨揭露的營收與成本，模型沒有分開處理，只隱含在汽車與服務營收的趨勢中；這些業務放量或延後都可能讓實際結果偏離情境。記憶體合約價在 2026 年大幅上漲（TrendForce 估計，見記憶體專題），但特斯拉沒有揭露記憶體成本對每輛車成本的影響，模型沒有使用記憶體價格，影響可用「每輛車銷貨成本」的敏感度估算。`,
    `業外收支含數位資產公允價值變動，${addQ(LAST, -3)}–${LAST} 單季在 ${num(Math.min(...l4q.map((r) => r.nonOp)), 0)} 至 ${num(Math.max(...l4q.map((r) => r.nonOp)), 0)} 百萬美元之間擺動，淨利與 EPS 的不確定性因此比營業利益更大。淨利 ÷ 稅前淨利的比例（${num(below.niRatio, 3)}）在稅前虧損時也照樣套用，等於假設虧損可以認列所得稅利益；實際上各地區分開課稅，虧損季度的淨損可能更大。`,
  ];

  const sourceKeys = [
    'sec-companyfacts', 'ex-q3-2026', 'ex-q2-2026', 'ex-q1-2026', 'ex-q4-2025', 'ex-q3-2025', 'deck-q2-2025', 'deck-q4-2024',
    'consensus-q1-2026', 'consensus-q2-2026', 'consensus-q3-2026', 'consensus-q3-2026-dtc', 'bnef-2025', 'letter-q3-2019', 'deck-q4-2020',
  ];

  return {
    company: 'tesla',
    generatedBy: 'scripts/models/tesla.ts',
    generatedOn: GENERATED_ON,
    asOf: inputs.asOf,
    currency: 'USD',
    amountUnit: 'million',
    periodLabel: '日曆季度（特斯拉會計年度與日曆年相同）',
    train: { from: TRAIN_FROM, to: TRAIN_TO },
    test: { from: TEST_FROM, to: TEST_TO },
    lastReported: LAST,
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
  const i = process.argv.indexOf('--dir');
  const dir = i > 0 ? process.argv[i + 1]! : 'src/data/forecast';
  const pricesPath = existsSync(join(dir, 'market-prices.yaml')) ? join(dir, 'market-prices.yaml') : 'src/data/memory/forecast/market-prices.yaml';
  const inputs = companyInputs.parse(parse(readFileSync(join(dir, 'tesla-inputs.yaml'), 'utf8')));
  const drivers = companyDrivers.parse(parse(readFileSync(join(dir, 'tesla-drivers.yaml'), 'utf8')));
  const prices = marketPrices.parse(parse(readFileSync(pricesPath, 'utf8')));
  const out = buildModel(inputs, prices, drivers);
  writeFileSync(resolve(dir, 'tesla-model.json'), `${JSON.stringify(out, null, 2)}\n`);
  const sel = out.candidates.find((c) => c.selected)!;
  console.log(`tesla-model.json written to ${dir}: selected ${sel.id}; ${out.candidates.map((c) => `${c.id} rev ${c.metrics.revenue?.mape ?? '-'}% gm ${c.metrics.grossMargin?.mae ?? '-'}pp eps ${c.metrics.eps?.mape ?? '-'}%`).join(' | ')}`);
  for (const s of out.scenarios) console.log(s.id, s.forecasts.map((f) => `${f.period} rev ${f.revenue} gm ${f.grossMargin} oi ${f.operatingIncome} eps ${f.eps}`).join(' | '));
}
