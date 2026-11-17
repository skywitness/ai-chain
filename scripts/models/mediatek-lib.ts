// 聯發科財報模型的資料整理（純函式，不讀檔）：把 companyInputs 與 companyDrivers 整理成每季一列的表，
// 並提供損益換算（營收、毛利率 → 營業利益、淨利、EPS）與分位數等小工具。scripts/models/mediatek.ts 使用。
import type { CompanyDrivers, CompanyInputs } from '../../src/schemas/forecast';
import { addQ, qIndex } from './lib';

export interface Guide { rev: number; low: number; high: number; gm: number; opexRatio: number; fx: number; issued: string; src: string }
export interface MQ {
  period: string;
  revenue: number;
  gp: number;
  gm: number; // 毛利率（%，財報）
  oneOff: number; // 公司說明的一次性項目對毛利率的影響（個百分點，正值＝墊高）
  gmEx: number; // 排除一次性項目的毛利率
  opex: number;
  oi: number;
  nonop: number;
  pretax: number;
  ni: number; // 歸屬母公司
  niTotal: number; // 含非控制權益
  tax: number;
  eps: number;
  shares: number; // 由淨利 ÷ EPS 推算的加權平均股數（百萬股）
  inventory?: number | undefined;
  guide?: Guide | undefined;
  fx: number; // 美元兌新台幣季平均（聯準會 H.10）
  share?: { m: number; e: number; p: number } | undefined; // 產品線占比（%，依公司簡報，正規化前）
  idc?: number | undefined; // 全球智慧型手機出貨（百萬支，IDC 估計）
  src: string;
}

export interface Pt { period: string; value: number; low?: number | undefined; high?: number | undefined; status: string; src: string; note?: string | undefined }
export function driver(drivers: CompanyDrivers, id: string): Map<string, Pt> {
  const s = drivers.series.find((x) => x.id === id);
  if (!s) throw new Error(`mediatek drivers: series ${id} missing`);
  return new Map(s.points.map((p) => [p.period, p as Pt]));
}

const X_ONEOFF = '一次性項目對毛利率影響（百分點，公司說明）';
const X_NI_TOTAL = '本期淨利（含非控制權益）';
const X_TAX = '所得稅費用';
const X_OPEX_G = '財測營業費用率中值（%）';
const X_FX_G = '財測假設匯率（新台幣／美元）';

export function quarterTable(inputs: CompanyInputs, drivers: CompanyDrivers): MQ[] {
  const fx = driver(drivers, 'usd-ntd-avg-fed');
  const sm = driver(drivers, 'revenue-share-mobile');
  const se = driver(drivers, 'revenue-share-smart-edge');
  const sp = driver(drivers, 'revenue-share-power-ic');
  const idc = driver(drivers, 'smartphone-shipments-idc');
  return inputs.quarters.map((q) => {
    const need = (v: number | undefined, f: string) => { if (v === undefined) throw new Error(`mediatek inputs: ${q.period} ${f} missing`); return v; };
    const revenue = q.revenue;
    const gp = need(q.grossProfit, 'grossProfit');
    const x = q.extra ?? {};
    const oneOff = x[X_ONEOFF] ?? 0;
    const ni = need(q.netIncome, 'netIncome');
    const eps = need(q.eps, 'eps');
    const g = q.guidance;
    const f = fx.get(q.period);
    if (!f) throw new Error(`mediatek drivers: FX ${q.period} missing`);
    const m = sm.get(q.period);
    const e = se.get(q.period);
    const p = sp.get(q.period);
    return {
      period: q.period,
      revenue,
      gp,
      gm: (100 * gp) / revenue,
      oneOff,
      gmEx: (100 * gp) / revenue - oneOff,
      opex: need(q.operatingExpenses, 'operatingExpenses'),
      oi: need(q.operatingIncome, 'operatingIncome'),
      nonop: need(q.nonOperating, 'nonOperating'),
      pretax: need(q.pretaxIncome, 'pretaxIncome'),
      ni,
      niTotal: need(x[X_NI_TOTAL], X_NI_TOTAL),
      tax: need(x[X_TAX], X_TAX),
      eps,
      shares: ni / eps,
      inventory: q.inventory,
      guide: g && g.revenue !== undefined && g.grossMargin !== undefined
        ? { rev: g.revenue, low: g.revenueLow ?? g.revenue, high: g.revenueHigh ?? g.revenue, gm: g.grossMargin, opexRatio: need(x[X_OPEX_G], X_OPEX_G), fx: need(x[X_FX_G], X_FX_G), issued: g.issued ?? '', src: g.src }
        : undefined,
      fx: f.value,
      share: m && e && p ? { m: m.value, e: e.value, p: p.value } : undefined,
      idc: idc.get(q.period)?.value,
      src: q.src,
    };
  });
}

/* ───────────── segments (US$) ───────────── */

export interface Seg { m: number; e: number; p: number }
/** 產品線營收（百萬美元）：公司占比為整數，先正規化到 100% 再乘以美元營收（營收 ÷ 當季平均匯率）。 */
export function segUsd(r: MQ): Seg | undefined {
  if (!r.share) return undefined;
  const t = r.share.m + r.share.e + r.share.p;
  const usd = r.revenue / r.fx;
  return { m: (usd * r.share.m) / t, e: (usd * r.share.e) / t, p: (usd * r.share.p) / t };
}
export const usdOf = (r: MQ) => r.revenue / r.fx;

/* ───────────── P&L bridges ───────────── */

export interface Pnl { rev: number; gm: number; oi: number; ni: number; eps: number; opex: number }
/** 回測用：營業費用、業外、稅率、少數股權比例與股數採當季實際值（視為已知），差異只來自營收、毛利率（與給定的營業費用）。 */
export function bridge(a: MQ, rev: number, gm: number, opex = a.opex): Pnl {
  const oi = (rev * gm) / 100 - opex;
  const tau = a.pretax > 0 ? Math.min(Math.max(a.tax / a.pretax, 0), 0.35) : 0.15;
  const niTotal = a.niTotal + (oi - a.oi) * (1 - tau);
  const ni = niTotal * (a.ni / a.niTotal);
  return { rev, gm, oi, ni, eps: ni / a.shares, opex };
}
export interface Below { nonop: number; tax: number; minority: number; shares: number }
/** 預測用：由營收、毛利率、營業費用與固定的業外、稅率、母公司比例、股數算出損益。 */
export function pnl(rev: number, gm: number, opex: number, b: Below): Pnl {
  const oi = (rev * gm) / 100 - opex;
  const ni = (oi + b.nonop) * (1 - b.tax) * b.minority;
  return { rev, gm, oi, ni, eps: ni / b.shares, opex };
}

/* ───────────── small stats ───────────── */

/** 線性內插的分位數（與試算表 PERCENTILE.INC 相同）。 */
export function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  return s[lo]! + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)] ?? s[lo]!) - s[lo]!);
}
/** 不含截距的最小平方斜率。 */
export function slope0(x: readonly number[], y: readonly number[]): number {
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < x.length; i++) { sxy += x[i]! * y[i]!; sxx += x[i]! * x[i]!; }
  return sxx ? sxy / sxx : 0;
}
export const months = (q: string) => { const y = q.slice(0, 4); const k = Number(q.slice(5)); return [1, 2, 3].map((i) => `${y}-${String((k - 1) * 3 + i).padStart(2, '0')}`); };
export const sortQ = (ps: string[]) => [...ps].sort((a, b) => qIndex(a) - qIndex(b));
export const prevQ = (p: string) => addQ(p, -1);
