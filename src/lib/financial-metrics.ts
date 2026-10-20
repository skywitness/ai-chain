/**
 * Derived financial metrics from a `financials` entry (src/content/financials/<id>.json).
 *
 * All money values returned here are in **millions of the native currency** (or millions of
 * USD for *Usd fields); margins are in percent units. Estimates and guidance are kept in the
 * point lists (flagged `estimate: true`) but never enter TTM, YoY baselines or rankings.
 */
import type { CurrencyCode } from './format';
import { pctChange } from './format';
import {
  type CalendarQuarter,
  type PeriodKind,
  calendarQuarterOf,
  detectGaps,
  isActual,
  isContinuous,
  latestContinuousRun,
  longPeriodNote,
  parsePeriod,
  periodLabel,
  periodLongLabel,
  previousPeriod,
  priorYearPeriod,
  sortByStart,
} from './fiscal';
import { toUsd } from './fx';
import type { z } from 'astro/zod';
import type { Schemas } from '../schemas/index';

/** Parsed `financials` collection entry data (what getCollection('financials') returns in .data). */
export type FinancialsData = z.output<Schemas['financials']>;

// ───────────────────────── input shapes (structural; the content schema output satisfies them) ─────────────────────────

export type FinMetric =
  | 'revenue'
  | 'gross-margin'
  | 'operating-margin'
  | 'operating-income'
  | 'net-income'
  | 'capex'
  | 'rnd'
  | 'free-cash-flow'
  | 'arr'
  | 'rpo'
  | 'backlog'
  | 'data-center-revenue'
  | 'segment-revenue';
export type FinPeriodType = 'quarter' | 'half' | 'year' | 'month';
export type FinStatus = 'reported' | 'restated' | 'preliminary' | 'estimate' | 'guidance';
export type FinUnit = 'thousand' | 'million' | 'billion' | 'percent';

export interface FinPointInput {
  period: string;
  start: string;
  end: string;
  value: number;
  status?: FinStatus | undefined;
  estimateBasis?: string | undefined;
  src: string;
  note?: string | undefined;
}

export interface FinSeriesInput {
  metric: FinMetric;
  periodType: FinPeriodType;
  unit: FinUnit;
  currency?: CurrencyCode | undefined;
  basis?: string | undefined;
  label?: string | undefined;
  points: readonly FinPointInput[];
}

export interface FinMixInput {
  group: string;
  groupZh: string;
  period: string;
  periodType: 'quarter' | 'half' | 'year';
  basis: 'value' | 'share';
  unit: 'million' | 'billion' | 'percent';
  currency?: CurrencyCode | undefined;
  items: readonly { name: string; nameZh: string; value: number }[];
  src: string;
}

export interface FinGuidanceInput {
  forPeriod: string;
  metric: 'revenue';
  low: number;
  high: number;
  unit: 'million' | 'billion';
  currency: CurrencyCode;
  issued: string;
  src: string;
}

export interface FinSourceInput {
  title: string;
  publisher: string;
  url: string;
  type?: string | undefined;
  accessed?: string | undefined;
  published?: string | undefined;
  note?: string | undefined;
}

export interface FinancialsInput {
  company: string | { id: string; collection?: string };
  reportingCurrency: CurrencyCode;
  accountingStandard?: string | undefined;
  fiscalYear: { endMonth: number; naming: 'end-year' | 'start-year'; description: string };
  series: readonly FinSeriesInput[];
  mix?: readonly FinMixInput[] | undefined;
  guidance?: readonly FinGuidanceInput[] | undefined;
  sources: Readonly<Record<string, FinSourceInput>>;
  lastVerified: string;
  editorial?: { status: string; author: string } | undefined;
}

// ───────────────────────── enriched points ─────────────────────────

