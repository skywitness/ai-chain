/**
 * scripts/fetch-fx.ts — build src/data/fx/usd-rates.json (period-average FX rates vs USD).
 *
 *   npx tsx scripts/fetch-fx.ts                       # 2021-01 … last complete month
 *   npx tsx scripts/fetch-fx.ts --from 2021-01 --to 2026-09
 *
 * Sources (no API key needed):
 *   1. FRED / Federal Reserve Board H.10 daily noon buying rates in New York
 *      https://fred.stlouisfed.org/graph/fredgraph.csv?id=<SERIES>
 *      DEXUSEU, DEXUSUK and DEXUSAL are quoted as USD per unit, so each daily value is
 *      inverted to "units per USD" BEFORE averaging (every currency is averaged in the
 *      same direction).
 *   2. ECB euro reference rates (data-api.ecb.europa.eu), as cross rates through EUR:
 *      units per USD = (units per EUR) / (USD per EUR), same ECB fixing date.
 *      Used for ILS (not in H.10) and as an automatic fallback when a FRED series fails.
 *   3. Official pegs (SAR 3.75 — Saudi Central Bank; AED 3.6725 — Central Bank of the UAE).
 *
 * Averages are arithmetic means of the daily observations inside each calendar month,
 * calendar quarter and calendar year (quarter/year means use the daily data, not the mean
 * of monthly means). Days without an observation (holidays, ".") are skipped.
 * The current calendar year is flagged `partial` when it is not complete.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Code =
  | 'TWD' | 'JPY' | 'KRW' | 'EUR' | 'CNY' | 'HKD' | 'GBP' | 'CHF' | 'CAD' | 'SEK'
  | 'DKK' | 'NOK' | 'ILS' | 'INR' | 'SGD' | 'AUD' | 'SAR' | 'AED' | 'BRL';

interface Plan {
  code: Code;
  nameZh: string;
  fred?: { series: string; inverted: boolean };
  ecb?: boolean; // currency is published as an ECB reference rate
  peg?: { rate: number; authority: string; url: string; since: string };
}

const PLANS: Plan[] = [
  { code: 'TWD', nameZh: '新台幣', fred: { series: 'DEXTAUS', inverted: false } },
  { code: 'JPY', nameZh: '日圓', fred: { series: 'DEXJPUS', inverted: false }, ecb: true },
  { code: 'KRW', nameZh: '韓元', fred: { series: 'DEXKOUS', inverted: false }, ecb: true },
  { code: 'EUR', nameZh: '歐元', fred: { series: 'DEXUSEU', inverted: true }, ecb: true },
  { code: 'CNY', nameZh: '人民幣', fred: { series: 'DEXCHUS', inverted: false }, ecb: true },
  { code: 'HKD', nameZh: '港幣', fred: { series: 'DEXHKUS', inverted: false }, ecb: true },
  { code: 'GBP', nameZh: '英鎊', fred: { series: 'DEXUSUK', inverted: true }, ecb: true },
  { code: 'CHF', nameZh: '瑞士法郎', fred: { series: 'DEXSZUS', inverted: false }, ecb: true },
  { code: 'CAD', nameZh: '加幣', fred: { series: 'DEXCAUS', inverted: false }, ecb: true },
  { code: 'SEK', nameZh: '瑞典克朗', fred: { series: 'DEXSDUS', inverted: false }, ecb: true },
  { code: 'DKK', nameZh: '丹麥克朗', fred: { series: 'DEXDNUS', inverted: false }, ecb: true },
  { code: 'NOK', nameZh: '挪威克朗', fred: { series: 'DEXNOUS', inverted: false }, ecb: true },
  { code: 'ILS', nameZh: '新謝克爾', ecb: true },
  { code: 'INR', nameZh: '印度盧比', fred: { series: 'DEXINUS', inverted: false }, ecb: true },
  { code: 'SGD', nameZh: '新加坡幣', fred: { series: 'DEXSIUS', inverted: false }, ecb: true },
  { code: 'AUD', nameZh: '澳幣', fred: { series: 'DEXUSAL', inverted: true }, ecb: true },
  {
    code: 'SAR', nameZh: '沙烏地里亞爾',
    peg: { rate: 3.75, authority: 'Saudi Central Bank (SAMA)', url: 'https://www.sama.gov.sa/en-US/About/Pages/SAMAFunctions.aspx', since: '1986-06' },
  },
  {
    code: 'AED', nameZh: '阿聯迪拉姆',
    peg: { rate: 3.6725, authority: 'Central Bank of the UAE (CBUAE)', url: 'https://www.centralbank.ae/en/our-operations/currency-and-coins/', since: '1997-11' },
  },
  { code: 'BRL', nameZh: '巴西雷亞爾', fred: { series: 'DEXBZUS', inverted: false }, ecb: true },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 ai-chain-atlas-fx/1.0';

// ───────────────────────── args ─────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const today = new Date();
const todayIso = today.toISOString().slice(0, 10);
const lastComplete = (() => {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();
const FROM = arg('from') ?? '2021-01';
const TO = arg('to') ?? lastComplete;
if (!/^\d{4}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}$/.test(TO) || FROM > TO) {
  console.error(`invalid range --from ${FROM} --to ${TO}`);
  process.exit(2);
}
const startDate = `${FROM}-01`;
const endDate = (() => {
  const [y, m] = TO.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of TO
})();

// ───────────────────────── fetch helpers ─────────────────────────
async function getText(url: string, tries = 4): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/csv,text/plain,*/*' },
        signal: AbortSignal.timeout(45_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      if (!t.trim()) throw new Error('empty body');
      return t;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
  throw new Error(`GET ${url} failed: ${(lastErr as Error)?.message ?? lastErr}`);
}

