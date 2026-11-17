// SpaceX 財報模型的資料整理與文字工具（純函式，不讀檔）。scripts/models/spacex.ts 使用。
// 季資料：src/data/forecast/spacex-inputs.yaml（extra 的中文鍵名見該檔 periodNote）；驅動因子：spacex-drivers.yaml。
import type { CompanyDrivers, CompanyInputs } from '../../src/schemas/forecast';
import { addQ, qIndex, round, sum } from './lib';

/** 一季的損益與部門資料（百萬美元；用戶為百萬戶、算力為 GW）。 */
export interface SQ {
  period: string;
  revenue: number;
  gp: number;
  gm: number; // %
  opex: number;
  oi: number;
  nonOp: number;
  pretax: number;
  ni: number;
  eps?: number | undefined;
  shares?: number | undefined;
  da: number;
  capex: number;
  capexAi: number; // AI 部門資本支出
  // 部門營收與銷貨成本
  space: number;
  conn: number;
  ai: number;
  cogsSpace: number;
  cogsConn: number;
  cogsAi: number;
  // 營收細項
  launchSvc: number; // 發射服務
  launchDev: number; // 發射與開發
  consumer: number; // Starlink 消費者
  eg: number; // 企業與政府
  ads: number; // X 廣告
  aiInfra: number; // AI 解決方案與基礎設施（含 Cursor）
  cursor: number; // Cursor（2026-08-14 併購後）
  aiX: number; // AI 解決方案與基礎設施，不含 Cursor
  sbc: number;
  sbcAcq: number; // 併購相關股份基礎給付
  interestIncome: number;
  interestExpense: number;
  other: number;
  tax: number;
}

const ex = (q: CompanyInputs['quarters'][number], k: string, fallback?: number): number => {
  const v = q.extra?.[k];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`spacex inputs ${q.period}: extra.${k} missing`);
  }
  return v;
};
const need = (v: number | undefined, what: string): number => {
  if (v === undefined) throw new Error(`spacex inputs: ${what} missing`);
  return v;
};

/** 把 inputs.quarters 轉成模型用的表，並檢查部門與細項相加等於合併數（差 2 百萬美元以內）。 */
export function quarterTable(inputs: CompanyInputs): SQ[] {
  return inputs.quarters.map((q) => {
    const revenue = q.revenue;
    const gp = need(q.grossProfit, `${q.period} grossProfit`);
    const cursor = ex(q, 'Cursor營收', 0);
    const r: SQ = {
      period: q.period,
      revenue,
      gp,
      gm: (100 * gp) / revenue,
      opex: need(q.operatingExpenses, `${q.period} operatingExpenses`),
      oi: need(q.operatingIncome, `${q.period} operatingIncome`),
      nonOp: need(q.nonOperating, `${q.period} nonOperating`),
      pretax: need(q.pretaxIncome, `${q.period} pretaxIncome`),
      ni: need(q.netIncome, `${q.period} netIncome`),
      eps: q.eps,
      shares: q.sharesDiluted,
      da: need(q.depreciation, `${q.period} depreciation`),
      capex: need(q.capex, `${q.period} capex`),
      capexAi: ex(q, 'AI部門資本支出'),
      space: ex(q, '太空部門營收'),
      conn: ex(q, '連網部門營收'),
      ai: ex(q, 'AI部門營收'),
      cogsSpace: ex(q, '太空部門銷貨成本'),
      cogsConn: ex(q, '連網部門銷貨成本'),
      cogsAi: ex(q, 'AI部門銷貨成本'),
      launchSvc: ex(q, '發射服務營收'),
      launchDev: ex(q, '發射與開發營收'),
      consumer: ex(q, '消費者營收'),
      eg: ex(q, '企業與政府營收'),
      ads: ex(q, '廣告營收'),
      aiInfra: ex(q, 'AI解決方案與基礎設施營收'),
      cursor,
      aiX: ex(q, 'AI解決方案與基礎設施營收') - cursor,
      sbc: ex(q, '股份基礎給付'),
      sbcAcq: ex(q, '併購相關股份基礎給付', 0),
      interestIncome: ex(q, '利息收入'),
      interestExpense: ex(q, '利息費用'),
      other: ex(q, '其他收支淨額'),
      tax: ex(q, '所得稅'),
    };
    const close = (a: number, b: number, what: string) => {
      if (Math.abs(a - b) > 2) throw new Error(`spacex inputs ${q.period}: ${what} ${a} ≠ ${b}`);
    };
    close(r.space + r.conn + r.ai, revenue, 'segment revenue sum');
    close(r.launchSvc + r.launchDev, r.space, 'space revenue lines');
    close(r.consumer + r.eg, r.conn, 'connectivity revenue lines');
    close(r.ads + r.aiInfra, r.ai, 'AI revenue lines');
    close(r.cogsSpace + r.cogsConn + r.cogsAi, revenue - gp, 'segment cost of revenue');
    return r;
  });
}

/* ───────────── drivers ───────────── */

type DSeries = CompanyDrivers['series'][number];
export function seriesById(drivers: CompanyDrivers, id: string): DSeries {
  const s = drivers.series.find((x) => x.id === id);
  if (!s) throw new Error(`spacex drivers: series ${id} missing`);
  return s;
}
/** 公司公布的實際值（status actual）。 */
export function actualSeries(drivers: CompanyDrivers, id: string): Map<string, number> {
  return new Map(seriesById(drivers, id).points.filter((p) => p.status === 'actual').map((p) => [p.period, p.value]));
}
/** 某一期的點（財測、推算等）。 */
export function pointOf(drivers: CompanyDrivers, id: string, period: string) {
  const p = seriesById(drivers, id).points.find((x) => x.period === period);
  if (!p) throw new Error(`spacex drivers: ${id} ${period} missing`);
  return p;
}
export const at = (s: Map<string, number>, p: string, what: string): number => {
  const v = s.get(p);
  if (v === undefined) throw new Error(`spacex drivers: ${what} ${p} missing`);
  return v;
};

/** 年報（招股書）的 Falcon 客戶發射營收與次數，只取季資料開始以前的年度。 */
export function annualLaunches(inputs: CompanyInputs, firstQuarter: string): { revenue: number; launches: number; years: string[] } {
  const y0 = Number(firstQuarter.slice(0, 4));
  let revenue = 0;
  let launches = 0;
  const years: string[] = [];
  for (const a of inputs.annual) {
    if (Number(a.year) >= y0) continue;
    const s = a.sales.find((x) => x.product === '發射服務');
    if (!s || s.units === undefined) continue;
    revenue += s.value;
    launches += s.units;
    years.push(a.year);
  }
  return { revenue, launches, years };
}

/** 最近 n 季（含 p）的期間清單，只保留資料有的季度。 */
export function lastN(periods: readonly string[], p: string, n: number): string[] {
  const set = new Set(periods);
  const out: string[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const q = addQ(p, -k);
    if (set.has(q)) out.push(q);
  }
  return out;
}
export const between = (p: string, from: string, to: string) => qIndex(p) >= qIndex(from) && qIndex(p) <= qIndex(to);
export const geoGrowth = (from: number, to: number, n: number) => (Math.pow(to / from, 1 / n) - 1) * 100;
export const meanOf = (xs: readonly number[]) => sum(xs) / xs.length;

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
