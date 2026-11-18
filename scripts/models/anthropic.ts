// Anthropic 財報模型：把公司說過的年化營收（run-rate）換算成當季認列的營收，毛利率用「銷貨成本 ÷ 算力與基礎設施費用」
// 乘上當季算力費用推算；預測期的第四季用招股書口徑的 9 月底、10 月底年化營收加上 11–12 月的情境路徑，並依招股書定義換算
// （用量計費的年化營收是過去 28 天 × 13，反映約 14 天前的營收，見 impliedDefinitional），2027 年沒有年化營收
// 可用，改以「算力受限」推估：營收 = 算力效率 × 算力費用，算力費用依招股書揭露的未來 12 個月算力承諾推算。
//   npx tsx scripts/models/anthropic.ts [--dir <dir>] [--out <file>]   → 寫出 <dir>/anthropic-model.json（預設 src/data/forecast）
// buildModel(inputs, prices, drivers) 是純函式（不讀檔、不取時間），scripts/check-forecast.ts 會重跑並比對輸出。
// prices（記憶體合約價）不影響 Anthropic 模型，可為 undefined。
//
// 口徑：GAAP，百萬美元，日曆季度。上市前沒有單季每股盈餘，淨損主要來自金融工具的公允價值變動，因此不預測淨利與 EPS。
// 公開財報只有招股書的 2025Q1–2026Q3 共 7 季，回測採「擴張視窗、逐季一步預測」：預測第 t 季時只用 t−1 季以前的財報估參數；
// 年化營收只用在第 t 季財報第一次公開以前發布的說法（2026Q3 的 9 月底與 10 月底年化營收和第三季財報同時公布，不用）。
// 條件式回測代入這些說法與當季實際的算力費用；事前版本只用季初的年化營收，算力費用延續上一季的成長。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import {
  companyDrivers, companyInputs, modelOutput,
  type CompanyDrivers, type CompanyInputs, type MarketPrices, type ModelOutput,
} from '../../src/schemas/forecast';
import { addQ, metrics, qIndex, qRange, round, sum, type Pair } from './lib';
import {
  T_CRIT_5PCT, USAGE_LAG_DAYS, dayNum, efficiency, impliedDefinitional, impliedFromPath, impliedRevenue, lineFit, meanOf, meanSe, nonCompute, num,
  oiText, pairedT, pct, pointOf, pp, qText, quarterTable, rrAt, runRatePoints, servingShare, signed, signedYi, startImplied, thousands, yi,
  type AQ, type PathPoint, type RRPoint,
} from './anthropic-lib';

const GENERATED_ON = '2026-11-18';
const TRAIN = { from: '2025Q1', to: '2025Q2' }; // 第一個測試季的訓練資料；之後每季擴張到 t−1
const TEST = { from: '2025Q3', to: '2026Q3' };
const LAST = '2026Q3';
const FORECAST = ['2026Q4', '2027Q1', '2027Q2', '2027Q3', '2027Q4'];
/** 參與選模的模型，由簡單到複雜；事前版本不參與（參數與條件式版本相同）。 */
const ELIGIBLE = ['naive', 'log-linear-trend', 'compute-efficiency', 'run-rate-conversion'] as const;
const EXPECTED = 'run-rate-conversion';
const SIMPLER_MARGIN = 2; // 較簡單的模型分數與最低者相差不到 2（營收 MAPE ＋ 毛利率 MAE）時改選較簡單者
const TREND_WINDOW = 4; // 對數線性趨勢用最近 4 季（不足時用全部，至少 2 季）
/** 各季財報第一次公開的日期：2025Q1–2026Q2 在 2026-10-26 的 S-1（sec-s1），2026Q3 在 2026-11-10 的 S-1/A 第 2 號（sec-fwp-eea 依此編製）。 */
const RESULTS_PUBLIC_DEFAULT = '2026-10-26';
const RESULTS_PUBLIC: Record<string, string> = { '2026Q3': '2026-11-10' };
/** 2026-09-30 起未來 12 個月的算力與基礎設施承諾約 707 億美元（含短期承諾、尚未開始的租賃與 9 月底以後的新合約，sec-fwp-eea）。 */
const COMMIT_NEXT_12M = 70_700;
/** 同口徑到 2030 年底約 4,516 億美元（sec-fwp-eea），用來對照 2027 年第四季的延伸。 */
const COMMIT_THROUGH_2030 = 451_600;
/**
 * 預測期的換算倍數：9 月底與 10 月底的年化營收是招股書口徑（過去 28 天用量 × 13 ＋ 月訂閱費 × 12），依定義換算
 * （impliedDefinitional：用量部分取 14 天後的年化營收）就是營收，不另乘倍數。
 */
const K_FORECAST = 1;
const MONTH_DAYS = 365.25 / 12;

/* ───────────── helpers ───────────── */

