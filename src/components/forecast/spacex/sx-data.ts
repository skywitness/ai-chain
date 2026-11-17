/**
 * Data helpers of the SpaceX sections of /forecast/spacex/ (Basics, Drivers, Volume): the three operating segments
 * read from the inputs' extra fields, driver points inside the page window, the model's derived series split into
 * history and base-scenario forecast, and the base-scenario figures the model only states in its forecast notes.
 * Every number the sections print comes from src/data/forecast/spacex-*.yaml|json through these helpers, so a data
 * update needs no edit here; a value that cannot be found is undefined and the sections leave it out.
 */
import {
  derivedOf,
  driverOf,
  forecastQuarters,
  inWindow,
  isQuarter,
  lastReportedOf,
  qIndex,
  quartersFrom,
  scenarioOf,
  type DriverPoint,
  type FcBundle,
  type Quarter,
  type ScenarioId,
} from '../../../lib/forecast-data';

/** The three operating segments: extra-field keys of the inputs, derived-series ids and the chart colour. */
export const SEGMENTS = [
  {
    id: 'connectivity',
    name: '連網',
    full: '連網（Starlink）',
    rev: '連網部門營收',
    oi: '連網部門營業利益',
    cogs: '連網部門銷貨成本',
    capex: '連網部門資本支出',
    gm: 'segment-gross-margin-connectivity',
    color: 'var(--chart-1)',
  },
  {
    id: 'ai',
    name: 'AI',
    full: 'AI（SI）',
    rev: 'AI部門營收',
    oi: 'AI部門營業利益',
    cogs: 'AI部門銷貨成本',
    capex: 'AI部門資本支出',
    gm: 'segment-gross-margin-ai',
    color: 'var(--chart-2)',
  },
  {
    id: 'space',
    name: '太空',
    full: '太空（發射與開發）',
    rev: '太空部門營收',
    oi: '太空部門營業利益',
    cogs: '太空部門銷貨成本',
    capex: '太空部門資本支出',
    gm: 'segment-gross-margin-space',
    color: 'var(--chart-7)',
  },
] as const;
export type Segment = (typeof SEGMENTS)[number];

/** A numeric extra field of a reported quarter (百萬美元 unless the inputs say otherwise). */
export function ex(q: Quarter | undefined, key: string): number | undefined {
  const v = q?.extra?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Reported quarters shown on the page (FC_META.historyFrom to the latest report). */
export const shownQuarters = (b: FcBundle): Quarter[] => quartersFrom(b.inputs, b.meta.historyFrom);

/** Quarterly points of a driver series inside the page window, in period order. */
export function driverQ(b: FcBundle, id: string): DriverPoint[] {
  return (driverOf(b, id)?.points ?? [])
    .filter((p) => isQuarter(p.period) && inWindow(b.meta, p.period))
    .sort((a, c) => qIndex(a.period) - qIndex(c.period));
}

/** A driver point of a period (any status). */
export const driverAt = (b: FcBundle, id: string, period: string): DriverPoint | undefined =>
  driverOf(b, id)?.points.find((p) => p.period === period);

export interface SxPoint {
  period: string;
  value: number;
  /** the model's base-scenario value (after the latest report) */
  forecast: boolean;
}

/**
 * A derived series from the page window: points up to the latest report are history (computed by the model from
 * reported figures), later points are the base scenario. `withForecast: false` keeps the history only.
 */
export function derivedQ(b: FcBundle, id: string, withForecast = true): SxPoint[] {
  const last = qIndex(lastReportedOf(b.model));
  return (derivedOf(b.model, id)?.points ?? [])
    .filter((p) => isQuarter(p.period) && inWindow(b.meta, p.period))
    .map((p) => ({ period: p.period, value: p.value, forecast: p.status === 'forecast' || qIndex(p.period) > last }))
    .filter((p) => withForecast || !p.forecast)
    .sort((a, c) => qIndex(a.period) - qIndex(c.period));
}

/** The derived value of one period. */
export const derivedAt = (b: FcBundle, id: string, period: string): number | undefined =>
  derivedOf(b.model, id)?.points.find((p) => p.period === period)?.value;

/**
 * Numbers the model states only in the notes of its scenario forecasts (「期末用戶 15.2 百萬戶」「平均額定算力 2.23 GW」),
 * per forecast quarter. A quarter whose note does not match is left out (and warned about once).
 */
export function fromNotes(b: FcBundle, re: RegExp, scenario: ScenarioId = 'base'): Array<{ period: string; value: number }> {
  const out: Array<{ period: string; value: number }> = [];
  const fq = forecastQuarters(scenarioOf(b.model, scenario));
  for (const f of fq) {
    const v = Number((re.exec(f.note ?? '')?.[1] ?? '').replace(/,/g, ''));
    if (Number.isFinite(v) && re.exec(f.note ?? '')) out.push({ period: f.period, value: v });
  }
  if (fq.length && out.length < fq.length) console.warn(`[forecast] spacex: ${re} not found in every ${scenario} forecast note`);
  return out;
}

/** Share in percent (undefined when either side is missing). */
export function shareOf(part: number | undefined, whole: number | undefined): number | undefined {
  return part != null && whole ? (part / whole) * 100 : undefined;
}

/** Change in percent from a to b. */
export function growth(a: number | undefined, b: number | undefined): number | undefined {
  return a != null && b != null && a !== 0 ? (b / a - 1) * 100 : undefined;
}

/** Reported consolidated gross margin of a quarter (GAAP, %). */
export function grossMarginOf(q: Quarter | undefined): number | undefined {
  return q?.grossProfit != null && q.revenue ? (q.grossProfit / q.revenue) * 100 : undefined;
}

/**
 * Parse the revenue effect of the model's sensitivities: 「2027 年營收 +482 億美元（+21.6%）」 → 21.6. One row per
 * driver (the larger of the + and − cases, sign kept; sorted by size); drivers that leave revenue unchanged are skipped.
 */
export function revenueSensitivities(b: FcBundle): Array<{ driver: string; change: string; pct: number; effect: string }> {
  const rows = new Map<string, { driver: string; change: string; pct: number; effect: string }>();
  for (const s of b.model.sensitivities) {
    const m = /營收\s*[+−-][\d,.]+\s*億美元（([+−-][\d.]+)%）/.exec(s.effect);
    if (!m) continue;
    const pct = Number(m[1]!.replace('−', '-'));
    const had = rows.get(s.driver);
    if (!had || Math.abs(pct) > Math.abs(had.pct)) rows.set(s.driver, { driver: s.driver, change: s.change, pct, effect: s.effect });
  }
  return [...rows.values()].sort((a, c) => Math.abs(c.pct) - Math.abs(a.pct));
}
