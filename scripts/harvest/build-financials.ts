// Convert harvested raw data (research/fin, research/fin-tw) into draft
// src/content/financials/<id>.json files that satisfy the financials schema.
// Never overwrites an existing file unless --force. Content agents then verify the latest
// quarter against primary sources, add mix/guidance and IR sources, and update editorial.
//
// Usage: npx tsx scripts/harvest/build-financials.ts [--only id1,id2] [--force]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1]!.split(',')) : null;
const force = args.includes('--force');

type Entry = {
  id: string; name: string; profile: 'full' | 'compact'; region: string; ownership: string;
  listings?: { exchange: string; ticker: string }[]; stockanalysis?: string | null; twMonthly?: string | null;
};
const roster: Entry[] = [];
for (const f of readdirSync('src/data/roster').filter((f) => f.endsWith('.yaml'))) {
  roster.push(...(parse(readFileSync(`src/data/roster/${f}`, 'utf8')) as { companies: Entry[] }).companies);
}

const DAY = 86400000;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Start date of a period that ends on `end` and spans `months` months (handles month-end and 52/53-week calendars). */
function periodStart(end: string, months: number): string {
  const d = new Date(end + 'T00:00:00Z');
  const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  if (d.getUTCDate() === lastOfMonth) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months + 1, 1)).toISOString().slice(0, 10);
  }
  return addDays(end, -Math.round((months / 12) * 364) + 1);
}
/** Prefer prev.end + 1 when it gives a plausible length, else the canonical start. */
function startFor(prevEnd: string | undefined, end: string, months: number): string {
  const lo = months === 3 ? 84 : months === 6 ? 175 : 350;
  const hi = months === 3 ? 98 : months === 6 ? 190 : 380;
  if (prevEnd) { const len = days(prevEnd, end); if (len >= lo && len <= hi) return addDays(prevEnd, 1); }
  return periodStart(end, months);
}
const dedupeLast = <T extends { period: string }>(pts: T[]) => { const m = new Map<string, T>(); for (const p of pts) m.set(p.period, p); return [...m.values()]; };
const r1 = (n: number) => Math.round(n * 10) / 10;

function standard(e: Entry, currency: string): string {
  const ex = e.listings?.[0]?.exchange ?? '';
  if (['TWSE', 'TPEx'].includes(ex)) return 'TIFRS';
  if (['NASDAQ', 'NYSE'].includes(ex) && currency === 'USD') return 'US-GAAP';
  if (['KRX', 'KOSDAQ'].includes(ex)) return 'K-IFRS';
  if (ex === 'TSE') return 'J-GAAP';
  if (['SSE', 'SZSE', 'STAR', 'BSE-CN'].includes(ex)) return 'CAS';
  if (ex === 'HKEX') return 'HKFRS';
  return 'IFRS';
}

