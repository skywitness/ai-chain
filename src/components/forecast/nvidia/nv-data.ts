/**
 * Build-time helpers of the 輝達 sections of /forecast/nvidia/ (Basics, Drivers, Volume in this folder). Everything
 * is read from the bundle — nvidia-inputs.yaml (fiscal quarters, market-platform revenue in `extra`), nvidia-drivers.yaml
 * (hyperscaler capex by calendar quarter, China, CoWoS, guidance series), nvidia-model.json (derived series and the
 * three scenarios) and the memory topic's market-prices.yaml — so the sections follow the data when the model is
 * re-run; a missing series or parameter hides the sentence or chart that needs it. Not a slot file:
 * src/components/forecast/registry.ts only loads Basics／Drivers／Volume／… .astro and sources.ts.
 *
 * Calendar ↔ fiscal: NVIDIA's fiscal year ends in late January, so fiscal quarter FY(Y+1)Qn runs about one month
 * after calendar quarter YQn (FY2027Q3 = 2026-07-27 to 2026-10-25 ↔ 2026Q3). The model pairs them the same way
 * (capture ratio = data-center revenue ÷ the matching calendar quarter's capex).
 */
import {
  derivedOf,
  driverOf,
  forecastQuarters,
  isQuarter,
  lastReportedOf,
  qIndex,
  quarterOf,
  scenarioOf,
  type DriverPoint,
  type FcBundle,
  type Quarter,
  type ScenarioId,
} from '../../../lib/forecast-data';

// ───────────── periods ─────────────

/** Fiscal quarter → the calendar quarter it is paired with: FY2027Q3 → 2026Q3. */
export function calOf(p: string): string {
  const m = /^FY(\d{4})Q([1-4])$/.exec(p);
  return m ? `${Number(m[1]) - 1}Q${m[2]}` : p;
}
/** Calendar quarter → fiscal quarter: 2026Q3 → FY2027Q3. */
export function fiscalOf(p: string): string {
  const m = /^(\d{4})Q([1-4])$/.exec(p);
  return m ? `FY${Number(m[1]) + 1}Q${m[2]}` : p;
}
/** Calendar quarters from `from` to `to` inclusive (2019Q1 … 2027Q4). */
export function calQuarters(from: string, to: string): string[] {
  const out: string[] = [];
  for (let i = qIndex(from); i <= qIndex(to); i++) out.push(`${Math.floor(i / 4)}Q${(i % 4) + 1}`);
  return out;
}
/** Weeks of a reported or forecast fiscal quarter (14 for the fourth quarter of a 53-week year, from the dates or the note). */
export function weeksOf(b: FcBundle, p: string): number {
  const q = quarterOf(b.inputs, p);
  if (q) return Math.round((Date.parse(q.end) - Date.parse(q.start)) / 86_400_000 / 7);
  const f = scenarioOf(b.model, 'base')?.forecasts.find((x) => x.period === p);
  return /14 週/.test(f?.note ?? '') ? 14 : 13;
}

// ───────────── series access ─────────────

/** Points of a driver series by period (empty map when the series is missing). */
export function driverMap(b: FcBundle, id: string): Map<string, DriverPoint> {
  return new Map((driverOf(b, id)?.points ?? []).map((p) => [p.period, p]));
}
/** Quarterly points of a driver series in period order, from `from` on. */
export function driverPts(b: FcBundle, id: string, from?: string): DriverPoint[] {
  return (driverOf(b, id)?.points ?? [])
    .filter((p) => isQuarter(p.period) && (!from || qIndex(p.period) >= qIndex(from)))
    .sort((x, y) => qIndex(x.period) - qIndex(y.period));
}
/** Points of a derived model series by period. */
export function derivedMap(b: FcBundle, id: string): Map<string, { value: number; status: string }> {
  return new Map((derivedOf(b.model, id)?.points ?? []).map((p) => [p.period, { value: p.value, status: p.status ?? 'estimate' }]));
}
/** An `extra` figure of a reported quarter (百萬美元 or %), e.g. 「資料中心營收」「超大規模營收」. */
export const extraOf = (q: Quarter | undefined, key: string): number | undefined => q?.extra?.[key];
/** First parameter whose name matches. */
export const param = (b: FcBundle, re: RegExp) => b.model.parameters.find((p) => re.test(p.name));
/** Reported quarters from `from` (default FC_META.historyFrom) to the latest report. */
export const shownQuarters = (b: FcBundle, from = b.meta.historyFrom): Quarter[] =>
  b.inputs.quarters.filter((q) => qIndex(q.period) >= qIndex(from) && qIndex(q.period) <= qIndex(lastReportedOf(b.model)));

