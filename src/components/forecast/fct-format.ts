// Small build-time helpers of the generic /forecast/ sections (driver and derived-series tables).
import { formatNumber } from '../../lib/format';
import { comparePeriods, isQuarter, qIndex } from '../../lib/forecast-data';

export type PointStatus = 'actual' | 'estimate' | 'forecast' | 'guidance';
export const STATUS_ZH: Record<PointStatus, string> = { actual: '實際', estimate: '估計', forecast: '預測', guidance: '財測' };

const RE_M = /^(\d{4})-(\d{2})$/;
const RE_Q = /^(FY)?(\d{4})Q([1-4])$/;
const RE_Y = /^(FY)?(\d{4})$/;

/** Sort key of a quarter, month or year id (months sit inside their calendar quarter). */
export function periodSortKey(p: string): number {
  const m = RE_M.exec(p);
  if (m) return Number(m[1]) * 4 + (Number(m[2]) - 1) / 3;
  if (isQuarter(p)) return qIndex(p);
  const y = RE_Y.exec(p);
  return y ? Number(y[2]) * 4 + 3.5 : Number.NaN;
}
export const byPeriod = <T extends { period: string }>(a: T, b: T): number => {
  const d = periodSortKey(a.period) - periodSortKey(b.period);
  return Number.isFinite(d) ? d : comparePeriods(a.period, b.period);
};

/** The same period one year earlier: 2026Q3 → 2025Q3, 2026-10 → 2025-10, FY2027 → FY2026. */
export function yearEarlier(p: string): string | undefined {
  const q = RE_Q.exec(p);
  if (q) return `${q[1] ?? ''}${Number(q[2]) - 1}Q${q[3]}`;
  const m = RE_M.exec(p);
  if (m) return `${Number(m[1]) - 1}-${m[2]}`;
  const y = RE_Y.exec(p);
  return y ? `${y[1] ?? ''}${Number(y[2]) - 1}` : undefined;
}

/** 「2026 Q3」「2026/10」「2025 年」 */
export function shortPeriod(p: string): string {
  const q = RE_Q.exec(p);
  if (q) return q[1] ? `FY${q[2]} Q${q[3]}` : `${q[2]} Q${q[3]}`;
  const m = RE_M.exec(p);
  if (m) return `${m[1]}/${Number(m[2])}`;
  const y = RE_Y.exec(p);
  return y ? (y[1] ? `FY${y[2]}` : `${y[2]} 年`) : p;
}

/** Amounts in 百萬 become 億 like the rest of the page: 「百萬美元（年化）」 → 「億美元（年化）」, value ÷ 100. */
export function displayUnit(unit: string): { unit: string; scale: number } {
  if (/^百萬美元/.test(unit)) return { unit: unit.replace(/^百萬美元/, '億美元'), scale: 0.01 };
  if (/^百萬元/.test(unit)) return { unit: unit.replace(/^百萬元/, '億元'), scale: 0.01 };
  return { unit, scale: 1 };
}

/** A value with sensible decimals for a table cell. */
export function fmtValue(v: number | null | undefined, unit = ''): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const pct = /^%|個百分點/.test(unit);
  const digits = pct ? 1 : Number.isInteger(v) ? 0 : a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return formatNumber(v, { digits });
}

/** Change against a year earlier: level → 「年增 12.3%」, share → 「+1.2 個百分點」; change series → none. */
export function changeText(kind: string, v: number, v0: number, unit = ''): string | null {
  if (kind === 'share' || (kind === 'level' && /^%/.test(unit))) return `${formatNumber(v - v0, { digits: 1, signed: true })} 個百分點`;
  if ((kind === 'level' || kind === 'index') && v0 > 0 && v >= 0) {
    const pct = (v / v0 - 1) * 100;
    return `${pct >= 0 ? '年增' : '年減'} ${formatNumber(Math.abs(pct), { digits: 1 })}%`;
  }
  return null;
}
