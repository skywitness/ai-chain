// SpaceX 財報模型：Starlink 用戶 × 每用戶營收、客戶發射 × 每次營收、AI 算力 × 每瓦營收，加總成營收；
// 三個部門的毛利率依營收比重加權成合併毛利率，再以營業費用、業外與稅率推到營業利益、淨利與 EPS。
//   npx tsx scripts/models/spacex.ts [--dir <dir>] [--out <file>]   → 寫出 <dir>/spacex-model.json（預設 src/data/forecast）
// buildModel(inputs, prices, drivers) 是純函式（不讀檔、不取時間），scripts/check-forecast.ts 會重跑並比對輸出。
// prices（記憶體合約價）不影響 SpaceX 模型，可為 undefined。
//
// 口徑：GAAP，百萬美元，日曆季度；EPS 為稀釋 EPS（美元）。
// 公開財報只有 2025Q1–2026Q3 共 7 季（招股書與上市後兩份季報），回測因此採「擴張視窗、逐季一步預測」：
// 預測第 t 季時只用 t−1 季以前的資料估參數；第一個測試季 2025Q3 的訓練資料是 2025Q1–Q2（另用 2023–2024 年度的發射資料）。
// 條件式回測代入當季實際的用戶數、客戶發射次數與額定算力；事前版本改用 t−1 季以前的趨勢推估這三個驅動因子。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import {
  companyDrivers, companyInputs, modelOutput,
  type CompanyDrivers, type CompanyInputs, type MarketPrices, type ModelOutput,
} from '../../src/schemas/forecast';
import { addQ, metrics, qRange, round, sum, type Pair } from './lib';
import {
  actualSeries, annualLaunches, at, geoGrowth, lastN, meanOf, num, pct, pointOf, pp, qText, quarterTable, signed, signedYi, thousands, yi, type SQ,
} from './spacex-lib';

const GENERATED_ON = '2026-11-17';
const TRAIN = { from: '2025Q1', to: '2025Q2' }; // 第一個測試季的訓練資料；之後每季擴張到 t−1
const TEST = { from: '2025Q3', to: '2026Q3' };
const LAST = '2026Q3';
const FORECAST = ['2026Q4', '2027Q1', '2027Q2', '2027Q3', '2027Q4'];
const ELIGIBLE = ['segment-average-yield', 'segment-marginal-yield'];
const EXPECTED = 'segment-marginal-yield';
const MIN_DGW = 0.01; // 額定算力以 0.1 GW 為單位公布（季平均最小變化 0.05 GW）；平均算力沒有變化的季度不用來計算邊際每 GW 營收
const CURSOR_DAYS_Q3 = 48; // Cursor 在 2026-08-14 併入，第三季計入 48 天（pr-q3-2026）
const QUARTER_DAYS = 92; // 2026 年第四季天數，用來把第三季的 48 天換算成整季
const CONN_ONE_OFF_PP = 3; // 第三季連網毛利率約 3 個百分點為關稅退款等一次性利益（tr-q3-2026）
const BEAR_AI_GM_CUT = 5; // 保守情境 2027 年 AI 部門毛利率比第四季反推值低 5 個百分點（本模型假設）
const TAX_RATE = 21; // 美國聯邦法定稅率（本模型假設；公司未提供稅率展望）

/* ───────────── context ───────────── */

interface Ctx {
  rows: SQ[];
  by: Map<string, SQ>;
  periods: string[];
  subs: Map<string, number>;
  arpu: Map<string, number>;
  cust: Map<string, number>;
  gw: Map<string, number>;
  backlog: Map<string, number>;
  backlogShare: Map<string, number>;
  annual: { revenue: number; launches: number; years: string[] };
}
function context(inputs: CompanyInputs, drivers: CompanyDrivers): Ctx {
  const rows = quarterTable(inputs);
  return {
    rows,
    by: new Map(rows.map((r) => [r.period, r])),
    periods: rows.map((r) => r.period),
    subs: actualSeries(drivers, 'starlink-subscribers'),
    arpu: actualSeries(drivers, 'starlink-arpu'),
    cust: actualSeries(drivers, 'launches-customer'),
    gw: actualSeries(drivers, 'nameplate-compute'),
    backlog: actualSeries(drivers, 'backlog'),
    backlogShare: actualSeries(drivers, 'backlog-next-12m-share'),
    annual: annualLaunches(inputs, rows[0]!.period),
  };
}
const row = (ctx: Ctx, p: string) => { const r = ctx.by.get(p); if (!r) throw new Error(`spacex inputs: ${p} missing`); return r; };
const avgSubs = (ctx: Ctx, p: string) => (at(ctx.subs, addQ(p, -1), 'subscribers') + at(ctx.subs, p, 'subscribers')) / 2;
const avgGW = (ctx: Ctx, p: string) => (at(ctx.gw, addQ(p, -1), 'compute') + at(ctx.gw, p, 'compute')) / 2;
/** Starlink 消費者營收 ÷ 平均用戶數 ÷ 3（美元／月，含終端設備）。 */
const consumerYield = (ctx: Ctx, p: string) => row(ctx, p).consumer / avgSubs(ctx, p) / 3;
const segGm = (r: SQ) => ({ space: (100 * (r.space - r.cogsSpace)) / r.space, conn: (100 * (r.conn - r.cogsConn)) / r.conn, ai: (100 * (r.ai - r.cogsAi)) / r.ai });
/** 每 GW（百萬美元／季）→ 每瓦年營收（美元／瓦／年）。 */
const perWatt = (mPerGwQ: number) => (mPerGwQ * 4) / 1000;
const fromPerWatt = (w: number) => (w * 1000) / 4;

/* ───────────── one-step-ahead engine ───────────── */

/** 在 o 季（t−1）結束時可用的參數：只用 o 季以前的資料。 */
interface Origin {
  period: string;
  yc: number; // Starlink 消費者每用戶月營收（含設備），美元
  price: number; // 每次客戶發射營收（百萬美元），2023 年起累計平均
  ld: number; // 發射與開發營收：最近四季平均
  eg: number;
  ads: number;
  aiX: number; // AI 解決方案與基礎設施營收（不含 Cursor）
  gwAvg: number;
  yAvg: number; // 平均每 GW 營收（百萬美元／GW／季）
  yMarg: number; // 邊際每 GW 營收
  yMargFrom: string; // 邊際每 GW 營收取自哪一季的變化
  gm: { space: number; conn: number; ai: number };
  subsEnd: number;
  gwEnd: number;
}
function marginalYield(ctx: Ctx, o: string): { y: number; from: string } {
  for (let p = o; ctx.by.has(addQ(p, -1)); p = addQ(p, -1)) {
    const d = avgGW(ctx, p) - avgGW(ctx, addQ(p, -1));
    if (d >= MIN_DGW) return { y: Math.max(0, (row(ctx, p).aiX - row(ctx, addQ(p, -1)).aiX) / d), from: p };
  }
  return { y: row(ctx, o).aiX / avgGW(ctx, o), from: o };
}
function origin(ctx: Ctx, o: string): Origin {
  const upTo = ctx.periods.filter((p) => p <= o);
  const r = row(ctx, o);
  const launchRev = ctx.annual.revenue + sum(upTo.map((p) => row(ctx, p).launchSvc));
  const launches = ctx.annual.launches + sum(upTo.map((p) => at(ctx.cust, p, 'customer launches')));
  const m = marginalYield(ctx, o);
  return {
    period: o,
    yc: consumerYield(ctx, o),
    price: launchRev / launches,
    ld: meanOf(lastN(ctx.periods, o, 4).map((p) => row(ctx, p).launchDev)),
    eg: r.eg,
    ads: r.ads,
    aiX: r.aiX,
    gwAvg: avgGW(ctx, o),
    yAvg: r.aiX / avgGW(ctx, o),
    yMarg: m.y,
    yMargFrom: m.from,
    gm: segGm(r),
    subsEnd: at(ctx.subs, o, 'subscribers'),
    gwEnd: at(ctx.gw, o, 'compute'),
  };
}

interface Vol { subsEnd: number; cust: number; gwEnd: number; cursor: number }
/** 條件式：當季實際的期末用戶、客戶發射、期末算力與 Cursor 營收。 */
const realised = (ctx: Ctx, t: string): Vol => ({ subsEnd: at(ctx.subs, t, 'subscribers'), cust: at(ctx.cust, t, 'customer launches'), gwEnd: at(ctx.gw, t, 'compute'), cursor: row(ctx, t).cursor });
/** 事前：用戶與算力延續上一季的增量，客戶發射取最近四季平均；Cursor 併購在季初尚未完成，不計入。 */
function exAnte(ctx: Ctx, t: string): Vol {
  const o = addQ(t, -1);
  const o2 = addQ(t, -2);
  const s1 = at(ctx.subs, o, 'subscribers');
  const g1 = at(ctx.gw, o, 'compute');
  return {
    subsEnd: s1 + (s1 - at(ctx.subs, o2, 'subscribers')),
    cust: meanOf(lastN(ctx.periods, o, 4).map((p) => at(ctx.cust, p, 'customer launches'))),
    gwEnd: g1 + (g1 - at(ctx.gw, o2, 'compute')),
    cursor: 0,
  };
}

interface Pred { rev: number; gm: number; space: number; conn: number; ai: number; consumer: number; eg: number; launchSvc: number; launchDev: number; ads: number; aiX: number; cursor: number }
function predictQ(o: Origin, v: Vol, kind: 'average' | 'marginal'): Pred {
  const subs = (o.subsEnd + v.subsEnd) / 2;
  const consumer = subs * 3 * o.yc;
  const gwAvg = (o.gwEnd + v.gwEnd) / 2;
  const aiX = kind === 'average' ? gwAvg * o.yAvg : o.aiX + o.yMarg * (gwAvg - o.gwAvg);
  const launchSvc = v.cust * o.price;
  const space = launchSvc + o.ld;
  const conn = consumer + o.eg;
  const ai = o.ads + aiX + v.cursor;
  const rev = space + conn + ai;
  const gm = (space * o.gm.space + conn * o.gm.conn + ai * o.gm.ai) / rev;
  return { rev, gm, space, conn, ai, consumer, eg: o.eg, launchSvc, launchDev: o.ld, ads: o.ads, aiX, cursor: v.cursor };
}

