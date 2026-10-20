// Shared, dependency-free renderer for the /models/compare/ table. Used at build time (the no-JS
// preset comparison, through set:html) and in the browser by src/client/compare.ts, so both
// produce identical markup. All display strings are prepared at build time (compare-data.ts);
// this module only arranges and escapes them. Owner: pages-models.

export interface CompareBenchScore {
  /** formatted score, e.g. 「96.1%」 */
  text: string;
  score: number;
  date: string;
  reporter: string;
  setting?: string | undefined;
}

export interface CompareVersion {
  /** unique key used in ?m= (the version id; `family.version` when ids collide) */
  key: string;
  id: string;
  name: string;
  familyId: string;
  familyTitle: string;
  href: string;
  lab: string;
  origin: string;
  kind: string;
  released: string;
  status: string;
  tier: string;
  weights: string;
  open: boolean;
  license: string;
  arch: string;
  params: string;
  modIn: string;
  modOut: string;
  context: string;
  maxOut: string;
  cutoff: string;
  reasoning: string;
  availability: string;
  price?: { input: string; output: string; cached: string; asOf: string; note?: string | undefined } | undefined;
  bench: Record<string, CompareBenchScore>;
  flagship: boolean;
}

export interface CompareBench {
  id: string;
  zh: string;
  scale: string;
  higherIsBetter: boolean;
}

export interface CompareData {
  versions: CompareVersion[];
  benches: CompareBench[];
  defaults: string[];
  /** family id → top strengths (family level, shared by its versions) */
  strengths: Record<string, string[]>;
  /** href of the family pages is already based; base for the compare page links */
  compareHref: string;
}

export const WARN_DAYS = 90;
export const MAX_SELECTED = 4;
export const MIN_SELECTED = 2;

/** ⚠ as an inline SVG (same drawing as the site's `warn` icon) */
export const WARN_SVG =
  '<svg class="cmp__ico" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3.5 2.8 19.5h18.4L12 3.5Z"/><path d="M12 10v4.5M12 17.3v.2"/></svg>';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]!);
}

function dayNum(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}
export function spreadDays(dates: Array<string | undefined>): number {
  const ds = dates.filter((d): d is string => !!d).map(dayNum);
  return ds.length < 2 ? 0 : Math.max(...ds) - Math.min(...ds);
}

/** Resolve ?m= tokens: a key, a plain version id, or a family id (→ its flagship). Max 4, unique. */
export function resolveSelection(tokens: readonly string[], versions: readonly CompareVersion[]): CompareVersion[] {
  const out: CompareVersion[] = [];
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    const v =
      versions.find((x) => x.key === t) ??
      versions.find((x) => x.id === t) ??
      versions.find((x) => x.familyId === t && x.flagship);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_SELECTED) break;
  }
  return out;
}

interface Row {
  label: string;
  sub?: string | undefined;
  cells: string[];
  warn?: string | undefined;
}

function rowHtml(r: Row, sel: CompareVersion[]): string {
  const warn = r.warn
    ? `<span class="cmp__warn" title="${esc(r.warn)}">${WARN_SVG}<span class="sr-only">注意：${esc(r.warn)}</span></span>`
    : '';
  const head = `<th scope="row" class="cmp__rh">${esc(r.label)}${warn}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</th>`;
  const cells = r.cells
    .map((c, i) => `<td data-label="${esc(sel[i]?.name ?? '')}"><div class="cmp__c">${c || '<span class="cmp__na">—</span>'}</div></td>`)
    .join('');
  return `<tr${r.warn ? ' class="has-warn"' : ''}>${head}${cells}</tr>`;
}

function group(title: string, rows: Row[], sel: CompareVersion[]): string {
  if (rows.length === 0) return '';
  return `<tbody class="cmp__group"><tr class="cmp__gh"><th scope="colgroup" colspan="${sel.length + 1}">${esc(title)}</th></tr>${rows
    .map((r) => rowHtml(r, sel))
    .join('')}</tbody>`;
}

const sub = (main: string, small?: string) => `${esc(main)}${small ? `<small>${esc(small)}</small>` : ''}`;

