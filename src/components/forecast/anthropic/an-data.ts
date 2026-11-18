/**
 * Data helpers of the Anthropic sections of /forecast/anthropic/ (Basics, Drivers, Volume): reported figures from the
 * inputs' extra fields, driver points, the model's derived series split into history and base-scenario forecast,
 * the scenario figures the model states only in its notes, and a few site calculations (scenario compute efficiency,
 * dated run-rate statements, list prices in effect per month). Every number the sections print comes from
 * src/data/forecast/anthropic-*.yaml|json through these helpers, so a data update needs no edit here; a value that
 * cannot be found is undefined and the sections leave it out.
 */
import {
  derivedOf,
  driverOf,
  forecastQuarters,
  isQuarter,
  isYear,
  lastReportedOf,
  qIndex,
  quarterOf,
  quartersFrom,
  scenarioOf,
  SCENARIO_ORDER,
  type DriverPoint,
  type FcBundle,
  type Quarter,
  type ScenarioId,
} from '../../../lib/forecast-data';

/** A numeric extra field of a reported quarter (百萬美元 unless the inputs say otherwise). */
export function ex(q: Quarter | undefined, key: string): number | undefined {
  const v = q?.extra?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Reported quarters shown on the page (FC_META.historyFrom to the latest report). */
export const shownQuarters = (b: FcBundle): Quarter[] => quartersFrom(b.inputs, b.meta.historyFrom);

/** The latest reported quarter and the one before it / a year before it. */
export function lastQuarters(b: FcBundle) {
  const P = lastReportedOf(b.model);
  const last = quarterOf(b.inputs, P) ?? b.inputs.quarters.at(-1)!;
  const prev = b.inputs.quarters.find((q) => qIndex(q.period) === qIndex(last.period) - 1);
  const yearAgo = b.inputs.quarters.find((q) => qIndex(q.period) === qIndex(last.period) - 4);
  return { P: last.period, last, prev, yearAgo };
}

/** Quarterly points of a driver series, in period order (no window filter: the sections choose their span). */
export function driverQ(b: FcBundle, id: string): DriverPoint[] {
  return (driverOf(b, id)?.points ?? []).filter((p) => isQuarter(p.period)).sort((a, c) => qIndex(a.period) - qIndex(c.period));
}

/** A driver point of a period (any status). */
export const driverAt = (b: FcBundle, id: string, period: string): DriverPoint | undefined =>
  driverOf(b, id)?.points.find((p) => p.period === period);

export interface AnPoint {
  period: string;
  value: number;
  /** the model's base-scenario value (after the latest report) */
  forecast: boolean;
}

/** A derived quarterly series: points up to the latest report are history, later points the base scenario. */
export function derivedQ(b: FcBundle, id: string, withForecast = true): AnPoint[] {
  const last = qIndex(lastReportedOf(b.model));
  return (derivedOf(b.model, id)?.points ?? [])
    .filter((p) => isQuarter(p.period))
    .map((p) => ({ period: p.period, value: p.value, forecast: p.status === 'forecast' || qIndex(p.period) > last }))
    .filter((p) => withForecast || !p.forecast)
    .sort((a, c) => qIndex(a.period) - qIndex(c.period));
}

/** The derived value of one period. */
export const derivedAt = (b: FcBundle, id: string, period: string): number | undefined =>
  derivedOf(b.model, id)?.points.find((p) => p.period === period)?.value;

/** Share in percent (undefined when either side is missing). */
export function shareOf(part: number | undefined, whole: number | undefined): number | undefined {
  return part != null && whole ? (part / whole) * 100 : undefined;
}

/** Change in percent from a to b. */
export function growth(a: number | undefined, b: number | undefined): number | undefined {
  return a != null && b != null && a !== 0 ? (b / a - 1) * 100 : undefined;
}

/** Reported gross margin (revenue − functional cost of revenue, %). */
export function grossMarginOf(q: Quarter | undefined): number | undefined {
  return q?.grossProfit != null && q.revenue ? (q.grossProfit / q.revenue) * 100 : undefined;
}

/**
 * Operating-cost structure of a reported quarter by nature (百萬美元): compute and infrastructure, the other operating
 * expenses without the non-cash donation and the Bartz settlement, and those two items.
 */
export function costByNature(q: Quarter | undefined) {
  const compute = ex(q, '算力與基礎設施費用');
  const donation = ex(q, '非現金捐贈') ?? 0;
  const bartz = ex(q, 'Bartz和解') ?? 0;
  const parts = ['人事費用', '銷售行銷與通路合作費用', '其他營運與管理費用'].map((k) => ex(q, k));
  const other = parts.every((v) => v != null) ? parts.reduce<number>((s, v) => s + (v ?? 0), 0) - donation : undefined;
  return { compute, other, donation, bartz };
}

/** Events of the inputs whose title matches, in date order. */
export const events = (b: FcBundle, titleRe: RegExp) =>
  b.inputs.events.filter((e) => titleRe.test(e.title)).sort((a, c) => a.date.localeCompare(c.date));

/** Base-, bear- or bull-scenario quarters of the model. */
export const scenarioQuarters = (b: FcBundle, id: ScenarioId) => forecastQuarters(scenarioOf(b.model, id));

/** The last full year the base scenario forecasts (「2027」), or undefined. */
export function forecastYear(b: FcBundle): string | undefined {
  return (scenarioOf(b.model, 'base')?.forecasts ?? []).filter((f) => isYear(f.period)).at(-1)?.period;
}

/**
 * Compute efficiency (revenue ÷ compute and infrastructure expense) of each scenario's forecast quarters: the
 * scenario revenue divided by the model's compute path (the same in every scenario). Site calculation.
 */
export function scenarioEfficiency(b: FcBundle, id: ScenarioId): AnPoint[] {
  const path = derivedQ(b, 'compute-expense-path').filter((p) => p.forecast);
  return scenarioQuarters(b, id).flatMap((f) => {
    const c = path.find((p) => p.period === f.period)?.value;
    return c ? [{ period: f.period, value: f.revenue / c, forecast: true }] : [];
  });
}

/** Number the model states in a scenario forecast note (「季末年化營收 985 億美元」 → 98,500 百萬美元 with scale 100). */
export function fromNote(b: FcBundle, id: ScenarioId, period: string, re: RegExp, scale = 1): number | undefined {
  const f = scenarioOf(b.model, id)?.forecasts.find((x) => x.period === period);
  const m = re.exec(f?.note ?? '');
  const v = m ? Number(m[1]!.replace(/,/g, '')) : Number.NaN;
  return Number.isFinite(v) ? v * scale : undefined;
}

/** Year-end run-rate of the first forecast quarter in every scenario (百萬美元), from the forecast notes. */
export function yearEndRunRates(b: FcBundle): Array<{ id: ScenarioId; period: string; value: number }> {
  const out: Array<{ id: ScenarioId; period: string; value: number }> = [];
  for (const id of SCENARIO_ORDER) {
    const f = scenarioQuarters(b, id)[0];
    const v = f ? fromNote(b, id, f.period, /季末年化營收 ([\d,]+) 億美元/, 100) : undefined;
    if (f && v != null) out.push({ id, period: f.period, value: v });
  }
  return out;
}

// ───────────── run-rate statements ─────────────

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Dates the model assumes for the run-rate statements, parsed from the note of its derived series
 * run-rate-quarter-end (「公司說法的時點：2025 年初 10 億美元、2025 年 8 月底 50 億美元、2026-02-12 140 億美元、…」):
 * key 「YYYY-MM|value in 百萬美元」 → ISO date.
 */
function statementDates(b: FcBundle): Map<string, string> {
  const out = new Map<string, string>();
  const note = derivedOf(b.model, 'run-rate-quarter-end')?.note ?? '';
  const list = /公司說法的時點：([^（]+)/.exec(note)?.[1] ?? '';
  for (const tok of list.split('、').map((t) => t.trim())) {
    const val = /([\d,.]+) 億美元$/.exec(tok);
    if (!val) continue;
    const v = Math.round(Number(val[1]!.replace(/,/g, '')) * 100);
    let m: RegExpExecArray | null;
    let y = 0;
    let mo = 0;
    let d = 0;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(tok))) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    else if ((m = /^(\d{4}) 年初/.exec(tok))) [y, mo, d] = [Number(m[1]), 1, 1];
    else if ((m = /^(\d{4}) 年底/.exec(tok))) [y, mo, d] = [Number(m[1]), 12, 31];
    else if ((m = /^(\d{4}) 年 (\d{1,2}) 月(初|中|底)/.exec(tok))) {
      y = Number(m[1]);
      mo = Number(m[2]);
      d = m[3] === '初' ? 1 : m[3] === '中' ? 15 : lastDay(y, mo);
    } else continue;
    out.set(`${y}-${String(mo).padStart(2, '0')}|${v}`, iso(y, mo, d));
  }
  return out;
}