/* ───────────── scenarios ───────────── */

interface Scenario {
  id: 'bear' | 'base' | 'bull';
  name: string;
  netAdds: number; // Starlink 每季淨增用戶（百萬戶）
  arpuQ: number; // 每用戶營收每季變化（%）
  cust: number; // 每季客戶發射次數
  egQ: number; // 企業與政府營收每季成長（%）
  gwQ4: number; // 2026 年底額定算力（GW）
  gwAdd: number; // 2027 年每季新增額定算力（GW）
  yieldW: number; // 新增算力每瓦年營收（美元／瓦／年）
  aiGm2027: number; // 2027 年 AI 部門毛利率（%）
}
interface Fixed {
  last: SQ;
  subsEnd: number;
  yc: number;
  gwEnd: number;
  gwAvg: number;
  price: number;
  ld: number;
  ads: number;
  cursorQ: number;
  gmSpace: number;
  gmConn: number;
  aiGmQ4: number;
  opexExAcq: number;
  opexG: number;
  acqSbcQ: number;
  nonOp: number;
  shares: number;
}
interface FcOpts { yieldAddW?: number; gwAddDelta?: number; aiGmAdd?: number; netAddsAdd?: number; arpuAddPP?: number; custAdd?: number; opexMult?: number }
interface FcRow {
  period: string; rev: number; gm: number; gp: number; oi: number; pretax: number; tax: number; ni: number; eps: number; opex: number;
  space: number; conn: number; ai: number; consumer: number; eg: number; launchSvc: number; launchDev: number; ads: number; aiX: number; cursor: number;
  subsEnd: number; subs: number; yc: number; gwEnd: number; gwAvg: number; gmAi: number;
}

function forecast(F: Fixed, sc: Scenario, o: FcOpts = {}): FcRow[] {
  let subsEnd = F.subsEnd;
  let yc = F.yc;
  let eg = F.last.eg;
  let gwEnd = F.gwEnd;
  let gwAvgPrev = F.gwAvg;
  let aiX = F.last.aiX;
  let opexExAcq = F.opexExAcq;
  const ym = fromPerWatt(sc.yieldW + (o.yieldAddW ?? 0));
  return FORECAST.map((p, i) => {
    const subsStart = subsEnd;
    subsEnd += sc.netAdds + (o.netAddsAdd ?? 0);
    const subs = (subsStart + subsEnd) / 2;
    yc *= 1 + (sc.arpuQ + (o.arpuAddPP ?? 0)) / 100;
    const consumer = subs * 3 * yc;
    eg *= 1 + sc.egQ / 100;
    const launchSvc = (sc.cust + (o.custAdd ?? 0)) * F.price;
    const gwStart = gwEnd;
    gwEnd = i === 0 ? sc.gwQ4 : gwEnd + sc.gwAdd + (o.gwAddDelta ?? 0);
    const gwAvg = (gwStart + gwEnd) / 2;
    aiX += ym * (gwAvg - gwAvgPrev);
    gwAvgPrev = gwAvg;
    const space = launchSvc + F.ld;
    const conn = consumer + eg;
    const ai = aiX + F.cursorQ + F.ads;
    const rev = space + conn + ai;
    const gmAi = (i === 0 ? F.aiGmQ4 : sc.aiGm2027) + (i === 0 ? 0 : (o.aiGmAdd ?? 0));
    const gp = (space * F.gmSpace + conn * F.gmConn + ai * gmAi) / 100;
    opexExAcq *= 1 + F.opexG / 100;
    const opex = (opexExAcq + F.acqSbcQ) * (o.opexMult ?? 1);
    const oi = gp - opex;
    const pretax = oi + F.nonOp;
    const tax = Math.max(0, (pretax * TAX_RATE) / 100);
    const ni = pretax - tax;
    return {
      period: p, rev, gm: (100 * gp) / rev, gp, oi, pretax, tax, ni, eps: ni / F.shares, opex,
      space, conn, ai, consumer, eg, launchSvc, launchDev: F.ld, ads: F.ads, aiX, cursor: F.cursorQ, subsEnd, subs, yc, gwEnd, gwAvg, gmAi,
    };
  });
}
const yearOf = (rows: FcRow[], y: string) => rows.filter((r) => r.period.startsWith(y));
function annual(rows: FcRow[]) {
  const rev = sum(rows.map((r) => r.rev));
  const gp = sum(rows.map((r) => r.gp));
  return { rev, gp, gm: (100 * gp) / rev, oi: sum(rows.map((r) => r.oi)), ni: sum(rows.map((r) => r.ni)), eps: sum(rows.map((r) => r.eps)), ai: sum(rows.map((r) => r.ai)), conn: sum(rows.map((r) => r.conn)), space: sum(rows.map((r) => r.space)) };
}

/* ───────────── build ───────────── */

