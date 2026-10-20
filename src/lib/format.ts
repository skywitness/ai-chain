/**
 * zh-TW number, money, percent and date formatting (build-time and client-safe; no deps).
 *
 * Conventions
 * - Money values are passed in **millions of the native currency** (the unit used by
 *   src/content/financials). Chinese large-number units: 萬 = 10⁴, 億 = 10⁸, 兆 = 10¹².
 * - Percent values are in percent units (53.3 means 53.3%), never fractions.
 * - Negative numbers use the true minus sign U+2212 (−).
 */
import { CURRENCIES } from '../schemas/common';

export type CurrencyCode = (typeof CURRENCIES)[number];

// ───────────────────────── currencies ─────────────────────────

interface CurrencyStyle {
  /** zh-TW name, e.g. 美元 */
  name: string;
  /**
   * prefix: 「新台幣 9,337 億元」 (name before the number, 元 after the unit)
   * suffix: 「4,674 億美元」 (name after the unit)
   */
  style: 'prefix' | 'suffix';
  /** ISO-ish symbol for compact UI (tables, chips) */
  symbol: string;
}

export const CURRENCY_STYLES: Record<CurrencyCode, CurrencyStyle> = {
  USD: { name: '美元', style: 'suffix', symbol: 'US$' },
  TWD: { name: '新台幣', style: 'prefix', symbol: 'NT$' },
  JPY: { name: '日圓', style: 'suffix', symbol: '¥' },
  KRW: { name: '韓元', style: 'suffix', symbol: '₩' },
  EUR: { name: '歐元', style: 'suffix', symbol: '€' },
  CNY: { name: '人民幣', style: 'prefix', symbol: 'CN¥' },
  HKD: { name: '港幣', style: 'prefix', symbol: 'HK$' },
  GBP: { name: '英鎊', style: 'suffix', symbol: '£' },
  CHF: { name: '瑞士法郎', style: 'suffix', symbol: 'CHF' },
  CAD: { name: '加幣', style: 'prefix', symbol: 'C$' },
  SEK: { name: '瑞典克朗', style: 'suffix', symbol: 'SEK' },
  DKK: { name: '丹麥克朗', style: 'suffix', symbol: 'DKK' },
  NOK: { name: '挪威克朗', style: 'suffix', symbol: 'NOK' },
  ILS: { name: '新謝克爾', style: 'suffix', symbol: '₪' },
  INR: { name: '印度盧比', style: 'suffix', symbol: '₹' },
  SGD: { name: '新加坡幣', style: 'prefix', symbol: 'S$' },
  AUD: { name: '澳幣', style: 'prefix', symbol: 'A$' },
  SAR: { name: '沙烏地里亞爾', style: 'suffix', symbol: 'SAR' },
  AED: { name: '阿聯迪拉姆', style: 'suffix', symbol: 'AED' },
  BRL: { name: '巴西雷亞爾', style: 'suffix', symbol: 'R$' },
};

/** 美元、新台幣、日圓… */
export const CURRENCY_ZH: Record<CurrencyCode, string> = Object.fromEntries(
  Object.entries(CURRENCY_STYLES).map(([k, v]) => [k, v.name]),
) as Record<CurrencyCode, string>;

export function currencyName(currency: CurrencyCode | string): string {
  return CURRENCY_STYLES[currency as CurrencyCode]?.name ?? currency;
}

export function isCurrency(v: unknown): v is CurrencyCode {
  return typeof v === 'string' && v in CURRENCY_STYLES;
}

// ───────────────────────── numbers ─────────────────────────

export const MINUS = '−';

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number): Intl.NumberFormat {
  const k = `${min}:${max}`;
  let f = nfCache.get(k);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: true });
    nfCache.set(k, f);
  }
  return f;
}

export interface NumberOptions {
  /** fraction digits (default 0) */
  digits?: number;
  /** drop trailing zeros after rounding (3.80 → 3.8). Default false. */
  trim?: boolean;
  /** prefix + for positive numbers */
  signed?: boolean;
}

/** 1234567.8 → "1,234,568"; uses a real minus sign. */
export function formatNumber(n: number, opts: NumberOptions = {}): string {
  if (!Number.isFinite(n)) return '—';
  const digits = opts.digits ?? 0;
  const s = nf(opts.trim ? 0 : digits, digits).format(Math.abs(n));
  const rounded = Number(Math.abs(n).toFixed(digits));
  const sign = n < 0 && rounded !== 0 ? MINUS : opts.signed && rounded !== 0 ? '+' : '';
  return sign + s;
}