export interface MetricPoint {
  period: string;
  start: string;
  end: string;
  /** millions of currency, or percent for margin metrics */
  value: number;
  status: FinStatus;
  /** estimate or guidance (hatched, excluded from TTM / rankings) */
  estimate: boolean;
  estimateBasis?: string | undefined;
  note?: string | undefined;
  src: string;
  kind: PeriodKind;
  /** 「FY27 Q2」 or 「2026 Q2」 */
  label: string;
  /** 「FY27 Q2（約 2026 Q2，2026/4/27–7/26）」 */
  longLabel: string;
  /** calendar quarter by largest overlap (quarters and months) */
  cal: CalendarQuarter | null;
  /** value of the same fiscal period one year earlier (actuals only) */
  priorYearValue: number | null;
  /** YoY % vs the same fiscal period of the prior fiscal year */
  yoy: number | null;
  /** change vs the previous period (QoQ / MoM / HoH / YoY for years) */
  pop: number | null;
  /** 14-week quarter / 53-week year note */
  longPeriod: string | null;
  /** true when derived (e.g. annual total summed from four quarters) */
  derived?: boolean;
}

export function companyId(fin: FinancialsInput): string {
  return typeof fin.company === 'string' ? fin.company : fin.company.id;
}

export function toMillions(value: number, unit: FinUnit): number {
  if (unit === 'thousand') return value / 1000;
  if (unit === 'billion') return value * 1000;
  return value;
}

const MARGIN_METRICS = new Set<FinMetric>(['gross-margin', 'operating-margin']);

/** Find a series. For revenue the unlabeled (total) series wins over segment series. */
export function findSeries(
  fin: FinancialsInput,
  metric: FinMetric,
  periodType?: FinPeriodType,
  opts: { label?: string } = {},
): FinSeriesInput | undefined {
  const all = fin.series.filter((s) => s.metric === metric && (!periodType || s.periodType === periodType));
  if (opts.label) return all.find((s) => s.label === opts.label);
  return all.find((s) => !s.label || s.periodType === 'month') ?? all[0];
}

/** Sort, de-duplicate (restated wins, then the later entry), convert units and add YoY / PoP. */
export function enrichPoints(series: FinSeriesInput): MetricPoint[] {
  const byPeriod = new Map<string, FinPointInput>();
  for (const p of series.points) {
    const prev = byPeriod.get(p.period);
    if (!prev || p.status === 'restated' || prev.status !== 'restated') byPeriod.set(p.period, p);
  }
  const sorted = sortByStart([...byPeriod.values()]);
  const isPct = series.unit === 'percent';
  const points: MetricPoint[] = sorted.map((p) => {
    const kind = parsePeriod(p.period)?.kind ?? series.periodType;
    const status = (p.status ?? 'reported') as FinStatus;
    return {
      period: p.period,
      start: p.start,
      end: p.end,
      value: isPct ? p.value : toMillions(p.value, series.unit),
      status,
      estimate: !isActual({ status }),
      estimateBasis: p.estimateBasis,
      note: p.note,
      src: p.src,
      kind,
      label: periodLabel(p),
      longLabel: periodLongLabel(p),
      cal: kind === 'quarter' || kind === 'month' ? calendarQuarterOf(p.start, p.end) : null,
      priorYearValue: null,
      yoy: null,
      pop: null,
      longPeriod: longPeriodNote(p),
    };
  });
  const map = new Map(points.map((p) => [p.period, p]));
  for (const p of points) {
    if (p.status === 'guidance') continue;
    const py = map.get(priorYearPeriod(p.period) ?? '');
    const pv = map.get(previousPeriod(p.period) ?? '');
    if (py && !py.estimate) {
      p.priorYearValue = py.value;
      p.yoy = isPct ? p.value - py.value : pctChange(p.value, py.value);
    }
    if (pv && pv.status !== 'guidance' && isContinuous(pv, p)) {
      p.pop = isPct ? p.value - pv.value : pctChange(p.value, pv.value);
    }
  }
  return points;
}

/** Enriched points of a metric; [] when the series does not exist. */
export function metricPoints(
  fin: FinancialsInput,
  metric: FinMetric,
  periodType: FinPeriodType,
  opts: { label?: string } = {},
): MetricPoint[] {
  const s = findSeries(fin, metric, periodType, opts);
  return s ? enrichPoints(s) : [];
}

/** Revenue points for a period type; years fall back to totals derived from four fiscal quarters. */
export function revenuePoints(fin: FinancialsInput, periodType: FinPeriodType = 'quarter'): MetricPoint[] {
  if (periodType === 'year') return annualRevenue(fin);
  return metricPoints(fin, 'revenue', periodType);
}

