/**
 * Build-time helpers of the 台積電 sections of /forecast/tsmc/ (Basics, Drivers, Volume, Scenarios in this folder).
 * Everything is read from the bundle (tsmc-inputs.yaml, tsmc-drivers.yaml, tsmc-model.json), so the sections follow
 * the data when the model is re-run; a missing series or parameter hides the sentence or chart that needs it.
 * The source keys each section cites are collected here too (sectionKeys), and sources.ts hands them to the page.
 */
import {
  actualGrossMargin,
  citesIn,
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
} from '../../../lib/forecast-data';

// ───────────── series access ─────────────

/** Points of a driver series by period (empty map when the series is missing). */
export function driverMap(b: FcBundle, id: string): Map<string, DriverPoint> {
  return new Map((driverOf(b, id)?.points ?? []).map((p) => [p.period, p]));
}

/** Points of a derived model series by period. */
export function derivedMap(b: FcBundle, id: string): Map<string, { value: number; status: string }> {
  return new Map((derivedOf(b.model, id)?.points ?? []).map((p) => [p.period, { value: p.value, status: p.status ?? 'estimate' }]));
}

/** Quarter ids from `from` to `to` inclusive (calendar quarters). */
export function quarters(from: string, to: string): string[] {
  const out: string[] = [];
  for (let i = qIndex(from); i <= qIndex(to); i++) out.push(`${Math.floor(i / 4)}Q${(i % 4) + 1}`);
  return out;
}

export const prevQuarter = (p: string): string => {
  const i = qIndex(p) - 1;
  return `${Math.floor(i / 4)}Q${(i % 4) + 1}`;
};

/** First parameter whose name matches. */
export const param = (b: FcBundle, re: RegExp) => b.model.parameters.find((p) => re.test(p.name));

/** Gross margin of a reported quarter (%), or of the base scenario for a forecast quarter. */
export function gmOf(b: FcBundle, p: string): { value: number; forecast: boolean } | undefined {
  const q = quarterOf(b.inputs, p);
  const a = q ? actualGrossMargin(b.company, q) : undefined;
  if (a != null) return { value: a, forecast: false };
  const f = scenarioOf(b.model, 'base')?.forecasts.find((x) => x.period === p);
  return f ? { value: f.grossMargin, forecast: true } : undefined;
}

// ───────────── node mix ─────────────

export interface NodeGroup {
  key: string;
  name: string;
  ids: string[];
  color: string;
}
/** Process nodes in the order of the stacked bars (newest first); 40 nm and older are summed. */
export const NODE_GROUPS: NodeGroup[] = [
  { key: 'n2', name: '2 奈米', ids: ['node-n2-share'], color: 'var(--chart-7)' },
  { key: 'n3', name: '3 奈米', ids: ['node-n3-share'], color: 'var(--chart-1)' },
  { key: 'n5', name: '5 奈米', ids: ['node-n5-share'], color: 'var(--chart-3)' },
  { key: 'n7', name: '7 奈米', ids: ['node-n7-share'], color: 'var(--chart-4)' },
  { key: 'n10', name: '10 奈米', ids: ['node-n10-share'], color: 'var(--chart-5)' },
  { key: 'n16', name: '16／20 奈米', ids: ['node-n16-20-share'], color: 'var(--chart-2)' },
  { key: 'n28', name: '28 奈米', ids: ['node-n28-share'], color: 'var(--chart-6)' },
  { key: 'mature', name: '40 奈米以上', ids: ['node-n40-45-share', 'node-n65-share', 'node-n90-above-share'], color: 'var(--c-fg-subtle)' },
];

/**
 * The latest reported quarter, then every fourth quarter of earlier years back to FC_META.historyFrom's year:
 * 2026Q3, 2025Q4, 2024Q4 … 2019Q4.
 */
export function mixPeriods(b: FcBundle): string[] {
  const last = lastReportedOf(b.model);
  const y0 = Number(b.meta.historyFrom.slice(0, 4));
  const out = [last];
  for (let y = Number(last.slice(0, 4)) - 1; y >= y0; y--) out.push(`${y}Q4`);
  return out;
}

export function nodeMixRow(b: FcBundle, p: string) {
  const items = NODE_GROUPS.map((g) => {
    const pts = g.ids.map((id) => driverMap(b, id).get(p)).filter((x): x is DriverPoint => !!x);
    return { key: g.key, name: g.name, color: g.color, share: pts.reduce((s, x) => s + x.value, 0), n: pts.length };
  }).filter((x) => x.n > 0 && x.share > 0);
  const src = driverMap(b, 'node-n28-share').get(p)?.src;
  return { period: p, items: items.map(({ n: _n, ...it }) => it), src };
}

// ───────────── GM bridge ─────────────

export const BRIDGE = [
  { id: 'gm-bridge-scale', short: '規模', name: '美元營收規模（營運槓桿）' },
  { id: 'gm-bridge-fx', short: '匯率', name: '匯率' },
  { id: 'gm-bridge-trend', short: '成本趨勢', name: '成本趨勢' },
  { id: 'gm-bridge-dilution', short: '稀釋', name: '新製程與海外廠稀釋' },
  { id: 'gm-bridge-other', short: '其他', name: '其他（模型未解釋）' },
] as const;

export interface BridgeRow {
  period: string;
  forecast: boolean;
  parts: number[];
  gm: number | undefined;
  gmPrev: number | undefined;
}

