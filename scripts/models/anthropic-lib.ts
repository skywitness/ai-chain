// Anthropic 財報模型的資料整理、年化營收路徑與文字工具（純函式，不讀檔）。scripts/models/anthropic.ts 使用。
// 季資料：src/data/forecast/anthropic-inputs.yaml（extra 的中文鍵名見該檔 periodNote）；驅動因子：anthropic-drivers.yaml。
import type { CompanyDrivers, CompanyInputs } from '../../src/schemas/forecast';
import { round, sum } from './lib';

/* ───────────── quarters ───────────── */

/** 一季的損益（百萬美元）。依性質分類的費用相加＝營收－營業損益；功能別費用（含 Bartz）相加也一樣。 */
export interface AQ {
  period: string;
  start: string;
  end: string;
  days: number;
  revenue: number;
  gp: number;
  gm: number; // %
  cogs: number; // 功能別銷貨成本
  oi: number;
  ni: number;
  compute: number; // 依性質：算力與基礎設施
  personnel: number;
  smChannel: number; // 依性質：銷售行銷與通路合作
  other: number; // 依性質：其他營運與管理（含非現金捐贈）
  bartz: number;
  donation: number; // 非現金捐贈（員工捐款配捐，以 N 類普通股支付）
  sbc: number;
  rd: number;
  sm: number;
  ga: number;
  adjOi: number; // 公司定義的調整後營業利益（非 GAAP）
}

const ex = (q: CompanyInputs['quarters'][number], k: string): number => {
  const v = q.extra?.[k];
  if (v === undefined) throw new Error(`anthropic inputs ${q.period}: extra.${k} missing`);
  return v;
};
const need = (v: number | undefined, what: string): number => {
  if (v === undefined) throw new Error(`anthropic inputs: ${what} missing`);
  return v;
};
export const dayNum = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;

/** 把 inputs.quarters 轉成模型用的表，並檢查兩種費用分類相加都等於營收－營業損益（差 2 百萬美元以內）。 */
export function quarterTable(inputs: CompanyInputs): AQ[] {
  return inputs.quarters.map((q) => {
    const revenue = q.revenue;
    const gp = need(q.grossProfit, `${q.period} grossProfit`);
    const r: AQ = {
      period: q.period,
      start: q.start,
      end: q.end,
      days: dayNum(q.end) - dayNum(q.start) + 1,
      revenue,
      gp,
      gm: (100 * gp) / revenue,
      cogs: ex(q, '銷貨成本'),
      oi: need(q.operatingIncome, `${q.period} operatingIncome`),
      ni: need(q.netIncome, `${q.period} netIncome`),
      compute: ex(q, '算力與基礎設施費用'),
      personnel: ex(q, '人事費用'),
      smChannel: ex(q, '銷售行銷與通路合作費用'),
      other: ex(q, '其他營運與管理費用'),
      bartz: ex(q, 'Bartz和解'),
      donation: ex(q, '非現金捐贈'),
      sbc: ex(q, '股份基礎給付'),
      rd: ex(q, '研發費用'),
      sm: ex(q, '銷售與行銷費用'),
      ga: ex(q, '一般及管理費用'),
      adjOi: ex(q, '調整後營業利益'),
    };
    const close = (a: number, b: number, what: string) => {
      if (Math.abs(a - b) > 2) throw new Error(`anthropic inputs ${q.period}: ${what} ${a} ≠ ${b}`);
    };
    close(r.compute + r.personnel + r.bartz + r.smChannel + r.other, revenue - r.oi, 'expenses by nature');
    close(r.cogs + r.rd + r.sm + r.ga + r.bartz, revenue - r.oi, 'expenses by function');
    close(r.cogs, revenue - gp, 'cost of revenue');
    close(r.oi + r.sbc + r.donation + r.bartz, r.adjOi, 'adjusted operating income');
    return r;
  });
}

/** 依性質分類中，算力以外的營業費用（人事、銷售行銷與通路合作、其他營運與管理），不含非現金捐贈與 Bartz 和解。 */
export const nonCompute = (r: AQ) => r.personnel + r.smChannel + r.other - r.donation;
/** 算力效率：營收 ÷ 算力與基礎設施費用（公司定義的 Compute Efficiency）。 */
export const efficiency = (r: AQ) => r.revenue / r.compute;
/** 銷貨成本 ÷ 算力與基礎設施費用：服務付費客戶的算力（另含少量人事與分攤費用）占全部算力費用的比例。 */
export const servingShare = (r: AQ) => r.cogs / r.compute;

/* ───────────── drivers ───────────── */

