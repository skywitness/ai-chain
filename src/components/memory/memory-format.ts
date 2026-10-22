// Number and unit formatting for the memory topic components (build-time only).
import { formatNumber } from '../../lib/format';

/** Units shown in a friendlier zh-TW form: 十億美元 → 億美元 (×10), 百萬美元 → 億美元 (÷100), 十億 Gb → 億 Gb (×10). */
export function displayUnit(unit: string): { unit: string; factor: number } {
  if (unit === '十億美元') return { unit: '億美元', factor: 10 };
  if (unit === '百萬美元') return { unit: '億美元', factor: 0.01 };
  if (unit === '十億 Gb') return { unit: '億 Gb', factor: 10 };
  return { unit, factor: 1 };
}

/**
 * Digits that keep the precision the data carries without padding it: integers stay integers; other values keep
 * their own decimals up to one (≥ 10), two (≥ 0.1) or four places — so 27.37 十億美元 shows as 273.7 億美元, not 274.
 */
export function digitsFor(v: number): number {
  if (!Number.isFinite(v) || Number.isInteger(v)) return 0;
  const a = Math.abs(v);
  // unit conversions add float noise (7.342 × 10 = 73.42000000000002): count decimals after rounding to 6 places
  const decimals = (String(Number(a.toFixed(6))).split('.')[1] ?? '').length;
  return Math.min(decimals, a >= 10 ? 1 : a >= 0.1 ? 2 : 4);
}

/** 「22%」「1,654」「0.0155」 — the unit is printed by the caller unless it is %. */
export function fmtValue(v: number, unit: string): string {
  const s = formatNumber(v, { digits: digitsFor(v), trim: true });
  return unit === '%' ? `${s}%` : s;
}

/** 「22%」「80 GB」「273.7 億美元」「3 倍」 */
export function fmtWithUnit(v: number, rawUnit: string): { num: string; unit: string } {
  const { unit, factor } = displayUnit(rawUnit);
  const x = v * factor;
  return { num: fmtValue(x, unit === '%' ? '' : unit), unit };
}

/** 億美元 amount: 「6,187 億美元」「91 億美元」 */
export function fmtYi(yi: number): string {
  return `${formatNumber(yi, { digits: yi >= 100 ? 0 : 1, trim: true })} 億美元`;
}

/** Signed percent: 「+12.5%」「−10.5%」 */
export function fmtSignedPct(v: number): string {
  return `${formatNumber(v, { digits: Number.isInteger(v) ? 0 : 1, signed: true, trim: true })}%`;
}