export interface Statement extends DriverPoint {
  /** ISO date the statement refers to (exact, or the model's assumption) */
  date: string;
  /** the date is the model's assumption (no exact day in the source) */
  assumed: boolean;
}

/** Run-rate statements of the company (and the media estimate), with the date each refers to. */
export function runRateStatements(b: FcBundle): Statement[] {
  const dates = statementDates(b);
  return (driverOf(b, 'run-rate-revenue')?.points ?? [])
    .filter((p) => /^\d{4}-\d{2}$/.test(p.period))
    .map((p) => {
      const exact = new RegExp(`${p.period}-(\\d{2})`).exec(p.note ?? '');
      const [y, mo] = p.period.split('-').map(Number) as [number, number];
      if (exact) return { ...p, date: `${p.period}-${exact[1]}`, assumed: false };
      const d = dates.get(`${p.period}|${Math.round(p.value)}`);
      return { ...p, date: d ?? iso(y, mo, 15), assumed: true };
    })
    .sort((a, c) => a.date.localeCompare(c.date));
}

// ───────────── list prices ─────────────

/** Months 「YYYY-MM」 from `from` to `to` inclusive. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  for (let i = 0; i < 240 && (y < ty || (y === ty && m <= tm)); i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

/**
 * The list price in effect each month for a model family (the latest launch at or before the month), from the
 * driver series of launch prices; null before the family's first point in the data.
 */
