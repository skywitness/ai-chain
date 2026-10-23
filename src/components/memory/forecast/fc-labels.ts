// Labels and small formatters shared by the financial-model components (build-time only).
import { fcEps, fcMoney, fcPct, fcYi, type Candidate, type FcBundle } from '../../../lib/forecast-data';
import { formatNumber } from '../../../lib/format';

export type Target = 'revenue' | 'grossMargin' | 'operatingIncome' | 'netIncome' | 'eps';
export const TARGETS: readonly Target[] = ['revenue', 'grossMargin', 'operatingIncome', 'netIncome', 'eps'];

/** Name of a target, with the accounting basis where the model mixes them (Micron: non-GAAP margin and EPS). */
export function targetLabel(b: FcBundle, t: Target): string {
  const mu = b.company === 'micron';
  switch (t) {
    case 'revenue':
      return '營收';
    case 'grossMargin':
      return mu ? '毛利率（非 GAAP）' : '毛利率';
    case 'operatingIncome':
      return mu ? '營業利益（GAAP）' : '營業利益';
    case 'netIncome':
      return mu ? '淨利（GAAP）' : '淨利（歸屬母公司）';
    default:
      return mu ? 'EPS（非 GAAP）' : 'EPS（基本）';
  }
}
export const TARGET_SHORT: Record<Target, string> = { revenue: '營收', grossMargin: '毛利率', operatingIncome: '營業利益', netIncome: '淨利', eps: 'EPS' };

/** Value of a target in the page's display convention. */
export function fmtTarget(b: FcBundle, t: Target, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (t === 'grossMargin') return fcPct(v);
  if (t === 'eps') return fcEps(v, b.meta.epsUnit);
  return fcMoney(v, b.meta.currency);
}
/** Value without unit for tables with a unit header (億 for money); `yi` fixes the decimals of a money column. */
export function numTarget(t: Target, v: number | null | undefined, yi?: number): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (t === 'grossMargin') return formatNumber(v, { digits: 1 });
  if (t === 'eps') return formatNumber(v, { digits: 2 });
  return fcYi(v, yi);
}
/** Unit header of a target column. */
export function unitOf(b: FcBundle, t: Target): string {
  if (t === 'grossMargin') return '%';
  if (t === 'eps') return b.meta.epsUnit;
  return b.meta.currency === 'TWD' ? '新台幣億元' : '億美元';
}
/** Chart value in display units (money → 億). */
export const chartValue = (t: Target, v: number): number => (t === 'grossMargin' || t === 'eps' ? v : v / 100);

/** Error of a prediction in the target's natural unit: %-points for margins, % for the others. */
export function errText(b: FcBundle, t: Target, actual: number, predicted: number): string {
  if (t === 'grossMargin') return `${formatNumber(predicted - actual, { digits: 1, signed: true })} 個百分點`;
  if (t === 'eps') return `${formatNumber(predicted - actual, { digits: 2, signed: true })} ${b.meta.epsUnit}`;
  if (actual === 0) return '—';
  return `${formatNumber(((predicted - actual) / Math.abs(actual)) * 100, { digits: 1, signed: true })}%`;
}

/** Role of a candidate in the comparison. */
export function candidateRole(c: Candidate): { label: string; kind: 'selected' | 'candidate' | 'baseline' | 'guidance' | 'diagnostic' } {
  if (c.selected) return { label: '選定模型', kind: 'selected' };
  if (c.id === 'guidance') return { label: '公司財測（對照）', kind: 'guidance' };
  if (c.id.startsWith('naive')) return { label: '天真模型（對照組）', kind: 'baseline' };
  if (/不參與模型選擇/.test(c.note ?? '')) return { label: '診斷用（不參與選模）', kind: 'diagnostic' };
  return { label: '候選模型', kind: 'candidate' };
}

/** Labels of the metric keys in model.candidates[].metrics. */
export function metricKeyLabel(b: FcBundle, key: string): { target: Target | null; variant: string } {
  const m = /^(revenue|grossMargin|operatingIncome|netIncome|eps)(ExAnte|Dynamic|Train)?$/.exec(key);
  if (!m) return { target: null, variant: key };
  const v = m[2];
  const variant =
    v === 'ExAnte'
      ? '事前：改用季初預測價、不知當季月營收'
      : v === 'Dynamic'
        ? b.company === 'micron'
          ? `連續預測：從 ${b.model.train.to} 出發推 8 季、不用實際值重設`
          : `連續預測：從 ${b.model.train.to} 出發推 6 季、不用新財報`
        : v === 'Train'
          ? `訓練期樣本內（${b.model.train.from}–${b.model.train.to}）`
          : '逐季（每季用上一季財報與當季價格）';
  return { target: m[1] as Target, variant };
}

type M = { mape?: number | undefined; mae?: number | undefined; bias?: number | undefined; n: number };
/** Headline error of a metric: MAPE for money, MAE for margins (pp) and EPS. */
export function errHeadline(b: FcBundle, t: Target, x: M | undefined): string {
  if (!x) return '—';
  if (t === 'grossMargin') return x.mae != null ? `${formatNumber(x.mae, { digits: 1 })} 個百分點` : '—';
  if (t === 'eps') {
    const mae = x.mae != null ? `${formatNumber(x.mae, { digits: 2 })} ${b.meta.epsUnit}` : '';
    const mape = x.mape != null ? `${formatNumber(x.mape, { digits: 1 })}%` : '';
    return [mae, mape && `（${mape}）`].filter(Boolean).join('') || '—';
  }
  return x.mape != null ? `${formatNumber(x.mape, { digits: 1 })}%` : '—';
}

/**
 * Plain-text equation → text runs with sub- and superscripts, so 「營收_{t−1}」 reads as 營收 with a subscript t−1
 * and 「(1 − λ)^k」 as a power, without LaTeX: _{…}, _t, _t−1 and _k become subscripts, ^k and ^g superscripts.
 */
export type EqRun = { kind: 'text' | 'sub' | 'sup'; text: string };
export function eqRuns(s: string): EqRun[] {
  const out: EqRun[] = [];
  const re = /_\{([^}]+)\}|_(t(?:\s*[−-]\s*[0-9k]+)?|[kK]|[0-9]+|[A-Z]{2,})|\^\{([^}]+)\}|\^([A-Za-z0-9]+)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push({ kind: 'text', text: s.slice(last, m.index) });
    if (m[1] != null || m[2] != null) out.push({ kind: 'sub', text: (m[1] ?? m[2])!.replace(/\s+/g, '') });
    else out.push({ kind: 'sup', text: (m[3] ?? m[4])! });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) });
  return out;
}