/** Quarterly bridge rows between two quarters (inclusive), with the gross margin before and after each quarter. */
export function bridgeRows(b: FcBundle, from: string, to: string): BridgeRow[] {
  const maps = BRIDGE.map((c) => derivedMap(b, c.id));
  if (maps.some((m) => m.size === 0)) return [];
  return quarters(from, to)
    .filter((p) => maps.every((m) => m.has(p)))
    .map((p) => ({
      period: p,
      forecast: maps.some((m) => m.get(p)!.status === 'forecast'),
      parts: maps.map((m) => m.get(p)!.value),
      gm: gmOf(b, p)?.value,
      gmPrev: gmOf(b, prevQuarter(p))?.value,
    }));
}

/** The two bridge windows of the page: the backtest window up to the latest report, and the base-scenario quarters. */
export function bridgeWindows(b: FcBundle) {
  const m = b.model;
  const last = lastReportedOf(m);
  const fq = forecastQuarters(scenarioOf(m, 'base')).map((f) => f.period);
  const actual = bridgeRows(b, m.test.from, last).filter((r) => !r.forecast);
  const forecast = fq.length ? bridgeRows(b, fq[0]!, fq.at(-1)!).filter((r) => r.forecast) : [];
  const sum = (rows: BridgeRow[]) => BRIDGE.map((_, i) => rows.reduce((s, r) => s + r.parts[i]!, 0));
  return {
    actual: { rows: actual, sums: sum(actual), start: actual[0]?.gmPrev, end: actual.at(-1)?.gm },
    forecast: { rows: forecast, sums: sum(forecast), start: forecast[0]?.gmPrev, end: forecast.at(-1)?.gm },
  };
}

// ───────────── dilution statements ─────────────

export interface DilutionRow {
  period: string;
  item: string;
  kind: 'quarter' | 'year';
  value: number;
  low: number | undefined;
  high: number | undefined;
  detail: string;
  src: string;
}
/** Every dilution statement of the drivers file (new nodes by quarter and year, overseas fabs by year), in time order. */
export function dilutionRows(b: FcBundle): DilutionRow[] {
  const rows: DilutionRow[] = [];
  const add = (id: string, kind: 'quarter' | 'year', fixed?: string) => {
    for (const p of driverOf(b, id)?.points ?? []) {
      const note = p.note ?? '';
      const node = /^(\d+ 奈米)[；;，,]?\s*/.exec(note);
      rows.push({
        period: p.period,
        item: fixed ?? node?.[1] ?? '新製程',
        kind,
        value: p.value,
        low: p.low,
        high: p.high,
        detail: node ? note.slice(node[0].length) : note,
        src: p.src,
      });
    }
  };
  add('new-node-gm-dilution', 'quarter');
  add('new-node-gm-dilution-year', 'year');
  add('overseas-fab-gm-dilution', 'year', '海外廠');
  const key = (r: DilutionRow) => (isQuarter(r.period) ? qIndex(r.period) : Number(r.period) * 4 + 3.5);
  return rows.sort((a, c) => key(a) - key(c) || (a.kind === c.kind ? 0 : a.kind === 'year' ? 1 : -1));
}

// ───────────── guidance beats (Scenarios) ─────────────

/** Actual USD revenue against the guidance range of every quarter with both (2017Q3 on). */
export function guidanceRanges(b: FcBundle) {
  const g = driverMap(b, 'guidance-revenue-usd');
  const a = driverMap(b, 'revenue-usd');
  return [...g.values()]
    .filter((p) => isQuarter(p.period) && p.status === 'guidance' && a.has(p.period))
    .map((p) => {
      const act = a.get(p.period)!;
      return {
        period: p.period,
        mid: p.value,
        low: p.low,
        high: p.high,
        actual: act.value,
        beat: (act.value / p.value - 1) * 100,
        position: p.high != null && act.value > p.high ? 'above' : p.low != null && act.value < p.low ? 'below' : 'inside',
        srcs: [p.src, act.src],
      };
    })
    .sort((x, y) => qIndex(x.period) - qIndex(y.period));
}

/** Gross margin against the guidance midpoint (every quarter with both). */
export function gmGuidanceRows(b: FcBundle) {
  const g = driverMap(b, 'guidance-gross-margin');
  return [...g.values()]
    .filter((p) => isQuarter(p.period) && p.status === 'guidance')
    .map((p) => {
      const q = quarterOf(b.inputs, p.period);
      const gm = q ? actualGrossMargin(b.company, q) : undefined;
      return gm == null || !q ? undefined : { period: p.period, mid: p.value, low: p.low, high: p.high, gm, beat: gm - p.value, srcs: [p.src, q.src] };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((x, y) => qIndex(x.period) - qIndex(y.period));
}

// ───────────── source keys ─────────────

/** Source keys the sections of this folder cite beyond the page defaults (sources.ts). */
export function sectionKeys(b: FcBundle): string[] {
  const keys = new Set<string>();
  for (const r of dilutionRows(b)) {
    keys.add(r.src);
    citesIn(b, r.detail).forEach((k) => keys.add(k));
  }
  citesIn(b, driverOf(b, 'ai-accelerator-revenue-share')?.note).forEach((k) => keys.add(k));
  for (const r of guidanceRanges(b)) r.srcs.forEach((k) => keys.add(k));
  for (const r of gmGuidanceRows(b)) r.srcs.forEach((k) => keys.add(k));
  for (const id of ['capex-budget', 'ai-accelerator-revenue-share', 'advanced-packaging-revenue-share', 'depreciation-growth-guidance', 'overseas-fab-gm-dilution'])
    for (const p of driverOf(b, id)?.points ?? []) keys.add(p.src);
  return [...keys].filter((k) => b.sourceByKey.has(k));
}