type DSeries = CompanyDrivers['series'][number];
export function seriesById(drivers: CompanyDrivers, id: string): DSeries {
  const s = drivers.series.find((x) => x.id === id);
  if (!s) throw new Error(`anthropic drivers: series ${id} missing`);
  return s;
}
export function pointOf(drivers: CompanyDrivers, id: string, period: string) {
  const p = seriesById(drivers, id).points.find((x) => x.period === period);
  if (!p) throw new Error(`anthropic drivers: ${id} ${period} missing`);
  return p;
}

/* ───────────── run-rate path ───────────── */

/**
 * 年化營收說法的時點（當天 00:00）。公司多半只說「8 月」「年底」「當月稍早」，本模型的假設：
 * 「2025 年初」＝2025-01-01；「8 月逾 50 億」＝8 月底；「2025 年底」＝2025 年底；新聞稿直接寫日期的用新聞稿日期；
 * 「5 月稍早突破 470 億」（5 月 28 日的新聞稿）＝5 月中；「7 月底」「9 月底」「10 月底」＝該月月底。
 * 新增資料點時要在這裡補上時點，否則模型會停下來。
 */
export const RR_INSTANT: Record<string, { at: string; label: string }> = {
  '2025-01': { at: '2025-01-01', label: '2025 年初' },
  '2025-08': { at: '2025-09-01', label: '2025 年 8 月底' },
  '2025-12': { at: '2026-01-01', label: '2025 年底' },
  '2026-02': { at: '2026-02-12', label: '2026-02-12' },
  '2026-04': { at: '2026-04-06', label: '2026-04-06' },
  '2026-05': { at: '2026-05-15', label: '2026 年 5 月中' },
  '2026-07': { at: '2026-08-01', label: '2026 年 7 月底' },
  '2026-09': { at: '2026-10-01', label: '2026 年 9 月底' },
  '2026-10': { at: '2026-11-01', label: '2026 年 10 月底' },
};

export interface RRPoint {
  period: string;
  day: number; // dayNum of the instant
  value: number; // 百萬美元
  status: string;
  src: string;
  published: string; // 來源的發布日
  label: string;
}

/** 年化營收的資料點（依時點排序），附來源的發布日，用來判斷回測時能不能用。 */
export function runRatePoints(drivers: CompanyDrivers): RRPoint[] {
  const s = seriesById(drivers, 'run-rate-revenue');
  return s.points
    .map((p) => {
      const t = RR_INSTANT[p.period];
      if (!t) throw new Error(`anthropic drivers: run-rate point ${p.period} has no instant in RR_INSTANT`);
      const published = drivers.sources[p.src]?.published;
      if (!published) throw new Error(`anthropic drivers: source ${p.src} has no published date`);
      return { period: p.period, day: dayNum(t.at), value: p.value, status: p.status, src: p.src, published, label: t.label };
    })
    .sort((a, b) => a.day - b.day);
}

/** 年化營收路徑上的一點（時點 dayNum、百萬美元）；RRPoint 也符合。 */
export type PathPoint = { day: number; value: number };

/** 某個時點的年化營收：相鄰兩點之間取對數線性內插（固定成長率），最後一點以後維持不變，第一點以前也維持不變。 */
export function rrAt(day: number, pts: readonly PathPoint[]): number {
  if (!pts.length) throw new Error('rrAt: no points');
  if (day <= pts[0]!.day) return pts[0]!.value;
  const last = pts.at(-1)!;
  if (day >= last.day) return last.value;
  let i = 0;
  while (pts[i + 1]!.day < day) i++;
  const a = pts[i]!;
  const b = pts[i + 1]!;
  const w = (day - a.day) / (b.day - a.day);
  return Math.exp(Math.log(a.value) + w * (Math.log(b.value) - Math.log(a.value)));
}

/** 年化營收換算的當季營收：Σ 當季每天（取正午）的年化營收 ÷ 364（招股書定義：28 天用量 × 13，一年約 364 天）。 */
export function impliedRevenue(start: string, end: string, pts: readonly PathPoint[]): number {
  const d0 = dayNum(start);
  const d1 = dayNum(end);
  let s = 0;
  for (let d = d0; d <= d1; d++) s += rrAt(d + 0.5, pts);
  return s / 364;
}
/** 只用季初（第一天 00:00）的年化營收換算：季初年化營收 × 天數 ÷ 364。 */
export const startImplied = (start: string, end: string, pts: readonly PathPoint[]) =>
  (rrAt(dayNum(start), pts) * (dayNum(end) - dayNum(start) + 1)) / 364;

