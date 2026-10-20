// Harvest quarterly + annual income-statement data from stockanalysis.com for every roster
// company that has a `stockanalysis` path, and Taiwan monthly revenue from Yahoo 股市 for
// companies with `twMonthly`. Raw output goes to research/fin/<id>.json and research/fin-tw/<id>.json.
//
// Usage: npx tsx scripts/harvest/fin.ts [--only id1,id2] [--force]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1]!.split(',')) : null;
const force = args.includes('--force');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Roster = { segment: string; companies: { id: string; name: string; stockanalysis?: string | null; twMonthly?: string | null }[] };
const roster: Roster['companies'] = [];
for (const f of readdirSync('src/data/roster').filter((f) => f.endsWith('.yaml'))) {
  const r = parse(readFileSync(`src/data/roster/${f}`, 'utf8')) as Roster;
  roster.push(...r.companies);
}

async function get(url: string, tries = 3): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
      if (res.status === 404) return null;
      if (res.ok) return await res.text();
      await sleep(2000 * (i + 1));
    } catch {
      await sleep(2000 * (i + 1));
    }
  }
  return null;
}

function parseArr(src: string): (string | number | null)[] {
  return src.split(',').map((s) => {
    const t = s.trim();
    if (t === 'null' || t === 'void 0' || t === '') return null;
    if (t.startsWith('"')) return t.slice(1, -1);
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  });
}

/** Extract the first income-statement data object from a stockanalysis financials page. */
function extract(html: string) {
  const sec = html.indexOf('id:"revenue-income"');
  const start = html.indexOf('data:{datekey:[', sec >= 0 ? sec : 0);
  if (start < 0) return null;
  const end = html.indexOf('}', start);
  const blob = html.slice(start, end);
  const pick = (k: string) => {
    const m = blob.match(new RegExp(`[{,]${k}:\\[([^\\]]*)\\]`));
    return m ? parseArr(m[1]!) : [];
  };
  const cur = html.slice(0, start).match(/currency:"([A-Z]{3})"/g)?.pop()?.slice(10, 13)
    ?? html.match(/currency:"([A-Z]{3})"/)?.[1] ?? null;
  const datekey = pick('datekey') as string[];
  const fy = pick('fiscalYear');
  const fq = pick('fiscalQuarter');
  const revenue = pick('revenue');
  const gp = pick('gp');
  const opinc = pick('opinc');
  const netinc = pick('netinccmn');
  const rows = datekey.map((d, i) => ({
    end: d,
    fy: fy[i] == null ? null : String(fy[i]),
    fq: fq[i] == null ? null : String(fq[i]),
    revenue: (revenue[i] as number | null) ?? null,
    gp: (gp[i] as number | null) ?? null,
    opinc: (opinc[i] as number | null) ?? null,
    netinc: (netinc[i] as number | null) ?? null,
  }));
  return { currency: cur, rows };
}

/** Yahoo 股市 monthly revenue: values are in thousands of TWD. */
function extractTw(html: string) {
  const key = '"data":[{"date":"';
  const i = html.indexOf(key);
  if (i < 0) return null;
  let depth = 0;
  let j = i + 7;
  for (; j < html.length; j++) {
    const ch = html[j];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) break; }
  }
  const arr = JSON.parse(html.slice(i + 7, j + 1)) as {
    date: string; currentPeriodRevenue: number | null; lastPeriodRevenue: number | null;
    currentPeriodGrowthRate: string | null; revenueYoY: string | null;
  }[];
  return arr.map((r) => ({
    month: r.date.replace('/', '-'),
    revenueK: r.currentPeriodRevenue,
    lastYearK: r.lastPeriodRevenue,
    mom: r.currentPeriodGrowthRate == null ? null : Number(r.currentPeriodGrowthRate),
    yoy: r.revenueYoY == null ? null : Number(r.revenueYoY),
  }));
}

mkdirSync('research/fin', { recursive: true });
mkdirSync('research/fin-tw', { recursive: true });
const report: string[] = [];
const fetched = new Date().toISOString().slice(0, 10);

for (const c of roster) {
  if (only && !only.has(c.id)) continue;
  if (c.stockanalysis) {
    const out = `research/fin/${c.id}.json`;
    if (force || !existsSync(out)) {
      const base = `https://stockanalysis.com/${c.stockanalysis}/financials`;
      const qHtml = await get(`${base}/?p=quarterly`);
      await sleep(600);
      const aHtml = await get(`${base}/`);
      await sleep(600);
      const q = qHtml ? extract(qHtml) : null;
      const a = aHtml ? extract(aHtml) : null;
      if (q || a) {
        writeFileSync(out, JSON.stringify({
          id: c.id, name: c.name, path: c.stockanalysis, currency: q?.currency ?? a?.currency ?? null,
          fetched, urlQuarterly: `${base}/?p=quarterly`, urlAnnual: `${base}/`,
          quarterly: q?.rows ?? [], annual: a?.rows ?? [],
        }, null, 1));
        report.push(`✓ ${c.id} sa q=${q?.rows.length ?? 0} a=${a?.rows.length ?? 0} ${q?.currency ?? a?.currency}`);
      } else report.push(`✗ ${c.id} sa ${c.stockanalysis} (no data)`);
    }
  }
  if (c.twMonthly) {
    const out = `research/fin-tw/${c.id}.json`;
    if (force || !existsSync(out)) {
      const url = `https://tw.stock.yahoo.com/quote/${c.twMonthly}/revenue`;
      const html = await get(url);
      await sleep(600);
      const months = html ? extractTw(html) : null;
      if (months?.length) {
        writeFileSync(out, JSON.stringify({ id: c.id, code: c.twMonthly, unit: 'thousand TWD', fetched, url, months }, null, 1));
        report.push(`✓ ${c.id} tw months=${months.length}`);
      } else report.push(`✗ ${c.id} tw ${c.twMonthly} (no data)`);
    }
  }
}
writeFileSync('research/fin-harvest-report.txt', report.join('\n'));
console.log(report.join('\n'));
console.log(`done: ${report.filter((r) => r.startsWith('✓')).length} ok, ${report.filter((r) => r.startsWith('✗')).length} failed`);
