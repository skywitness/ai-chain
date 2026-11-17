/**
 * Build-time helpers of the 特斯拉 sections of /forecast/tesla/ (Basics, Drivers, Volume): driver points from
 * src/data/forecast/tesla-drivers.yaml, the per-quarter figures of the model's forecast notes (scripts/models/tesla.ts
 * writes 「交車 467,132 輛、每輛車售價 41,861 美元、成本 34,536 美元；汽車營收 197 億美元（監管積分 113 百萬美元）、能源
 * 31 億美元（部署 16.0 GWh）、服務及其他 49 億美元；營業費用 51 億美元。」) and small text helpers. Not a slot file:
 * src/components/forecast/registry.ts only loads Basics／Drivers／Volume／… .astro and sources.ts.
 */
import {
  derivedOf,
  driverOf,
  forecastQuarters,
  isQuarter,
  qIndex,
  quarterOf,
  scenarioOf,
  type DriverPoint,
  type FcBundle,
  type Forecast,
  type Quarter,
  type ScenarioId,
} from '../../../lib/forecast-data';
import { formatNumber } from '../../../lib/format';

/** Quarterly points of a drivers series, in period order, from `from` on (inclusive). */
export function driverPts(b: FcBundle, id: string, from?: string): DriverPoint[] {
  return (driverOf(b, id)?.points ?? [])
    .filter((p) => isQuarter(p.period) && (!from || qIndex(p.period) >= qIndex(from)))
    .sort((x, y) => qIndex(x.period) - qIndex(y.period));
}

/** One point of a drivers series (quarter or year id). */
export const driverAt = (b: FcBundle, id: string, period: string): DriverPoint | undefined =>
  driverOf(b, id)?.points.find((p) => p.period === period);

/** Value of a model-derived series at a period. */
export const derivedAt = (b: FcBundle, id: string, period: string): number | undefined =>
  derivedOf(b.model, id)?.points.find((p) => p.period === period)?.value;

/** Derived points from `from` on (quarters), in order. */
export function derivedPts(b: FcBundle, id: string, from?: string) {
  return (derivedOf(b.model, id)?.points ?? [])
    .filter((p) => isQuarter(p.period) && (!from || qIndex(p.period) >= qIndex(from)))
    .sort((x, y) => qIndex(x.period) - qIndex(y.period));
}

/** An `extra` figure of a reported quarter (百萬美元 or %), e.g. 「汽車營收」「汽車毛利率不含積分」. */
export const extraOf = (q: Quarter | undefined, key: string): number | undefined => q?.extra?.[key];

/** The figures a forecast note states (amounts in 百萬美元; the note rounds the segment revenues to 億美元). */
export interface NoteFigures {
  deliveries?: number | undefined;
  asp?: number | undefined;
  cost?: number | undefined;
  autoRevenue?: number | undefined;
  credits?: number | undefined;
  energyRevenue?: number | undefined;
  storage?: number | undefined;
  servicesRevenue?: number | undefined;
  opex?: number | undefined;
}
const num = (s: string | undefined): number | undefined => (s == null ? undefined : Number(s.replace(/,/g, '')));
export function noteFigures(note: string | null | undefined): NoteFigures {
  const t = note ?? '';
  const g = (re: RegExp) => num(re.exec(t)?.[1]);
  const yi = (re: RegExp) => {
    const v = g(re);
    return v == null ? undefined : v * 100;
  };
  return {
    deliveries: g(/交車 ([\d,]+) 輛/),
    asp: g(/每輛車售價 ([\d,]+) 美元/),
    cost: g(/成本 ([\d,]+) 美元/),
    autoRevenue: yi(/汽車營收 ([\d,.]+) 億美元/),
    credits: g(/監管積分 ([\d,.]+) 百萬美元/),
    energyRevenue: yi(/能源 ([\d,.]+) 億美元/),
    storage: g(/部署 ([\d.]+) GWh/),
    servicesRevenue: yi(/服務及其他 ([\d,.]+) 億美元/),
    opex: yi(/營業費用 ([\d,.]+) 億美元/),
  };
}

/** Forecast quarters of a scenario with the figures of their notes. */
export function scenarioQuarters(b: FcBundle, id: ScenarioId = 'base'): Array<Forecast & { fig: NoteFigures }> {
  return forecastQuarters(scenarioOf(b.model, id)).map((f) => ({ ...f, fig: noteFigures(f.note) }));
}

/** A forecast year (「2027」) of a scenario with the figures of its note (全年交車、儲能部署). */
export function scenarioYear(b: FcBundle, year: string, id: ScenarioId = 'base') {
  const f = scenarioOf(b.model, id)?.forecasts.find((x) => x.period === year);
  return f ? { ...f, fig: noteFigures(f.note) } : undefined;
}

/** The reported quarter one year before `period`. */
export const yearAgoOf = (b: FcBundle, period: string): Quarter | undefined =>
  b.inputs.quarters.find((q) => qIndex(q.period) === qIndex(period) - 4);

export const quarterAt = (b: FcBundle, period: string): Quarter | undefined => quarterOf(b.inputs, period);

/** Parameter by name prefix. */
export const paramOfPrefix = (b: FcBundle, prefix: string) => b.model.parameters.find((p) => p.name.startsWith(prefix));

/** 「年增 39.2%」「年減 3.1%」 */
export function yoyText(v: number | undefined, v0: number | undefined): string {
  if (v == null || v0 == null || v0 === 0) return '';
  const pct = (v / v0 - 1) * 100;
  return `${pct >= 0 ? '年增' : '年減'} ${formatNumber(Math.abs(pct), { digits: 1 })}%`;
}

/** Shares of the deliveries (%, 0–100) for a period: other models (S／X、Cybertruck) and operating-lease deliveries. */
export function deliveryMix(b: FcBundle, period: string): { other?: number | undefined; leased?: number | undefined } {
  const total = driverAt(b, 'deliveries-total', period)?.value;
  const other = driverAt(b, 'deliveries-other', period)?.value;
  const leased = driverAt(b, 'deliveries-leased', period)?.value;
  if (!total) return {};
  return {
    other: other != null ? (other / total) * 100 : undefined,
    leased: leased != null ? (leased / total) * 100 : undefined,
  };
}