/** Which period type best represents this company's revenue: quarter → half → year. */
export function primaryPeriodType(
  fin: FinancialsInput,
  metric: FinMetric = 'revenue',
): 'quarter' | 'half' | 'year' | null {
  for (const t of ['quarter', 'half', 'year'] as const) {
    const s = findSeries(fin, metric, t);
    if (s && s.points.length) return t;
  }
  return null;
}

/** Currency of a metric (series currency, falling back to the reporting currency). */
export function seriesCurrency(
  fin: FinancialsInput,
  metric: FinMetric = 'revenue',
  periodType?: FinPeriodType,
): CurrencyCode {
  return findSeries(fin, metric, periodType)?.currency ?? fin.reportingCurrency;
}

/**
 * Annual revenue: the `year` series, plus fiscal years that have four continuous actual
 * quarters but no annual point (marked `derived`).
 */
export function annualRevenue(fin: FinancialsInput): MetricPoint[] {
  const years = metricPoints(fin, 'revenue', 'year');
  const have = new Set(years.map((p) => p.period));
  const derived: MetricPoint[] = [];
  for (const [type, need, how] of [
    ['quarter', 4, '由四季營收加總'],
    ['half', 2, '由上下半年營收加總'],
  ] as const) {
    const parts = metricPoints(fin, 'revenue', type);
    const byFy = new Map<number, MetricPoint[]>();
    for (const q of parts) {
      const fy = parsePeriod(q.period)?.fy;
      if (fy == null) continue;
      (byFy.get(fy) ?? byFy.set(fy, []).get(fy)!).push(q);
    }
    for (const [fy, qs] of byFy) {
      if (have.has(`FY${fy}`) || qs.length !== need || qs.some((q) => q.estimate)) continue;
      const s = sortByStart(qs);
      if (s.some((q, i) => i > 0 && !isContinuous(s[i - 1]!, q))) continue;
      have.add(`FY${fy}`);
      const start = s[0]!.start;
      const end = s.at(-1)!.end;
      const pt = { period: `FY${fy}`, start, end };
      derived.push({
        ...pt,
        value: s.reduce((a, q) => a + q.value, 0),
        status: 'reported',
        estimate: false,
        src: s.at(-1)!.src,
        kind: 'year',
        label: periodLabel(pt),
        longLabel: periodLongLabel(pt),
        cal: null,
        priorYearValue: null,
        yoy: null,
        pop: null,
        longPeriod: longPeriodNote(pt),
        derived: true,
        note: how,
      });
    }
  }
  const all = sortByStart([...years, ...derived]);
  const map = new Map(all.map((p) => [p.period, p]));
  for (const p of all) {
    const py = map.get(priorYearPeriod(p.period) ?? '');
    if (py && !py.estimate && p.status !== 'guidance') {
      p.priorYearValue = py.value;
      p.yoy = pctChange(p.value, py.value);
      p.pop = p.yoy;
    }
  }
  return all;
}

/** Latest point; by default the latest actual (non-estimate) one. */
export function latestPoint(
  points: readonly MetricPoint[],
  opts: { includeEstimates?: boolean } = {},
): MetricPoint | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]!;
    if (p.status === 'guidance') continue;
    if (!p.estimate || opts.includeEstimates) return p;
  }
  return null;
}

// ───────────────────────── TTM ─────────────────────────

export interface TtmResult {
  /** millions of `currency` */
  value: number;
  currency: CurrencyCode;
  basis: 'quarter' | 'half' | 'year';
  /** 「近四季」「近兩個半年度」「最近財年」 */
  label: string;
  periods: MetricPoint[];
  start: string;
  end: string;
  /** YoY vs the previous 12 months when those periods are complete actuals */
  yoy: number | null;
}

/**
 * Trailing twelve months: the latest 4 continuous actual quarters, else the latest 2 continuous
 * halves, else the latest actual fiscal year. Estimates never count. Null when unavailable.
 */