/** A scenario assumption by name. */
export const assumptionOf = (b: FcBundle, id: ScenarioId, re: RegExp) => scenarioOf(b.model, id)?.assumptions.find((a) => re.test(a.name));
/** The first number of a scenario assumption's value matched by `re` (group 1), e.g. 「年增 62.5%」 → 62.5. */
export function assumptionNum(b: FcBundle, id: ScenarioId, nameRe: RegExp, valueRe: RegExp): number | undefined {
  const m = valueRe.exec(assumptionOf(b, id, nameRe)?.value ?? '');
  return m ? Number(m[1]!.replace(/,/g, '')) : undefined;
}

// ───────────── where a quarter's figures come from ─────────────

/**
 * The quarter notes of nvidia-inputs.yaml name the source of each group of figures (「市場平台營收取自 rev-fy2026q4」,
 * 「新分類（超大規模、ACIE、邊緣運算）取自 rev-fy2027q3」…). The charts cite that key, falling back to the quarter's src.
 */
const NOTE_KEY: Record<'platform' | 'newPlatform' | 'dcSplit' | 'supply' | 'provision', RegExp[]> = {
  platform: [/市場平台營收取自 ([a-z0-9-]+)/],
  newPlatform: [/新分類[^取；]*取自 ([a-z0-9-]+)/, /新市場平台營收取自 ([a-z0-9-]+)/],
  dcSplit: [/資料中心運算與網路營收取自 ([a-z0-9-]+)/],
  supply: [/供應(?:與產能)?承諾[^取；]*取自 ([a-z0-9-]+)/],
  provision: [/存貨與超額採購承諾提列取自 ([a-z0-9-]+)/, /存貨提列取自 ([a-z0-9-]+)/],
};
export type NoteKind = keyof typeof NOTE_KEY;
export function noteKey(b: FcBundle, q: Quarter | undefined, kind: NoteKind): string | undefined {
  if (!q) return undefined;
  for (const re of NOTE_KEY[kind]) {
    const k = re.exec(q.note ?? '')?.[1];
    if (k && b.sourceByKey.has(k)) return k;
  }
  return q.src;
}

// ───────────── revenue by platform ─────────────

/** First quarter reported only in the new market platforms (hyperscale／ACIE／edge, no gaming line): FY2027Q1. */
export const newClassFrom = (b: FcBundle): Quarter | undefined =>
  b.inputs.quarters.find((q) => extraOf(q, '超大規模營收') != null && extraOf(q, '遊戲營收') == null);

/** Data-center revenue of a reported quarter (both market-platform classifications report the same figure). */
export const dcOf = (q: Quarter | undefined): number | undefined => extraOf(q, '資料中心營收');

/** Reported quarters followed by the base scenario: data center, edge (revenue − data center) and total revenue. */
export function platformRows(b: FcBundle, from = b.meta.historyFrom) {
  const dc = derivedMap(b, 'dc-revenue');
  const edge = derivedMap(b, 'edge-revenue');
  const actual = shownQuarters(b, from).map((q) => {
    const d = dcOf(q);
    return { period: q.period, forecast: false, revenue: q.revenue, dc: d, edge: d != null ? q.revenue - d : undefined, q };
  });
  const base = forecastQuarters(scenarioOf(b.model, 'base')).map((f) => ({
    period: f.period,
    forecast: true,
    revenue: f.revenue,
    dc: dc.get(f.period)?.value,
    edge: edge.get(f.period)?.value,
    q: undefined as Quarter | undefined,
  }));
  return [...actual, ...base];
}

// ───────────── hyperscaler capex ─────────────