export function priceInEffect(b: FcBundle, id: string, months: string[]): Array<number | null> {
  const pts = (driverOf(b, id)?.points ?? []).filter((p) => /^\d{4}-\d{2}$/.test(p.period)).sort((a, c) => a.period.localeCompare(c.period));
  return months.map((mo) => pts.filter((p) => p.period <= mo).at(-1)?.value ?? null);
}

// ───────────── sensitivities ─────────────

/**
 * Operating-income effect of each sensitivity in the forecast year (億美元, signed; 0 for 「營業損益不變」), parsed
 * from the model's effect text after 「<year> 年」. Rows without a figure for that year are left out.
 */
export function oiSensitivities(b: FcBundle, year: string): Array<{ driver: string; change: string; value: number; stress: boolean }> {
  const out: Array<{ driver: string; change: string; value: number; stress: boolean }> = [];
  for (const s of b.model.sensitivities) {
    const i = s.effect.indexOf(`${year} 年`);
    if (i < 0) continue;
    const rest = s.effect.slice(i);
    const m = /營業損益\s*([+−-][\d,.]+)\s*億美元/.exec(rest);
    const value = m ? Number(m[1]!.replace('−', '-').replace(/,/g, '')) : /營業損益不變/.test(rest) ? 0 : Number.NaN;
    if (!Number.isFinite(value)) continue;
    out.push({ driver: s.driver, change: s.change, value, stress: /壓力測試/.test(s.driver) });
  }
  return out;
}

/** Operating-income effect in the first forecast quarter (「2026 年第四季營業損益 −12 億美元」) of the sensitivities naming `driverRe`. */
export function quarterOiEffect(b: FcBundle, driverRe: RegExp): number | undefined {
  for (const s of b.model.sensitivities) {
    if (!driverRe.test(s.driver)) continue;
    const m = /第[一二三四]季營業損益\s*([+−-][\d,.]+)\s*億美元/.exec(s.effect);
    if (m) return Number(m[1]!.replace('−', '-').replace(/,/g, ''));
  }
  return undefined;
}