export function ttm(fin: FinancialsInput, metric: FinMetric = 'revenue'): TtmResult | null {
  if (MARGIN_METRICS.has(metric)) return null;
  const currency = seriesCurrency(fin, metric);
  const tries: Array<['quarter' | 'half', number, string]> = [
    ['quarter', 4, '近四季'],
    ['half', 2, '近兩個半年度'],
  ];
  for (const [type, n, label] of tries) {
    const pts = metricPoints(fin, metric, type);
    if (!pts.length) continue;
    const run = latestContinuousRun(pts, n);
    if (!run) continue;
    const prevRun = (() => {
      const before = pts.filter((p) => p.end < run[0]!.start);
      const r = latestContinuousRun(before, n);
      return r && isContinuous(r.at(-1)!, run[0]!) ? r : null;
    })();
    const value = run.reduce((a, p) => a + p.value, 0);
    const prev = prevRun ? prevRun.reduce((a, p) => a + p.value, 0) : null;
    return {
      value,
      currency,
      basis: type,
      label,
      periods: run,
      start: run[0]!.start,
      end: run.at(-1)!.end,
      yoy: pctChange(value, prev),
    };
  }
  const years = metric === 'revenue' ? annualRevenue(fin) : metricPoints(fin, metric, 'year');
  const last = latestPoint(years);
  if (!last) return null;
  return {
    value: last.value,
    currency,
    basis: 'year',
    label: '最近財年',
    periods: [last],
    start: last.start,
    end: last.end,
    yoy: last.yoy,
  };
}

export interface TtmUsdResult extends TtmResult {
  /** millions of USD — each period converted at its own period-average rate */
  valueUsd: number;
}

/** TTM converted to USD for cross-company ranking (「以美元換算」). */
export function ttmUsd(fin: FinancialsInput, metric: FinMetric = 'revenue'): TtmUsdResult | null {
  const t = ttm(fin, metric);
  if (!t) return null;
  let sum = 0;
  for (const p of t.periods) {
    const usd = toUsd(p.value, t.currency, { start: p.start, end: p.end });
    if (usd == null) return null;
    sum += usd;
  }
  return { ...t, valueUsd: sum };
}

/** Rank entries by USD-converted TTM revenue (descending); entries without TTM are dropped. */
export function rankByTtmUsd<T extends { financials: FinancialsInput }>(
  entries: readonly T[],
): Array<T & { ttm: TtmUsdResult }> {
  return entries
    .map((e) => ({ ...e, ttm: ttmUsd(e.financials) }))
    .filter((e): e is T & { ttm: TtmUsdResult } => e.ttm != null)
    .sort((a, b) => b.ttm.valueUsd - a.ttm.valueUsd);
}

// ───────────────────────── margins ─────────────────────────

export interface MarginSeries {
  periodType: FinPeriodType;
  gross: MetricPoint[];
  operating: MetricPoint[];
}

/** Gross and operating margin series (quarterly, else half, else annual). */
export function marginSeries(fin: FinancialsInput, periodType?: FinPeriodType): MarginSeries {
  const types: FinPeriodType[] = periodType ? [periodType] : ['quarter', 'half', 'year'];
  for (const t of types) {
    const gross = metricPoints(fin, 'gross-margin', t);
    const operating = metricPoints(fin, 'operating-margin', t);
    if (gross.length || operating.length) return { periodType: t, gross, operating };
  }
  return { periodType: periodType ?? 'quarter', gross: [], operating: [] };
}

/** Latest actual margin (percent) of a metric, any period type (quarter preferred). */
export function latestMargin(
  fin: FinancialsInput,
  metric: 'gross-margin' | 'operating-margin',
): MetricPoint | null {
  for (const t of ['quarter', 'half', 'year'] as const) {
    const p = latestPoint(metricPoints(fin, metric, t));
    if (p) return p;
  }
  return null;
}

// ───────────────────────── monthly (Taiwan) ─────────────────────────

export interface MonthlyPoint extends MetricPoint {
  /** month over month % */
  mom: number | null;
  /** cumulative revenue Jan…this month of the same calendar year (null if a month is missing) */
  ytd: number | null;
  /** same window one year earlier */
  ytdPrior: number | null;
  /** cumulative YTD YoY % */
  ytdYoy: number | null;
}

