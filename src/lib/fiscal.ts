/**
 * Fiscal-period helpers: calendarisation, display labels, YoY pairing, TTM and gap detection.
 *
 * Periods are stored with the company-native label (FY2027-Q2, FY2025, FY2025-H1, 2026-08)
 * plus exact inclusive start/end dates. Everything here is derived from those dates.
 */
import { calendarQuarterLabel, formatDateRange } from './format';

export type PeriodKind = 'quarter' | 'half' | 'year' | 'month';

export interface ParsedPeriod {
  kind: PeriodKind;
  label: string;
  /** fiscal year number for FY labels (FY2027 → 2027) */
  fy?: number;
  quarter?: 1 | 2 | 3 | 4;
  half?: 1 | 2;
  /** calendar year/month for month labels (2026-08) */
  year?: number;
  month?: number;
}

/** Minimal shape of a dated period (FinPoint satisfies it). */
export interface PeriodLike {
  period: string;
  start: string;
  end: string;
}

export interface StatusLike extends PeriodLike {
  status?: string | undefined;
}

const RE_FY = /^FY(\d{4})(?:-(Q[1-4]|H[12]))?$/;
const RE_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parsePeriod(label: string): ParsedPeriod | null {
  const m = RE_FY.exec(label);
  if (m) {
    const fy = Number(m[1]);
    const sub = m[2];
    if (!sub) return { kind: 'year', label, fy };
    if (sub.startsWith('Q')) return { kind: 'quarter', label, fy, quarter: Number(sub[1]) as 1 | 2 | 3 | 4 };
    return { kind: 'half', label, fy, half: Number(sub[1]) as 1 | 2 };
  }
  const mm = RE_MONTH.exec(label);
  if (mm) return { kind: 'month', label, year: Number(mm[1]), month: Number(mm[2]) };
  return null;
}

export function periodKind(label: string): PeriodKind | null {
  return parsePeriod(label)?.kind ?? null;
}

// ───────────────────────── day arithmetic (UTC, inclusive ranges) ─────────────────────────

const DAY = 86_400_000;

/** Days since 1970-01-01 for an ISO date (YYYY-MM-DD). */
export function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

export function isoFromDay(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

/** Inclusive length in days. */
export function periodDays(p: { start: string; end: string }): number {
  return dayNumber(p.end) - dayNumber(p.start) + 1;
}

/** Overlap in days between two inclusive ranges. */
export function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const s = Math.max(dayNumber(aStart), dayNumber(bStart));
  const e = Math.min(dayNumber(aEnd), dayNumber(bEnd));
  return Math.max(0, e - s + 1);
}