/** 給定時點的年化營收路徑（百萬美元）上，[start, end] 每一天的年化營收合計 ÷ 364。 */
export const impliedFromPath = (start: string, end: string, path: readonly PathPoint[]): number => impliedRevenue(start, end, path);

/** 用量計費的年化營收是過去 28 天營收 × 13，反映的是這 28 天中點、約 14 天前的營收。 */
export const USAGE_LAG_DAYS = 14;
/**
 * 依招股書定義把年化營收路徑換算成 [start, end] 的營收：第 d 天的用量計費營收 ≈ 用量占比 × 第 d 天正午再過 14 天的
 * 年化營收 ÷ 364（那時的過去 28 天以第 d 天為中點），訂閱營收 ≈（1 − 用量占比）× 當天的年化營收 ÷ 364（月訂閱費 × 12
 * 是當天的值，沒有落後）。年化營收固定時與 impliedRevenue 相同；成長愈快，impliedRevenue 低估愈多。
 */
export function impliedDefinitional(start: string, end: string, pts: readonly PathPoint[], usage: number): number {
  if (!(usage >= 0 && usage <= 1)) throw new Error(`impliedDefinitional: usage share ${usage} out of range`);
  const d0 = dayNum(start);
  const d1 = dayNum(end);
  let s = 0;
  for (let d = d0; d <= d1; d++) s += (1 - usage) * rrAt(d + 0.5, pts) + usage * rrAt(d + 0.5 + USAGE_LAG_DAYS, pts);
  return s / 364;
}

/* ───────────── statistics ───────────── */

export const meanOf = (xs: readonly number[]) => sum(xs) / xs.length;
export function sdOf(xs: readonly number[]): number {
  const m = meanOf(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}
/** 平均數與標準誤。 */
export const meanSe = (xs: readonly number[]) => ({ mean: meanOf(xs), se: xs.length > 1 ? sdOf(xs) / Math.sqrt(xs.length) : NaN, n: xs.length });
/** 簡單迴歸 y = a + b x，附斜率的標準誤（古典假設）。 */
export function lineFit(x: readonly number[], y: readonly number[]) {
  const n = x.length;
  const mx = meanOf(x);
  const my = meanOf(y);
  const sxx = sum(x.map((v) => (v - mx) ** 2));
  const b = sum(x.map((v, i) => (v - mx) * (y[i]! - my))) / sxx;
  const a = my - b * mx;
  const rss = sum(x.map((v, i) => (y[i]! - a - b * v) ** 2));
  const se = n > 2 ? Math.sqrt(rss / (n - 2) / sxx) : NaN;
  return { a, b, se, n };
}
/** 雙尾 5% 的 t 臨界值（依自由度）。 */
export const T_CRIT_5PCT: Record<number, number> = { 1: 12.71, 2: 4.3, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31 };
/** 成對差距的 t 值（平均 ÷ 標準誤）。 */
export function pairedT(d: readonly number[]) {
  const s = meanSe(d);
  return { t: s.mean / s.se, df: d.length - 1, mean: s.mean };
}

/* ───────────── text helpers (zh-TW) ───────────── */

/** 千分位（不依賴執行環境的語系設定）。 */
export function thousands(v: number, d = 0): string {
  const s = Math.abs(round(v, d)).toFixed(d);
  const [i, f] = s.split('.');
  const g = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 && round(v, d) !== 0 ? '−' : ''}${g}${f ? `.${f}` : ''}`;
}
/** 百萬美元 → 「x 億美元」。 */
export const yi = (m: number, d = 0) => `${thousands(m / 100, d)} 億美元`;
export const num = (v: number, d = 1) => thousands(v, d);
export const pct = (v: number, d = 1) => `${thousands(v, d)}%`;
export const signed = (v: number, d = 1, unit = '%') => `${v >= 0 ? '+' : '−'}${thousands(Math.abs(v), d)}${unit}`;
export const pp = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${thousands(Math.abs(v), d)} 個百分點`;
export const signedYi = (m: number, d = 0) => `${m >= 0 ? '+' : '−'}${yi(Math.abs(m), d)}`;
/** 2026Q4 → 「2026 年第四季」。 */
export function qText(p: string): string {
  const n = ['一', '二', '三', '四'][Number(p.slice(5)) - 1];
  return `${p.slice(0, 4)} 年第${n}季`;
}
/** 營業損益的文字：正值「營業利益 x 億美元」，負值「營業損失 x 億美元」。 */
export const oiText = (m: number, d = 0) => (m >= 0 ? `營業利益 ${yi(m, d)}` : `營業損失 ${yi(-m, d)}`);