/** Chinese large-number units. */
export type ZhUnit = '兆' | '億' | '萬' | '';
export const ZH_UNIT_SIZE: Record<ZhUnit, number> = { 兆: 1e12, 億: 1e8, 萬: 1e4, '': 1 };

/** Pick the natural unit for an absolute amount in base units (not millions). */
export function pickZhUnit(absBase: number): ZhUnit {
  const a = Math.abs(absBase);
  if (a >= 1e12) return '兆';
  if (a >= 1e8) return '億';
  if (a >= 1e4) return '萬';
  return '';
}

/**
 * Unit for a chart axis or table column whose largest absolute value is `maxAbsMillions`.
 * Prefers 億 up to 2 兆 so that ticks stay integers (e.g. 0 / 4,000 / 8,000 / 12,000 億).
 */
export function pickAxisUnit(maxAbsMillions: number): ZhUnit {
  const base = Math.abs(maxAbsMillions) * 1e6;
  if (base >= 2e12) return '兆';
  if (base >= 1e8) return '億';
  if (base >= 1e4) return '萬';
  return '';
}

/** Convert millions to the given zh unit: scaleMillions(933700, '億') → 9337 */
export function scaleMillions(valueMillions: number, unit: ZhUnit): number {
  return (valueMillions * 1e6) / ZH_UNIT_SIZE[unit];
}

function defaultDigits(scaled: number, unit: ZhUnit): number {
  const a = Math.abs(scaled);
  if (unit === '兆') return a < 10 ? 2 : a < 100 ? 1 : 0;
  if (unit === '億') return a < 10 ? 2 : a < 100 ? 1 : 0;
  if (unit === '萬') return a < 100 ? 1 : 0;
  return 0;
}

export interface MoneyOptions {
  /** force a unit instead of choosing automatically */
  unit?: ZhUnit;
  /** fraction digits (default depends on magnitude) */
  digits?: number;
  /** trim trailing zeros (default true) */
  trim?: boolean;
  /** prefix with 「約」 */
  approx?: boolean;
  /** signed (+/−) — for differences */
  signed?: boolean;
}

export interface MoneyParts {
  /** e.g. 「新台幣」 for prefix currencies, '' otherwise */
  prefix: string;
  /** formatted number, e.g. 「9,337」 */
  number: string;
  /** zh unit, e.g. 「億」 */
  unit: ZhUnit;
  /** e.g. 「元」 (prefix currencies) or 「美元」 */
  suffix: string;
  /** the scaled numeric value */
  scaled: number;
}

/** Split a money amount into parts so callers can style the number separately. */
export function moneyParts(valueMillions: number, currency: CurrencyCode | string, opts: MoneyOptions = {}): MoneyParts {
  const st = CURRENCY_STYLES[currency as CurrencyCode] ?? { name: String(currency), style: 'suffix' as const, symbol: '' };
  const unit = opts.unit ?? pickZhUnit(valueMillions * 1e6);
  const scaled = scaleMillions(valueMillions, unit);
  const digits = opts.digits ?? defaultDigits(scaled, unit);
  const number = formatNumber(scaled, { digits, trim: opts.trim ?? true, signed: opts.signed ?? false });
  return st.style === 'prefix'
    ? { prefix: st.name, number, unit, suffix: '元', scaled }
    : { prefix: '', number, unit, suffix: st.name, scaled };
}

/**
 * formatMoney(933700, 'TWD') → 「新台幣 9,337 億元」
 * formatMoney(467400, 'USD') → 「4,674 億美元」
 * formatMoney(3809054.3, 'TWD') → 「新台幣 3.81 兆元」
 */
export function formatMoney(valueMillions: number | null | undefined, currency: CurrencyCode | string, opts: MoneyOptions = {}): string {
  if (valueMillions == null || !Number.isFinite(valueMillions)) return '—';
  const p = moneyParts(valueMillions, currency, opts);
  const body = `${p.number} ${p.unit}${p.suffix}`.replace(/ $/, '');
  const s = p.prefix ? `${p.prefix} ${body}` : body;
  return opts.approx ? `約 ${s}` : s;
}

/**
 * A range in one unit: formatMoneyRange(41000, 42400, 'USD') → 「410–424 億美元」;
 * formatMoneyRange(1.30e6, 1.35e6, 'TWD') → 「新台幣 1.3–1.35 兆元」.
 */
