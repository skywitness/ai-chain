/**
 * roadmap-tunnel data helpers: the `trends` page-data shape (docs/SCENES.md), its type guard,
 * partial-date parsing (YYYY | YYYY-MM | YYYY-MM-DD → fractional year + precision), compact 3D
 * label text and the slot layout that keeps markers on one lane from overlapping.
 */

export type Category = 'hardware' | 'software' | 'market' | 'policy';
export type Status = 'done' | 'expected' | 'speculative';
export type Precision = 'year' | 'month' | 'day';

export interface TrendMilestone {
  date: string;
  label: string;
  status: Status;
}
export interface TrendDatum {
  id: string;
  title: string;
  category: Category;
  milestones: TrendMilestone[];
  /** Site-relative, without the base (default `/trends/<id>/`). */
  href?: string;
}

export const CATEGORIES: readonly Category[] = ['hardware', 'software', 'market', 'policy'];
export const STATUSES: readonly Status[] = ['done', 'expected', 'speculative'];

const DATE_RE = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/;

function isMilestone(m: unknown): m is TrendMilestone {
  if (!m || typeof m !== 'object') return false;
  const o = m as TrendMilestone;
  return (
    typeof o.date === 'string' &&
    DATE_RE.test(o.date) &&
    typeof o.label === 'string' &&
    STATUSES.includes(o.status)
  );
}

function isTrend(t: unknown): t is TrendDatum {
  if (!t || typeof t !== 'object') return false;
  const o = t as TrendDatum;
  return (
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    CATEGORIES.includes(o.category) &&
    Array.isArray(o.milestones) &&
    o.milestones.every(isMilestone) &&
    (o.href === undefined || typeof o.href === 'string')
  );
}

/** Type guard for the `trends` payload: a non-empty list with at least one milestone. */
export function isTrends(d: unknown): d is TrendDatum[] {
  return (
    Array.isArray(d) && d.length > 0 && d.every(isTrend) && d.some((t: TrendDatum) => t.milestones.length > 0)
  );
}

export interface ParsedDate {
  /** Centre of the date span as a fractional year. */
  t: number;
  /** The span the date stands for (a whole year, a month, or one day). */
  t0: number;
  t1: number;
  precision: Precision;
  y: number;
  m: number;
  d: number;
}

export function parseDate(s: string): ParsedDate | null {
  const r = DATE_RE.exec(s);
  if (!r) return null;
  const y = Number(r[1]);
  const m = r[2] ? Number(r[2]) : 0;
  const d = r[3] ? Number(r[3]) : 0;
  if (!m) return { t: y + 0.5, t0: y, t1: y + 1, precision: 'year', y, m, d };
  const m0 = y + (m - 1) / 12;
  if (!d) return { t: m0 + 1 / 24, t0: m0, t1: m0 + 1 / 12, precision: 'month', y, m, d };
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const t = m0 + (Math.min(d, days) - 0.5) / days / 12;
  return { t, t0: t - 1 / 730, t1: t + 1 / 730, precision: 'day', y, m, d };
}

/** 「2027 年」「2026 年 3 月」「2025 年 4 月 16 日」 */
export function dateText(p: Pick<ParsedDate, 'y' | 'm' | 'd'>): string {
  if (!p.m) return `${p.y} 年`;
  if (!p.d) return `${p.y} 年 ${p.m} 月`;
  return `${p.y} 年 ${p.m} 月 ${p.d} 日`;
}

/** Fractional year → 「2026 年 10 月」. */
export function monthText(t: number): string {
  const y = Math.floor(t + 1e-6);
  const m = Math.min(12, Math.floor((t - y) * 12 + 1e-6) + 1);
  return `${y} 年 ${m} 月`;
}

const isNarrow = (ch: string) => ch.charCodeAt(0) < 0x2e80;