export function buildModel(inputs: CompanyInputs, _prices?: MarketPrices, drivers?: CompanyDrivers): ModelOutput {
  if (!drivers) throw new Error('spacex model needs spacex-drivers.yaml');
  const ctx = context(inputs, drivers);
  const test = qRange(TEST.from, TEST.to);
  for (const p of qRange(TRAIN.from, LAST)) row(ctx, p);
  if (ctx.periods.at(-1) !== LAST) throw new Error(`spacex inputs must end at ${LAST}; move the test window and forecasts first`);

  /* ── one-step-ahead backtest (expanding window) ── */
  type Id = 'naive' | 'momentum' | 'segment-average-yield' | 'segment-marginal-yield' | 'segment-marginal-ex-ante';
  const preds = new Map<Id, Map<string, { rev: number; gm: number; conn?: number; space?: number; ai?: number }>>();
  const exAvg = new Map<string, Pred>();
  const put = (id: Id, p: string, x: { rev: number; gm: number; conn?: number; space?: number; ai?: number }) => { if (!preds.has(id)) preds.set(id, new Map()); preds.get(id)!.set(p, x); };
  const origins = new Map<string, Origin>();
  for (const t of test) {
    const o = addQ(t, -1);
    const O = origin(ctx, o);
    origins.set(t, O);
    const q = row(ctx, o);
    const q2 = row(ctx, addQ(t, -2));
    put('naive', t, { rev: q.revenue, gm: q.gm, conn: q.conn, space: q.space, ai: q.ai });
    put('momentum', t, { rev: (q.revenue * q.revenue) / q2.revenue, gm: q.gm });
    put('segment-average-yield', t, predictQ(O, realised(ctx, t), 'average'));
    put('segment-marginal-yield', t, predictQ(O, realised(ctx, t), 'marginal'));
    put('segment-marginal-ex-ante', t, predictQ(O, exAnte(ctx, t), 'marginal'));
    exAvg.set(t, predictQ(O, exAnte(ctx, t), 'average'));
  }
  const actualOf = (p: string) => row(ctx, p);
  const pairsOf = (m: Map<string, { rev: number; gm: number; conn?: number; space?: number; ai?: number }>, k: 'rev' | 'gm' | 'conn' | 'space' | 'ai'): Pair[] =>
    test.flatMap((p) => {
      const x = m.get(p)?.[k];
      if (x === undefined) return [];
      const a = actualOf(p);
      return [{ actual: k === 'rev' ? a.revenue : k === 'gm' ? a.gm : a[k], predicted: x }];
    });
  type MetricSet = Record<string, ReturnType<typeof metrics>>;
  const M: Record<string, MetricSet> = {};
  for (const [id, m] of preds) {
    const out: MetricSet = { revenue: metrics(pairsOf(m, 'rev')), grossMargin: metrics(pairsOf(m, 'gm'), false) };
    if (m.get(test[0]!)?.conn !== undefined) {
      out.connectivityRevenue = metrics(pairsOf(m, 'conn'));
      out.spaceRevenue = metrics(pairsOf(m, 'space'));
      out.aiRevenue = metrics(pairsOf(m, 'ai'));
    }
    M[id] = out;
  }
  // 事前版本（驅動因子改用趨勢推估）：天真與動能模型本來就只用過去資料，事前與條件式相同
  const exPairs = (m: Map<string, { rev: number; gm: number }>) => ({ revenueExAnte: metrics(pairsOf(m, 'rev')), grossMarginExAnte: metrics(pairsOf(m, 'gm'), false) });
  Object.assign(M.naive!, exPairs(preds.get('naive')!));
  Object.assign(M.momentum!, exPairs(preds.get('momentum')!));
  Object.assign(M['segment-average-yield']!, exPairs(exAvg));
  Object.assign(M['segment-marginal-yield']!, exPairs(preds.get('segment-marginal-ex-ante')!));
  const score = (id: string) => M[id]!.revenue!.mape! + M[id]!.grossMargin!.mae;
  const selected = [...ELIGIBLE].sort((a, b) => score(a) - score(b))[0]!;
  if (selected !== EXPECTED) throw new Error(`selection changed to ${selected}; review the forecast wiring and texts`);
  const S = M[selected]!;
  const N = M.naive!;
  const AV = M['segment-average-yield']!;
  const EA = M['segment-marginal-ex-ante']!;
  const beatsNaive = S.revenue!.mape! < N.revenue!.mape!;
  const beatsNaiveGm = S.grossMargin!.mae < N.grossMargin!.mae;
  const errOf = (id: Id, p: string) => (preds.get(id)!.get(p)!.rev / actualOf(p).revenue - 1) * 100;
  // 逐季絕對百分比誤差（天真 − 選定）的配對 t 值；樣本只有 5 季，用來說明差距是否顯著
  const apeDiff = test.map((p) => Math.abs(errOf('naive', p)) - Math.abs(errOf(selected as Id, p)));
  const sdDiff = Math.sqrt(sum(apeDiff.map((d) => (d - meanOf(apeDiff)) ** 2)) / (apeDiff.length - 1));
  const tStat = meanOf(apeDiff) / (sdDiff / Math.sqrt(apeDiff.length));
  const T_CRIT_5PCT: Record<number, number> = { 2: 4.3, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31 }; // 雙尾 5%，依自由度
  const tCrit = T_CRIT_5PCT[apeDiff.length - 1];
  if (tCrit === undefined) throw new Error('extend T_CRIT_5PCT for the new test length');
  const tText = `天真模型與本模型逐季絕對百分比誤差的配對 t 值約 ${num(tStat, 1)}，自由度 ${apeDiff.length - 1}，${Math.abs(tStat) < tCrit ? `未達 5% 顯著水準所需的 ${num(tCrit, 2)}` : `超過 5% 顯著水準所需的 ${num(tCrit, 2)}，但樣本仍很小`}`;
  // 兩個部門模型的逐季差距（平均每 GW 版本 − 本模型的絕對百分比誤差；正值＝本模型較準）：差距集中在哪一季
  const altId: Id = selected === 'segment-marginal-yield' ? 'segment-average-yield' : 'segment-marginal-yield';
  const segDiff = test.map((p) => ({ p, d: Math.abs(errOf(altId, p)) - Math.abs(errOf(selected as Id, p)) }));
  const segTop = [...segDiff].sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0]!;
  const segRestMax = Math.max(...segDiff.filter((x) => x.p !== segTop.p).map((x) => Math.abs(x.d)));
  const segConcentrated = sum(segDiff.map((x) => x.d)) > 0 && segTop.d / sum(segDiff.map((x) => x.d)) >= 0.6;

  /* ── full-data parameters (through 2026Q3) and forecasts ── */
  const OF = origin(ctx, LAST);
  const last = row(ctx, LAST);
  const last4 = lastN(ctx.periods, LAST, 4).map((p) => row(ctx, p));
  const netAdds4 = last4.map((r) => round(at(ctx.subs, r.period, 'subscribers') - at(ctx.subs, addQ(r.period, -1), 'subscribers'), 2));
  const cust4 = last4.map((r) => at(ctx.cust, r.period, 'customer launches'));
  const arpuA = actualSeries(drivers, 'starlink-arpu-annual');
  const arpuYearChanges = [['2023', '2024'], ['2024', '2025']].map(([a, b]) => (at(arpuA, b!, 'ARPU') / at(arpuA, a!, 'ARPU') - 1) * 100);
  const arpuBaseQ = (Math.pow(1 + meanOf(arpuYearChanges) / 100, 0.25) - 1) * 100;
  const arpuYoyLast = (at(ctx.arpu, LAST, 'ARPU') / at(ctx.arpu, addQ(LAST, -4), 'ARPU') - 1) * 100;
  const arpuBearQ = (Math.pow(1 + arpuYoyLast / 100, 0.25) - 1) * 100;
  const fy = (y: string) => { const a = inputs.annual.find((x) => x.year === y); if (!a) throw new Error(`annual ${y} missing`); return a; };
  const egOf = (y: string) => fy(y).sales.find((s) => s.product.startsWith('企業與政府'))!.value;
  const egFyGrowth = (egOf('2025') / egOf('2024') - 1) * 100;
  const egBaseQ = (Math.pow(1 + egFyGrowth / 100, 0.25) - 1) * 100;
  const egBullQ = geoGrowth(row(ctx, addQ(LAST, -4)).eg, last.eg, 4);
  const gwG = pointOf(drivers, 'nameplate-compute', '2026Q4');
  const gw27 = pointOf(drivers, 'nameplate-compute', '2027Q4');
  const gwQ4 = { bear: gwG.low!, base: gwG.value, bull: gwG.high! };
  const gwPaceBear = (at(ctx.gw, LAST, 'compute') - at(ctx.gw, addQ(LAST, -3), 'compute')) / 3;
  const priceW = pointOf(drivers, 'compute-price-per-watt', '2026Q2');
  const dataYieldW = perWatt(OF.yMarg);
  const gmQ2 = row(ctx, '2026Q2').gm;
  const gmSpace4 = (100 * sum(last4.map((r) => r.space - r.cogsSpace))) / sum(last4.map((r) => r.space));
  const gmConnQ3 = segGm(last).conn;
  const gmAiQ3 = segGm(last).ai;
  const opexExAcq = (r: SQ) => r.opex - r.sbcAcq;
  const fixed0: Omit<Fixed, 'aiGmQ4'> = {
    last,
    subsEnd: at(ctx.subs, LAST, 'subscribers'),
    yc: OF.yc,
    gwEnd: at(ctx.gw, LAST, 'compute'),
    gwAvg: OF.gwAvg,
    price: OF.price,
    ld: OF.ld,
    ads: meanOf(last4.map((r) => r.ads)),
    cursorQ: (last.cursor * QUARTER_DAYS) / CURSOR_DAYS_Q3,
    gmSpace: gmSpace4,
    gmConn: gmConnQ3 - CONN_ONE_OFF_PP,
    opexExAcq: opexExAcq(last),
    opexG: geoGrowth(opexExAcq(row(ctx, addQ(LAST, -4))), opexExAcq(last), 4),
    acqSbcQ: (last.sbcAcq * QUARTER_DAYS) / CURSOR_DAYS_Q3,
    nonOp: last.interestIncome - last.interestExpense,
    shares: last.shares!,
  };
  const mkScenarios = (aiGmQ4: number): Scenario[] => [
    { id: 'bear', name: '保守', netAdds: Math.min(...netAdds4), arpuQ: arpuBearQ, cust: Math.min(...cust4), egQ: 0, gwQ4: gwQ4.bear, gwAdd: gwPaceBear, yieldW: priceW.low!, aiGm2027: aiGmQ4 - BEAR_AI_GM_CUT },
    { id: 'base', name: '基準', netAdds: meanOf(netAdds4), arpuQ: arpuBaseQ, cust: meanOf(cust4), egQ: egBaseQ, gwQ4: gwQ4.base, gwAdd: gwQ4.base - at(ctx.gw, LAST, 'compute'), yieldW: dataYieldW, aiGm2027: aiGmQ4 },
    { id: 'bull', name: '樂觀', netAdds: Math.max(...netAdds4), arpuQ: 0, cust: Math.max(...cust4), egQ: egBullQ, gwQ4: gwQ4.bull, gwAdd: (gw27.value - gwQ4.bull) / 4, yieldW: dataYieldW, aiGm2027: gmAiQ3 },
  ];
  // 第四季 AI 部門毛利率：財務長說第四季合併毛利率與第二季相近（tr-q3-2026），由基準情境的部門組合反推，三個情境的第四季都用這個值
  const rawBase = forecast({ ...fixed0, aiGmQ4: gmAiQ3 }, mkScenarios(gmAiQ3).find((s) => s.id === 'base')!);
  const q4raw = rawBase[0]!;
  const aiGmQ4 = (gmQ2 * q4raw.rev - q4raw.space * fixed0.gmSpace - q4raw.conn * fixed0.gmConn) / q4raw.ai;
  const F: Fixed = { ...fixed0, aiGmQ4 };
  const SCENARIOS = mkScenarios(aiGmQ4);
  const fc = Object.fromEntries(SCENARIOS.map((s) => [s.id, forecast(F, s)])) as Record<Scenario['id'], FcRow[]>;
  const base = fc.base;
  const baseSc = SCENARIOS.find((s) => s.id === 'base')!;
  const y27 = { bear: annual(yearOf(fc.bear, '2027')), base: annual(yearOf(base, '2027')), bull: annual(yearOf(fc.bull, '2027')) };
  const q4 = { bear: fc.bear[0]!, base: base[0]!, bull: fc.bull[0]! };
  const q1 = { bear: fc.bear[1]!, base: base[1]!, bull: fc.bull[1]! };

  // 公司展望：2027Q1 營收財測、12 月年化營收目標、第四季資本支出
  const g27 = pointOf(drivers, 'revenue-outlook', '2027Q1');
  const arr = pointOf(drivers, 'annualized-revenue', '2026Q4');
  const capexQ4 = pointOf(drivers, 'capex', '2026Q4');
  const guideText = (r: number) => (r < g27.low! ? `低於財測區間下緣 ${yi(g27.low!)}` : r > g27.high! ? `高於財測區間上緣 ${yi(g27.high!)}` : `在財測區間 ${thousands(g27.low! / 100)}–${yi(g27.high!)}內`);
  // 對照：新增算力改用平均每瓦年營收（＝平均每 GW 版本的預測方式）時的基準情境 2027 年第一季營收
  const avgYieldW = perWatt(OF.yAvg);
  const q1AvgYield = forecast(F, baseSc, { yieldAddW: avgYieldW - dataYieldW })[1]!.rev;
  const selText = `平均每 GW 版本與本模型的逐季絕對誤差差距為 ${segDiff.map((x) => num(x.d, 1)).join('、')} 個百分點（正值代表本模型較準）${segConcentrated ? `，差距主要來自 ${qText(segTop.p)}（其餘各季相差不到 ${Math.max(1, Math.ceil(segRestMax))} 個百分點），回測本身不足以區分兩者` : ''}。另一個依據是公司財測：若新增算力改用平均每瓦年營收（${num(avgYieldW, 1)} 美元）換算，基準情境 2027 年第一季營收約 ${yi(q1AvgYield)}，${guideText(q1AvgYield)}；本模型為 ${yi(q1.base.rev)}，${guideText(q1.base.rev)}。`;
  const sensYieldDown = (() => { const y = annual(yearOf(forecast(F, baseSc, { yieldAddW: -10 }), '2027')); return (y.rev / y27.base.rev - 1) * 100; })();

  // 未完成合約：2026Q3 底一年內認列的部分，對照基準情境未來四季的「合約型」營收（不含 Starlink 消費者、X 廣告與 Cursor）
  const blQ3 = at(ctx.backlog, LAST, 'backlog');
  const bl12 = (blQ3 * at(ctx.backlogShare, LAST, 'backlog share')) / 100;
  const contractType = (r: { rev: number; consumer: number; ads: number; cursor: number }) => r.rev - r.consumer - r.ads - r.cursor;
  const next4Contract = sum(base.slice(0, 4).map(contractType));

  /* ── sensitivities on 2027 (base) ── */
  const sens = (o: FcOpts) => {
    const y = annual(yearOf(forecast(F, baseSc, o), '2027'));
    return { rev: y.rev - y27.base.rev, revPct: (y.rev / y27.base.rev - 1) * 100, gm: y.gm - y27.base.gm, oi: y.oi - y27.base.oi, eps: y.eps - y27.base.eps };
  };
  const sensText = (x: ReturnType<typeof sens>) => {
    const parts: string[] = [];
    if (Math.abs(x.rev) >= 50) parts.push(`營收 ${signedYi(x.rev)}（${signed(x.revPct, 1)}）`);
    if (Math.abs(x.gm) >= 0.05) parts.push(`毛利率 ${pp(x.gm, 1)}`);
    parts.push(`營業利益 ${signedYi(x.oi)}`);
    parts.push(`EPS ${x.eps >= 0 ? '+' : '−'}${num(Math.abs(x.eps), 2)} 美元`);
    return `2027 年${parts.join('、')}${Math.abs(x.rev) < 50 ? '（營收不變）' : ''}`;
  };
  const sensitivities: ModelOutput['sensitivities'] = [
    { driver: '新增算力的每瓦年營收（2026 年第四季起）', change: '每瓦多 10 美元', effect: sensText(sens({ yieldAddW: 10 })) },
    { driver: '新增算力的每瓦年營收（2026 年第四季起）', change: '每瓦少 10 美元', effect: sensText(sens({ yieldAddW: -10 })) },
    { driver: '2027 年每季新增額定算力', change: '每季多 0.5 GW', effect: sensText(sens({ gwAddDelta: 0.5 })) },
    { driver: '2027 年每季新增額定算力', change: '每季少 0.5 GW', effect: sensText(sens({ gwAddDelta: -0.5 })) },
    { driver: 'AI 部門毛利率（2027 年）', change: '低 5 個百分點', effect: sensText(sens({ aiGmAdd: -5 })) },
    { driver: 'Starlink 每季淨增用戶', change: '每季少 30 萬戶', effect: sensText(sens({ netAddsAdd: -0.3 })) },
    { driver: 'Starlink 每用戶月營收', change: '每季多降 2 個百分點', effect: sensText(sens({ arpuAddPP: -2 })) },
    { driver: '客戶發射次數', change: '每季少 3 次', effect: sensText(sens({ custAdd: -3 })) },
    { driver: '營業費用', change: '多 10%', effect: sensText(sens({ opexMult: 1.1 })) },
  ];

  /* ── candidates ── */
  const eqSeg = [
    'Starlink 消費者營收_t = 平均用戶數_t × 3 × 每用戶月營收_t−1（每用戶月營收含終端設備）',
    '企業與政府營收_t = 企業與政府營收_t−1',
    '發射服務營收_t = 客戶發射次數_t × 每次客戶發射營收（2023 年至 t−1 季的累計平均）',
    '發射與開發營收_t = 最近四季平均（開發合約依里程碑認列，波動大）',
    'X 廣告營收_t = X 廣告營收_t−1；Cursor 營收_t 用當季實際值（2026-08-14 起併入）',
  ];
  const eqGm = '合併毛利率_t =（太空營收_t × 太空毛利率_t−1 + 連網營收_t × 連網毛利率_t−1 + AI 營收_t × AI 毛利率_t−1）÷ 營收_t';
  const mOf = (id: string) => M[id]!;
  const backtestNote = `測試期 ${TEST.from}–${TEST.to} 共 ${test.length} 季，每季只用上一季以前的資料估參數（擴張視窗），並代入當季實際的用戶數、客戶發射次數與額定算力，屬於「已知驅動因子條件下」的誤差。`;
  const q3Miss = (id: Id) => {
    const [a, b] = [errOf(id, '2026Q2'), errOf(id, '2026Q3')];
    const w = (e: number) => (e < 0 ? '低估' : '高估');
    return w(a) === w(b)
      ? `2026 年第二、三季分別${w(a)} ${num(Math.abs(a), 0)}% 與 ${num(Math.abs(b), 0)}%`
      : `2026 年第二季${w(a)} ${num(Math.abs(a), 0)}%、第三季${w(b)} ${num(Math.abs(b), 0)}%`;
  };
  const candidates: ModelOutput['candidates'] = [
    {
      id: 'naive', name: '天真模型（上一季不變）',
      description: '假設本季營收與毛利率都和上一季一樣。這是最簡單的對照組：模型如果贏不了它，就沒有存在的價值。SpaceX 在 2026 年營收倍增，這種假設在高成長期會系統性低估。',
      equations: ['營收_t = 營收_t−1', '毛利率_t = 毛利率_t−1'],
      metrics: mOf('naive'), selected: false,
      note: `${q3Miss('naive')}。部門層級（各部門沿用上一季）的營收誤差：連網 ${pct(N.connectivityRevenue!.mape!)}、太空 ${pct(N.spaceRevenue!.mape!)}、AI ${pct(N.aiRevenue!.mape!)}。測試期內 SpaceX 沒有公布任何營收或毛利率財測（第一次營收財測是 2026-10-20 對 2027 年第一季的 330–370 億美元），因此沒有「公司財測」對照組；財測改在預測段落對照。`,
    },
    {
      id: 'momentum', name: '動能外推（上一季成長率延續）',
      description: '假設本季營收以上一季的季成長率繼續成長，毛利率沿用上一季。成長加速時比天真模型好，但成長率忽高忽低時會放大誤差。',
      equations: ['營收_t = 營收_t−1 ×（營收_t−1 ÷ 營收_t−2）', '毛利率_t = 毛利率_t−1'],
      metrics: mOf('momentum'), selected: false,
      note: `${q3Miss('momentum')}；2025 年第四季把第三季的發射高峰當成趨勢，高估 ${num(errOf('momentum', '2025Q4'), 0)}%。`,
    },
    {
      id: 'segment-average-yield', name: '部門單位經濟（算力以平均每 GW 營收換算）',
      description: '把營收拆成三個部門的「數量 × 單價」：Starlink 用戶 × 每用戶營收、客戶發射 × 每次營收、AI 額定算力 × 每 GW 營收；單價用上一季的值，數量用當季實際值。AI 這一版假設所有算力（含 xAI 自己訓練 Grok 用的部分）都以上一季的平均每 GW 營收變現。',
      equations: [...eqSeg, 'AI 算力營收_t = 平均額定算力_t × 平均每 GW 營收_t−1（AI 算力營收＝AI 解決方案與基礎設施營收，不含 Cursor）', eqGm],
      metrics: mOf('segment-average-yield'), selected: false,
      note: `${backtestNote}${q3Miss('segment-average-yield')}：2025 年算力多半供 xAI 自己使用，平均每 GW 營收逐季下降，2026 年第二季起對外出租後又急升，平均值跟不上。revenueExAnte／grossMarginExAnte 為驅動因子改用事前推估時的誤差（營收 ${pct(AV.revenueExAnte!.mape!)}）。`,
    },
    {
      id: 'segment-marginal-yield', name: '部門單位經濟（新增算力以邊際每 GW 營收換算）',
      description: '與上一個模型相同，但 AI 算力營收改成「上一季的算力營收照舊，新增的算力以最近一次觀察到的邊際每 GW 營收變現」。既有合約延續、新上線的算力才帶來新營收，比較貼近雲端算力出租的實際運作。',
      equations: [
        ...eqSeg,
        'AI 算力營收_t = AI 算力營收_t−1 + 邊際每 GW 營收 ×（平均額定算力_t − 平均額定算力_t−1）',
        '邊際每 GW 營收 =（AI 算力營收_t−1 − AI 算力營收_t−2）÷（平均額定算力_t−1 − 平均額定算力_t−2）',
        eqGm,
      ],
      metrics: mOf('segment-marginal-yield'), selected: true,
      note: `${backtestNote}選擇規則：在兩個部門單位經濟模型中，取「營收 MAPE（%）＋ 毛利率 MAE（個百分點）」最小者：本模型 ${num(score(selected), 2)}、平均每 GW 版本 ${num(score('segment-average-yield'), 2)}；天真模型 ${num(score('naive'), 2)}、動能外推 ${num(score('momentum'), 2)}。本模型營收誤差${beatsNaive ? '低於' : '沒有低於'}天真模型、毛利率誤差${beatsNaiveGm ? '低於' : '沒有低於'}天真模型，但只有 ${test.length} 季樣本：${tText}。${selText}${q3Miss(selected as Id)}，主因是 2026 年 5 月起與 Anthropic 等客戶的雲端算力合約：新增算力的邊際每瓦年營收在 2026 年第一季約 ${num(perWatt(origins.get('2026Q2')!.yMarg), 1)} 美元，第二季跳到約 ${num(perWatt(origins.get('2026Q3')!.yMarg), 1)} 美元、第三季約 ${num(dataYieldW, 1)} 美元，模型用上一季的值，只能落後一季跟上。部門營收誤差：連網 ${pct(S.connectivityRevenue!.mape!)}、太空 ${pct(S.spaceRevenue!.mape!)}、AI ${pct(S.aiRevenue!.mape!)}。毛利率只反映部門組合變化，部門內的毛利率變化（例如 AI 部門由 2026 年第一季的 ${pct(segGm(row(ctx, '2026Q1')).ai)} 升到第三季的 ${pct(gmAiQ3)}）要落後一季才反映。營業利益在測試期介於 ${yi(Math.min(...test.map((p) => actualOf(p).oi)), 1)}與 ${yi(Math.max(...test.map((p) => actualOf(p).oi)), 1)}之間，接近零時百分比誤差沒有意義，因此回測只評估營收與毛利率。revenueExAnte／grossMarginExAnte 為驅動因子改用事前推估時的誤差（營收 ${pct(S.revenueExAnte!.mape!)}、毛利率 ${num(S.grossMarginExAnte!.mae, 1)} 個百分點）。`,
    },
    {
      id: 'segment-marginal-ex-ante', name: '部門單位經濟（邊際每 GW，驅動因子事前推估）',
      description: '與選定模型完全相同，但不代入當季實際的驅動因子：用戶數與額定算力延續上一季的增量、客戶發射取最近四季平均，Cursor 併購在季初尚未完成而不計入。用來衡量「真的事前預測」時的誤差。',
      equations: ['期末用戶數_t = 期末用戶數_t−1 +（期末用戶數_t−1 − 期末用戶數_t−2）', '期末額定算力_t = 期末額定算力_t−1 +（期末額定算力_t−1 − 期末額定算力_t−2）', '客戶發射次數_t = 最近四季平均；其餘同選定模型'],
      metrics: mOf('segment-marginal-ex-ante'), selected: false,
      note: `不參與模型選擇：參數與選定模型相同，只是驅動因子改用事前推估。營收 MAPE ${pct(EA.revenue!.mape!)}，${EA.revenue!.mape! < N.revenue!.mape! ? '仍低於' : '沒有低於'}天真模型的 ${pct(N.revenue!.mape!)}。`,
    },
  ];

  /* ── backtest rows ── */
  const backtest: ModelOutput['backtest'] = [];
  for (const id of ['segment-marginal-yield', 'segment-marginal-ex-ante', 'segment-average-yield', 'momentum', 'naive'] as Id[]) {
    for (const [metric, k] of [['revenue', 'rev'], ['grossMargin', 'gm']] as const) {
      for (const p of test) {
        const x = preds.get(id)!.get(p)!;
        const a = actualOf(p);
        const d = metric === 'grossMargin' ? 2 : 0;
        const nv = preds.get('naive')!.get(p)![k];
        backtest.push({
          period: p, metric, actual: round(metric === 'revenue' ? a.revenue : a.gm, d), predicted: round(x[k], d), candidate: id,
          ...(id !== 'naive' ? { benchmark: round(nv, d), benchmarkLabel: '天真模型（上一季不變）' } : {}),
        });
      }
    }
  }

  /* ── derived series ── */
  const derived: ModelOutput['derived'] = [];
  type Pt = ModelOutput['derived'][number]['points'][number];
  const hist = (f: (r: SQ) => number | undefined, d = 1, status: Pt['status'] = 'estimate'): Pt[] =>
    ctx.rows.flatMap((r) => { const v = f(r); return v === undefined ? [] : [{ period: r.period, value: round(v, d), status }]; });
  const fut = (f: (r: FcRow) => number, d = 1): Pt[] => base.map((r) => ({ period: r.period, value: round(f(r), d), status: 'forecast' as const }));
  const segNames = { conn: '連網部門（Starlink）', space: '太空部門（發射與開發）', ai: 'AI 部門（SI：算力、Grok、X、Cursor）' } as const;
  for (const k of ['conn', 'space', 'ai'] as const) {
    derived.push({
      id: `segment-revenue-${k === 'conn' ? 'connectivity' : k}`, name: `${segNames[k]}營收`, unit: '百萬美元',
      points: [...hist((r) => r[k], 0, 'actual'), ...fut((r) => r[k], 0)],
      note: '2025Q4 由招股書全年減前九個月推算；2026Q4 起為基準情境的模型值。',
    });
  }
  const gmKey = { conn: 'conn', space: 'space', ai: 'ai' } as const;
  const gmFc = { conn: () => F.gmConn, space: () => F.gmSpace, ai: (r: FcRow) => r.gmAi };
  for (const k of ['conn', 'space', 'ai'] as const) {
    derived.push({
      id: `segment-gross-margin-${k === 'conn' ? 'connectivity' : k}`, name: `${segNames[k]}毛利率`, unit: '%',
      points: [...hist((r) => segGm(r)[gmKey[k]], 1), ...fut((r) => gmFc[k](r), 1)],
      note: k === 'conn'
        ? `（部門營收 − 部門銷貨成本）÷ 部門營收，本站計算。2026Q3 約 3 個百分點為關稅退款等一次性利益（tr-q3-2026），預測期以 ${pct(gmConnQ3)} 扣除後的 ${pct(F.gmConn)} 計。`
        : k === 'space'
          ? `本站計算。太空部門大部分 Starship 開發費用列在研發費用，不在銷貨成本，因此毛利率偏高；預測期用最近四季合計的 ${pct(F.gmSpace)}。`
          : `本站計算。2026Q4 為依財務長「第四季毛利率與第二季相近」反推的 ${pct(aiGmQ4)}（三個情境相同），2027 年基準情境維持此值。`,
    });
  }
  // 毛利率橋接：合併毛利率的季變化 = 部門組合效果 + 部門內毛利率效果（以上一季毛利率與本季比重計，兩者相加剛好等於變化）
  {
    type Mix = { period: string; rev: number; seg: Record<'space' | 'conn' | 'ai', number>; gm: Record<'space' | 'conn' | 'ai', number>; status: Pt['status'] };
    const seq: Mix[] = [
      ...ctx.rows.map((r) => ({ period: r.period, rev: r.revenue, seg: { space: r.space, conn: r.conn, ai: r.ai }, gm: segGm(r), status: 'estimate' as const })),
      ...base.map((r) => ({ period: r.period, rev: r.rev, seg: { space: r.space, conn: r.conn, ai: r.ai }, gm: { space: F.gmSpace, conn: F.gmConn, ai: r.gmAi }, status: 'forecast' as const })),
    ];
    const mixPts: Pt[] = [];
    const withinPts: Pt[] = [];
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1]!;
      const b = seq[i]!;
      let mix = 0;
      let within = 0;
      for (const k of ['space', 'conn', 'ai'] as const) {
        mix += (b.seg[k] / b.rev - a.seg[k] / a.rev) * a.gm[k];
        within += (b.seg[k] / b.rev) * (b.gm[k] - a.gm[k]);
      }
      mixPts.push({ period: b.period, value: round(mix, 2), status: b.status });
      withinPts.push({ period: b.period, value: round(within, 2), status: b.status });
    }
    const q3 = (pts: Pt[]) => pts.find((x) => x.period === LAST)!.value;
    const q2 = (pts: Pt[]) => pts.find((x) => x.period === '2026Q2')!.value;
    derived.push({
      id: 'gross-margin-bridge-mix', name: '合併毛利率季變化：部門組合效果', unit: '個百分點', points: mixPts,
      note: `Σ（本季部門營收比重 − 上季比重）× 上季部門毛利率，本站計算；與「部門內毛利率效果」相加等於合併毛利率的季變化。2026 年第二、三季組合效果只有 ${pp(q2(mixPts), 1)}、${pp(q3(mixPts), 1)}：AI 部門比重大增，但 AI 部門上一季的毛利率與連網部門差距不大（2026Q1 為 ${pp(segGm(row(ctx, '2026Q1')).ai - segGm(row(ctx, '2026Q1')).conn, 1)}、2026Q2 為 ${pp(segGm(row(ctx, '2026Q2')).ai - segGm(row(ctx, '2026Q2')).conn, 1)}），組合改變本身影響不大。2026Q4 起為基準情境的模型值。`,
    });
    derived.push({
      id: 'gross-margin-bridge-within', name: '合併毛利率季變化：部門內毛利率效果', unit: '個百分點', points: withinPts,
      note: `Σ 本季部門營收比重 ×（本季 − 上季部門毛利率），本站計算。2026 年第二、三季合併毛利率上升主要來自這一項（${pp(q2(withinPts), 1)}、${pp(q3(withinPts), 1)}），其中又以 AI 部門自身毛利率改善（對外出租算力）為主；選定模型的毛利率只用上一季的部門毛利率，因此這部分會落後一季。2026Q4 的負值來自依財務長說法反推的 AI 部門毛利率下降與連網一次性利益消失。`,
    });
  }
  derived.push({
    id: 'starlink-revenue-per-subscriber', name: 'Starlink 消費者每用戶月營收（含終端設備）', unit: '美元／月',
    points: [...ctx.rows.map((r) => ({ period: r.period, value: round(consumerYield(ctx, r.period), 1), status: 'estimate' as const })), ...fut((r) => r.yc, 1)],
    note: `消費者營收 ÷ 平均用戶數（期初與期末平均）÷ 3，本站計算；含終端設備營收，因此高於公司公布、只計服務營收的 ARPU。2026 年第一季的下降反映低價方案與國際市場比重提高；預測期基準情境每季 ${signed(arpuBaseQ, 1)}。`,
  });
  derived.push({
    id: 'starlink-hardware-revenue', name: 'Starlink 消費者終端設備營收（推算）', unit: '百萬美元',
    points: ctx.rows.flatMap((r) => {
      const a = ctx.arpu.get(r.period);
      return a === undefined ? [] : [{ period: r.period, value: round(r.consumer - a * avgSubs(ctx, r.period) * 3, 0), status: 'estimate' as const }];
    }),
    note: '消費者營收 − 公司公布的 ARPU × 平均用戶數 × 3，本站推算；平均用戶數用期初與期末平均，與公司以月計算的口徑不同，只能看大致規模。2025Q4 公司未公布單季 ARPU，省略。',
  });
  derived.push({
    id: 'revenue-per-customer-launch', name: '每次客戶發射的發射服務營收', unit: '百萬美元／次',
    points: [...hist((r) => r.launchSvc / at(ctx.cust, r.period, 'customer launches'), 1), ...fut(() => F.price, 1)],
    note: `發射服務營收 ÷ 客戶發射次數，本站計算；發射服務營收也含 Dragon 載人與貨運等任務，單季受任務組合影響很大（例如 2026Q3 含 Falcon Heavy 發射的 NASA 羅曼太空望遠鏡）。預測期用 ${ctx.annual.years.join('、')} 年與 2025Q1–2026Q3 的累計平均 ${num(F.price, 1)} 百萬美元。`,
  });
  derived.push({
    id: 'ai-revenue-per-watt-average', name: 'AI 算力平均每瓦年營收', unit: '美元／瓦／年',
    points: [...hist((r) => perWatt(r.aiX / avgGW(ctx, r.period)), 1), ...fut((r) => perWatt(r.aiX / r.gwAvg), 1)],
    note: 'AI 解決方案與基礎設施營收（不含 Cursor）× 4 ÷ 平均額定算力，本站計算。額定算力含 xAI 自己訓練 Grok 使用的部分，因此平均值低於管理層所說出租價格（每瓦約 30–50 美元以上）。',
  });
  derived.push({
    id: 'ai-revenue-per-watt-marginal', name: 'AI 新增算力的邊際每瓦年營收', unit: '美元／瓦／年',
    points: [
      ...ctx.rows.flatMap((r) => {
        if (!ctx.by.has(addQ(r.period, -1))) return [];
        const d = avgGW(ctx, r.period) - avgGW(ctx, addQ(r.period, -1));
        return d < MIN_DGW ? [] : [{ period: r.period, value: round(perWatt((r.aiX - row(ctx, addQ(r.period, -1)).aiX) / d), 1), status: 'estimate' as const }];
      }),
      ...base.map((r) => ({ period: r.period, value: round(baseSc.yieldW, 1), status: 'forecast' as const })),
    ],
    note: '（本季 − 上季 AI 算力營收）× 4 ÷（本季 − 上季平均額定算力），本站計算（平均算力沒有增加的季度省略）；選定模型用最近一季的值預測下一季。2026 年第二季起對外出租算力，邊際值大幅上升；預測期為基準情境假設（沿用 2026Q3 的值）。',
  });
  derived.push({
    id: 'ai-capex-per-watt-added', name: 'AI 部門資本支出 ÷ 新增額定算力', unit: '美元／瓦',
    points: ctx.rows.flatMap((r) => {
      const d = at(ctx.gw, r.period, 'compute') - at(ctx.gw, addQ(r.period, -1), 'compute');
      return d > MIN_DGW ? [{ period: r.period, value: round(r.capexAi / (d * 1000), 1), status: 'estimate' as const }] : [];
    }),
    note: `AI 部門當季資本支出 ÷ 當季新增的期末額定算力，本站計算（額定算力沒有增加的季度省略）。資料中心建設與預付設備的支出通常早於算力上線，單季比值波動大；以融資租賃取得的 GPU 不在資本支出內。可與新增算力的邊際每瓦年營收（2026Q3 約 ${num(dataYieldW, 1)} 美元）對照，粗看投資回收速度；財務長稱新部署的回收期不到一年（tr-q3-2026）。`,
  });
  derived.push({
    id: 'nameplate-compute-path', name: 'AI 額定算力（期末）', unit: 'GW',
    points: [
      ...ctx.rows.map((r) => ({ period: r.period, value: at(ctx.gw, r.period, 'compute'), status: 'actual' as const })),
      ...fut((r) => r.gwEnd, 2),
    ],
    note: `公司公布的期末額定算力；2026Q4 為財務長財測 2.5–3 GW 的中點，2027 年基準情境每季增加 ${num(baseSc.gwAdd, 2)} GW（延續第四季的增幅），年底約 ${num(base.at(-1)!.gwEnd, 1)} GW，低於執行長口頭目標的約 ${num(gw27.value, 0)} GW。`,
  });
  derived.push({
    id: 'contract-type-revenue', name: '合約型營收（不含 Starlink 消費者、X 廣告與 Cursor）', unit: '百萬美元',
    points: [...hist((r) => contractType({ rev: r.revenue, consumer: r.consumer, ads: r.ads, cursor: r.cursor }), 0), ...fut((r) => contractType(r), 0)],
    note: '營收 − Starlink 消費者 − X 廣告 − Cursor，本站計算；大致對應企業與政府、發射與 AI 算力等以合約計價的營收，與未完成合約對照用。',
  });
  derived.push({
    id: 'backlog-implied-next-quarter', name: '未完成合約隱含的下一季認列額', unit: '百萬美元',
    points: [...ctx.backlog.keys()].map((p) => ({ period: addQ(p, 1), value: round((at(ctx.backlog, p, 'backlog') * at(ctx.backlogShare, p, 'backlog share')) / 100 / 4, 0), status: 'estimate' as const })),
    note: '上一季底未完成合約 × 一年內認列比重 ÷ 4，本站計算，標在預計認列的季度。未完成合約只計不可取消期間（雲端算力合約多可提前 90 天通知終止），所以實際合約型營收常高於這個數字，例如 2026 年第二季的 Anthropic 合約在季中才簽訂。',
  });
  derived.push({
    id: 'capex-intensity', name: '資本支出占營收比重', unit: '%',
    points: [
      ...hist((r) => (100 * r.capex) / r.revenue, 0),
      { period: '2026Q4', value: round((100 * capexQ4.value) / base[0]!.rev, 0), status: 'forecast' as const },
    ],
    note: `現金流量表的購置不動產廠房設備支出 ÷ 營收，本站計算。2026Q4 以財務長財測中值 ${yi(capexQ4.value)}（${thousands(capexQ4.low! / 100)}–${yi(capexQ4.high!)}）除以基準情境營收。以融資租賃取得的 GPU（例如 2026-10 與 Apollo 約 400 億美元的租賃承諾）不計入資本支出。`,
  });

  /* ── parameters ── */
  const parameters: ModelOutput['parameters'] = [
    { name: '新增算力的邊際每瓦年營收（2026Q3）', value: round(dataYieldW, 1), unit: '美元／瓦／年', note: `（${thousands(last.aiX)} − ${thousands(row(ctx, '2026Q2').aiX)}）百萬美元 × 4 ÷（${num(OF.gwAvg, 2)} − ${num(avgGW(ctx, '2026Q2'), 2)}）GW，即每 GW 每季約 ${yi(OF.yMarg)}、每瓦每年約 ${num(dataYieldW, 1)} 美元（每 GW 1 百萬美元＝每瓦 0.001 美元）。落在管理層每瓦 30–50 美元估計的上緣（tr-q2-2026；財務長 2026-10 稱目前價格略高於上緣、新部署回收期不到一年，tr-q3-2026），基準與樂觀情境沿用；只由一季的變化估計，這段增量也包含第二季已上線的 Anthropic 合約第一次整季認列，可能高估新算力的變現速度（見限制）。` },
    { name: 'AI 算力平均每瓦年營收（2026Q3）', value: round(perWatt(OF.yAvg), 1), unit: '美元／瓦／年', note: `AI 解決方案與基礎設施營收（不含 Cursor）${yi(last.aiX)} × 4 ÷ 平均額定算力 ${num(OF.gwAvg, 2)} GW；額定算力也包含 xAI 自用的部分。` },
    { name: 'Starlink 消費者每用戶月營收（含設備，2026Q3）', value: round(OF.yc, 1), unit: '美元／月', note: `公司公布的服務 ARPU 為 ${at(ctx.arpu, LAST, 'ARPU')} 美元，差額是終端設備營收。` },
    { name: '每次客戶發射的發射服務營收（累計平均）', value: round(F.price, 1), unit: '百萬美元', note: `${ctx.annual.years.join('、')} 年與 2025Q1–2026Q3 的發射服務營收合計 ÷ 客戶發射次數合計（Falcon 客戶發射；Starship 全部歸為內部發射）。` },
    { name: '發射與開發營收（最近四季平均）', value: round(F.ld, 0), unit: '百萬美元／季' },
    { name: 'X 廣告營收（最近四季平均）', value: round(F.ads, 0), unit: '百萬美元／季' },
    { name: 'Cursor 營收（第三季 48 天換算整季）', value: round(F.cursorQ, 0), unit: '百萬美元／季', note: `第三季 2026-08-14 至 09-30 認列 ${thousands(last.cursor)} 百萬美元（pr-q3-2026），× ${QUARTER_DAYS} ÷ ${CURSOR_DAYS_Q3}；預測期持平（本模型假設，公司未揭露 Cursor 的成長展望）。` },
    { name: '太空部門毛利率（最近四季合計）', value: round(F.gmSpace, 1), unit: '%' },
    { name: '連網部門毛利率（2026Q3 扣除一次性利益）', value: round(F.gmConn, 1), unit: '%', note: `第三季 ${pct(gmConnQ3)} 減約 ${CONN_ONE_OFF_PP} 個百分點的關稅退款等一次性利益（tr-q3-2026）。` },
    { name: 'AI 部門毛利率（2026Q3）', value: round(gmAiQ3, 1), unit: '%', note: '樂觀情境 2027 年沿用。' },
    { name: 'AI 部門毛利率（2026Q4，依財務長說法反推）', value: round(aiGmQ4, 1), unit: '%', note: `財務長表示第四季合併毛利率與第二季（${pct(gmQ2)}）相近，因第三季有一次性利益與客戶組合因素（tr-q3-2026）；以基準情境的部門組合反推 AI 部門毛利率，三個情境的第四季都用這個值。` },
    { name: '模型未調整的 2026Q4 合併毛利率', value: round(q4raw.gm, 1), unit: '%', note: `部門毛利率全部沿用第三季（連網扣除一次性利益）時的結果，比財務長的說法高 ${num(q4raw.gm - gmQ2, 1)} 個百分點。` },
    { name: '營業費用（不含併購相關股份基礎給付）每季成長', value: round(F.opexG, 1), unit: '%', note: `2025Q3 至 2026Q3 的幾何平均（${yi(opexExAcq(row(ctx, addQ(LAST, -4))))} → ${yi(F.opexExAcq)}），三個情境相同。` },
    { name: '併購相關股份基礎給付（每季）', value: round(F.acqSbcQ, 0), unit: '百萬美元', note: `第三季 48 天認列 ${thousands(last.sbcAcq)} 百萬美元換算整季並假設持平（本模型假設）。Cursor 併購另有 234 億美元的股權獎酬要在員工後續服務期間認列（pr-q3-2026），公司未揭露各期金額。` },
    { name: '業外收支（每季）', value: round(F.nonOp, 0), unit: '百萬美元', note: `2026Q3 利息收入 ${thousands(last.interestIncome)} 減利息費用 ${thousands(last.interestExpense)}；不含投資公允價值變動等其他收支（第三季 ${thousands(last.other)}，含對 The Boring Company 投資的利益 5.61 億美元）。` },
    { name: '所得稅率', value: TAX_RATE, unit: '%', note: '美國聯邦法定稅率，本模型假設；稅前虧損時不計所得稅利益。公司過去各季的稅負與稅率差異很大（2026Q3 認列所得稅利益 3.9 億美元）。' },
    { name: '稀釋加權平均股數', value: round(F.shares, 0), unit: '百萬股', note: '2026Q3 的值，預測期持平（本模型假設）；Cursor 併購與股份基礎給付會增加股數。' },
    { name: '2027Q1 營收財測中值', value: g27.value, unit: '百萬美元', note: `財務長 2026-10-20 財測 ${thousands(g27.low! / 100)}–${yi(g27.high!)}（tr-q3-2026）；基準情境模型值 ${yi(q1.base.rev)}，${guideText(q1.base.rev)}。` },
    { name: '2026 年 12 月年化營收目標', value: arr.value, unit: '百萬美元', note: `12 月單月營收 × 12（tr-q3-2026）。基準情境第四季營收 × 4 為 ${yi(q4.base.rev * 4)}；季內營收逐月增加時，12 月單月年化會高於季平均。` },
    { name: '2026 年底額定算力財測中值', value: gwG.value, unit: 'GW', note: `財務長財測 ${gwG.low}–${gwG.high} GW（tr-q3-2026），三個情境分別用下緣、中點與上緣。` },
    { name: '2026Q3 底未完成合約中一年內認列的金額', value: round(bl12, 0), unit: '百萬美元', note: `未完成合約 ${yi(blQ3)} × 約 ${at(ctx.backlogShare, LAST, 'backlog share')}%（sec-10q-q3-2026）。基準情境 2026Q4–2027Q3 的合約型營收（不含 Starlink 消費者、X 廣告與 Cursor）合計 ${yi(next4Contract)}，未完成合約只涵蓋其中約 ${num((100 * bl12) / next4Contract, 0)}%；其餘要靠新簽或續約，而且未完成合約只計不可取消期間。` },
  ];

  /* ── scenarios ── */
  const gwText = (sc: Scenario) =>
    sc.id === 'bear' ? `2026 年底 ${sc.gwQ4} GW（財測下緣），2027 年每季增加 ${num(sc.gwAdd, 2)} GW（2026 年第一至三季的平均增幅），年底約 ${num(fc[sc.id].at(-1)!.gwEnd, 1)} GW`
      : sc.id === 'base' ? `2026 年底 ${sc.gwQ4} GW（財測中點），2027 年每季增加 ${num(sc.gwAdd, 2)} GW（延續第四季的增幅），年底約 ${num(fc[sc.id].at(-1)!.gwEnd, 1)} GW`
        : `2026 年底 ${sc.gwQ4} GW（財測上緣），2027 年每季增加 ${num(sc.gwAdd, 2)} GW，年底達到執行長口頭目標的約 ${num(gw27.value, 0)} GW（不是正式財測）`;
  const scenarios: ModelOutput['scenarios'] = SCENARIOS.map((sc) => {
    const rows = fc[sc.id];
    const assumptions: ModelOutput['scenarios'][number]['assumptions'] = [
      { name: 'AI 額定算力', value: gwText(sc), src: 'tr-q3-2026' },
      {
        name: '新增算力的每瓦年營收',
        value: sc.id === 'bear'
          ? `每瓦 ${num(sc.yieldW, 0)} 美元（管理層 30–50 美元估計的下緣），代表出租價格較低或較多算力留給 xAI 自用`
          : `每瓦約 ${num(sc.yieldW, 1)} 美元：沿用 2026 年第三季資料算出的邊際值，與管理層「略高於每瓦 30–50 美元上緣」的說法一致（tr-q3-2026）`,
        src: sc.id === 'bear' ? 'tr-q2-2026' : 'pr-q3-2026',
      },
      {
        name: 'AI 部門毛利率',
        value: `2026 年第四季 ${pct(aiGmQ4)}（依財務長「第四季合併毛利率與第二季相近」反推，三個情境相同）；2027 年${sc.id === 'bear' ? `再低 ${BEAR_AI_GM_CUT} 個百分點至 ${pct(sc.aiGm2027)}（本模型假設，代表價格競爭或新算力的成本）` : sc.id === 'base' ? '維持第四季水準' : `回到 2026 年第三季的 ${pct(sc.aiGm2027)}`}`,
        src: 'tr-q3-2026',
      },
      {
        name: 'Starlink 消費者用戶',
        value: `每季淨增 ${num(sc.netAdds, 2)} 百萬戶（最近四季淨增 ${netAdds4.map((x) => num(x, 1)).join('、')} 百萬戶的${sc.id === 'bear' ? '最小值' : sc.id === 'base' ? '平均' : '最大值'}）`,
        src: 'pr-q3-2026',
      },
      {
        name: 'Starlink 每用戶月營收',
        value: sc.id === 'bear'
          ? `每季 ${signed(sc.arpuQ, 1)}（ARPU 由 ${addQ(LAST, -4)} 的 ${at(ctx.arpu, addQ(LAST, -4), 'ARPU')} 美元降到 ${LAST} 的 ${at(ctx.arpu, LAST, 'ARPU')} 美元，年減 ${num(Math.abs(arpuYoyLast), 1)}%，換算每季）`
          : sc.id === 'base'
            ? `每季 ${signed(sc.arpuQ, 1)}（2024、2025 年 ARPU 年減 ${arpuYearChanges.map((x) => num(Math.abs(x), 1)).join('%、')}% 的平均換算每季；公司預期國際市場比重提高與低價方案使 ARPU 繼續下降）`
            : `持平：假設 2026 年第三季的有利客戶組合（ARPU 季增約 ${num((at(ctx.arpu, LAST, 'ARPU') / at(ctx.arpu, addQ(LAST, -1), 'ARPU') - 1) * 100, 0)}%）延續，每用戶營收不再下降`,
        src: sc.id === 'base' ? 'sec-424b4' : 'pr-q3-2026',
      },
      {
        name: '企業與政府營收',
        value: sc.id === 'bear' ? '維持 2026 年第三季水準' : sc.id === 'base' ? `每季 ${signed(sc.egQ, 1)}（2025 年全年成長 ${num(egFyGrowth, 1)}% 換算每季）` : `每季 ${signed(sc.egQ, 1)}（最近四季的幾何平均成長）`,
        src: sc.id === 'base' ? 'sec-424b4' : 'pr-q3-2026',
      },
      {
        name: '客戶發射',
        value: `每季 ${num(sc.cust, 0)} 次（最近四季 ${cust4.join('、')} 次的${sc.id === 'bear' ? '最小值' : sc.id === 'base' ? '平均' : '最大值'}），每次營收 ${num(F.price, 1)} 百萬美元；公司預期 Starship 投入營運後 Falcon 9 發射會逐步減少`,
        src: 'sec-424b4',
      },
      { name: '發射與開發、X 廣告、Cursor', value: `發射與開發每季 ${yi(F.ld, 1)}、X 廣告每季 ${yi(F.ads, 1)}（最近四季平均）；Cursor 每季 ${yi(F.cursorQ, 1)}（第三季 48 天換算整季，持平）`, src: 'pr-q3-2026' },
      { name: '太空與連網部門毛利率', value: `太空 ${pct(F.gmSpace)}（最近四季合計）；連網 ${pct(F.gmConn)}（2026 年第三季扣除約 3 個百分點的一次性利益）`, src: 'tr-q3-2026' },
      { name: '營業費用、業外、稅率與股數', value: `營業費用（不含併購相關股份基礎給付）每季 ${signed(F.opexG, 1)}，另加併購相關股份基礎給付每季 ${yi(F.acqSbcQ, 1)}；業外收支每季 ${yi(F.nonOp, 1)}（利息收入減利息費用）；稅率 ${TAX_RATE}%；稀釋股數 ${thousands(F.shares)} 百萬股（三個情境相同）`, src: 'pr-q3-2026' },
      { name: '與公司展望對照', value: `2027 年第一季營收 ${yi(rows[1]!.rev)}，${guideText(rows[1]!.rev)}；2026 年第四季營收 × 4 為 ${yi(rows[0]!.rev * 4)}，公司目標是 12 月單月年化 ${yi(arr.value)}`, src: 'tr-q3-2026' },
    ];
    const forecasts: ModelOutput['scenarios'][number]['forecasts'] = rows.map((r, i) => ({
      period: r.period,
      revenue: round(r.rev, 0), grossMargin: round(r.gm, 2), operatingIncome: round(r.oi, 0), netIncome: round(r.ni, 0), eps: round(r.eps, 2),
      known: [],
      note: `AI ${yi(r.ai)}（算力 ${yi(r.aiX)}，平均額定算力 ${num(r.gwAvg, 2)} GW）、連網 ${yi(r.conn)}（期末用戶 ${num(r.subsEnd, 1)} 百萬戶）、太空 ${yi(r.space)}。${i === 1 ? `公司財測 ${thousands(g27.low! / 100)}–${yi(g27.high!)}。` : ''}${i === 0 && sc.id === 'base' ? `部門毛利率全部沿用第三季時，模型的合併毛利率為 ${pct(q4raw.gm)}；依財務長說法調整後為 ${pct(r.gm)}。` : ''}`,
    }));
    // 2026 年：前三季實際＋第四季預測
    const a26 = qRange('2026Q1', LAST).map((p) => row(ctx, p));
    const rev26 = sum(a26.map((r) => r.revenue)) + rows[0]!.rev;
    const gp26 = sum(a26.map((r) => r.gp)) + rows[0]!.gp;
    forecasts.push({
      period: '2026', revenue: round(rev26, 0), grossMargin: round((100 * gp26) / rev26, 2),
      operatingIncome: round(sum(a26.map((r) => r.oi)) + rows[0]!.oi, 0), netIncome: round(sum(a26.map((r) => r.ni)) + rows[0]!.ni, 0), known: [],
      note: '第一至三季為實際值，第四季為模型值；淨利為合併淨利（第一季歸屬普通股股東的淨損另含特別股視同股利 6.71 億美元）。各季股數差異很大，不列全年 EPS。',
    });
    const y = annual(yearOf(rows, '2027'));
    forecasts.push({
      period: '2027', revenue: round(y.rev, 0), grossMargin: round(y.gm, 2), operatingIncome: round(y.oi, 0), netIncome: round(y.ni, 0), eps: round(y.eps, 2), known: [],
      note: `四季加總；毛利率為全年毛利 ÷ 全年營收，EPS 為四季加總。AI ${yi(y.ai)}、連網 ${yi(y.conn)}、太空 ${yi(y.space)}。`,
    });
    return { id: sc.id, name: sc.name, assumptions, forecasts };
  });

  /* ── summary and limitations ── */
  const summary = `選定模型把營收拆成 Starlink 用戶 × 每用戶營收、客戶發射 × 每次營收，以及 AI 算力營收（既有營收加上新增額定算力 × 最近一季的邊際每瓦營收），部門毛利率加權成合併毛利率。公開財報只有 7 季，回測只有 ${TEST.from}–${TEST.to} 共 ${test.length} 季（代入當季實際用戶、發射與算力）：營收平均誤差（MAPE）${pct(S.revenue!.mape!)}、毛利率平均誤差 ${num(S.grossMargin!.mae, 1)} 個百分點，天真模型為 ${pct(N.revenue!.mape!)} 與 ${num(N.grossMargin!.mae, 1)} 個百分點；驅動因子改用事前推估時營收誤差 ${pct(EA.revenue!.mape!)}；${q3Miss(selected as Id)}（季中新簽的雲端算力合約只能落後一季反映），樣本太少，誤差只能當參考。基準情境 2026 年第四季營收約 ${yi(q4.base.rev)}、毛利率依財務長說法約 ${pct(q4.base.gm, 0)}，2027 年第一季 ${yi(q1.base.rev)}（公司財測 ${thousands(g27.low! / 100)}–${yi(g27.high!)}），2027 年約 ${yi(y27.base.rev)}（保守至樂觀 ${thousands(y27.bear.rev / 100)}–${yi(y27.bull.rev)}），差距主要來自算力擴充速度與每瓦營收。這是依假設推算的模型結果，不是投資建議。`;
  if (summary.length > 800) throw new Error(`summary too long (${summary.length})`);

  const limitations = [
    `歷史太短：SpaceX 在 2026 年 6 月才上市，招股書只有 2025 年起的季資料，回測只有 ${test.length} 季、參數由 2–6 季估計。營收誤差 ${pct(S.revenue!.mape!)} 與天真模型 ${pct(N.revenue!.mape!)} 的差距${Math.abs(tStat) < tCrit ? '不具統計顯著性' : '樣本太小、不宜過度解讀'}（${tText}），選定模型主要是因為它的結構（數量 × 單價）較能說明營收從哪裡來，而不是因為回測證明它比較準。`,
    `回測是條件式的：代入當季實際的用戶數、客戶發射次數與額定算力（Cursor 營收也用實際值），衡量的是「驅動因子已知時」模型拆解營收的能力；驅動因子改用趨勢推估時營收誤差升到 ${pct(EA.revenue!.mape!)}。2026 年第二、三季的大幅低估來自季中新簽的雲端算力合約，任何只看過去資料的模型都難以事前預知。`,
    `AI 營收高度集中：2026 年第三季單一 AI 客戶（Customer B）占合併營收 ${num(at(actualSeries(drivers, 'customer-b-share'), LAST, 'customer B'), 1)}%，雲端算力合約多可提前 90 天通知終止；未完成合約只計不可取消期間，基準情境未來四季的合約型營收只有約 ${num((100 * bl12) / next4Contract, 0)}% 有未完成合約支撐。2027 年的算力擴充（樂觀情境的約 ${num(gw27.value, 0)} GW 是執行長口頭目標）與每瓦營收都是假設，三個情境 2027 年營收相差約 ${num(y27.bull.rev / y27.bear.rev, 1)} 倍。`,
    `新增算力的每瓦年營收（約 ${num(dataYieldW, 1)} 美元）只由 2026 年第二到第三季一次變化估計，平均每 GW 版本與本模型的回測差距也集中在${segConcentrated ? ` ${qText(segTop.p)}` : '少數幾季'}。這段增量包含 5 月起的 Anthropic 合約第一次整季認列（第二季已開始認列，所用算力在第二季已上線），因此可能高估新算力的變現速度；它與財務長「略高於每瓦 30–50 美元上緣」的說法相近，基準與樂觀情境假設之後新增的算力都和這段增量一樣變現（自用比例不變）。新增算力每瓦少 10 美元，基準情境 2027 年營收變動約 ${signed(sensYieldDown, 1)}（見敏感度）。`,
    `毛利率：部門毛利率沿用最近一季或最近四季，沒有分開建模折舊、電力與新算力爬坡成本；Cursor 的毛利率未單獨揭露，模型以 AI 部門整體毛利率計；2026 年第四季的 AI 部門毛利率是依財務長「與第二季相近」的口頭說法反推（未給數字）。以融資租賃取得的 GPU（2026-10 與 Apollo 約 400 億美元的租賃承諾，2027 上半年起租）不計入資本支出，租賃成本與利息會影響之後的毛利率與淨利。`,
    '營業費用、併購相關股份基礎給付（Cursor 的 234 億美元股權獎酬認列時程未揭露）、業外收支、21% 稅率與股數都是簡化假設；Cursor 營收只有第三季 48 天的資料，預測期假設持平。EPS 對這些假設很敏感。',
    ...(() => {
      const q3s = ctx.rows.filter((r) => r.period.endsWith('Q3'));
      const rest = ctx.rows.filter((r) => !r.period.endsWith('Q3')).map((r) => r.launchDev);
      if (q3s.length < 2 || Math.min(...q3s.map((r) => r.launchDev)) <= Math.max(...rest)) return [];
      return [`太空部門的發射與開發營收用最近四季平均，但 ${q3s.map((r) => r.period.slice(0, 4)).join('、')} 年都是第三季最高（${q3s.map((r) => thousands(r.launchDev)).join('、')} 百萬美元，其他季度 ${thousands(Math.min(...rest))}–${thousands(Math.max(...rest))} 百萬美元），可能有季節性，模型沒有處理；太空部門只占基準情境 2027 年營收約 ${num((100 * y27.base.space) / y27.base.rev, 1)}%，對合併數影響小。`];
    })(),
    'SpaceX 與 Tesla 的董事會已各自成立特別委員會評估合併（尚無決定），EchoStar 與 800 MHz 頻譜收購、Starship 商業發射與 Starlink 直連手機服務等事件都可能改變營收結構，模型沒有納入。',
  ];

  const sourceKeys = ['sec-424b4', 'pr-q2-2026', 'pr-q3-2026', 'sec-10q-q2-2026', 'sec-10q-q3-2026', 'tr-q2-2026', 'tr-q3-2026', 'sec-fwp-google', 'sec-8k-apollo', 'sec-companyfacts'];

  const out: ModelOutput = {
    company: 'spacex',
    generatedBy: 'scripts/models/spacex.ts',
    generatedOn: GENERATED_ON,
    asOf: inputs.asOf < drivers.asOf ? inputs.asOf : drivers.asOf,
    currency: 'USD',
    amountUnit: 'million',
    periodLabel: '日曆季度（百萬美元；EPS 為稀釋 EPS，美元）',
    train: TRAIN,
    test: TEST,
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
  return modelOutput.parse(out);
}

/* ───────────── CLI ───────────── */

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
  const dir = arg('--dir') ?? 'src/data/forecast';
  const inputs = companyInputs.parse(parse(readFileSync(`${dir}/spacex-inputs.yaml`, 'utf8')));
  const drivers = companyDrivers.parse(parse(readFileSync(`${dir}/spacex-drivers.yaml`, 'utf8')));
  const out = buildModel(inputs, undefined, drivers);
  const file = arg('--out') ?? `${dir}/spacex-model.json`;
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  const sel = out.candidates.find((c) => c.selected)!;
  console.log(`✓ ${file}: selected ${sel.id}`);
  for (const c of out.candidates) console.log(`  ${c.selected ? '*' : ' '} ${c.id.padEnd(26)} Rev MAPE ${c.metrics.revenue?.mape}%  GM MAE ${c.metrics.grossMargin?.mae}pp  Rev ex-ante ${c.metrics.revenueExAnte?.mape ?? '-'}%`);
  for (const s of out.scenarios) console.log(`  ${s.id}: ${s.forecasts.map((f) => `${f.period} R${f.revenue} GM${f.grossMargin} EPS${f.eps ?? '-'}`).join(' | ')}`);
}