type Daily = Map<string, number>; // ISO date -> units per USD

async function fred(series: string, inverted: boolean): Promise<Daily> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${startDate}&coed=${endDate}`;
  const text = await getText(url);
  const out: Daily = new Map();
  const lines = text.trim().split(/\r?\n/);
  if (!/^observation_date|^DATE/i.test(lines[0] ?? '')) throw new Error(`${series}: unexpected CSV header ${lines[0]}`);
  for (const line of lines.slice(1)) {
    const [d, v] = line.split(',');
    if (!d || !v || v === '.' || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    out.set(d, inverted ? 1 / n : n);
  }
  return out;
}

const ecbCache = new Map<string, Promise<Map<string, number>>>();
function ecbRaw(code: string): Promise<Map<string, number>> {
  // units of `code` per 1 EUR
  if (!ecbCache.has(code)) {
    ecbCache.set(
      code,
      (async () => {
        const url = `https://data-api.ecb.europa.eu/service/data/EXR/D.${code}.EUR.SP00.A?startPeriod=${startDate}&endPeriod=${endDate}&format=csvdata`;
        const text = await getText(url);
        const lines = text.trim().split(/\r?\n/);
        const head = (lines[0] ?? '').split(',');
        const iT = head.indexOf('TIME_PERIOD');
        const iV = head.indexOf('OBS_VALUE');
        if (iT < 0 || iV < 0) throw new Error(`ECB ${code}: unexpected header`);
        const m = new Map<string, number>();
        for (const line of lines.slice(1)) {
          const cells = line.split(',');
          const d = cells[iT];
          const n = Number(cells[iV]);
          if (d && Number.isFinite(n) && n > 0) m.set(d, n);
        }
        return m;
      })(),
    );
  }
  return ecbCache.get(code)!;
}

async function ecbCross(code: string): Promise<Daily> {
  const [perEur, usdPerEur] = await Promise.all([ecbRaw(code), ecbRaw('USD')]);
  const out: Daily = new Map();
  if (code === 'EUR') {
    for (const [d, u] of usdPerEur) out.set(d, 1 / u);
    return out;
  }
  for (const [d, v] of perEur) {
    const u = usdPerEur.get(d);
    if (u) out.set(d, v / u);
  }
  return out;
}

// ───────────────────────── averaging ─────────────────────────
const sig = (n: number) => Number(n.toPrecision(6));

function monthsInRange(): string[] {
  const out: string[] = [];
  let [y, m] = FROM.split('-').map(Number) as [number, number];
  const [ty, tm] = TO.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

interface Averages {
  monthly: Record<string, number>;
  quarterly: Record<string, number>;
  annual: Record<string, number>;
  observations: number;
  firstObservation: string | null;
  lastObservation: string | null;
}

function average(daily: Daily): Averages {
  const buckets = { m: new Map<string, number[]>(), q: new Map<string, number[]>(), y: new Map<string, number[]>() };
  const push = (map: Map<string, number[]>, k: string, v: number) => {
    const a = map.get(k);
    if (a) a.push(v);
    else map.set(k, [v]);
  };
  const dates = [...daily.keys()].filter((d) => d >= startDate && d <= endDate).sort();
  for (const d of dates) {
    const v = daily.get(d)!;
    const ym = d.slice(0, 7);
    const y = d.slice(0, 4);
    const q = Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1;
    push(buckets.m, ym, v);
    push(buckets.q, `${y}-Q${q}`, v);
    push(buckets.y, y, v);
  }
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const toObj = (map: Map<string, number[]>) =>
    Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, a]) => [k, sig(mean(a))]));
  return {
    monthly: toObj(buckets.m),
    quarterly: toObj(buckets.q),
    annual: toObj(buckets.y),
    observations: dates.length,
    firstObservation: dates[0] ?? null,
    lastObservation: dates.at(-1) ?? null,
  };
}

function pegAverages(rate: number): Averages {
  const monthly: Record<string, number> = {};
  const quarterly: Record<string, number> = {};
  const annual: Record<string, number> = {};
  for (const ym of monthsInRange()) {
    monthly[ym] = rate;
    const y = ym.slice(0, 4);
    quarterly[`${y}-Q${Math.floor((Number(ym.slice(5)) - 1) / 3) + 1}`] = rate;
    annual[y] = rate;
  }
  return { monthly, quarterly, annual, observations: 0, firstObservation: null, lastObservation: null };
}