/** Monthly revenue with MoM, YoY and cumulative YTD YoY. */
export function monthlyRevenue(fin: FinancialsInput): MonthlyPoint[] {
  const pts = metricPoints(fin, 'revenue', 'month');
  const map = new Map(pts.map((p) => [p.period, p]));
  const cum = (year: number, month: number): number | null => {
    let s = 0;
    for (let m = 1; m <= month; m++) {
      const p = map.get(`${year}-${String(m).padStart(2, '0')}`);
      if (!p || p.estimate) return null;
      s += p.value;
    }
    return s;
  };
  return pts.map((p) => {
    const parsed = parsePeriod(p.period);
    const y = parsed?.year ?? 0;
    const m = parsed?.month ?? 1;
    const ytd = cum(y, m);
    const ytdPrior = cum(y - 1, m);
    return { ...p, mom: p.pop, ytd, ytdPrior, ytdYoy: pctChange(ytd, ytdPrior) };
  });
}

/** Cumulative YTD for the latest month (or a given year). */
export function cumulativeYtd(fin: FinancialsInput, year?: number): MonthlyPoint | null {
  const m = monthlyRevenue(fin).filter(
    (p) => !p.estimate && (year == null || p.period.startsWith(`${year}-`)),
  );
  return m.at(-1) ?? null;
}

// ───────────────────────── guidance ─────────────────────────

export interface GuidanceInfo {
  forPeriod: string;
  /** millions */
  low: number;
  high: number;
  mid: number;
  currency: CurrencyCode;
  issued: string;
  src: string;
  /** 「FY27 Q3」 */
  label: string;
}

/** The most recently issued revenue guidance for a period that has no actual yet. */
export function pendingGuidance(fin: FinancialsInput): GuidanceInfo | null {
  const actual = new Set(
    fin.series
      .filter((s) => s.metric === 'revenue')
      .flatMap((s) => s.points.filter(isActual).map((p) => p.period)),
  );
  const cands = (fin.guidance ?? []).filter((g) => g.metric === 'revenue' && !actual.has(g.forPeriod));
  if (!cands.length) return null;
  const g = [...cands].sort((a, b) => (a.issued < b.issued ? 1 : -1))[0]!;
  const k = g.unit === 'billion' ? 1000 : 1;
  const parsed = parsePeriod(g.forPeriod);
  const label =
    parsed?.kind === 'quarter' ? `FY${String(parsed.fy).slice(2)} Q${parsed.quarter}` : g.forPeriod;
  return {
    forPeriod: g.forPeriod,
    low: g.low * k,
    high: g.high * k,
    mid: ((g.low + g.high) / 2) * k,
    currency: g.currency,
    issued: g.issued,
    src: g.src,
    label,
  };
}

// ───────────────────────── mix ─────────────────────────

export interface MixItem {
  name: string;
  nameZh: string;
  /** millions (value basis) or percent (share basis) */
  value: number;
  /** share of the snapshot total, percent */
  share: number;
}

export interface MixSnapshotOut {
  group: string;
  groupZh: string;
  period: string;
  periodType: 'quarter' | 'half' | 'year';
  basis: 'value' | 'share';
  currency: CurrencyCode | null;
  items: MixItem[];
  /** sum of item values (millions or percent) */
  total: number;
  src: string;
}

/** Mix snapshots, optionally of one group, sorted chronologically by period label. */
export function mixSnapshots(fin: FinancialsInput, group?: string): MixSnapshotOut[] {
  const list = (fin.mix ?? []).filter((m) => !group || m.group === group);
  return list
    .map((m) => {
      const k = m.unit === 'billion' ? 1000 : 1;
      const vals = m.items.map((i) => ({ ...i, value: m.unit === 'percent' ? i.value : i.value * k }));
      const total = vals.reduce((a, i) => a + i.value, 0);
      return {
        group: m.group,
        groupZh: m.groupZh,
        period: m.period,
        periodType: m.periodType,
        basis: m.basis,
        currency: m.currency ?? (m.unit === 'percent' ? null : fin.reportingCurrency),
        items: vals.map((i) => ({
          name: i.name,
          nameZh: i.nameZh,
          value: i.value,
          share: total ? (i.value / total) * 100 : 0,
        })),
        total,
        src: m.src,
      };
    })
    .sort((a, b) => comparePeriodLabels(a.period, b.period));
}