export function formatMoneyRange(lowMillions: number, highMillions: number, currency: CurrencyCode | string, opts: MoneyOptions = {}): string {
  if (!Number.isFinite(lowMillions) || !Number.isFinite(highMillions)) return '—';
  const unit = opts.unit ?? pickZhUnit(Math.max(Math.abs(lowMillions), Math.abs(highMillions)) * 1e6);
  // same precision on both ends: 「1.30–1.35 兆」, not 「1.3–1.35 兆」
  const digits = opts.digits ?? defaultDigits(scaleMillions(Math.max(Math.abs(lowMillions), Math.abs(highMillions)), unit), unit);
  const hi = moneyParts(highMillions, currency, { trim: false, ...opts, unit, digits });
  const lo = moneyParts(lowMillions, currency, { trim: false, ...opts, unit, digits });
  const body = `${lo.number}–${hi.number} ${hi.unit}${hi.suffix}`.replace(/ $/, '');
  return hi.prefix ? `${hi.prefix} ${body}` : body;
}

/** Compact form without the currency name: 「9,337 億」「3.81 兆」. */
export function formatAmount(valueMillions: number | null | undefined, opts: MoneyOptions = {}): string {
  if (valueMillions == null || !Number.isFinite(valueMillions)) return '—';
  const unit = opts.unit ?? pickZhUnit(valueMillions * 1e6);
  const scaled = scaleMillions(valueMillions, unit);
  const n = formatNumber(scaled, { digits: opts.digits ?? defaultDigits(scaled, unit), trim: opts.trim ?? true, signed: opts.signed ?? false });
  return unit ? `${n} ${unit}` : n;
}

/** Unit label for axes and table headers: 「億美元」, 「新台幣億元」, 「百萬日圓」 (unit '' → 「美元」). */
export function moneyUnitLabel(unit: ZhUnit, currency: CurrencyCode | string): string {
  const st = CURRENCY_STYLES[currency as CurrencyCode];
  const name = st?.name ?? String(currency);
  if (!st || st.style === 'suffix') return `${unit}${name}`;
  return `${name}${unit}元`;
}

/** 「單位：新台幣億元」 */
export function unitLine(unit: ZhUnit, currency: CurrencyCode | string): string {
  return `單位：${moneyUnitLabel(unit, currency)}`;
}

// ───────────────────────── percent & change ─────────────────────────