export const CAPEX_COMPANIES = [
  { id: 'capex-msft', name: '微軟', color: 'var(--chart-1)' },
  { id: 'capex-googl', name: 'Alphabet', color: 'var(--chart-3)' },
  { id: 'capex-amzn', name: '亞馬遜', color: 'var(--chart-4)' },
  { id: 'capex-meta', name: 'Meta', color: 'var(--chart-2)' },
  { id: 'capex-orcl', name: '甲骨文', color: 'var(--chart-7)' },
] as const;

/** Hyperscaler capex by calendar quarter: the drivers file's actual sum, then the model's base path (forecast). */
export function capexPath(b: FcBundle): Array<{ period: string; value: number; forecast: boolean; src?: string | undefined }> {
  const actual = driverPts(b, 'hyperscaler-capex-total');
  const lastActual = actual.at(-1)?.period;
  const path = [...derivedMap(b, 'hyperscaler-capex-path')]
    .filter(([p, v]) => isQuarter(p) && v.status === 'forecast' && (!lastActual || qIndex(p) > qIndex(lastActual)))
    .sort((x, y) => qIndex(x[0]) - qIndex(y[0]))
    .map(([p, v]) => ({ period: p, value: v.value, forecast: true }));
  return [...actual.map((p) => ({ period: p.period, value: p.value, forecast: false, src: p.src })), ...path];
}

/**
 * Calendar-year capex of the five companies from the first full year on: four reported quarters, or reported plus the
 * model's base path (marked forecast, with the split in `note`).
 */
export function capexYears(b: FcBundle, fromYear: number) {
  const byQ = new Map(capexPath(b).map((p) => [p.period, p]));
  const years = [...new Set([...byQ.keys()].map((p) => Number(p.slice(0, 4))))].filter((y) => y >= fromYear).sort((x, y) => x - y);
  return years
    .map((y) => {
      const qs = [1, 2, 3, 4].map((n) => byQ.get(`${y}Q${n}`));
      if (qs.some((q) => !q)) return undefined;
      const act = qs.filter((q) => !q!.forecast);
      const fc = qs.filter((q) => q!.forecast);
      return {
        year: String(y),
        value: qs.reduce((s, q) => s + q!.value, 0),
        actual: act.reduce((s, q) => s + q!.value, 0),
        nActual: act.length,
        forecast: fc.reduce((s, q) => s + q!.value, 0),
        nForecast: fc.length,
        srcs: act.map((q) => q!.src).filter((k): k is string => !!k),
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

// ───────────── gross margin ─────────────

/** Whether a quarter's provision is the 10-Q total (inventory and excess purchase obligations) or only the XBRL write-down. */
export function provisionBasis(q: Quarter | undefined): 'total' | 'writedown' | undefined {
  if (!q) return undefined;
  if (extraOf(q, '存貨與超額採購承諾提列') != null) return 'total';
  return q.inventoryWritedown != null ? 'writedown' : undefined;
}

// ───────────── source keys ─────────────

/** Source keys the sections of this folder cite beyond the page defaults (sources.ts). */
export function sectionKeys(b: FcBundle): string[] {
  const keys = new Set<string>();
  for (const q of shownQuarters(b)) {
    keys.add(q.src);
    for (const kind of Object.keys(NOTE_KEY) as NoteKind[]) {
      const k = noteKey(b, q, kind);
      if (k) keys.add(k);
    }
  }
  // memory contract prices behind the model's DRAM (incl. HBM) price index
  const idx = derivedOf(b.model, 'hbm-blended-price-index')?.points ?? [];
  const idxFrom = idx[0]?.period;
  if (idxFrom) for (const p of b.prices.series.find((s) => s.id === 'dram-incl-hbm-contract-qoq')?.points ?? []) if (isQuarter(p.period) && qIndex(p.period) >= qIndex(idxFrom)) keys.add(p.src);
  for (const id of ['capex-top5-outlook', 'capex-annual-googl', 'capex-annual-meta', 'capex-annual-amzn', 'cowos-capacity-tsmc', 'cowos-capacity-tsmc-gs', 'cowos-nvidia-share', 'neocloud-capacity', 'guidance-gross-margin-annual', 'china-dc-hopper'])
    for (const p of driverOf(b, id)?.points ?? []) keys.add(p.src);
  for (const e of b.inputs.events) keys.add(e.src);
  return [...keys].filter((k) => b.sourceByKey.has(k));
}