function quarterBounds(year: number, q: number): [string, string] {
  const sm = (q - 1) * 3 + 1;
  const start = `${year}-${String(sm).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, sm + 2, 0)).toISOString().slice(0, 10);
  return [start, end];
}

// ───────────────────────── calendarisation ─────────────────────────

export interface CalendarQuarter {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  /** '2026-Q2' — matches the keys of src/data/fx/usd-rates.json */
  key: string;
  /** 「2026 Q2」 */
  label: string;
  overlapDays: number;
  totalDays: number;
  /** true when start/end equal the calendar quarter boundaries */
  aligned: boolean;
}

/**
 * Calendar quarter with the largest overlap. Ties go to the later quarter.
 * NVIDIA FY2027-Q2 (2026-04-27 → 2026-07-26): 65 days in CQ2, 26 in CQ3 → 2026 Q2.
 */
export function calendarQuarterOf(start: string, end: string): CalendarQuarter {
  const ys = Number(start.slice(0, 4));
  const ye = Number(end.slice(0, 4));
  let best: CalendarQuarter | null = null;
  for (let y = ys; y <= ye; y++) {
    for (let q = 1; q <= 4; q++) {
      const [qs, qe] = quarterBounds(y, q);
      const ov = overlapDays(start, end, qs, qe);
      if (ov > 0 && (!best || ov >= best.overlapDays)) {
        best = {
          year: y,
          quarter: q as 1 | 2 | 3 | 4,
          key: `${y}-Q${q}`,
          label: calendarQuarterLabel(y, q),
          overlapDays: ov,
          totalDays: periodDays({ start, end }),
          aligned: qs === start.slice(0, 10) && qe === end.slice(0, 10),
        };
      }
    }
  }
  if (!best) throw new Error(`calendarQuarterOf: empty range ${start}–${end}`);
  return best;
}

/** Calendar year with the largest overlap (ties → later year). */
export function calendarYearOf(start: string, end: string): number {
  const ys = Number(start.slice(0, 4));
  const ye = Number(end.slice(0, 4));
  let best = ys;
  let bestOv = -1;
  for (let y = ys; y <= ye; y++) {
    const ov = overlapDays(start, end, `${y}-01-01`, `${y}-12-31`);
    if (ov >= bestOv) {
      best = y;
      bestOv = ov;
    }
  }
  return best;
}

/** Calendar month (YYYY-MM) with the largest overlap. */
export function calendarMonthOf(start: string, end: string): string {
  let best = start.slice(0, 7);
  let bestOv = -1;
  let d = dayNumber(start.slice(0, 7) + '-01');
  const last = dayNumber(end);
  while (d <= last) {
    const ms = isoFromDay(d);
    const [y, m] = ms.split('-').map(Number) as [number, number];
    const me = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const ov = overlapDays(start, end, ms, me);
    if (ov >= bestOv) {
      best = ms.slice(0, 7);
      bestOv = ov;
    }
    d = dayNumber(me) + 1;
  }
  return best;
}

/** True when the period's dates are exactly a calendar quarter / year / month. */
export function isCalendarAligned(p: PeriodLike): boolean {
  const kind = periodKind(p.period);
  const s = p.start.slice(0, 10);
  const e = p.end.slice(0, 10);
  if (kind === 'month') return true;
  if (kind === 'quarter') return calendarQuarterOf(s, e).aligned;
  if (kind === 'year') {
    const y = s.slice(0, 4);
    return s === `${y}-01-01` && e === `${y}-12-31`;
  }
  if (kind === 'half') {
    const y = s.slice(0, 4);
    return (s === `${y}-01-01` && e === `${y}-06-30`) || (s === `${y}-07-01` && e === `${y}-12-31`);
  }
  return false;
}

// ───────────────────────── labels ─────────────────────────

/** FY2027-Q2 → 「FY27 Q2」, FY2025 → 「FY25」, FY2025-H1 → 「FY25 H1」, 2026-08 → 「2026/8」 */
export function fiscalShortLabel(label: string): string {
  const p = parsePeriod(label);
  if (!p) return label;
  if (p.kind === 'month') return `${p.year}/${p.month}`;
  const fy = `FY${String(p.fy).slice(2)}`;
  if (p.kind === 'year') return fy;
  if (p.kind === 'quarter') return `${fy} Q${p.quarter}`;
  return `${fy} H${p.half}`;
}

/**
 * Label for a period known only by its label (guidance, mix snapshots): calendar names when the
 * company's fiscal year is the calendar year (「2026 Q3」), else fiscal names (「FY27 Q3」).
 */
export function labelForPeriod(label: string, fiscalYear?: { endMonth: number; naming: string } | null): string {
  const p = parsePeriod(label);
  if (!p || p.kind === 'month') return p ? `${p.year}/${p.month}` : label;
  if (fiscalYear && fiscalYear.endMonth === 12 && fiscalYear.naming === 'end-year') {
    if (p.kind === 'quarter') return calendarQuarterLabel(p.fy!, p.quarter!);
    if (p.kind === 'half') return `${p.fy} H${p.half}`;
    return `${p.fy} 年`;
  }
  return fiscalShortLabel(label);
}

/**
 * Short display label. Calendar-aligned periods use calendar names (「2026 Q2」「2025 年」
 * 「2025 H1」); others keep the fiscal name (「FY27 Q2」).
 */
export function periodLabel(p: PeriodLike): string {
  const parsed = parsePeriod(p.period);
  if (!parsed) return p.period;
  if (parsed.kind === 'month') return `${parsed.year}/${parsed.month}`;
  if (isCalendarNamed(p)) {
    const y = Number(p.start.slice(0, 4));
    if (parsed.kind === 'quarter') return calendarQuarterLabel(y, parsed.quarter!);
    if (parsed.kind === 'year') return `${y} 年`;
    if (parsed.kind === 'half') return `${y} H${parsed.half}`;
  }
  return fiscalShortLabel(p.period);
}

/**
 * True when the fiscal label IS the calendar name: the dates are calendar-aligned and the
 * fiscal year number equals the calendar year (TSMC FY2026-Q2 = 2026 Q2). Tokyo Electron's
 * FY2027-Q1 (2026/4/1–6/30) is aligned but not calendar-named.
 */
export function isCalendarNamed(p: PeriodLike): boolean {
  const parsed = parsePeriod(p.period);
  if (!parsed || parsed.kind === 'month') return parsed?.kind === 'month';
  if (!isCalendarAligned(p)) return false;
  const y = Number(p.start.slice(0, 4));
  if (parsed.fy !== y) return false;
  if (parsed.kind === 'quarter') return calendarQuarterOf(p.start, p.end).quarter === parsed.quarter;
  if (parsed.kind === 'half') return (p.start.slice(5, 7) === '01' ? 1 : 2) === parsed.half;
  return true;
}

/**
 * Long label with calendarisation:
 *   「FY27 Q2（約 2026 Q2，2026/4/27–7/26）」
 *   calendar-named → 「2026 Q2（2026/4/1–6/30）」
 *   aligned but fiscal-named → 「FY27 Q1（2026 Q2，2026/4/1–6/30）」
 *   years → 「FY26（約 2025 年，2025/1/27–2026/1/25）」
 */
export function periodLongLabel(p: PeriodLike): string {
  const parsed = parsePeriod(p.period);
  const range = formatDateRange(p.start, p.end);
  if (!parsed) return `${p.period}（${range}）`;
  if (parsed.kind === 'month') return `${parsed.year} 年 ${parsed.month} 月`;
  if (isCalendarNamed(p)) return `${periodLabel(p)}（${range}）`;
  const approx = isCalendarAligned(p) ? '' : '約 ';
  return `${fiscalShortLabel(p.period)}（${approx}${calendarApproxLabel(p)}，${range}）`;
}

/** Calendar approximation used in labels: 「2026 Q2」, 「2025 年」, 「2025 下半年」 */
export function calendarApproxLabel(p: PeriodLike): string {
  const kind = periodKind(p.period);
  if (kind === 'quarter') return calendarQuarterOf(p.start, p.end).label;
  if (kind === 'year') return `${calendarYearOf(p.start, p.end)} 年`;
  if (kind === 'half') {
    const cq = calendarQuarterOf(p.start, p.end);
    // the half whose quarters overlap the most
    const y = cq.year;
    const h1 = overlapDays(p.start, p.end, `${y}-01-01`, `${y}-06-30`);
    const h2 = overlapDays(p.start, p.end, `${y}-07-01`, `${y}-12-31`);
    return h1 >= h2 ? `${y} 上半年` : `${y} 下半年`;
  }
  return calendarMonthOf(p.start, p.end);
}

/** Note for 53-week years / 14-week quarters, else null. */
export function longPeriodNote(p: PeriodLike): string | null {
  const kind = periodKind(p.period);
  const days = periodDays(p);
  if (kind === 'quarter' && days >= 95) return '本季含 14 週，比一般季度多一週';
  if (kind === 'year' && days >= 368) return '本財年含 53 週，比一般年度多一週';
  return null;
}

// ───────────────────────── period arithmetic ─────────────────────────

/** Same period one fiscal (or calendar) year earlier: FY2027-Q2 → FY2026-Q2; 2026-08 → 2025-08. */
export function priorYearPeriod(label: string): string | null {
  const p = parsePeriod(label);
  if (!p) return null;
  if (p.kind === 'month') return `${p.year! - 1}-${String(p.month).padStart(2, '0')}`;
  const fy = `FY${p.fy! - 1}`;
  if (p.kind === 'year') return fy;
  if (p.kind === 'quarter') return `${fy}-Q${p.quarter}`;
  return `${fy}-H${p.half}`;
}

/** The immediately preceding period of the same kind. */
export function previousPeriod(label: string): string | null {
  const p = parsePeriod(label);
  if (!p) return null;
  if (p.kind === 'month') {
    const m = p.month! === 1 ? 12 : p.month! - 1;
    const y = p.month! === 1 ? p.year! - 1 : p.year!;
    return `${y}-${String(m).padStart(2, '0')}`;
  }
  if (p.kind === 'year') return `FY${p.fy! - 1}`;
  if (p.kind === 'quarter') return p.quarter === 1 ? `FY${p.fy! - 1}-Q4` : `FY${p.fy}-Q${p.quarter! - 1}`;
  return p.half === 1 ? `FY${p.fy! - 1}-H2` : `FY${p.fy}-H1`;
}

/** The immediately following period of the same kind. */
export function nextPeriod(label: string): string | null {
  const p = parsePeriod(label);
  if (!p) return null;
  if (p.kind === 'month') {
    const m = p.month! === 12 ? 1 : p.month! + 1;
    const y = p.month! === 12 ? p.year! + 1 : p.year!;
    return `${y}-${String(m).padStart(2, '0')}`;
  }
  if (p.kind === 'year') return `FY${p.fy! + 1}`;
  if (p.kind === 'quarter') return p.quarter === 4 ? `FY${p.fy! + 1}-Q1` : `FY${p.fy}-Q${p.quarter! + 1}`;
  return p.half === 2 ? `FY${p.fy! + 1}-H1` : `FY${p.fy}-H2`;
}

/** Fiscal year number of a FY label, or the calendar year for months. */
export function fiscalYearOf(label: string): number | null {
  const p = parsePeriod(label);
  if (!p) return null;
  return p.kind === 'month' ? p.year! : p.fy!;
}

// ───────────────────────── continuity, gaps, TTM ─────────────────────────

/** Sort a copy by start date. */
export function sortByStart<T extends PeriodLike>(points: readonly T[]): T[] {
  return [...points].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/**
 * b directly follows a: the gap between a.end and b.start is at most `toleranceDays`
 * (1 = perfectly adjacent inclusive ranges). Overlaps (≤ 0) are not continuous.
 */
export function isContinuous(a: PeriodLike, b: PeriodLike, toleranceDays = 4): boolean {
  const d = dayNumber(b.start) - dayNumber(a.end);
  return d >= 1 && d <= toleranceDays;
}

export interface PeriodGap {
  /** last period before the gap */
  after: string;
  /** first period after the gap */
  before: string;
  /** uncovered days between the two */
  gapDays: number;
  /** labels expected in between (when they can be inferred) */
  missing: string[];
}

/** Gaps between consecutive periods (sorted by start). */
export function detectGaps<T extends PeriodLike>(points: readonly T[], toleranceDays = 4): PeriodGap[] {
  const pts = sortByStart(points);
  const out: PeriodGap[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const d = dayNumber(b.start) - dayNumber(a.end);
    if (d > toleranceDays) {
      const missing: string[] = [];
      let lab = nextPeriod(a.period);
      for (let guard = 0; lab && lab !== b.period && guard < 40; guard++) {
        missing.push(lab);
        lab = nextPeriod(lab);
      }
      out.push({ after: a.period, before: b.period, gapDays: d - 1, missing: lab === b.period ? missing : [] });
    }
  }
  return out;
}

export const NON_ACTUAL_STATUSES = new Set(['estimate', 'guidance']);
export function isActual(p: { status?: string | undefined }): boolean {
  return !NON_ACTUAL_STATUSES.has(p.status ?? 'reported');
}

/**
 * The latest `count` consecutive actual (non-estimate, non-guidance) periods, or null when
 * they are not continuous. Used for TTM: 4 quarters, or 2 halves.
 */
export function latestContinuousRun<T extends StatusLike>(points: readonly T[], count: number): T[] | null {
  const actual = sortByStart(points.filter(isActual));
  if (actual.length < count) return null;
  const run = actual.slice(-count);
  for (let i = 1; i < run.length; i++) if (!isContinuous(run[i - 1]!, run[i]!)) return null;
  return run;
}

/** Number of trailing consecutive quarters (useful for validation and coverage reports). */
export function trailingContinuousCount<T extends PeriodLike>(points: readonly T[]): number {
  const pts = sortByStart(points);
  if (!pts.length) return 0;
  let n = 1;
  for (let i = pts.length - 1; i > 0; i--) {
    if (isContinuous(pts[i - 1]!, pts[i]!)) n++;
    else break;
  }
  return n;
}
