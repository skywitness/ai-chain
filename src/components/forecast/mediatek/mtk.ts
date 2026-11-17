/**
 * Build-time data helpers of the 聯發科 sections of /forecast/mediatek/ (Basics, Drivers, Volume in this folder).
 * Every figure is read from the bundle (mediatek-inputs.yaml, mediatek-drivers.yaml, mediatek-model.json), so the
 * sections follow the data when the model is re-run; a missing series or parameter makes the dependent sentence or
 * chart disappear instead of printing a stale number.
 */
import {
  derivedOf,
  driverOf,
  forecastQuarters,
  inWindow,
  isQuarter,
  lastReportedOf,
  nextGuidance,
  paramStarting,
  qIndex,
  scenarioOf,
  type FcBundle,
  type ScenarioId,
} from '../../../lib/forecast-data';

/** Product lines of the company's quarterly breakdown (drivers ids end with these). */
export const LINES = [
  { id: 'mobile', name: '手機', color: 'var(--chart-1)' },
  { id: 'smart-edge', name: '智慧邊緣平台', color: 'var(--chart-2)' },
  { id: 'power-ic', name: '電源管理 IC', color: 'var(--chart-3)' },
] as const;
export const ASIC_COLOR = 'var(--chart-5)';

export type Pt = { period: string; value: number; status?: string | undefined; src?: string | undefined; note?: string | undefined };

/** Point of a drivers series at a period. */
export function driverAt(b: FcBundle, id: string, period: string): Pt | undefined {
  return driverOf(b, id)?.points.find((p) => p.period === period);
}
/** Points of a drivers series inside the page window, in file order. */
export function driverWindow(b: FcBundle, id: string): Pt[] {
  return (driverOf(b, id)?.points ?? []).filter((p) => inWindow(b.meta, p.period));
}
/** Point of a derived series at a period. */
export function derivedAt(b: FcBundle, id: string, period: string): Pt | undefined {
  return derivedOf(b.model, id)?.points.find((p) => p.period === period);
}

/** The quarter n quarters before (2026Q3, 4 → 2025Q3). */
export function quarterBack(p: string, n: number): string {
  const i = qIndex(p) - n;
  return `${Math.floor(i / 4)}Q${(i % 4) + 1}`;
}

/** Guidance against the reported revenue, quarters of the page window with a guidance range. */
export function guidanceRecord(b: FcBundle) {
  const rows = b.inputs.quarters
    .filter((q) => q.guidance?.revenueLow != null && q.guidance?.revenueHigh != null && inWindow(b.meta, q.period))
    .map((q) => {
      const g = q.guidance!;
      const mid = g.revenue ?? (g.revenueLow! + g.revenueHigh!) / 2;
      return {
        period: q.period,
        beat: (q.revenue / mid - 1) * 100,
        above: q.revenue > g.revenueHigh!,
        below: q.revenue < g.revenueLow!,
        src: g.src,
        qsrc: q.src,
      };
    });
  const n = rows.length;
  const mean = n ? rows.reduce((s, r) => s + r.beat, 0) / n : Number.NaN;
  return {
    rows,
    n,
    mean,
    above: rows.filter((r) => r.above).length,
    below: rows.filter((r) => r.below).length,
    inside: rows.filter((r) => !r.above && !r.below).length,
    from: rows[0]?.period,
    to: rows.at(-1)?.period,
  };
}

/** Pearson correlation of two equally long series (NaN when undefined). */
export function correlation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return Number.NaN;
  const mx = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = ys.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]! - mx;
    const y = ys[i]! - my;
    sxy += x * y;
    sxx += x * x;
    syy += y * y;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : Number.NaN;
}

/**
 * The data-center ASIC figures of the first forecast quarter: the company's statement for the quarter (model
 * parameter 「<period> 資料中心 ASIC 營收（公司說法）」, US$ millions), the guidance FX and its share of the revenue
 * guidance midpoint, and the company's next-year target (drivers datacenter-asic-revenue, guidance points).
 */
export function asicFacts(b: FcBundle) {
  const g = nextGuidance(b);
  const period = g?.period ?? forecastQuarters(scenarioOf(b.model, 'base'))[0]?.period;
  const q = period ? paramStarting(b.model, `${period} 資料中心 ASIC 營收`) : undefined;
  const fx = period ? paramStarting(b.model, `${period} 財測：假設匯率`) : undefined;
  const share = q && fx && g ? ((q.value * fx.value) / g.revenue) * 100 : undefined;
  const series = driverOf(b, 'datacenter-asic-revenue');
  const year = period ? String(Number(period.slice(0, 4)) + 1) : undefined;
  const target = series?.points.find((p) => p.period === year);
  return { period, quarterUsd: q?.value, share, fxGuide: fx?.value, target, targetSrc: target?.src ?? series?.points.at(-1)?.src };
}

/** Sum of a derived series over the quarters of a calendar year (undefined unless all four quarters exist). */
export function derivedYear(b: FcBundle, id: string, year: string): number | undefined {
  const pts = (derivedOf(b.model, id)?.points ?? []).filter((p) => isQuarter(p.period) && p.period.startsWith(`${year}Q`));
  return pts.length === 4 ? pts.reduce((s, p) => s + p.value, 0) : undefined;
}

/** Whether a quarter is after the latest reported one. */
export const isForecastQ = (b: FcBundle, p: string): boolean => isQuarter(p) && qIndex(p) > qIndex(lastReportedOf(b.model));

/** A scenario assumption by the start of its name (「資料中心 ASIC 毛利率」). */
export function assumptionOf(b: FcBundle, scenario: ScenarioId, prefix: string) {
  return scenarioOf(b.model, scenario)?.assumptions.find((a) => a.name.startsWith(prefix));
}

/** First number of a text: 「38.8%：由第四季…」 → 38.8; 「…2027 年 120 億美元…」 with a pattern. */
export function numberIn(text: string | undefined, re: RegExp): number | undefined {
  const m = text ? re.exec(text) : null;
  return m ? Number(m[1]!.replace(/,/g, '')) : undefined;
}

/** Unique, non-empty keys in order. */
export const uniq = (ks: ReadonlyArray<string | null | undefined>): string[] => [...new Set(ks.filter((k): k is string => !!k))];