const qDates = (p: string) => {
  const y = Number(p.slice(0, 4));
  const q = Number(p.slice(5));
  const m0 = 3 * (q - 1) + 1;
  const endDay = new Date(Date.UTC(y, m0 + 2, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return { start: `${y}-${pad(m0)}-01`, end: `${y}-${pad(m0 + 2)}-${pad(endDay)}` };
};
const resultsPublic = (p: string) => RESULTS_PUBLIC[p] ?? RESULTS_PUBLIC_DEFAULT;
/** 回測第 t 季時能用的年化營收說法：來源在 t 季財報第一次公開以前發布。 */
const usableFor = (pts: readonly RRPoint[], t: string) => pts.filter((x) => x.published < resultsPublic(t));
const monthlyGrowth = (from: RRPoint, to: RRPoint) => (Math.pow(to.value / from.value, MONTH_DAYS / (to.day - from.day)) - 1) * 100;

/* ───────────── scenarios ───────────── */

interface Scenario {
  id: 'bear' | 'base' | 'bull';
  name: string;
  rrDec: number; // 2026 年底的年化營收（百萬美元）
  rrText: string;
  effTarget: number; // 2027 年第四季的算力效率（倍）
  effFrom: string; // 取自哪一季
  share: number; // 銷貨成本 ÷ 算力與基礎設施費用
  shareText: string;
}
interface FcOpts { computeMult?: number; effAdd?: number; shareAdd?: number; ncAdd?: number; k?: number; noLag?: boolean; rrDec?: number; revFixed?: boolean; flatRev?: boolean }
interface FcRow { period: string; rev: number; compute: number; eff: number; share: number; cogs: number; gp: number; gm: number; nc: number; donation: number; oi: number }

/* ───────────── build ───────────── */

export function buildModel(inputs: CompanyInputs, _prices?: MarketPrices, drivers?: CompanyDrivers): ModelOutput {
  if (!drivers) throw new Error('anthropic model needs anthropic-drivers.yaml');
  const rows = quarterTable(inputs);
  const by = new Map(rows.map((r) => [r.period, r]));
  const periods = rows.map((r) => r.period);
  const row = (p: string): AQ => { const r = by.get(p); if (!r) throw new Error(`anthropic inputs: ${p} missing`); return r; };
  if (periods.at(-1) !== LAST) throw new Error(`anthropic inputs must end at ${LAST}; move the test window and forecasts first`);
  if (inputs.sources['sec-s1']?.published !== RESULTS_PUBLIC_DEFAULT) throw new Error('sec-s1 publication date changed; review RESULTS_PUBLIC');
  const test = qRange(TEST.from, TEST.to);
  const allPts = runRatePoints(drivers);
  const before = (t: string) => periods.filter((p) => qIndex(p) < qIndex(t));

  /* ── one-step-ahead backtest (expanding window) ── */
  type Id = 'naive' | 'log-linear-trend' | 'compute-efficiency' | 'run-rate-conversion' | 'run-rate-ex-ante';
  interface P { rev: number; gm: number }
  const preds = new Map<Id, Map<string, P>>();
  const exCompute = new Map<string, P>(); // 算力效率模型的事前版本（算力費用延續上一季成長）
  const put = (id: Id, p: string, x: P) => { if (!preds.has(id)) preds.set(id, new Map()); preds.get(id)!.set(p, x); };
  const kAt = new Map<string, { k: number; ks: number; implied: number; startImp: number; usable: RRPoint[] }>();
  const trendAt = new Map<string, { b: number; se: number; n: number }>();
  for (const t of test) {
    const o = addQ(t, -1);
    const o2 = addQ(t, -2);
    const q = row(o);
    const q2 = row(o2);
    const a = row(t);
    put('naive', t, { rev: q.revenue, gm: q.gm });
    // 對數線性趨勢：最近 4 季的 ln 營收、ln（銷貨成本 ÷ 營收）對季度做迴歸
    const win = before(t).slice(-TREND_WINDOW);
    const xs = win.map((p) => qIndex(p));
    const fr = lineFit(xs, win.map((p) => Math.log(row(p).revenue)));
    const fc = lineFit(xs, win.map((p) => Math.log(row(p).cogs / row(p).revenue)));
    trendAt.set(t, { b: fr.b, se: fr.se, n: fr.n });
    const revTrend = Math.exp(fr.a + fr.b * qIndex(t));
    put('log-linear-trend', t, { rev: revTrend, gm: 100 * (1 - Math.exp(fc.a + fc.b * qIndex(t))) });
    // 算力效率：上一季的營收 ÷ 算力費用 × 當季實際算力費用；毛利率因此等於上一季
    put('compute-efficiency', t, { rev: efficiency(q) * a.compute, gm: q.gm });
    const cHat = (q.compute * q.compute) / q2.compute;
    exCompute.set(t, { rev: efficiency(q) * cHat, gm: q.gm });
    // 年化營收換算：Σ 當季每日年化營收 ÷ 364 × 換算倍數（訓練期平均）
    const usable = usableFor(allPts, t);
    const train = before(t);
    const k = meanOf(train.map((p) => row(p).revenue / impliedRevenue(row(p).start, row(p).end, usable)));
    const ks = meanOf(train.map((p) => row(p).revenue / startImplied(row(p).start, row(p).end, usable)));
    const implied = impliedRevenue(a.start, a.end, usable);
    const startImp = startImplied(a.start, a.end, usable);
    kAt.set(t, { k, ks, implied, startImp, usable });
    const revRR = k * implied;
    put('run-rate-conversion', t, { rev: revRR, gm: 100 * (1 - (servingShare(q) * a.compute) / revRR) });
    const revEx = ks * startImp;
    put('run-rate-ex-ante', t, { rev: revEx, gm: 100 * (1 - (servingShare(q) * cHat) / revEx) });
  }
  const pairsOf = (m: Map<string, P>, k: keyof P): Pair[] => test.map((p) => ({ actual: k === 'rev' ? row(p).revenue : row(p).gm, predicted: m.get(p)![k] }));
  type MetricSet = Record<string, ReturnType<typeof metrics>>;
  const M: Record<string, MetricSet> = {};
  for (const [id, m] of preds) M[id] = { revenue: metrics(pairsOf(m, 'rev')), grossMargin: metrics(pairsOf(m, 'gm'), false) };
  const exOf = (m: Map<string, P>) => ({ revenueExAnte: metrics(pairsOf(m, 'rev')), grossMarginExAnte: metrics(pairsOf(m, 'gm'), false) });
  // 天真與趨勢模型本來就只用過去的財報，事前與逐季相同
  Object.assign(M.naive!, exOf(preds.get('naive')!));
  Object.assign(M['log-linear-trend']!, exOf(preds.get('log-linear-trend')!));
  Object.assign(M['compute-efficiency']!, exOf(exCompute));
  Object.assign(M['run-rate-conversion']!, exOf(preds.get('run-rate-ex-ante')!));
  const score = (id: string) => M[id]!.revenue!.mape! + M[id]!.grossMargin!.mae;
  const best = [...ELIGIBLE].sort((a, b) => score(a) - score(b))[0]!;
  const simplerOk = ELIGIBLE.slice(0, ELIGIBLE.indexOf(best)).find((id) => score(id) - score(best) < SIMPLER_MARGIN);
  const selected = simplerOk ?? best;
  if (selected !== EXPECTED) throw new Error(`selection changed to ${selected}; review the forecast wiring and texts`);
  // 同一規則改用事前版本計分（條件式與事前模型不能直接比較）：排名必須不變，否則選模的說明要改寫
  const scoreEx = (id: string) => (M[id]!.revenueExAnte ?? M[id]!.revenue)!.mape! + (M[id]!.grossMarginExAnte ?? M[id]!.grossMargin)!.mae;
  const bestEx = [...ELIGIBLE].sort((a, b) => scoreEx(a) - scoreEx(b))[0]!;
  const selectedEx = ELIGIBLE.slice(0, ELIGIBLE.indexOf(bestEx)).find((id) => scoreEx(id) - scoreEx(bestEx) < SIMPLER_MARGIN) ?? bestEx;
  if (selectedEx !== selected) throw new Error(`ex-ante scoring selects ${selectedEx}; review the selection text`);
  const S = M[selected]!;
  const N = M.naive!;
  const TR = M['log-linear-trend']!;
  const CE = M['compute-efficiency']!;
  const EA = M['run-rate-ex-ante']!;
  const errOf = (id: Id, p: string) => (preds.get(id)!.get(p)!.rev / row(p).revenue - 1) * 100;
  const apeOf = (id: Id, p: string) => Math.abs(errOf(id, p));
  const tTest = (a: Id, b: Id) => {
    const d = test.map((p) => apeOf(a, p) - apeOf(b, p));
    const r = pairedT(d);
    const crit = T_CRIT_5PCT[r.df];
    if (crit === undefined) throw new Error('extend T_CRIT_5PCT for the new test length');
    // 差距是否只靠一季：拿掉貢獻最大的一季後，平均差距會不會變號
    const top = test.map((p, i) => ({ p, d: d[i]! })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d))[0]!;
    const rest = sum(d) - top.d;
    const oneQuarter = Math.sign(rest) !== Math.sign(sum(d)) || Math.abs(rest) < 1e-9;
    return { ...r, crit, sig: Math.abs(r.t) >= crit, top, oneQuarter, wins: d.filter((x) => x > 0.5).length, losses: d.filter((x) => x < -0.5).length };
  };
  const tText = (x: ReturnType<typeof tTest>, aName: string, bName: string) =>
    `${aName}與${bName}逐季營收絕對百分比誤差的配對 t 值約 ${num(x.t, 1)}（自由度 ${x.df}），${x.sig ? `超過 5% 顯著水準所需的 ${num(x.crit, 2)}，但樣本只有 ${x.df + 1} 季` : `未達 5% 顯著水準所需的 ${num(x.crit, 2)}`}${x.oneQuarter ? `；差距主要來自 ${qText(x.top.p)}，拿掉這一季排名就會改變` : ''}`;
  const tSelNaive = tTest('naive', selected as Id);
  const tExNaive = tTest('naive', 'run-rate-ex-ante');
  const tExTrend = tTest('log-linear-trend', 'run-rate-ex-ante');
  const w = (e: number) => (e < 0 ? '低估' : '高估');
  const missText = (id: Id) => test.map((p) => `${qText(p)}${w(errOf(id, p))} ${num(Math.abs(errOf(id, p)), 0)}%`).join('、');

  // 年化營收的時點與事前版本的資訊洩漏：季初值內插時用到的下一個說法在季初後幾天（季初剛好有說法時沒有洩漏）
  const leak = test.map((t) => {
    const a = row(t);
    const u = kAt.get(t)!.usable;
    const d0 = dayNum(a.start);
    const next = u.some((x) => x.day === d0) ? undefined : u.find((x) => x.day > d0);
    return { t, next, after: next ? next.day - d0 : undefined, atOrAfterEnd: next ? next.day >= dayNum(a.end) + 1 : false };
  });
  const leakText = leak
    .filter((x) => x.next && x.after !== undefined && x.after > 0)
    .map((x) => `${qText(x.t)}用到 ${x.next!.label}${/\d$/.test(x.next!.label) ? ' ' : ''}的 ${yi(x.next!.value)}${x.atOrAfterEnd ? '（就是該季季末）' : `（季初後 ${x.after} 天）`}`)
    .join('、');
  const q3Usable = kAt.get('2026Q3')!.usable;
  const q3Last = q3Usable.at(-1)!;
  // 嚴格的事前檢查（診斷用，不列為候選模型）：季初的年化營收只用季初以前已經發布的說法，最後一個說法之後維持不變、不用之後的說法內插；
  // 季初倍數 k_s 也用同一組說法在訓練期估計。季初以前沒有任何已發布說法的季度無法預測，不計入。
  const strict = test.map((t) => {
    const a = row(t);
    const pts = allPts.filter((x) => x.published < a.start);
    const naiveApe = Math.abs(row(addQ(t, -1)).revenue / a.revenue - 1) * 100;
    if (!pts.length) return { t, ok: false, err: NaN, naive: naiveApe };
    const ks = meanOf(before(t).map((p) => row(p).revenue / startImplied(row(p).start, row(p).end, pts)));
    const rev = ks * startImplied(a.start, a.end, pts);
    return { t, ok: true, err: (rev / a.revenue - 1) * 100, naive: naiveApe };
  });
  const strictOk = strict.filter((x) => x.ok);
  const strictNone = strict.filter((x) => !x.ok).map((x) => x.t);
  if (strictOk.length < 3) throw new Error('strict ex-ante check has fewer than 3 quarters; review the text');
  const strictMape = meanOf(strictOk.map((x) => Math.abs(x.err)));
  const strictNaive = meanOf(strictOk.map((x) => x.naive));
  const firstPublished = [...allPts].sort((a, b) => (a.published < b.published ? -1 : 1))[0]!.published;
  const strictText = `若再要求季初的值只用季初以前已經發布的說法（不用之後的說法內插，最後一個說法之後維持不變）：${strictNone.length ? `${strictNone.map(qText).join('、')}開始前沒有任何已發布的說法（最早的「2025 年初」與「8 月」數字在 ${firstPublished} 才公布），無法預測；` : ''}其餘 ${strictOk.length} 季營收 MAPE ${pct(strictMape)}（${strictOk.map((x) => `${qText(x.t)}${w(x.err)} ${num(Math.abs(x.err), 0)}%`).join('、')}），同 ${strictOk.length} 季的天真模型 ${pct(strictNaive)}。公司在這段期間公布年化營收的次數太少，真正即時的預測做不到上面的事前誤差`;

  /* ── full-data parameters (through 2026Q3) ── */
  const last = row(LAST);
  const ratiosAll = rows.map((r) => ({ p: r.period, v: r.revenue / impliedRevenue(r.start, r.end, allPts) }));
  const kAll = meanSe(ratiosAll.map((x) => x.v));
  const kQ3 = ratiosAll.at(-1)!.v;
  const rQ2 = ratiosAll.find((x) => x.p === '2026Q2')!.v;
  const r25 = ratiosAll.filter((x) => x.p.startsWith('2025')).map((x) => x.v);
  const r25Text = `${num((Math.min(...r25) - 1) * 100, 0)}–${num((Math.max(...r25) - 1) * 100, 0)}%`;
  const gm2025 = (() => { const a = inputs.annual.find((x) => x.year === '2025')?.extra; if (!a?.['毛利'] || !a['營收']) throw new Error('annual 2025 gross profit missing'); return (100 * a['毛利']) / a['營收']; })();
  const ksAll = meanSe(rows.map((r) => r.revenue / startImplied(r.start, r.end, allPts)));
  const trendWin = periods.slice(-TREND_WINDOW);
  const trendFull = lineFit(trendWin.map((p) => qIndex(p)), trendWin.map((p) => Math.log(row(p).revenue)));
  const last4 = periods.slice(-4).map(row);
  const last3 = periods.slice(-3).map(row);
  const shareQ3 = servingShare(last);
  const shareMean4 = meanOf(last4.map(servingShare));
  const shareMin4 = Math.min(...last4.map(servingShare));
  const shareMinQ = last4.find((r) => servingShare(r) === shareMin4)!.period;
  const effs3 = last3.map((r) => ({ p: r.period, e: efficiency(r) }));
  const effLo = effs3.reduce((a, b) => (b.e < a.e ? b : a));
  const effHi = effs3.reduce((a, b) => (b.e > a.e ? b : a));
  const effQ3 = efficiency(last);
  const ncRatio = nonCompute(last) / last.revenue;
  const donationAvg = meanOf(last4.map((r) => r.donation));
  const usageShareOf = (r: AQ) => { const v = inputs.quarters.find((q) => q.period === r.period)?.extra?.['用量計費營收']; if (v === undefined) throw new Error(`${r.period}: consumption revenue missing`); return v / r.revenue; };
  const consumptionShareQ3 = 100 * usageShareOf(last);
  const usageQ3 = usageShareOf(last);
  // 依招股書定義換算（用量計費部分落後 14 天）的倍數：只有 2026Q3 的季末有招股書口徑的年化營收，其他各季只作參考
  const ratiosDef = rows.map((r) => ({ p: r.period, v: r.revenue / impliedDefinitional(r.start, r.end, allPts, usageShareOf(r)) }));
  const kDefQ3 = ratiosDef.at(-1)!.v;
  const fvChange9m = -sum(inputs.quarters.filter((q) => q.period.startsWith('2026')).map((q) => q.extra?.['可轉換票據等公允價值變動'] ?? NaN));
  if (!Number.isFinite(fvChange9m)) throw new Error('2026 fair-value changes missing');

  // 年化營收：9 月底、10 月底（招股書口徑）、5 月的說法
  const ptOf = (period: string) => { const x = allPts.find((y) => y.period === period); if (!x) throw new Error(`run-rate ${period} missing`); return x; };
  const rrSep = ptOf('2026-09');
  const rrOct = ptOf('2026-10');
  const rrMay = ptOf('2026-05');
  const gOct = monthlyGrowth(rrSep, rrOct);
  const gMayOct = monthlyGrowth(rrMay, rrOct);
  const decInstant = dayNum('2027-01-01');
  const rrDecAt = (g: number) => rrOct.value * Math.pow(1 + g / 100, (decInstant - rrOct.day) / MONTH_DAYS);
  // 第四季的年化營收路徑：公司說法＋年底值；依定義換算時 12 月下旬的用量營收要看 1 月上旬的年化營收，年底以後沿用 11–12 月的成長率
  const pathOf = (rrDec: number): PathPoint[] => {
    const rate = Math.log(rrDec / rrOct.value) / (decInstant - rrOct.day);
    return [...allPts.map((x) => ({ day: x.day, value: x.value })), { day: decInstant, value: rrDec }, { day: decInstant + 31, value: rrDec * Math.exp(31 * rate) }];
  };
  const q4D = qDates(FORECAST[0]!);
  /** 依定義換算的第四季營收 ÷ Σ 每日年化營收 ÷ 364（與歷史的換算倍數同一口徑） */
  const defRatioOf = (rrDec: number) => impliedDefinitional(q4D.start, q4D.end, pathOf(rrDec), usageQ3) / impliedFromPath(q4D.start, q4D.end, pathOf(rrDec));

  // 算力費用：2026Q4–2027Q3 合計等於未來 12 個月的承諾，逐季等比成長；2027Q4 延續同一成長率
  const solveG = () => {
    let lo = 0.5;
    let hi = 3;
    for (let i = 0; i < 200; i++) {
      const g = (lo + hi) / 2;
      const s = last.compute * (g + g ** 2 + g ** 3 + g ** 4);
      if (s > COMMIT_NEXT_12M) hi = g; else lo = g;
    }
    return (lo + hi) / 2;
  };
  const gC = solveG();
  const computePath = FORECAST.map((_, i) => last.compute * gC ** (i + 1));
  const compute2027 = sum(computePath.slice(1));
  const oblig2027 = pointOf(drivers, 'contractual-obligations', '2027');

  const SCENARIOS: Scenario[] = [
    {
      id: 'bear', name: '保守', rrDec: rrSep.value,
      rrText: `10 月的增加沒有維持：11–12 月年化營收逐步回落，年底回到 9 月底的 ${yi(rrSep.value)}。用量計費占第三季營收 ${pct(consumptionShareQ3, 0)}（sec-fwp-japan），年化營收會隨用量波動；招股書也指出第二季到第三季約 6 億美元的成長被降價抵銷（sec-fwp-eea）`,
      effTarget: effLo.e, effFrom: effLo.p,
      share: shareMean4, shareText: `最近四季平均 ${pct(100 * shareMean4)}（短期承諾的高價算力比重提高）`,
    },
    {
      id: 'base', name: '基準', rrDec: rrDecAt(gMayOct),
      rrText: `11–12 月每月 ${signed(gMayOct, 1)}，等於 2026 年 5 月的 ${yi(rrMay.value)}（an-series-h）到 10 月底的 ${yi(rrOct.value)}（sec-fwp-eea）之間的平均月增幅（5 月的新聞稿口徑未說明、時點假設為 5 月中），年底約 ${yi(rrDecAt(gMayOct))}`,
      effTarget: effQ3, effFrom: LAST,
      share: shareQ3, shareText: `維持 ${qText(LAST)}的 ${pct(100 * shareQ3)}`,
    },
    {
      id: 'bull', name: '樂觀', rrDec: rrDecAt(gOct),
      rrText: `10 月的增幅延續：11–12 月每月 ${signed(gOct, 1)}（9 月底 ${yi(rrSep.value)} → 10 月底 ${yi(rrOct.value)}，sec-fwp-eea），年底約 ${yi(rrDecAt(gOct))}；公司在使用前數月到數年就簽下算力承諾（sec-fwp-eea），第四季可用的算力大致已定，更快的成長需要更多短期算力`,
      effTarget: effHi.e, effFrom: effHi.p,
      share: shareMin4, shareText: `最近四季最低的 ${pct(100 * shareMin4)}（${qText(shareMinQ)}；長期合約算力取代短期承諾算力）`,
    },
  ];

  const forecast = (sc: Scenario, o: FcOpts = {}): FcRow[] => {
    const k = o.k ?? K_FORECAST;
    const path = pathOf(o.rrDec ?? sc.rrDec);
    // noLag：舊的換算方式（Σ 每日年化營收 ÷ 364，不考慮用量計費是過去 28 天的平均）
    const rev0 = k * (o.noLag ? impliedFromPath(q4D.start, q4D.end, path) : impliedDefinitional(q4D.start, q4D.end, path, usageQ3));
    const cm = o.computeMult ?? 1;
    const out: FcRow[] = [];
    // 第四季的算力效率（營收由年化營收換算、算力費用依承諾），2027 年由這個值逐季線性移到情境值（2027Q4 達到）
    const eff0 = rev0 / computePath[0]!;
    const target = sc.effTarget + (o.effAdd ?? 0);
    FORECAST.forEach((p, i) => {
      const compute = computePath[i]! * cm;
      const effPath = i === 0 ? eff0 : eff0 + ((target - eff0) * i) / (FORECAST.length - 1);
      // computeMult：算力多出的部分以同樣效率轉成營收；revFixed：營收維持原本的算力路徑換算值（多出的算力沒有營收）
      // flatRev：2027 年營收停在第四季的水準（需求停滯的壓力測試）
      const rev = i === 0 || o.flatRev ? rev0 : effPath * (o.revFixed ? computePath[i]! : compute);
      const eff = rev / compute;
      const share = sc.share + (o.shareAdd ?? 0);
      const cogs = share * compute;
      const gp = rev - cogs;
      const nc = (ncRatio + (o.ncAdd ?? 0)) * rev;
      const oi = rev - compute - nc - donationAvg;
      out.push({ period: p, rev, compute, eff, share, cogs, gp, gm: (100 * gp) / rev, nc, donation: donationAvg, oi });
    });
    return out;
  };
  const fc = Object.fromEntries(SCENARIOS.map((s) => [s.id, forecast(s)])) as Record<Scenario['id'], FcRow[]>;
  const base = fc.base;
  const baseSc = SCENARIOS.find((s) => s.id === 'base')!;
  const yearOf = (rs: FcRow[], y: string) => rs.filter((r) => r.period.startsWith(y));
  const annual = (rs: FcRow[]) => {
    const rev = sum(rs.map((r) => r.rev));
    const gp = sum(rs.map((r) => r.gp));
    return { rev, gp, gm: (100 * gp) / rev, oi: sum(rs.map((r) => r.oi)), compute: sum(rs.map((r) => r.compute)) };
  };
  const y27 = { bear: annual(yearOf(fc.bear, '2027')), base: annual(yearOf(base, '2027')), bull: annual(yearOf(fc.bull, '2027')) };
  const q4 = { bear: fc.bear[0]!, base: base[0]!, bull: fc.bull[0]! };
  const a26 = qRange('2026Q1', LAST).map(row);
  const y26 = (r: FcRow) => {
    const rev = sum(a26.map((x) => x.revenue)) + r.rev;
    const gp = sum(a26.map((x) => x.gp)) + r.gp;
    return { rev, gm: (100 * gp) / rev, oi: sum(a26.map((x) => x.oi)) + r.oi };
  };
  const y26b = { bear: y26(q4.bear), base: y26(q4.base), bull: y26(q4.bull) };
  const q4kAll = forecast(baseSc, { k: kAll.mean, noLag: true })[0]!.rev;
  const q4NoLag = forecast(baseSc, { noLag: true })[0]!.rev;
  const defRatio = Object.fromEntries(SCENARIOS.map((s) => [s.id, defRatioOf(s.rrDec)])) as Record<Scenario['id'], number>;

  /* ── sensitivities ── */
  const sens = (o: FcOpts) => {
    const y = annual(yearOf(forecast(baseSc, o), '2027'));
    return { rev: y.rev - y27.base.rev, revPct: (y.rev / y27.base.rev - 1) * 100, gm: y.gm - y27.base.gm, oi: y.oi - y27.base.oi };
  };
  const sensText = (x: ReturnType<typeof sens>) => {
    const parts: string[] = [];
    if (Math.abs(x.rev) >= 50) parts.push(`營收 ${signedYi(x.rev)}（${signed(x.revPct, 1)}）`);
    if (Math.abs(x.gm) >= 0.05) parts.push(`毛利率 ${pp(x.gm, 1)}`);
    parts.push(Math.abs(x.oi) < 50 ? '營業損益不變' : `營業損益 ${signedYi(x.oi)}`);
    return `2027 年${parts.join('、')}${Math.abs(x.rev) < 50 ? '（營收不變）' : ''}`;
  };
  const q4Sens = (o: FcOpts) => {
    const r = forecast(baseSc, o)[0]!;
    return `2026 年第四季營收 ${signedYi(r.rev - q4.base.rev)}（${signed((r.rev / q4.base.rev - 1) * 100, 1)}）、營業損益 ${signedYi(r.oi - q4.base.oi)}`;
  };
  const q4OiSens = (o: FcOpts) => `2026 年第四季營業損益 ${signedYi(forecast(baseSc, o)[0]!.oi - q4.base.oi)}（第四季營收由年化營收決定，不變）`;
  const sensitivities: ModelOutput['sensitivities'] = [
    { driver: '11–12 月的年化營收', change: `停在 10 月底的 ${yi(rrOct.value)}（每月 0%）`, effect: `${q4Sens({ rrDec: rrOct.value })}；2027 年的路徑也從較低的第四季出發（${sensText(sens({ rrDec: rrOct.value }))}）` },
    { driver: '換算方式', change: `不做 ${USAGE_LAG_DAYS} 天落後調整（Σ 每日年化營收 ÷ 364，倍數 1）`, effect: `${q4Sens({ noLag: true })}；${sensText(sens({ noLag: true }))}` },
    { driver: '換算方式', change: `改用回測的全期平均倍數 ${num(kAll.mean, 2)}（不做落後調整）`, effect: `${q4Sens({ k: kAll.mean, noLag: true })}；${sensText(sens({ k: kAll.mean, noLag: true }))}` },
    { driver: '算力與基礎設施費用（2026 年第四季起）', change: '多 10%，算力效率不變（2027 年營收跟著算力增加）', effect: `${q4OiSens({ computeMult: 1.1 })}；${sensText(sens({ computeMult: 1.1 }))}` },
    { driver: '算力與基礎設施費用（2026 年第四季起）', change: '多 10%，營收不變（多出的算力沒有轉成營收）', effect: `${q4OiSens({ computeMult: 1.1, revFixed: true })}；${sensText(sens({ computeMult: 1.1, revFixed: true }))}` },
    { driver: '算力效率（2027 年第四季的目標）', change: '低 0.2 倍', effect: sensText(sens({ effAdd: -0.2 })) },
    { driver: '算力效率（2027 年第四季的目標）', change: '高 0.2 倍', effect: sensText(sens({ effAdd: 0.2 })) },
    { driver: '銷貨成本 ÷ 算力費用', change: '高 5 個百分點', effect: `${sensText(sens({ shareAdd: 0.05 }))}；算力費用總額不變，只是較多算力列為銷貨成本、較少列為研發` },
    { driver: '算力以外的營業費用占營收比', change: '高 5 個百分點', effect: sensText(sens({ ncAdd: 0.05 })) },
    { driver: '需求停滯的壓力測試', change: '2027 年每季營收停在基準情境 2026 年第四季的水準，算力承諾照付', effect: `${sensText(sens({ flatRev: true }))}（毛利率的變化來自銷貨成本仍按算力費用的比例計算；營業損益不受這個分類影響）` },
  ];

  /* ── candidates ── */
  const condNote = `測試期 ${TEST.from}–${TEST.to} 共 ${test.length} 季，每季只用上一季以前的財報估參數（擴張視窗）。`;
  const kPath = test.map((t) => num(kAt.get(t)!.k, 3)).join('、');
  const candidates: ModelOutput['candidates'] = [
    {
      id: 'naive', name: '天真模型（上一季不變）',
      description: '假設本季營收與毛利率都和上一季一樣。這是最簡單的對照組：模型如果贏不了它，就沒有存在的價值。Anthropic 的營收在測試期每季成長 47–144%，這種假設會系統性低估。',
      equations: ['營收_t = 營收_t−1', '毛利率_t = 毛利率_t−1'],
      metrics: M.naive!, selected: false,
      note: `${missText('naive')}。Anthropic 上市前沒有公布任何營收或毛利率財測，2026-11-10 的初步招股書直接揭露第三季實際財報，沒有區間式的初步數字，因此沒有「公司財測」對照組。`,
    },
    {
      id: 'log-linear-trend', name: '對數線性趨勢（最近四季的成長率外推）',
      description: '用最近四季（不足四季時用全部，至少兩季）的營收取對數、對時間做直線迴歸，把迴歸的平均季成長率延伸一季；毛利率用同樣方法外推「銷貨成本 ÷ 營收」。只看營收本身的成長軌跡，不用任何驅動因子。',
      equations: ['ln 營收_t = a + b × t（以 t−4 至 t−1 季估計 a、b）', 'ln（銷貨成本 ÷ 營收）_t = c + d × t；毛利率_t = 1 −（銷貨成本 ÷ 營收）_t'],
      metrics: TR, selected: false,
      note: `${missText('log-linear-trend')}。成長率忽高忽低（2026 年第一、二季季增 132%、144%，第三季 47%），用過去的平均成長率外推，在加速時低估、減速時高估。各測試季迴歸的平均季成長率（斜率換算）依序為 ${test.map((t) => pct((Math.exp(trendAt.get(t)!.b) - 1) * 100, 0)).join('、')}；只有兩點時（${test[0]}）沒有標準誤。`,
    },
    {
      id: 'compute-efficiency', name: '算力效率（營收跟著算力費用走）',
      description: '用公司定義的算力效率（營收 ÷ 算力與基礎設施費用）：本季營收 = 上一季的算力效率 × 本季實際的算力費用。直覺是「算力受限」：公司要先買到算力才能服務更多用量。銷貨成本也假設跟著算力費用等比例變化，所以毛利率會等於上一季。',
      equations: ['營收_t = 算力效率_t−1 × 算力與基礎設施費用_t', '算力效率 = 營收 ÷ 算力與基礎設施費用', '毛利率_t = 毛利率_t−1'],
      metrics: CE, selected: false,
      note: `${condNote}代入當季實際的算力費用（條件式）。${missText('compute-efficiency')}。算力費用大部分用在訓練、研究與免費使用者（列在研發與銷售行銷），不是服務付費客戶，算力效率在 2025 年第四季到 2026 年第二季由 ${num(efficiency(row('2025Q4')), 2)} 倍跳到 ${num(efficiency(row('2026Q2')), 2)} 倍、第三季又降到 ${num(effQ3, 2)} 倍（約 50 億美元短期承諾的高價算力，sec-fwp-ipo-site），所以單看算力費用預測不了營收。事前誤差是算力費用改用上一季的成長外推時的誤差（營收 MAPE ${pct(CE.revenueExAnte!.mape!)}）。預測期的 2027 年仍用這個關係搭配情境假設（見限制）。`,
    },
    {
      id: 'run-rate-conversion', name: '年化營收換算（年化營收 → 當季營收，毛利率看算力）',
      description: `Anthropic 用「年化營收」（招股書定義：過去 28 天用量計費營收 × 13，加上當天的月訂閱費 × 12）描述營收規模。本模型把公司在各時點說過的年化營收連成一條每日路徑（相鄰兩點之間假設固定成長率），當季每天的年化營收加總 ÷ 364 就是「年化營收換算的當季營收」，再乘上訓練期的平均換算倍數；2025 年到 2026 年 8 月的說法來自新聞稿與媒體、口徑未說明，倍數同時吸收口徑差異與用量計費「過去 28 天」的落後。毛利率用上一季的「銷貨成本 ÷ 算力費用」乘上本季算力費用，得到銷貨成本，再除以預測的營收。預測期的第四季改用招股書口徑的 9 月底、10 月底數字，依定義換算（用量計費部分取 ${USAGE_LAG_DAYS} 天後的年化營收），不再乘回測的平均倍數。`,
      equations: [
        '營收_t = k × Σ（當季每日年化營收）÷ 364',
        'k = 訓練期各季的（營收 ÷ 年化營收換算值）平均',
        '銷貨成本_t =（銷貨成本 ÷ 算力與基礎設施費用）_t−1 × 算力與基礎設施費用_t',
        '毛利率_t = 1 − 銷貨成本_t ÷ 營收_t',
      ],
      metrics: S, selected: true,
      note: '',
    },
    {
      id: 'run-rate-ex-ante', name: '年化營收換算（事前版本：只用季初的年化營收）',
      description: '與選定模型相同，但不知道季中與季末的年化營收：本季營收 = 季初年化營收 × 天數 ÷ 364 × 訓練期的平均倍數（倍數同時包含季內成長與口徑差異）；算力費用延續上一季的成長率。用來衡量接近事前預測時的誤差。',
      equations: ['營收_t = k_s × 季初年化營收_t × 天數_t ÷ 364', 'k_s = 訓練期各季的（營收 ÷ 季初年化營收換算值）平均', '算力費用_t = 算力費用_t−1 ×（算力費用_t−1 ÷ 算力費用_t−2）；毛利率同選定模型'],
      metrics: EA, selected: false,
      note: `不參與模型選擇：參數與選定模型的做法相同，只是不用季中與季末的資訊。營收 MAPE ${pct(EA.revenue!.mape!)}、毛利率 MAE ${num(EA.grossMargin!.mae, 1)} 個百分點；${missText('run-rate-ex-ante')}。這仍不是嚴格的事前預測：公司在 2025–2026 年只是偶爾在新聞稿提到年化營收，季初的值要用前後兩次說法內插，其中 ${leakText}。${strictText}。${tText(tExNaive, '天真模型', '本版本')}；${tText(tExTrend, '對數線性趨勢', '本版本')}。`,
    },
  ];
  const selNote = `${condNote}代入在該季財報第一次公開以前公布的年化營收說法，以及當季實際的算力費用，屬於「驅動因子已知時」的誤差；2025Q1–2026Q2 的財報第一次公開是 2026-10-26 的 S-1（sec-s1），2026Q3 是 2026-11-10 的初步招股書。${qText('2026Q3')}的 9 月底與 10 月底年化營收和第三季財報同時公布（sec-fwp-eea），回測不用；該季只用到 ${q3Last.label}的 ${yi(q3Last.value)}（媒體引述知情人士，${q3Last.src}），之後維持不變。各季的預測：${missText(selected as Id)}。換算倍數 k 在各測試季依序為 ${kPath}：2025 年的說法多是「逾」「約」的整數、計算方式未說明，已認列營收比換算值高約 ${r25Text}；2026 年的說法接近招股書口徑後，第二、三季只高約 ${pct((ratiosAll.find((x) => x.p === '2026Q2')!.v - 1) * 100, 0)}、${pct((kQ3 - 1) * 100, 0)}，所以用平均倍數在最後兩季高估。選擇規則：在 ${ELIGIBLE.length} 個逐季模型中取「營收 MAPE（%）＋ 毛利率 MAE（個百分點）」最小者，較簡單的模型與最低分相差不到 ${SIMPLER_MARGIN} 時改選較簡單者：本模型 ${num(score(selected), 1)}、算力效率 ${num(score('compute-efficiency'), 1)}、對數線性趨勢 ${num(score('log-linear-trend'), 1)}、天真模型 ${num(score('naive'), 1)}；四個模型都改用事前版本計分時排名不變（本模型 ${num(scoreEx(selected), 1)}、對數線性趨勢 ${num(scoreEx('log-linear-trend'), 1)}、算力效率 ${num(scoreEx('compute-efficiency'), 1)}、天真模型 ${num(scoreEx('naive'), 1)}）。${tText(tSelNaive, '天真模型', '本模型')}；不過本模型是條件式的（年化營收幾乎就是營收本身的年化），天真與趨勢模型則完全事前，兩者不能直接比較。公平的比較是事前版本：營收 MAPE ${pct(EA.revenue!.mape!)}，天真模型 ${pct(N.revenue!.mape!)}、對數線性趨勢 ${pct(TR.revenue!.mape!)}。毛利率誤差主要來自 2025 年第三季（毛利率由 ${pct(row('2025Q2').gm)} 升到 ${pct(row('2025Q3').gm)}，銷貨成本 ÷ 算力費用由 ${pct(100 * servingShare(row('2025Q2')))} 降到 ${pct(100 * servingShare(row('2025Q3')))}，模型用上一季的比例）。營業損益在測試期介於 ${yi(Math.min(...test.map((p) => row(p).oi)), 1)}與 ${yi(Math.max(...test.map((p) => row(p).oi)), 1)}之間，接近零時百分比誤差沒有意義，回測只評估營收與毛利率。本模型的「事前」誤差就是事前版本的誤差。預測期的第四季不用回測的平均倍數，改依招股書定義換算（見參數）：只有 ${qText(LAST)}一季可以對照，依定義換算的倍數 ${num(kDefQ3, 3)}，但用到和財報同時公布的 9 月底數字，只是事後對照、不是回測。`;
  candidates.find((c) => c.id === selected)!.note = selNote;

  /* ── backtest rows ── */
  const backtest: ModelOutput['backtest'] = [];
  for (const id of ['run-rate-conversion', 'run-rate-ex-ante', 'compute-efficiency', 'log-linear-trend', 'naive'] as Id[]) {
    for (const [metric, k] of [['revenue', 'rev'], ['grossMargin', 'gm']] as const) {
      for (const p of test) {
        const x = preds.get(id)!.get(p)!;
        const d = metric === 'grossMargin' ? 2 : 0;
        const nv = preds.get('naive')!.get(p)![k];
        backtest.push({
          period: p, metric, actual: round(metric === 'revenue' ? row(p).revenue : row(p).gm, d), predicted: round(x[k], d), candidate: id,
          ...(id !== 'naive' ? { benchmark: round(nv, d), benchmarkLabel: '天真模型（上一季不變）' } : {}),
        });
      }
    }
  }

  /* ── derived series ── */
  type Pt = ModelOutput['derived'][number]['points'][number];
  const hist = (f: (r: AQ) => number | undefined, d = 1, status: Pt['status'] = 'estimate'): Pt[] =>
    rows.flatMap((r) => { const v = f(r); return v === undefined ? [] : [{ period: r.period, value: round(v, d), status }]; });
  const fut = (f: (r: FcRow) => number, d = 1, n = FORECAST.length): Pt[] => base.slice(0, n).map((r) => ({ period: r.period, value: round(f(r), d), status: 'forecast' as const }));
  const derived: ModelOutput['derived'] = [
    {
      id: 'run-rate-quarter-end', name: '季末年化營收（由公司說法內插）', unit: '百萬美元',
      points: [...hist((r) => rrAt(dayNum(r.end) + 1, allPts), 0), { period: FORECAST[0]!, value: round(baseSc.rrDec, 0), status: 'forecast' }],
      note: `公司說法的時點：${allPts.map((x) => `${x.label} ${yi(x.value)}`).join('、')}（「8 月逾 50 億美元」假設在 8 月底，5 月 28 日新聞稿的「當月稍早」假設在 5 月中，都是本模型的假設）；相鄰兩點之間以固定成長率內插，本站推算。2026 年 9 月底以前的說法來自新聞稿與媒體，口徑未說明；7 月底為 Bloomberg 引述知情人士（bbg-65b）。2026Q4 為基準情境的年底值。`,
    },
    {
      id: 'run-rate-implied-revenue', name: '年化營收換算的當季營收（Σ 每日年化營收 ÷ 364）', unit: '百萬美元',
      points: [...hist((r) => impliedRevenue(r.start, r.end, allPts), 0), { period: FORECAST[0]!, value: round(impliedFromPath(q4D.start, q4D.end, pathOf(baseSc.rrDec)), 0), status: 'forecast' }],
      note: '用上面的每日年化營收路徑加總後除以 364（招股書定義是 28 天 × 13 ≈ 364 天），本站推算；和已認列營收對照，就是選定模型的換算倍數。2026Q4 用 9 月底、10 月底的招股書數字加上基準情境的 11–12 月路徑，換算方式和歷史相同（沒有用量計費的 14 天落後調整）。',
    },
    {
      id: 'revenue-to-run-rate', name: '已認列營收 ÷ 年化營收換算值（換算倍數）', unit: '倍',
      points: [...ratiosAll.map((x) => ({ period: x.p, value: round(x.v, 3), status: 'estimate' as const })), { period: FORECAST[0]!, value: round(defRatio.base, 3), status: 'forecast' }],
      note: `本站計算（用全部年化營收說法，含 9 月底的招股書數字；回測的 ${qText('2026Q3')}不用 9 月底的數字，倍數為 ${num(kAt.get('2026Q3')!.k, 3)} 的預測值對 ${num(row('2026Q3').revenue / kAt.get('2026Q3')!.implied, 3)} 的實際值）。全期平均 ${num(kAll.mean, 3)}（標準誤 ${num(kAll.se, 3)}；倍數逐季下降，不是獨立樣本，標準誤偏小）。大於 1 表示已認列營收比年化營收換算值高：2025 年的說法多是「逾」的整數；用量計費的年化營收是過去 28 天的平均，成長時也會落後於當天的營收。2026 年第三季的季末值用招股書口徑後倍數降到 ${num(kQ3, 3)}，再依定義把用量計費部分落後 ${USAGE_LAG_DAYS} 天計算則是 ${num(kDefQ3, 3)}。2026Q4 為基準情境依定義換算的營收 ÷ 本表的換算值（相當於倍數 ${num(defRatio.base, 3)}，不是另外乘上的倍數）。`,
    },
    {
      id: 'run-rate-monthly-growth', name: '年化營收的平均月增幅（相鄰兩次說法之間）', unit: '%',
      points: allPts.slice(1).map((x, i) => ({ period: x.period, value: round(monthlyGrowth(allPts[i]!, x), 1), status: 'estimate' as const })),
      note: '（本次 ÷ 上次說法）^（30.44 ÷ 相隔天數）− 1，標在本次說法的月份，本站計算；7 月與 9 月的值用到 Bloomberg 的 7 月底估計（bbg-65b）。說法相隔 1–8 個月，月增幅只是平均值，看不出月內的波動。',
    },
    {
      id: 'compute-efficiency', name: '算力效率（營收 ÷ 算力與基礎設施費用）', unit: '倍',
      points: [...hist((r) => efficiency(r), 2), ...fut((r) => r.eff, 2)],
      note: `公司定義的 Compute Efficiency，本站以招股書金額計算到小數兩位（sec-fwp-ipo-site 公布的是一位或兩位的約數）。2026Q4 為基準情境的第四季營收 ÷ 算力費用，2027 年逐季移到 ${qText(LAST)}的 ${num(effQ3, 2)} 倍（保守情境移到 ${qText(effLo.p)}的 ${num(effLo.e, 2)} 倍、樂觀情境移到 ${qText(effHi.p)}的 ${num(effHi.e, 2)} 倍）。`,
    },
    {
      id: 'cogs-to-compute', name: '銷貨成本 ÷ 算力與基礎設施費用', unit: '%',
      points: [...hist((r) => 100 * servingShare(r), 1), ...fut((r) => 100 * r.share, 1)],
      note: '功能別銷貨成本（幾乎全是服務付費客戶的算力，另含少量人事與分攤費用，sec-fwp-japan）÷ 依性質分類的算力與基礎設施費用，本站計算；其餘算力列在研發（訓練、研究、內部使用）與銷售行銷（免費使用者）。選定模型用上一季的比例推算本季的銷貨成本。預測期為基準情境。',
    },
    {
      id: 'non-serving-compute-to-revenue', name: '銷貨成本以外的算力費用 ÷ 營收', unit: '%',
      points: [...hist((r) => (100 * (r.compute - r.cogs)) / r.revenue, 1), ...fut((r) => (100 * (r.compute - r.cogs)) / r.rev, 1)],
      note: `（算力與基礎設施費用 − 銷貨成本）÷ 營收，本站計算；銷貨成本另含少量人事與分攤費用，所以這是訓練、研究與免費使用算力的下限。營業損益主要由這一項決定：${qText(LAST)}占營收 ${pct((100 * (last.compute - last.cogs)) / last.revenue)}，高於算力以外的營業費用合計（${pct(100 * ncRatio)}，不含非現金捐贈）。預測期為基準情境。`,
    },
  ];
  // 毛利率橋接：毛利率 = 1 − （銷貨成本 ÷ 算力費用）÷ 算力效率，季變化拆成「算力效率」與「銷貨成本占算力比例」兩項，相加等於變化
  {
    type B = { period: string; e: number; s: number; status: Pt['status'] };
    const seq: B[] = [
      ...rows.map((r) => ({ period: r.period, e: efficiency(r), s: servingShare(r), status: 'estimate' as const })),
      ...base.map((r) => ({ period: r.period, e: r.eff, s: r.share, status: 'forecast' as const })),
    ];
    const effPts: Pt[] = [];
    const shPts: Pt[] = [];
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1]!;
      const b = seq[i]!;
      effPts.push({ period: b.period, value: round(100 * (a.s / a.e - a.s / b.e), 2), status: b.status });
      shPts.push({ period: b.period, value: round((100 * (a.s - b.s)) / b.e, 2), status: b.status });
    }
    const v = (pts: Pt[], p: string) => pts.find((x) => x.period === p)!.value;
    derived.push({
      id: 'gross-margin-bridge-efficiency', name: '毛利率季變化：算力效率的影響', unit: '個百分點', points: effPts,
      note: `上季（銷貨成本 ÷ 算力費用）×（1 ÷ 上季算力效率 − 1 ÷ 本季算力效率），本站計算；與「銷貨成本占算力比例的影響」相加等於毛利率的季變化。2026 年第一、二季毛利率大升主要來自這一項（${pp(v(effPts, '2026Q1'), 1)}、${pp(v(effPts, '2026Q2'), 1)}）：營收成長遠快於算力費用；第三季算力效率下降（短期承諾的高價算力）使毛利率 ${pp(v(effPts, '2026Q3'), 1)}。2026Q4 起為基準情境。`,
    });
    derived.push({
      id: 'gross-margin-bridge-cogs-share', name: '毛利率季變化：銷貨成本占算力比例的影響', unit: '個百分點', points: shPts,
      note: `（上季 − 本季的銷貨成本 ÷ 算力費用）÷ 本季算力效率，本站計算。2026 年第二季這一項 ${pp(v(shPts, '2026Q2'), 1)}，第三季 ${pp(v(shPts, '2026Q3'), 1)}。選定模型的毛利率用上一季的比例，所以這部分要落後一季才反映。`,
    });
  }
  derived.push(
    {
      id: 'compute-expense-path', name: '算力與基礎設施費用', unit: '百萬美元',
      points: [...hist((r) => r.compute, 0, 'actual'), ...fut((r) => r.compute, 0)],
      note: `${LAST} 以前為招股書數字；2026Q4–2027Q3 依招股書「未來 12 個月約 707 億美元」的承諾（sec-fwp-eea）以每季 ${signed((gC - 1) * 100, 1)} 等比成長分配，2027Q4 延續同一成長率（三個情境相同）。付款承諾不等於費用：自建資料中心與租賃會先列資本支出或使用權資產。`,
    },
    {
      id: 'non-compute-opex-to-revenue', name: '算力以外的營業費用 ÷ 營收（不含非現金捐贈與 Bartz 和解）', unit: '%',
      points: [...hist((r) => (100 * nonCompute(r)) / r.revenue, 1), ...fut((r) => (100 * r.nc) / r.rev, 1)],
      note: '依性質分類的人事、銷售行銷與通路合作、其他營運與管理費用，扣除非現金捐贈，÷ 營收，本站計算；人事費用含股份基礎給付。預測期沿用 2026 年第三季的比例。',
    },
    {
      id: 'adjusted-operating-margin', name: '調整後營業利益率（公司定義的非 GAAP 指標）', unit: '%',
      points: hist((r) => (100 * r.adjOi) / r.revenue, 1, 'actual'),
      note: '調整後營業利益 ÷ 營收；調整後營業利益是公司定義的非 GAAP 指標，營業損益加回股份基礎給付、非現金捐贈與 Bartz 和解（sec-fwp-eea）。模型預測的是 GAAP 營業損益，這裡只列歷史供對照。',
    },
    {
      id: 'price-cut-offset-share', name: '季增營收中被降價抵銷的金額 ÷ 上一季營收', unit: '%',
      points: seriesPoints(drivers, 'price-cut-revenue-effect').map((x) => ({ period: x.period, value: round((100 * -x.value) / row(addQ(x.period, -1)).revenue, 1), status: 'estimate' as const })),
      note: `招股書季度趨勢說明的約數（${seriesPoints(drivers, 'price-cut-revenue-effect').map((x) => `${qText(x.period)}約 ${yi(-x.value, -x.value % 100 === 0 ? 0 : 1)}`).join('、')}，sec-fwp-eea）÷ 上一季營收，本站計算；兩季的營收仍比前一季成長。新模型版本降價（例如 Opus 5.5 比 Opus 5 低 20%、Fable 5.2 比 Fable 5.1 低 20%）會壓低每 token 營收，用量增加才能抵銷。`,
    },
  );

  /* ── parameters ── */
  const ratioList = ratiosAll.map((x) => `${x.p} ${num(x.v, 3)}`).join('、');
  const parameters: ModelOutput['parameters'] = [
    { name: '換算倍數 k（全期 7 季平均）', value: round(kAll.mean, 3), unit: '倍', note: `已認列營收 ÷ 年化營收換算值，各季依序為 ${ratioList}；標準誤 ${num(kAll.se, 3)}。逐季下降，2025 年的新聞稿數字多是「逾」的整數。` },
    { name: '換算倍數 k（最後一個測試季使用，2025Q1–2026Q2 平均）', value: round(kAt.get('2026Q3')!.k, 3), unit: '倍' },
    { name: '2026Q3 實測換算倍數（9 月底用招股書數字）', value: round(kQ3, 3), unit: '倍', note: `沒有用量計費的 ${USAGE_LAG_DAYS} 天落後調整；7–8 月的值仍由 5 月的新聞稿與 7 月底的媒體報導內插。` },
    { name: '2026Q3 依定義換算的倍數（用量計費部分落後 14 天）', value: round(kDefQ3, 3), unit: '倍', note: `已認列營收 ÷ 依招股書定義換算的營收（用量計費部分取 ${USAGE_LAG_DAYS} 天後的年化營收，用各季的用量計費占比），各季依序為 ${ratiosDef.map((x) => `${x.p} ${num(x.v, 3)}`).join('、')}。只有 ${qText(LAST)}的季末有招股書口徑的年化營收，而且 9 月底的數字和第三季財報同時公布，這是事後對照、不是回測；更早的說法口徑未說明，倍數只能參考。` },
    { name: '預測期的換算（依招股書定義；基準情境相當的倍數）', value: round(defRatio.base, 3), unit: '倍', note: `9 月底與 10 月底的年化營收都是招股書口徑（過去 28 天用量計費營收 × 13 ＋ 當天的月訂閱費 × 12，sec-fwp-ipo-site）。用量計費（${qText(LAST)}占營收 ${pct(consumptionShareQ3, 0)}，sec-fwp-japan）的部分是過去 28 天的平均，反映約 ${USAGE_LAG_DAYS} 天前的營收，所以每天的用量營收取 ${USAGE_LAG_DAYS} 天後的年化營收 ÷ 364、訂閱營收取當天 ÷ 364，不另乘倍數（${K_FORECAST}）；年化營收成長時，這相當於 Σ 每日年化營收 ÷ 364 的 ${num(defRatio.base, 3)} 倍（保守 ${num(defRatio.bear, 3)}、樂觀 ${num(defRatio.bull, 3)}）。12 月下旬的用量營收要看 1 月上旬的年化營收，沿用各情境 11–12 月的月增幅。不做這項調整時，2026 年第四季基準營收是 ${yi(q4NoLag)}；改用回測的全期平均 ${num(kAll.mean, 2)}（不做落後調整）則是 ${yi(q4kAll)}（見敏感度）。` },
    { name: '事前版本的季初倍數 k_s（全期 7 季平均）', value: round(ksAll.mean, 3), unit: '倍', note: `營收 ÷（季初年化營收 × 天數 ÷ 364），標準誤 ${num(ksAll.se, 3)}；包含季內成長，季間差異很大。` },
    { name: '對數線性趨勢的平均季成長率（最近四季）', value: round((Math.exp(trendFull.b) - 1) * 100, 1), unit: '%', note: `${trendWin[0]}–${LAST} 的 ln 營收對季度迴歸，斜率 ${num(trendFull.b, 3)}（標準誤 ${num(trendFull.se, 3)}，t 值 ${num(trendFull.b / trendFull.se, 1)}，自由度 ${trendFull.n - 2}）；只作對照，預測不使用。` },
    { name: '2026-09-30 年化營收', value: rrSep.value, unit: '百萬美元', note: '招股書稱 10 月底比 9 月底增加 100 億美元，以 810 億減 100 億推得（sec-fwp-eea）。' },
    { name: '2026-10-31 年化營收', value: rrOct.value, unit: '百萬美元', note: '約 810 億美元（未經查核，sec-fwp-eea）；第四季的第一個月因此已大致可知。' },
    { name: '10 月的年化營收月增幅', value: round(gOct, 1), unit: '%', note: '樂觀情境的 11–12 月沿用。' },
    { name: '2026 年 5 月至 10 月底的平均月增幅', value: round(gMayOct, 1), unit: '%', note: `5 月的 ${yi(rrMay.value)}（時點假設為 5 月中，an-series-h）到 10 月底的 ${yi(rrOct.value)}；基準情境的 11–12 月沿用。` },
    { name: '未來 12 個月的算力與基礎設施承諾', value: COMMIT_NEXT_12M, unit: '百萬美元', note: `招股書：截至 2026-09-30 的承諾總額約 9,009 億美元，其中未來 12 個月約 707 億、2030 年底前約 4,516 億（sec-fwp-eea）。模型把 2026Q4–2027Q3 的算力費用合計設為 707 億美元。` },
    { name: '算力費用的季成長率（2026Q4 起）', value: round((gC - 1) * 100, 1), unit: '%', note: `${yi(last.compute)} × （g + g² + g³ + g⁴）= 707 億美元的解；2027 年合計 ${yi(compute2027)}，高於合約義務表 2027 年的 ${yi(oblig2027.value)}（只含已開始、不可取消的最低付款）。2027Q4 為 ${yi(computePath.at(-1)!)}，2030 年底前的承諾平均每季約 ${yi((COMMIT_THROUGH_2030 - COMMIT_NEXT_12M) / 13)}（扣除未來 12 個月後分攤到其餘 13 季）。` },
    { name: `算力效率（${qText(LAST)}）`, value: round(effQ3, 2), unit: '倍', note: `基準情境 2027 年第四季的目標；${qText(effLo.p)} ${num(effLo.e, 2)} 倍為保守、${qText(effHi.p)} ${num(effHi.e, 2)} 倍為樂觀（最近三季的最低與最高）。` },
    { name: `銷貨成本 ÷ 算力費用（${qText(LAST)}）`, value: round(100 * shareQ3, 1), unit: '%', note: `基準情境沿用；保守用最近四季平均 ${pct(100 * shareMean4)}、樂觀用最近四季最低 ${pct(100 * shareMin4)}。` },
    { name: `算力以外的營業費用 ÷ 營收（${qText(LAST)}）`, value: round(100 * ncRatio, 1), unit: '%', note: `人事 ${yi(last.personnel, 1)}、銷售行銷與通路合作 ${yi(last.smChannel, 1)}、其他營運與管理 ${yi(last.other, 1)}（扣除非現金捐贈 ${yi(last.donation, 1)}）÷ 營收；三個情境相同。` },
    { name: '非現金捐贈（每季，最近四季平均）', value: round(donationAvg, 0), unit: '百萬美元', note: `${last4.map((r) => `${r.period} ${r.donation ? yi(r.donation, 1) : '0'}`).join('、')} 的平均；員工捐款配捐計畫以 N 類普通股支付，時點與金額無法預測，預測期每季以平均數計入營業損益。` },
  ];

  /* ── scenarios ── */
  const scenarios: ModelOutput['scenarios'] = SCENARIOS.map((sc) => {
    const rs = fc[sc.id];
    const y = annual(yearOf(rs, '2027'));
    const yy = y26b[sc.id];
    const assumptions: ModelOutput['scenarios'][number]['assumptions'] = [
      { name: '2026 年第四季的年化營收', value: `9 月底 ${yi(rrSep.value)}、10 月底 ${yi(rrOct.value)}（招股書，sec-fwp-eea）；${sc.rrText}`, src: 'sec-fwp-eea' },
      { name: '年化營收換算成營收', value: `依招股書定義，不另乘倍數：用量計費（第三季占營收 ${pct(consumptionShareQ3, 0)}，sec-fwp-japan）的年化營收是過去 28 天 × 13，反映約 ${USAGE_LAG_DAYS} 天前的營收，所以每天的用量營收取 ${USAGE_LAG_DAYS} 天後的年化營收 ÷ 364、訂閱營收取當天 ÷ 364；本情境相當於 Σ 每日年化營收 ÷ 364 的 ${num(defRatio[sc.id], 3)} 倍（2026 年第三季依同一方式為 ${num(kDefQ3, 2)}，不做落後調整為 ${num(kQ3, 2)}）`, src: 'sec-fwp-ipo-site' },
      { name: '算力與基礎設施費用', value: `2026Q4–2027Q3 合計 707 億美元（招股書揭露的未來 12 個月承諾），每季 ${signed((gC - 1) * 100, 1)}；2027Q4 延續，2027 年合計 ${yi(compute2027)}（三個情境相同：算力在使用前數月到數年就簽約承諾，近期大多是固定費用）`, src: 'sec-fwp-eea' },
      { name: '2027 年的算力效率（營收 ÷ 算力費用）', value: `由第四季的 ${num(rs[0]!.eff, 2)} 倍逐季移到 ${num(sc.effTarget, 2)} 倍（${qText(sc.effFrom)}的實際值）${sc.id === 'bear' ? '：算力到位但用量或價格跟不上（降價、競爭、出口限制或客戶流失）' : sc.id === 'bull' ? '：長期合約算力取代短期承諾的高價算力，營收成長快於算力' : ''}`, src: 'sec-fwp-ipo-site' },
      { name: '銷貨成本 ÷ 算力費用', value: sc.shareText, src: 'sec-fwp-japan' },
      { name: '算力以外的營業費用與捐贈', value: `營收的 ${pct(100 * ncRatio)}（${qText(LAST)}，不含非現金捐贈）；非現金捐贈每季 ${yi(donationAvg, 1)}（最近四季平均）`, src: 'sec-fwp-eea' },
      { name: '不預測的項目', value: '淨利與 EPS（淨損主要來自可轉換票據等金融工具的公允價值變動，上市後的股數與轉換條件要等最終招股書）；上市可能帶來的股份基礎給付變化', src: 'sec-fwp-eea' },
    ];
    const forecasts: ModelOutput['scenarios'][number]['forecasts'] = rs.map((r, i) => ({
      period: r.period,
      revenue: round(r.rev, 0), grossMargin: round(r.gm, 2), operatingIncome: round(r.oi, 0),
      known: [],
      note: `算力費用 ${yi(r.compute)}、算力效率 ${num(r.eff, 2)} 倍、銷貨成本 ${yi(r.cogs)}；算力以外的營業費用 ${yi(r.nc)}。${i === 0 ? `營收由年化營收路徑依招股書定義換算（10 月已知，11–12 月為情境），季末年化營收 ${yi(sc.rrDec)}；季增 ${signed((r.rev / last.revenue - 1) * 100, 0)}。` : ''}`,
    }));
    forecasts.push({
      period: '2026', revenue: round(yy.rev, 0), grossMargin: round(yy.gm, 2), operatingIncome: round(yy.oi, 0), known: [],
      note: `第一至三季為實際值（營收 ${yi(sum(a26.map((x) => x.revenue)))}、${oiText(sum(a26.map((x) => x.oi)))}），第四季為模型值；年增 ${signed((yy.rev / annualRevenue(inputs, '2025') - 1) * 100, 0)}。`,
    });
    forecasts.push({
      period: '2027', revenue: round(y.rev, 0), grossMargin: round(y.gm, 2), operatingIncome: round(y.oi, 0), known: [],
      note: `四季加總；毛利率為全年毛利 ÷ 全年營收。算力費用 ${yi(y.compute)}，營收是算力費用的 ${num(y.rev / y.compute, 2)} 倍；年增 ${signed((y.rev / yy.rev - 1) * 100, 0)}。`,
    });
    return { id: sc.id, name: sc.name, assumptions, forecasts };
  });

  /* ── summary and limitations ── */
  const summary = `選定模型把公司說過的年化營收連成每日路徑、加總 ÷ 364 換算成當季營收，毛利率用上一季「銷貨成本 ÷ 算力費用」推算。招股書只有 7 季財報，回測只有 ${TEST.from}–${TEST.to} 共 ${test.length} 季：代入財報公開前公布的年化營收與當季實際算力費用時，營收平均誤差 ${pct(S.revenue!.mape!)}、毛利率 ${num(S.grossMargin!.mae, 1)} 個百分點，但這是條件式結果；只用季初年化營收的事前版本營收誤差 ${pct(EA.revenue!.mape!)}，天真模型 ${pct(N.revenue!.mape!)}，差距${tExNaive.sig ? '在統計上顯著但樣本很小' : '在統計上不顯著'}。基準情境 2026 年第四季營收約 ${yi(q4.base.rev)}（保守至樂觀 ${thousands(q4.bear.rev / 100)}–${yi(q4.bull.rev)}）；2027 年依招股書未來 12 個月約 707 億美元的算力承諾與算力效率假設推估約 ${yi(y27.base.rev)}（${thousands(y27.bear.rev / 100)}–${yi(y27.bull.rev)}），營業損益在 ${yi(y27.bear.oi)}與 ${yi(y27.bull.oi)}之間，取決於承諾的算力能否轉成營收。這是依假設推算的模型結果，不是投資建議。`;
  if (summary.length > 800) throw new Error(`summary too long (${summary.length})`);

  const limitations = [
    `歷史太短：招股書只揭露 2025 年起的 7 季財報，回測只有 ${test.length} 季、參數由 2–6 季估計，營收在這段期間成長約 ${num(last.revenue / row('2025Q1').revenue, 0)} 倍。事前版本與天真模型的差距只有 ${test.length} 季樣本可以檢驗（${tText(tExNaive, '天真模型', '事前版本')}），誤差只能當參考。`,
    `回測是條件式的：年化營收幾乎就是營收本身的年化，代入季中與季末的年化營收等於事先知道大部分答案，誤差 ${pct(S.revenue!.mape!)} 低估了真正預測的難度。事前版本（只用季初的年化營收）營收誤差 ${pct(EA.revenue!.mape!)}，而且季初的值要用前後兩次說法內插（${leakText}），仍不是嚴格的事前預測；只用季初以前已發布的說法時，可預測的 ${strictOk.length} 季營收 MAPE ${pct(strictMape)}，同期天真模型 ${pct(strictNaive)}。依「與財報同日公布的說法不用」的規則，${qText('2026Q3')}的回測不用 9 月底的 ${yi(rrSep.value)}與 10 月底的 ${yi(rrOct.value)}。`,
    `年化營收的資料點：2026 年 9 月以前來自募資與合作新聞稿（多是「逾」「約」的整數，計算方式未說明），7 月底的 650 億美元是 Bloomberg 引述知情人士（公司未證實）；各說法的時點（例如「5 月稍早」假設為 5 月中）是本模型的假設。換算倍數因此在 2025 年約 ${num(Math.min(...r25), 2)}–${num(Math.max(...r25), 2)}、2026 年第二、三季降到約 ${num(rQ2, 2)}、${num(kQ3, 2)}。預測期改依招股書定義換算（用量計費部分落後 ${USAGE_LAG_DAYS} 天，基準情境相當於倍數 ${num(defRatio.base, 2)}），這個換算方式只有 ${qText(LAST)}一季可以事後對照（${num(kDefQ3, 2)}）；不做落後調整，2026 年第四季營收會低約 ${pct((1 - q4NoLag / q4.base.rev) * 100, 0)}，改用全期平均 ${num(kAll.mean, 2)} 則高約 ${pct((q4kAll / q4.base.rev - 1) * 100, 0)}。招股書也提醒年化營收可能包含之後因違反使用政策被停權客戶的營收。`,
    `2027 年沒有年化營收可用，改以「算力受限」的假設推估：營收 = 算力效率 × 算力費用，算力費用依招股書揭露的未來 12 個月約 707 億美元承諾等比分配。付款承諾不等於費用（自建資料中心、租賃與預付款會先資本化），約 1,862 億美元的承諾附終止權或生效條件；同一個關係（上一季效率 × 當季算力）在回測中營收 MAPE ${pct(CE.revenue!.mape!)}，表現很差，算力效率在最近三季介於 ${num(effLo.e, 2)} 與 ${num(effHi.e, 2)} 倍。樂觀情境的 2027 年營收是保守情境的 ${num(y27.bull.rev / y27.bear.rev, 2)} 倍，營業損益在 ${yi(y27.bear.oi)}與 ${yi(y27.bull.oi)}之間，應看成情境，不是預測精度。`,
    `毛利率：招股書的風險因素提醒，服務客戶所需的算力可能比相關營收增加得更快、今天簽下的算力日後可能變得較不具成本效益、開放權重模型可能帶來價格壓力（1.1.3、1.1.4、1.1.9 節，sec-fwp-eea）。2025 年毛利率 ${pct(gm2025)}、2026 年第二季 ${pct(row('2026Q2').gm)}、第三季 ${pct(last.gm)}，模型只用「銷貨成本 ÷ 算力費用」與算力效率兩個比例推算，沒有分開建模每 token 成本、硬體世代、短期承諾算力（第三季約 50 億美元，價格明顯高於多年期合約）與降價（Opus 5.5 比 Opus 5 低 20%，an-opus55；Fable 5.2 比 Fable 5.1 低 20%，an-fable52）。模型開發與內部使用的算力計入研發、免費使用的算力計入銷售與行銷，所以毛利率遠高於「營收減全部算力費用」的比率。`,
    `營業損益：算力以外的營業費用沿用第三季占營收的比例（這個比例在 2026 年第一季到第三季由 ${pct((100 * nonCompute(row('2026Q1'))) / row('2026Q1').revenue, 0)} 降到 ${pct(100 * ncRatio, 0)}，若繼續下降，營業損益會比模型好），非現金捐贈用最近四季平均；上市可能帶來的股份基礎給付變化與上市相關費用，模型沒有納入。第四季的算力費用依承諾等比分配，是本模型的假設；第四季營收由年化營收決定，算力費用每多 10%，第四季營業損益約少 ${yi(0.1 * computePath[0]!)}。不預測淨利與 EPS：淨損主要來自可轉換票據、衍生負債與 SAFE 的公允價值變動（2026 年前九個月 ${yi(fvChange9m, 2)}），以及列在其他收支的票據購買協議公允價值變動（sec-fwp-eea），上市後這些工具如何轉換、流通股數多少，要等最終招股書；截至 2026-11-18 EDGAR 還沒有 424B4，2026-11-17 的 S-1/A 第 3 號主文件本站也未能讀取，無法排除其中有數字修正（sec-submissions）。`,
    '集中度與關係人：2026 年前九個月前五大客戶約占營收 25%、經雲端業者市集的營收占 44%；Amazon 與 Google 同時是投資人、算力供應商、通路與客戶（sec-fwp-eea）。這些關係的變化會同時影響營收、通路費用與算力成本，模型沒有分開處理。美國國防部的供應鏈風險認定（an-dow）、2026 年 6 月對 Fable 5 與 Mythos 5 的出口限制等事件也可能影響營收，模型沒有納入。',
    '治理與上市：Anthropic 是公益公司（PBC），長期利益信託（LTBT）選任過半董事，上市後創辦人 LLC 將握有 50.1% 投票權（sec-fwp-eea）。上市預計 2026-11-18 訂價、11-19 起在 Nasdaq 以代號 ANT 交易（sec-fwp-ipo-site），截至資料日尚未訂價；本站不推測發行價格，也不做估值。',
    '利益揭露：本站由 Anthropic 開發的 Claude 撰寫。為避免偏頗，模型只用招股書與公開資料，成長數字與招股書的風險因素並列，不使用推銷字眼，也不提供投資建議。',
  ];

  const sourceKeys = ['sec-fwp-eea', 'sec-fwp-japan', 'sec-fwp-ipo-site', 'sec-s1', 'sec-submissions', 'an-series-f', 'an-series-g', 'an-google-broadcom', 'an-series-h', 'bbg-65b', 'an-opus55', 'an-fable52', 'an-dow'];

  const out: ModelOutput = {
    company: 'anthropic',
    generatedBy: 'scripts/models/anthropic.ts',
    generatedOn: GENERATED_ON,
    asOf: inputs.asOf < drivers.asOf ? inputs.asOf : drivers.asOf,
    currency: 'USD',
    amountUnit: 'million',
    periodLabel: '日曆季度（百萬美元；不預測淨利與 EPS）',
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

function seriesPoints(drivers: CompanyDrivers, id: string) {
  const s = drivers.series.find((x) => x.id === id);
  if (!s) throw new Error(`anthropic drivers: series ${id} missing`);
  return s.points;
}
function annualRevenue(inputs: CompanyInputs, y: string): number {
  const a = inputs.annual.find((x) => x.year === y);
  const v = a?.extra?.['營收'];
  if (v === undefined) throw new Error(`anthropic inputs: annual ${y} revenue missing`);
  return v;
}

/* ───────────── CLI ───────────── */

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
  const dir = arg('--dir') ?? 'src/data/forecast';
  const inputs = companyInputs.parse(parse(readFileSync(`${dir}/anthropic-inputs.yaml`, 'utf8')));
  const drivers = companyDrivers.parse(parse(readFileSync(`${dir}/anthropic-drivers.yaml`, 'utf8')));
  const out = buildModel(inputs, undefined, drivers);
  const file = arg('--out') ?? `${dir}/anthropic-model.json`;
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  const sel = out.candidates.find((c) => c.selected)!;
  console.log(`✓ ${file}: selected ${sel.id}`);
  for (const c of out.candidates) console.log(`  ${c.selected ? '*' : ' '} ${c.id.padEnd(22)} Rev MAPE ${c.metrics.revenue?.mape}%  GM MAE ${c.metrics.grossMargin?.mae}pp  Rev ex-ante ${c.metrics.revenueExAnte?.mape ?? '-'}%`);
  for (const s of out.scenarios) console.log(`  ${s.id}: ${s.forecasts.map((f) => `${f.period} R${f.revenue} GM${f.grossMargin} OI${f.operatingIncome ?? '-'}`).join(' | ')}`);
}