/** formatPercent(53.27) → 「53.3%」 */
export function formatPercent(v: number | null | undefined, digits = 1, opts: { signed?: boolean; trim?: boolean } = {}): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${formatNumber(v, { digits, signed: opts.signed ?? false, trim: opts.trim ?? false })}%`;
}

/** 「+53.3%」 / 「−2.1%」 */
export function formatSignedPercent(v: number | null | undefined, digits = 1): string {
  return formatPercent(v, digits, { signed: true });
}

export type ChangeKind = 'yoy' | 'qoq' | 'mom' | 'hoh' | 'ytd' | 'pop';

const CHANGE_WORDS: Record<ChangeKind, { up: string; down: string; flat: string }> = {
  yoy: { up: '年增', down: '年減', flat: '與去年同期持平' },
  qoq: { up: '季增', down: '季減', flat: '與上季持平' },
  mom: { up: '月增', down: '月減', flat: '與上月持平' },
  hoh: { up: '較上期增', down: '較上期減', flat: '與上期持平' },
  ytd: { up: '累計年增', down: '累計年減', flat: '累計與去年同期持平' },
  pop: { up: '較前期增', down: '較前期減', flat: '與前期持平' },
};

/** Change words without the number: 「年增」 / 「季減」 */
export function changeWord(pct: number, kind: ChangeKind): string {
  const w = CHANGE_WORDS[kind];
  return pct >= 0 ? w.up : w.down;
}

/**
 * formatChange(53.27, 'yoy') → 「年增 53.3%」; formatChange(-2.1, 'qoq') → 「季減 2.1%」.
 * Rounds-to-zero values become 「與去年同期持平」.
 */
export function formatChange(pct: number | null | undefined, kind: ChangeKind = 'yoy', digits = 1): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const w = CHANGE_WORDS[kind];
  if (Number(Math.abs(pct).toFixed(digits)) === 0) return w.flat;
  return `${pct > 0 ? w.up : w.down} ${formatNumber(Math.abs(pct), { digits })}%`;
}

/**
 * Percentage-point change: 「增加 1.2 個百分點」 / 「減少 0.4 個百分點」;
 * with a kind: formatPointChange(-3.2, 1, 'yoy') → 「年減 3.2 個百分點」.
 */
export function formatPointChange(pp: number | null | undefined, digits = 1, kind?: ChangeKind): string {
  if (pp == null || !Number.isFinite(pp)) return '—';
  if (Number(Math.abs(pp).toFixed(digits)) === 0) return kind ? CHANGE_WORDS[kind].flat : '持平';
  const word = kind ? (pp > 0 ? CHANGE_WORDS[kind].up : CHANGE_WORDS[kind].down) : pp > 0 ? '增加' : '減少';
  return `${word} ${formatNumber(Math.abs(pp), { digits })} 個百分點`;
}

/** Growth ratio in percent: pctChange(150, 100) → 50. Null when prior ≤ 0 or missing. */
export function pctChange(curr: number | null | undefined, prior: number | null | undefined): number | null {
  if (curr == null || prior == null || !Number.isFinite(curr) || !Number.isFinite(prior) || prior <= 0) return null;
  return (curr / prior - 1) * 100;
}

// ───────────────────────── dates ─────────────────────────

const ZH_NUM = ['零', '一', '二', '三', '四'] as const;

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return [y ?? 0, m ?? 1, d ?? 1];
}

export type DateStyle = 'long' | 'short' | 'ym' | 'iso' | 'md' | 'ym-short';

/**
 * long 「2026 年 9 月 3 日」 · short 「2026/9/3」 · ym 「2026 年 9 月」 · ym-short 「2026/9」
 * md 「9/3」 · iso 「2026-09-03」. Accepts YYYY, YYYY-MM or YYYY-MM-DD.
 */
export function formatDate(iso: string | null | undefined, style: DateStyle = 'long'): string {
  if (!iso) return '—';
  const hasMonth = iso.length >= 7;
  const hasDay = iso.length >= 10;
  const [y, m, d] = parts(iso);
  switch (style) {
    case 'iso':
      return iso.slice(0, 10);
    case 'short':
      return hasDay ? `${y}/${m}/${d}` : hasMonth ? `${y}/${m}` : `${y}`;
    case 'md':
      return hasDay ? `${m}/${d}` : `${m}月`;
    case 'ym':
      return hasMonth ? `${y} 年 ${m} 月` : `${y} 年`;
    case 'ym-short':
      return hasMonth ? `${y}/${m}` : `${y}`;
    default:
      return hasDay ? `${y} 年 ${m} 月 ${d} 日` : hasMonth ? `${y} 年 ${m} 月` : `${y} 年`;
  }
}

/** 「2026/4/27–7/26」, or 「2025/12/29–2026/3/29」 across years. */
export function formatDateRange(start: string, end: string): string {
  const [ys, ms, ds] = parts(start);
  const [ye, me, de] = parts(end);
  return ys === ye ? `${ys}/${ms}/${ds}–${me}/${de}` : `${ys}/${ms}/${ds}–${ye}/${me}/${de}`;
}

/** 「資料截至 2026-10-06」 */
export function formatAsOf(iso: string | null | undefined): string {
  return iso ? `資料截至 ${iso.slice(0, 10)}` : '';
}

/** calendarQuarterLabel(2026, 2) → 「2026 Q2」; 'long' → 「2026 年第二季」 */
export function calendarQuarterLabel(year: number, quarter: number, style: 'short' | 'long' | 'compact' = 'short'): string {
  if (style === 'long') return `${year} 年第${ZH_NUM[quarter] ?? quarter}季`;
  if (style === 'compact') return `${String(year).slice(2)}Q${quarter}`;
  return `${year} Q${quarter}`;
}

/** monthLabel('2026-08') → 「2026 年 8 月」; 'short' → 「2026/8」; 'month' → 「8 月」 */
export function monthLabel(ym: string, style: 'long' | 'short' | 'month' = 'long'): string {
  const [y, m] = parts(ym);
  if (style === 'short') return `${y}/${m}`;
  if (style === 'month') return `${m} 月`;
  return `${y} 年 ${m} 月`;
}

const LATIN_EDGE = /[A-Za-z0-9%)）]$/;
const LATIN_START = /^[A-Za-z0-9(（]/;

/** Concatenate with a half-width space only at CJK–Latin boundaries (盤古之白). */
export function zhConcat(...chunks: string[]): string {
  let out = '';
  for (const c of chunks) {
    if (!c) continue;
    const needSpace =
      out && ((LATIN_EDGE.test(out) && !/^[\s，。、；：）」』]/.test(c)) || (LATIN_START.test(c) && !/[\s（「『]$/.test(out)));
    out += needSpace ? ` ${c}` : c;
  }
  return out;
}

/** Join list items the zh-TW way: 「台積電、三星和 Intel」 */
export function joinZh(items: string[], last = '和'): string {
  if (items.length <= 1) return items[0] ?? '';
  return zhConcat(items.slice(0, -1).join('、'), last, items.at(-1) ?? '');
}