/** Distinct mix groups in the order they first appear. */
export function mixGroups(fin: FinancialsInput): Array<{ group: string; groupZh: string }> {
  const seen = new Map<string, string>();
  for (const m of fin.mix ?? []) if (!seen.has(m.group)) seen.set(m.group, m.groupZh);
  return [...seen].map(([group, groupZh]) => ({ group, groupZh }));
}

function comparePeriodLabels(a: string, b: string): number {
  const pa = parsePeriod(a);
  const pb = parsePeriod(b);
  const key = (p: ReturnType<typeof parsePeriod>) =>
    !p
      ? 0
      : p.kind === 'month'
        ? p.year! * 100 + p.month!
        : p.fy! * 100 + (p.quarter ? p.quarter * 3 : p.half ? p.half * 6 : 12);
  return key(pa) - key(pb);
}

// ───────────────────────── sparkline & summary ─────────────────────────

export interface SparkData {
  values: number[];
  estimate: boolean[];
  labels: string[];
  periodType: FinPeriodType | null;
}

/** Last `n` revenue values of the primary period type (quarters, else halves, else years). */
export function sparkline(fin: FinancialsInput, n = 8, metric: FinMetric = 'revenue'): SparkData {
  const t = primaryPeriodType(fin, metric);
  if (!t) return { values: [], estimate: [], labels: [], periodType: null };
  const pts = (metric === 'revenue' && t === 'year' ? annualRevenue(fin) : metricPoints(fin, metric, t))
    .filter((p) => p.status !== 'guidance')
    .slice(-n);
  return {
    values: pts.map((p) => p.value),
    estimate: pts.map((p) => p.estimate),
    labels: pts.map((p) => p.label),
    periodType: t,
  };
}

export interface FinancialSummary {
  company: string;
  currency: CurrencyCode;
  periodType: 'quarter' | 'half' | 'year' | null;
  latest: MetricPoint | null;
  latestIncludingEstimates: MetricPoint | null;
  ttm: TtmUsdResult | null;
  /** ttm without USD (when FX is unavailable) */
  ttmNative: TtmResult | null;
  latestYear: MetricPoint | null;
  grossMargin: MetricPoint | null;
  operatingMargin: MetricPoint | null;
  monthly: MonthlyPoint | null;
  guidance: GuidanceInfo | null;
  /** every revenue point is an estimate (private companies) */
  estimateOnly: boolean;
  gaps: ReturnType<typeof detectGaps>;
  asOf: string;
}

/** One-call summary used by cards, chips and the company header. */
export function summarizeFinancials(fin: FinancialsInput): FinancialSummary {
  const periodType = primaryPeriodType(fin);
  const pts = periodType ? revenuePoints(fin, periodType) : [];
  const monthly = metricPoints(fin, 'revenue', 'month').length ? cumulativeYtd(fin) : null;
  return {
    company: companyId(fin),
    currency: seriesCurrency(fin),
    periodType,
    latest: latestPoint(pts),
    latestIncludingEstimates: latestPoint(pts, { includeEstimates: true }),
    ttm: ttmUsd(fin),
    ttmNative: ttm(fin),
    latestYear: latestPoint(annualRevenue(fin)),
    grossMargin: latestMargin(fin, 'gross-margin'),
    operatingMargin: latestMargin(fin, 'operating-margin'),
    monthly,
    guidance: pendingGuidance(fin),
    estimateOnly: pts.length > 0 && pts.every((p) => p.estimate),
    gaps: detectGaps(pts.filter((p) => p.status !== 'guidance')),
    asOf: fin.lastVerified,
  };
}

// ───────────────────────── cross-company helpers ─────────────────────────

export interface CalendarPoint {
  /** calendar quarter label 「2025 Q1」 (MultiLine category) */
  x: string;
  /** '2025-Q1' */
  key: string;
  /** millions of the native currency, or of USD when `usd` is set */
  y: number;
  estimate: boolean;
  /** native period label, e.g. FY2026-Q2 */
  period: string;
}

/**
 * A metric re-keyed by calendar quarter (largest-overlap rule) for cross-company charts such as
 * hyperscaler capex. With `usd: true` every point is converted at its own period-average rate.
 */