// ───────────────────────── main ─────────────────────────
interface SourceRecord {
  provider: string;
  series: string;
  url: string;
  method: string;
  inverted: boolean;
  accessed: string;
  fallbackFrom?: string;
  note?: string;
}

async function build(plan: Plan): Promise<{ source: SourceRecord; avg: Averages }> {
  if (plan.peg) {
    return {
      source: {
        provider: plan.peg.authority,
        series: `official peg ${plan.peg.rate} ${plan.code}/USD (since ${plan.peg.since})`,
        url: plan.peg.url,
        method: 'fixed official peg applied to every period',
        inverted: false,
        accessed: todayIso,
        note: '官方聯繫匯率（固定匯率），各期間以同一匯率換算。',
      },
      avg: pegAverages(plan.peg.rate),
    };
  }
  let fredError: string | undefined;
  if (plan.fred) {
    try {
      const daily = await fred(plan.fred.series, plan.fred.inverted);
      if (daily.size < 50) throw new Error(`only ${daily.size} observations`);
      return {
        source: {
          provider: 'FRED, Federal Reserve Bank of St. Louis (Board of Governors H.10)',
          series: plan.fred.series,
          url: `https://fred.stlouisfed.org/series/${plan.fred.series}`,
          method: plan.fred.inverted
            ? 'daily noon buying rates (USD per unit) inverted per day, then averaged'
            : 'mean of daily noon buying rates (units per USD)',
          inverted: plan.fred.inverted,
          accessed: todayIso,
        },
        avg: average(daily),
      };
    } catch (e) {
      fredError = (e as Error).message;
      console.warn(`  ! FRED ${plan.fred.series} unavailable (${fredError}); falling back to ECB`);
    }
  }
  if (plan.ecb) {
    const daily = await ecbCross(plan.code);
    if (daily.size < 50) throw new Error(`${plan.code}: ECB returned only ${daily.size} observations`);
    return {
      source: {
        provider: 'European Central Bank euro foreign exchange reference rates',
        series: plan.code === 'EUR' ? 'EXR.D.USD.EUR.SP00.A' : `EXR.D.${plan.code}.EUR.SP00.A ÷ EXR.D.USD.EUR.SP00.A`,
        url: `https://data.ecb.europa.eu/data/datasets/EXR/EXR.D.${plan.code === 'EUR' ? 'USD' : plan.code}.EUR.SP00.A`,
        method: 'daily cross rate through EUR on the same ECB fixing date, then averaged',
        inverted: plan.code === 'EUR',
        accessed: todayIso,
        ...(plan.fred ? { fallbackFrom: `FRED ${plan.fred.series}: ${fredError ?? 'unavailable'}` } : {}),
      },
      avg: average(daily),
    };
  }
  throw new Error(`${plan.code}: no available source (${fredError ?? 'no plan'})`);
}

async function main() {
  console.log(`FX ${FROM} … ${TO} (${startDate} … ${endDate})`);
  const results: Record<string, unknown> = {};
  const problems: string[] = [];
  // modest concurrency: FRED rate-limits bursts
  const queue = [...PLANS];
  const workers = Array.from({ length: 3 }, async () => {
    for (;;) {
      const plan = queue.shift();
      if (!plan) return;
      try {
        const { source, avg } = await build(plan);
        const months = monthsInRange();
        const missing = months.filter((m) => !(m in avg.monthly));
        if (missing.length) problems.push(`${plan.code}: missing months ${missing.join(', ')}`);
        const toYear = TO.slice(0, 4);
        const partial = TO.endsWith('-12') ? [] : [toYear];
        results[plan.code] = {
          nameZh: plan.nameZh,
          source,
          observations: avg.observations,
          firstObservation: avg.firstObservation,
          lastObservation: avg.lastObservation,
          partial,
          monthly: avg.monthly,
          quarterly: avg.quarterly,
          annual: avg.annual,
        };
        console.log(`  ✓ ${plan.code} ${source.series} (${avg.observations} obs)`);
      } catch (e) {
        problems.push(`${plan.code}: ${(e as Error).message}`);
        console.error(`  ✗ ${plan.code}: ${(e as Error).message}`);
      }
    }
  });
  await Promise.all(workers);

  const ordered = Object.fromEntries(PLANS.filter((p) => p.code in results).map((p) => [p.code, results[p.code]]));
  const out = {
    $comment:
      'Generated by scripts/fetch-fx.ts — do not edit by hand. Rates are units of the currency per 1 USD, period averages of daily rates. Re-run: npx tsx scripts/fetch-fx.ts',
    base: 'USD',
    quote: 'units per 1 USD',
    generated: todayIso,
    coverage: { from: FROM, to: TO },
    method:
      'Arithmetic mean of daily observations within each calendar month, quarter and year. Series quoted as USD per unit (EUR, GBP, AUD) are inverted per day before averaging. A year listed in `partial` covers only the months up to coverage.to.',
    currencies: ordered,
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, '../src/data/fx/usd-rates.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 1) + '\n', 'utf8');
  console.log(`wrote ${file}`);
  if (problems.length) {
    console.error('Problems:\n  ' + problems.join('\n  '));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