mkdirSync('src/content/financials', { recursive: true });
const log: string[] = [];
for (const e of roster) {
  if (only && !only.has(e.id)) continue;
  const out = `src/content/financials/${e.id}.json`;
  if (existsSync(out) && !force) { log.push(`= ${e.id} exists, skipped`); continue; }
  const saPath = `research/fin/${e.id}.json`;
  const twPath = `research/fin-tw/${e.id}.json`;
  if (!existsSync(saPath) && !existsSync(twPath)) continue;
  const sa = existsSync(saPath) ? JSON.parse(readFileSync(saPath, 'utf8')) : null;
  const tw = existsSync(twPath) ? JSON.parse(readFileSync(twPath, 'utf8')) : null;
  const currency: string = sa?.currency ?? 'TWD';
  const sources: Record<string, unknown> = {};
  const series: unknown[] = [];
  const maxQ = e.profile === 'full' ? 16 : 8;
  let endMonth = 12;
  let naming: 'end-year' | 'start-year' = 'end-year';
  let fyExample = '';

  if (sa) {
    sources['sa-q'] = {
      title: `${e.name} quarterly income statement`, publisher: 'Stock Analysis', url: sa.urlQuarterly,
      type: 'dataset', lang: 'en', accessed: sa.fetched, note: '彙整自公司財報；最新一季已與公司公告核對者另列一手來源',
    };
    sources['sa-a'] = {
      title: `${e.name} annual income statement`, publisher: 'Stock Analysis', url: sa.urlAnnual,
      type: 'dataset', lang: 'en', accessed: sa.fetched,
    };
    // annual → fiscal-year convention
    const ann = (sa.annual as any[]).filter((r) => r.revenue != null && r.fy).sort((a, b) => a.end.localeCompare(b.end));
    const lastAnn = ann.at(-1);
    if (lastAnn) {
      endMonth = Number(lastAnn.end.slice(5, 7));
      // 52/53-week years ending in the first days of a month belong to the previous month
      if (Number(lastAnn.end.slice(8, 10)) <= 7) endMonth = endMonth === 1 ? 12 : endMonth - 1;
      naming = Number(lastAnn.end.slice(0, 4)) === Number(lastAnn.fy) ? 'end-year' : 'start-year';
      fyExample = `FY${lastAnn.fy} 結束於 ${lastAnn.end}`;
    }
    // quarterly / half-yearly
    const q = (sa.quarterly as any[]).filter((r) => r.revenue != null && r.fy).sort((a, b) => a.end.localeCompare(b.end));
    const gaps = q.slice(1).map((r, i) => days(q[i].end, r.end)).sort((a, b) => a - b);
    const med = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 91;
    const periodType = med <= 100 ? 'quarter' : med <= 200 ? 'half' : 'year';
    if (periodType !== 'year' && q.length > 1) {
      const label = (r: any) => {
        if (periodType === 'quarter') return `FY${r.fy}-${r.fq}`;
        const h = /H[12]/.test(r.fq) ? r.fq : r.fq === 'Q2' ? 'H1' : 'H2';
        return `FY${r.fy}-${h}`;
      };
      const months = periodType === 'quarter' ? 3 : 6;
      const rows = q.map((r, i) => ({ ...r, start: startFor(q[i - 1]?.end, r.end, months) })).slice(-maxQ);
      const pts = (val: (r: any) => number | null) =>
        dedupeLast(rows.filter((r) => val(r) != null).map((r) => ({ period: label(r), start: r.start, end: r.end, value: val(r)!, status: 'reported', src: 'sa-q' })));
      series.push({ metric: 'revenue', periodType, unit: 'million', currency, basis: standard(e, currency) === 'US-GAAP' ? 'GAAP' : 'IFRS', points: pts((r) => r2(r.revenue / 1e6)) });
      const gm = pts((r) => (r.gp == null || !r.revenue ? null : r1((r.gp / r.revenue) * 100)));
      if (gm.length >= 4) series.push({ metric: 'gross-margin', periodType, unit: 'percent', basis: 'GAAP', points: gm });
      const om = pts((r) => (r.opinc == null || !r.revenue ? null : r1((r.opinc / r.revenue) * 100)));
      if (om.length >= 4) series.push({ metric: 'operating-margin', periodType, unit: 'percent', basis: 'GAAP', points: om });
    }
    if (ann.length >= 1) {
      const rows = ann.map((r, i) => ({ ...r, start: startFor(ann[i - 1]?.end, r.end, 12) }));
      series.push({
        metric: 'revenue', periodType: 'year', unit: 'million', currency, basis: 'GAAP',
        points: dedupeLast(rows.map((r) => ({ period: `FY${r.fy}`, start: r.start, end: r.end, value: r2(r.revenue / 1e6), status: 'reported', src: 'sa-a' }))),
      });
    }
  }
  if (tw) {
    sources['tw-monthly'] = {
      title: `${e.name} 每月營收（${tw.code}）`, publisher: 'Yahoo 股市（資料源：公開資訊觀測站）', url: tw.url,
      type: 'monthly-revenue', lang: 'zh-TW', accessed: tw.fetched, note: '月營收為自結合併數字，未經會計師查核',
    };
    const months = (tw.months as any[]).filter((m) => m.revenueK != null).slice(-24);
    series.push({
      metric: 'revenue', periodType: 'month', unit: 'million', currency: 'TWD', basis: 'TIFRS', label: '月營收',
      points: months.map((m) => {
        const [y, mo] = m.month.split('-').map(Number);
        const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        return { period: m.month, start: `${m.month}-01`, end: `${m.month}-${String(last).padStart(2, '0')}`, value: r2(m.revenueK / 1000), status: 'reported', src: 'tw-monthly' };
      }),
    });
  }
  if (!series.length) { log.push(`✗ ${e.id} no usable series`); continue; }
  const doc = {
    company: e.id,
    reportingCurrency: currency,
    accountingStandard: standard(e, currency),
    fiscalYear: {
      endMonth,
      naming,
      description: `會計年度結束於每年 ${endMonth} 月，以${naming === 'end-year' ? '結束' : '起始'}年份命名${fyExample ? `（例如 ${fyExample}）` : ''}。`,
    },
    series,
    mix: [],
    guidance: [],
    sources,
    lastVerified: sa?.fetched ?? tw?.fetched,
    editorial: { status: 'draft', author: 'harvest-script', notes: '由腳本自 stockanalysis.com／Yahoo 股市擷取，待與公司一手來源核對' },
  };
  writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
  log.push(`✓ ${e.id} series=${series.length}`);
}
console.log(log.join('\n'));