export function calendarQuarterPoints(
  fin: FinancialsInput,
  metric: FinMetric = 'revenue',
  opts: { usd?: boolean; from?: string; label?: string } = {},
): CalendarPoint[] {
  const pts = metricPoints(fin, metric, 'quarter', opts.label ? { label: opts.label } : {}).filter(
    (p) => p.status !== 'guidance',
  );
  const cur = seriesCurrency(fin, metric, 'quarter');
  const out: CalendarPoint[] = [];
  for (const p of pts) {
    if (!p.cal) continue;
    if (opts.from && p.cal.key < opts.from) continue;
    const y =
      opts.usd && !MARGIN_METRICS.has(metric) ? toUsd(p.value, cur, { start: p.start, end: p.end }) : p.value;
    if (y == null) continue;
    out.push({ x: p.cal.label, key: p.cal.key, y, estimate: p.estimate, period: p.period });
  }
  return out;
}

export interface YoyMatrix {
  /** 'YYYY-MM', oldest first */
  columns: string[];
  rows: Array<{
    label: string;
    group?: string | undefined;
    href?: string | undefined;
    values: Array<number | null>;
  }>;
}

/**
 * Monthly revenue YoY matrix for the Taiwan heatmap: the last `months` calendar months up to
 * the latest month any entry reports. Entries without monthly data are skipped.
 */
export function monthlyYoyMatrix(
  entries: ReadonlyArray<{
    label: string;
    group?: string | undefined;
    href?: string | undefined;
    financials: FinancialsInput;
  }>,
  months = 24,
): YoyMatrix {
  const data = entries
    .map((e) => ({
      e,
      m: new Map(
        monthlyRevenue(e.financials)
          .filter((p) => !p.estimate)
          .map((p) => [p.period, p.yoy]),
      ),
    }))
    .filter((d) => d.m.size > 0);
  const latest = data
    .flatMap((d) => [...d.m.keys()])
    .sort()
    .at(-1);
  if (!latest) return { columns: [], rows: [] };
  const columns: string[] = [];
  let [y, m] = latest.split('-').map(Number) as [number, number];
  for (let i = 0; i < months; i++) {
    columns.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m--;
    if (m === 0) {
      m = 12;
      y--;
    }
  }
  return {
    columns,
    rows: data.map(({ e, m: map }) => ({
      label: e.label,
      group: e.group,
      href: e.href,
      values: columns.map((c) => map.get(c) ?? null),
    })),
  };
}

// ───────────────────────── statistics ─────────────────────────

export function median(values: readonly number[]): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export function quantile(values: readonly number[], q: number): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

export interface MarginGroupStat {
  key: string;
  n: number;
  median: number;
  min: number;
  max: number;
  p25: number;
  p75: number;
  members: Array<{ id: string; value: number; period: string }>;
}

/**
 * Median latest margin per group (e.g. per segment) — for MarginLadder. Uses the latest
 * actual margin of each entry; estimates never count.
 */
export function marginByGroup(
  entries: ReadonlyArray<{ id: string; group: string; financials: FinancialsInput }>,
  metric: 'gross-margin' | 'operating-margin' = 'gross-margin',
): MarginGroupStat[] {
  const groups = new Map<string, Array<{ id: string; value: number; period: string }>>();
  for (const e of entries) {
    const p = latestMargin(e.financials, metric);
    if (!p) continue;
    (groups.get(e.group) ?? groups.set(e.group, []).get(e.group)!).push({
      id: e.id,
      value: p.value,
      period: p.period,
    });
  }
  return [...groups].map(([key, members]) => {
    const vals = members.map((m) => m.value);
    return {
      key,
      n: members.length,
      median: median(vals)!,
      min: Math.min(...vals),
      max: Math.max(...vals),
      p25: quantile(vals, 0.25)!,
      p75: quantile(vals, 0.75)!,
      members,
    };
  });
}

/** Unique sources referenced by a list of points (in first-use order). */
export function sourcesFor(fin: FinancialsInput, keys: Iterable<string>): FinSourceInput[] {
  const out: FinSourceInput[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    const s = fin.sources[k];
    if (s) out.push(s);
  }
  return out;
}

// Compile-time guarantee: collection entries can be passed straight to every helper above.
const _assignable = (d: FinancialsData): FinancialsInput => d;
void _assignable;