/** The full comparison table (HTML string) for 1–4 selected versions. */
export function renderCompareTable(
  sel: CompareVersion[],
  benches: readonly CompareBench[],
  strengthsByFamily: Readonly<Record<string, string[]>> = {},
): string {
  if (sel.length === 0) {
    return '<p class="cmp__empty">請至少選擇兩個版本來比較。</p>';
  }
  const warnings: string[] = [];

  const basics: Row[] = [
    { label: '系列', cells: sel.map((v) => `<a href="${esc(v.href)}">${esc(v.familyTitle)}</a>`) },
    { label: '實驗室', cells: sel.map((v) => sub(v.lab, v.origin)) },
    { label: '類型', cells: sel.map((v) => esc(v.kind)) },
    { label: '發表日', cells: sel.map((v) => sub(v.released, v.status)) },
    { label: '定位', cells: sel.map((v) => esc(v.tier) + (v.flagship ? '<small>目前的系列旗艦</small>' : '')) },
  ];
  const specs: Row[] = [
    { label: '權重', cells: sel.map((v) => `<span class="${v.open ? 'cmp__open' : ''}">${esc(v.weights)}</span><small>${esc(v.license)}</small>`) },
    { label: '架構／參數量', cells: sel.map((v) => sub(v.arch, v.params === v.arch ? undefined : v.params)) },
    { label: '輸入模態', cells: sel.map((v) => esc(v.modIn)) },
    { label: '輸出模態', cells: sel.map((v) => esc(v.modOut)) },
    { label: '上下文', sub: 'tokens', cells: sel.map((v) => sub(v.context, v.maxOut !== '—' ? `最多輸出 ${v.maxOut}` : undefined)) },
    { label: '知識截止', cells: sel.map((v) => esc(v.cutoff)) },
    { label: '推理', cells: sel.map((v) => esc(v.reasoning)) },
    { label: '取用方式', cells: sel.map((v) => esc(v.availability)) },
  ];

  const priceSpread = spreadDays(sel.map((v) => v.price?.asOf));
  const priceWarn = priceSpread > WARN_DAYS ? `定價日期相差 ${priceSpread} 天` : undefined;
  if (priceWarn) warnings.push(`價格：${priceWarn}`);
  const anyPrice = sel.some((v) => v.price);
  const prices: Row[] = anyPrice
    ? [
        { label: '輸入', sub: '美元／每百萬 tokens', cells: sel.map((v) => (v.price ? `<strong>${esc(v.price.input)}</strong>` : '<span class="cmp__na">無官方 API 定價</span>')) },
        { label: '快取輸入', sub: '美元／每百萬 tokens', cells: sel.map((v) => (v.price ? esc(v.price.cached) : '')) },
        { label: '輸出', sub: '美元／每百萬 tokens', cells: sel.map((v) => (v.price ? `<strong>${esc(v.price.output)}</strong>` : '')) },
        { label: '定價日', cells: sel.map((v) => (v.price ? sub(v.price.asOf, v.price.note) : '')), warn: priceWarn },
      ]
    : [];

  const benchRows: Row[] = [];
  for (const b of benches) {
    const scores = sel.map((v) => v.bench[b.id]);
    if (scores.every((s) => !s)) continue;
    const present = scores.filter((s): s is CompareBenchScore => !!s);
    const spread = spreadDays(present.map((s) => s.date));
    const warn = spread > WARN_DAYS ? `各版本分數日期相差 ${spread} 天，可能來自不同的測試版本或設定` : undefined;
    if (warn) warnings.push(`${b.zh}：日期相差 ${spread} 天`);
    const best =
      present.length >= 2 ? (b.higherIsBetter ? Math.max(...present.map((s) => s.score)) : Math.min(...present.map((s) => s.score))) : null;
    benchRows.push({
      label: b.zh,
      sub: b.scale,
      warn,
      cells: scores.map((s) =>
        s
          ? `<span class="cmp__score${best !== null && s.score === best ? ' is-best' : ''}">${esc(s.text)}${
              best !== null && s.score === best ? '<span class="sr-only">（所選版本中最高）</span>' : ''
            }</span><small>${esc(s.date)}・${esc(s.reporter)}${s.setting ? `<br>${esc(s.setting)}` : ''}</small>`
          : '',
      ),
    });
  }

  const st = (v: CompareVersion) => strengthsByFamily[v.familyId] ?? [];
  const strengths: Row[] = sel.some((v) => st(v).length)
    ? [
        {
          label: '系列優勢',
          cells: sel.map((v) => (st(v).length ? `<ul>${st(v).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '')),
        },
      ]
    : [];

  const head = `<thead><tr><th scope="col" class="cmp__corner">項目</th>${sel
    .map(
      (v) =>
        `<th scope="col" class="cmp__vh" style="--k: var(--chart-${(sel.indexOf(v) % 8) + 1})"><a href="${esc(v.href)}">${esc(v.name)}</a><small>${esc(v.lab)}</small></th>`,
    )
    .join('')}</tr></thead>`;

  const notice = warnings.length
    ? `<p class="cmp__notice">${WARN_SVG}<span>日期相差超過 ${WARN_DAYS} 天的項目：${esc(warnings.join('；'))}。比較時請以各格標示的日期為準。</span></p>`
    : '';

  return `${notice}<div class="cmp__scroll scroll-x" role="region" aria-label="模型比較表"><table class="cmp cmp--n${sel.length}"><caption class="sr-only">模型並排比較：${esc(
    sel.map((v) => v.name).join('、'),
  )}</caption>${head}${group('基本資料', basics, sel)}${group('規格', specs, sel)}${group('API 價格', prices, sel)}${group(
    '評測分數',
    benchRows,
    sel,
  )}${group('優勢', strengths, sel)}</table></div>`;
}