/** The label without a leading 「推測：」 / 「預計：」 (the status is shown separately). */
export function cleanLabel(s: string): string {
  return s.replace(/^(推測|預估|預期|預計)\s*[：:]\s*/, '').trim();
}

/**
 * Compact 3D label: drops a leading 「推測：」, keeps the first clause when it is long enough and
 * caps the visual width (full-width characters = 1, Latin/digits ≈ 0.55).
 */
export function shortLabel(s: string, max = 11): string {
  let t = cleanLabel(s);
  // A comma inside a number (「1,300 兆」) is not a clause break: cutting there left 「Google 每月處理逾 1」.
  const cut = t.search(/[，；。;（(]|,(?!\d)/);
  if (cut >= 5) t = t.slice(0, cut);
  let w = 0;
  let out = '';
  for (const ch of t) {
    const cw = isNarrow(ch) ? 0.55 : 1;
    if (w + cw > max) return `${out.trimEnd()}…`;
    w += cw;
    out += ch;
  }
  return out;
}

export interface Milestone {
  /** Index in the flat list (also the picking / instance key). */
  index: number;
  trend: TrendDatum;
  lane: number;
  status: Status;
  label: string;
  short: string;
  date: ParsedDate;
  /** Placed time: the date centre, nudged inside its precision span when a lane is crowded. */
  tx: number;
  /** Angular slot around the lane's rail: 0, ±1, ±2, ±3. */
  slot: number;
  /** First milestone of its lane in its calendar year (入門 emphasis). */
  key: boolean;
}

const SLOTS = [0, 1, -1, 2, -2, 3, -3];
const NUDGE = [0, 1, -1, 2, -2, 3, -3, 4, -4];

/**
 * Flatten the trends into milestones inside [from, to) and give each one a slot so markers on the
 * same lane stay at least `gap` years apart within a slot. Year-precision items may slide inside
 * their year (the precision band still spans the whole year); month/day items keep their date.
 */
export function layoutMilestones(
  trends: readonly TrendDatum[],
  from: number,
  to: number,
  gap: number,
): Milestone[] {
  const out: Milestone[] = [];
  for (const trend of trends) {
    const lane = CATEGORIES.indexOf(trend.category);
    if (lane < 0) continue;
    for (const ms of trend.milestones) {
      const date = parseDate(ms.date);
      if (!date || date.t < from || date.t >= to) continue;
      out.push({
        index: 0,
        trend,
        lane,
        status: ms.status,
        label: ms.label,
        short: shortLabel(ms.label),
        date,
        tx: date.t,
        slot: 0,
        key: false,
      });
    }
  }
  out.sort(
    (a, b) => a.lane - b.lane || a.date.t - b.date.t || a.date.t1 - a.date.t0 - (b.date.t1 - b.date.t0),
  );
  out.forEach((m, i) => (m.index = i));

  const placed: Milestone[][] = CATEGORIES.map(() => []);
  for (const m of out) {
    const lane = placed[m.lane]!;
    const span = m.date.precision === 'year' ? 0.42 : 0;
    const cands: { slot: number; tx: number; cost: number }[] = [];
    for (const s of SLOTS)
      for (const k of NUDGE) {
        const tx = m.date.t + k * gap;
        if (Math.abs(tx - m.date.t) > span + 1e-9) continue;
        cands.push({ slot: s, tx, cost: Math.abs(s) + Math.abs(k) * 0.85 });
      }
    cands.sort((a, b) => a.cost - b.cost);
    const free = cands.find((c) => !lane.some((o) => o.slot === c.slot && Math.abs(o.tx - c.tx) < gap));
    const pick = free ?? cands[0]!;
    m.slot = pick.slot;
    m.tx = Math.min(to - 1e-3, Math.max(from + 1e-3, pick.tx));
    lane.push(m);
  }

  const seen = new Set<string>();
  for (const m of [...out].sort((a, b) => a.date.t - b.date.t)) {
    const k = `${m.lane}|${m.date.y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    m.key = true;
  }
  return out;
}
