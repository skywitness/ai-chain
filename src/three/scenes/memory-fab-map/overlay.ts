/**
 * memory-fab-map overlay: two rows of filter chips (product family, status) top left, the legend
 * bottom left and a small bar panel bottom right, as real HTML inside the stage (keyboard and
 * screen-reader accessible). Colours come from CSS tokens only, so the overlay follows the theme by
 * itself. The chip rows are `[role=group]`, so poster captures hide them (the legend stays).
 * On short stages (a phone at the default 4:3 height, `setCompact`) the legend keeps only its form
 * key and the bar panel opens from a 產能加總 toggle, so the map is not buried under the overlay.
 * Stacking: z-index 3 (above the host label layer, below the host card). Removed on dispose.
 */
import { FAMILY_INFO, FAMILY_ORDER, type Family, type StatusFilter } from './data';

export type ProductFilter = Family | 'all';

const CSS = `
.mf-ui{position:absolute;inset:0;z-index:3;pointer-events:none;font-family:var(--font-sans,system-ui,sans-serif);color:var(--scene-fg)}
.mf-bars{position:absolute;top:10px;left:10px;display:grid;gap:6px;max-width:calc(100% - 20px)}
.mf-badge .mf-bars{max-width:calc(100% - 7rem)}
.mf-filter{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;border:0}
.mf-chip{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:3px 11px 4px;border-radius:999px;border:1px solid color-mix(in srgb,var(--scene-fg) 20%,transparent);background:color-mix(in srgb,var(--scene-bg) 82%,transparent);color:var(--scene-fg);font:inherit;font-size:12.5px;line-height:1.2;cursor:pointer;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);transition:background-color .15s ease,color .15s ease,border-color .15s ease}
.mf-chip:hover{border-color:color-mix(in srgb,var(--scene-fg) 45%,transparent)}
.mf-chip[aria-pressed=true]{background:var(--scene-fg);color:var(--scene-bg);border-color:var(--scene-fg)}
.mf-chip:focus-visible{outline:2px solid var(--c-focus,var(--scene-highlight));outline-offset:2px}
.mf-chip svg{width:9px;height:13px;flex:none}
.mf-dot{width:10px;height:10px;border-radius:3px;flex:none;box-shadow:0 0 0 1px color-mix(in srgb,var(--scene-bg) 55%,transparent)}
.mf-n{opacity:.62;font-variant-numeric:tabular-nums}
.mf-legend{position:absolute;left:10px;bottom:10px;display:grid;gap:3px;margin:0;padding:7px 11px 8px;border-radius:12px;background:color-mix(in srgb,var(--scene-bg) 84%,transparent);border:1px solid color-mix(in srgb,var(--scene-fg) 12%,transparent);font-size:12px;line-height:1.4;max-width:min(27rem,calc(100% - 20px));-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.mf-row{display:flex;flex-wrap:wrap;gap:2px 12px;align-items:center}
.mf-key{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.mf-key svg{width:10px;height:14px;flex:none;color:var(--scene-fg)}
.mf-sub{color:var(--c-fg-muted,var(--scene-muted))}
.mf-fam{display:none}
.mf-fam .mf-dot{width:9px;height:9px}
:root[data-poster] .mf-fam{display:flex}
.mf-extra:empty{display:none}
.mf-extra b{font-weight:600;color:var(--scene-fg)}
.mf-panel{position:absolute;right:10px;bottom:10px;width:min(17rem,calc(50% - 16px));margin:0;padding:8px 12px 9px;border-radius:12px;background:color-mix(in srgb,var(--scene-bg) 86%,transparent);border:1px solid color-mix(in srgb,var(--scene-fg) 12%,transparent);font-size:12px;line-height:1.35;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.mf-panel[hidden]{display:none}
.mf-panel-title{font-weight:600;margin:0 0 5px}
.mf-unit{white-space:nowrap;font-weight:400}
.mf-list{display:grid;grid-template-columns:minmax(0,max-content) minmax(1.75rem,1fr) auto;gap:4px 8px;align-items:center;margin:0;padding:0;list-style:none}
.mf-lab{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mf-list li{display:contents}
.mf-track{height:8px;border-radius:4px;background:color-mix(in srgb,var(--scene-fg) 10%,transparent);overflow:hidden}
.mf-bar{display:block;height:100%;border-radius:4px;background:var(--c-accent,var(--scene-flow));transform-origin:left center;transition:transform .7s cubic-bezier(.2,.7,.2,1)}
.mf-bar--partial{border-radius:4px 0 0 4px;-webkit-mask-image:linear-gradient(90deg,#000 62%,transparent);mask-image:linear-gradient(90deg,#000 62%,transparent)}
.mf-val{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.mf-note{margin:5px 0 0;color:var(--c-fg-muted,var(--scene-muted));font-size:11px}
@media (prefers-reduced-motion: reduce){.mf-bar{transition:none}}
:root[data-motion=reduce] .mf-bar{transition:none}
@container scene (max-width: 40rem){
  .mf-bars{gap:4px;top:8px;left:8px;max-width:calc(100% - 16px)}
  .mf-badge .mf-bars{max-width:calc(100% - 6rem)}
  .mf-filter{gap:4px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding-bottom:1px}
  .mf-filter::-webkit-scrollbar{display:none}
  .mf-chip{flex:none;font-size:11px;min-height:26px;padding:2px 8px 3px;gap:4px}
  .mf-dot{width:8px;height:8px;border-radius:2px}
  .mf-n{display:none}
  .mf-legend{left:8px;bottom:8px;font-size:10.5px;padding:5px 8px 6px;gap:2px;max-width:calc(48% - 8px)}
  .mf-row{gap:1px 8px}
  .mf-key{gap:3px}
  .mf-key svg{width:8px;height:12px}
  .mf-hide-narrow{display:none}
  .mf-panel{right:8px;bottom:8px;font-size:10.5px;padding:5px 8px 6px;width:calc(52% - 12px)}
  .mf-list{gap:3px 6px}
  .mf-track{height:6px}
  .mf-panel-title{margin-bottom:3px}
  .mf-note{display:none}
}
/* Short stages (a phone at the default 4:3 height): the legend keeps its form key only, and the bar
   panel opens from a 產能加總 toggle instead of covering half the map. */
.mf-toggle{display:none;position:absolute;right:8px;bottom:8px}
.mf-compact .mf-toggle{display:inline-flex}
.mf-compact .mf-toggle[hidden]{display:none}
.mf-toggle[aria-expanded=true]{background:var(--scene-fg);color:var(--scene-bg);border-color:var(--scene-fg)}
.mf-compact .mf-legend{max-width:calc(100% - 8.5rem)}
.mf-compact .mf-legend .mf-sub{display:none}
.mf-compact .mf-panel{display:none;bottom:42px}
.mf-compact.mf-open .mf-panel:not([hidden]){display:block}
`;

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(viewBox: string, parts: readonly Record<string, string>[], tag: (i: number) => string): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  parts.forEach((attrs, i) => {
    const e = document.createElementNS(SVG_NS, tag(i));
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    s.appendChild(e);
  });
  return s;
}

export type StatusKey = 'operating' | 'expanding' | 'ghost' | 'delayed';
/** Status icon: a small column drawn the way the 3D column looks (form, not colour). */
export function statusIcon(k: StatusKey): SVGSVGElement {
  const solid = { fill: 'currentColor' };
  const ghost = { fill: 'currentColor', 'fill-opacity': '0.18', stroke: 'currentColor', 'stroke-width': '1', 'stroke-dasharray': '2 1.4' };
  if (k === 'operating') return svg('0 0 10 14', [{ x: '1.5', y: '1', width: '7', height: '12', rx: '1.2', ...solid }], () => 'rect');
  if (k === 'expanding')
    return svg(
      '0 0 10 14',
      [
        { x: '1.5', y: '1', width: '7', height: '5', rx: '1.2', fill: 'currentColor', 'fill-opacity': '0.3', stroke: 'currentColor', 'stroke-width': '0.8' },
        { x: '1.5', y: '6', width: '7', height: '7', rx: '1.2', ...solid },
      ],
      () => 'rect',
    );
  if (k === 'ghost') return svg('0 0 10 14', [{ x: '1.5', y: '1', width: '7', height: '12', rx: '1.2', ...ghost }], () => 'rect');
  return svg(
    '0 0 10 14',
    [
      { x: '2.5', y: '1', width: '5', height: '9', rx: '1', ...ghost },
      { cx: '5', cy: '11.6', rx: '4.4', ry: '1.8', fill: 'none', style: 'stroke:var(--c-neg)', 'stroke-width': '1.2', 'stroke-dasharray': '1.6 1.1' },
    ],
    (i) => (i === 0 ? 'rect' : 'ellipse'),
  );
}

export interface BarPanel {
  title: string;
  /** Unit note after the title (「（千片/月，示意）」), kept on one line. */
  unit?: string;
  /** `color`: CSS custom property name (without --) for the bar; default --c-accent. */
  /** `partial`: the value is a lower bound (some sites unpublished); the bar fades out at its end. */
  rows: readonly { label: string; value: number; text: string; color?: string; partial?: boolean }[];
  note: string;
}

export interface Overlay {
  setProduct(f: ProductFilter): void;
  setStatus(f: StatusFilter): void;
  setCounts(product: Readonly<Record<ProductFilter, number>>, status: Readonly<Record<StatusFilter, number>>): void;
  /** Step-specific legend line (plain text segments; `strong` ones are emphasised). */
  setExtra(parts: readonly (string | { strong: string })[]): void;
  /** Bar panel (bottom right); `null` hides it. */
  setPanel(panel: BarPanel | null): void;
  /**
   * Short stages: a one-row legend, and the panel behind a 產能加總 toggle (closed by default).
   * `on.layout` runs after the reader opens or closes it (the scene re-measures the overlay).
   */
  setCompact(on: boolean): void;
  /** Stage-px rectangles of the chip rows, the legend and the panel (labels keep out of them). */
  rects(): { x0: number; y0: number; x1: number; y1: number }[];
  destroy(): void;
}

let panelSeq = 0;

const STATUS_CHIPS: readonly { f: StatusFilter; label: string; icon: StatusKey | null }[] = [
  { f: 'all', label: '全部狀態', icon: null },
  { f: 'existing', label: '現有產能', icon: 'operating' },
  { f: 'growth', label: '擴產與新建', icon: 'expanding' },
];

export function createOverlay(
  stage: HTMLElement,
  on: { product(f: ProductFilter): void; status(f: StatusFilter): void; layout?(): void },
  signal: AbortSignal,
  /** the host shows its 「示意資料」 badge top right: keep the chips clear of it */
  badge: boolean,
): Overlay {
  const style = document.createElement('style');
  style.textContent = CSS;
  const ui = document.createElement('div');
  ui.className = badge ? 'mf-ui mf-badge' : 'mf-ui';
  const bars = document.createElement('div');
  bars.className = 'mf-bars';

  const makeGroup = (label: string) => {
    const g = document.createElement('div');
    g.className = 'mf-filter';
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    bars.appendChild(g);
    return g;
  };
  const chip = (g: HTMLElement, label: string, lead: Element | null, onClick: () => void) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mf-chip';
    btn.setAttribute('aria-pressed', 'false');
    if (lead) btn.appendChild(lead);
    btn.appendChild(document.createTextNode(label));
    const n = document.createElement('span');
    n.className = 'mf-n';
    btn.appendChild(n);
    btn.addEventListener('click', onClick, { signal });
    g.appendChild(btn);
    return { btn, n, label };
  };

  const pg = makeGroup('依產品篩選廠區');
  const productChips = new Map<ProductFilter, ReturnType<typeof chip>>();
  productChips.set('all', chip(pg, '全部產品', null, () => on.product('all')));
  for (const f of FAMILY_ORDER) {
    const dot = document.createElement('span');
    dot.className = 'mf-dot';
    dot.style.background = `var(--${FAMILY_INFO[f].token})`;
    productChips.set(f, chip(pg, FAMILY_INFO[f].chip, dot, () => on.product(f)));
  }
  const sg = makeGroup('依狀態篩選廠區');
  const statusChips = new Map<StatusFilter, ReturnType<typeof chip>>();
  for (const s of STATUS_CHIPS) statusChips.set(s.f, chip(sg, s.label, s.icon ? statusIcon(s.icon) : null, () => on.status(s.f)));

  // Legend: the four column forms, the encoding, and a step-specific line. The product colours live
  // on the chips; poster captures hide the chips, so a colour row shows there instead.
  const legend = document.createElement('div');
  legend.className = 'mf-legend';
  const r0 = document.createElement('div');
  r0.className = 'mf-row mf-fam';
  r0.setAttribute('aria-hidden', 'true');
  for (const f of FAMILY_ORDER) {
    const k = document.createElement('span');
    k.className = 'mf-key';
    const dot = document.createElement('span');
    dot.className = 'mf-dot';
    dot.style.background = `var(--${FAMILY_INFO[f].token})`;
    k.append(dot, document.createTextNode(FAMILY_INFO[f].chip));
    r0.appendChild(k);
  }
  const r1 = document.createElement('div');
  r1.className = 'mf-row';
  const keys: readonly [StatusKey, string][] = [
    ['operating', '營運中'],
    ['expanding', '擴產中'],
    ['ghost', '興建・規劃中'],
    ['delayed', '延後'],
  ];
  for (const [k, label] of keys) {
    const s = document.createElement('span');
    s.className = 'mf-key';
    s.append(statusIcon(k), document.createTextNode(label));
    r1.appendChild(s);
  }
  const r2 = document.createElement('div');
  r2.className = 'mf-row mf-sub';
  const a = document.createElement('span');
  a.textContent = '柱高＝月產能（千片/月）';
  const b = document.createElement('span');
  b.className = 'mf-hide-narrow';
  b.textContent = '顏色＝產品';
  r2.append(a, b);
  const r3 = document.createElement('div');
  r3.className = 'mf-row mf-sub mf-extra';
  legend.append(r0, r1, r2, r3);

  // Bar panel.
  const panel = document.createElement('div');
  panel.className = 'mf-panel';
  panel.hidden = true;
  const pTitle = document.createElement('p');
  pTitle.className = 'mf-panel-title';
  const list = document.createElement('ul');
  list.className = 'mf-list';
  const pNote = document.createElement('p');
  pNote.className = 'mf-note';
  panel.append(pTitle, list, pNote);
  panel.id = `mf-panel-${++panelSeq}`;

  // Compact mode: the panel opens from this toggle (bottom right).
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'mf-chip mf-toggle';
  toggle.textContent = '產能加總';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panel.id);
  toggle.hidden = true;
  toggle.addEventListener(
    'click',
    () => {
      const open = !ui.classList.contains('mf-open');
      ui.classList.toggle('mf-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      on.layout?.();
    },
    { signal },
  );

  // Its own (unpositioned) wrapper: poster captures hide any element whose direct child is a
  // button, which must be this box and not the whole overlay.
  const toggleBox = document.createElement('div');
  toggleBox.className = 'mf-togglebox';
  toggleBox.appendChild(toggle);

  ui.append(bars, legend, panel, toggleBox);
  stage.append(style, ui);

  const press = <K>(chips: Map<K, { btn: HTMLButtonElement }>, f: K, row: HTMLElement) => {
    for (const [k, c] of chips) c.btn.setAttribute('aria-pressed', String(k === f));
    // Narrow stages scroll the chip row sideways: keep the pressed chip in view (horizontally only).
    const btn = chips.get(f)?.btn;
    if (btn && row.scrollWidth > row.clientWidth + 1) {
      const x = btn.offsetLeft - row.offsetLeft;
      if (x < row.scrollLeft) row.scrollLeft = Math.max(0, x - 6);
      else if (x + btn.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = x + btn.offsetWidth - row.clientWidth + 6;
    }
  };

  return {
    setProduct: (f) => press(productChips, f, pg),
    setStatus: (f) => press(statusChips, f, sg),
    setCounts(product, status) {
      for (const [k, c] of productChips) {
        const n = product[k] ?? 0;
        c.n.textContent = String(n);
        c.btn.hidden = k !== 'all' && n === 0;
        c.btn.setAttribute('aria-label', `${c.label}（${n} 座廠區）`);
      }
      for (const [k, c] of statusChips) {
        const n = status[k] ?? 0;
        c.n.textContent = String(n);
        c.btn.setAttribute('aria-label', `${c.label}（${n} 座廠區）`);
      }
    },
    setExtra(parts) {
      r3.textContent = '';
      if (!parts.length) return;
      const line = document.createElement('span');
      for (const p of parts) {
        if (typeof p === 'string') line.appendChild(document.createTextNode(p));
        else {
          const el = document.createElement('b');
          el.textContent = p.strong;
          line.appendChild(el);
        }
      }
      r3.appendChild(line);
    },
    setPanel(p) {
      panel.hidden = !p?.rows.length;
      toggle.hidden = panel.hidden;
      if (!p?.rows.length) return;
      pTitle.textContent = p.title;
      if (p.unit) {
        const u = document.createElement('span');
        u.className = 'mf-unit';
        u.textContent = p.unit;
        pTitle.appendChild(u);
      }
      pNote.textContent = p.note;
      list.textContent = '';
      const max = Math.max(...p.rows.map((r) => r.value), 1);
      const fills: HTMLElement[] = [];
      for (const r of p.rows) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'mf-lab';
        name.textContent = r.label;
        const track = document.createElement('span');
        track.className = 'mf-track';
        const bar = document.createElement('span');
        bar.className = 'mf-bar';
        bar.style.transform = 'scaleX(0)';
        if (r.color) bar.style.background = `var(--${r.color})`;
        if (r.partial) bar.classList.add('mf-bar--partial');
        bar.dataset['k'] = String(r.value / max);
        track.appendChild(bar);
        const val = document.createElement('span');
        val.className = 'mf-val';
        val.textContent = r.text;
        li.append(name, track, val);
        list.appendChild(li);
        fills.push(bar);
      }
      // Next frame: grow the bars (CSS transition; instant under reduced motion).
      requestAnimationFrame(() => fills.forEach((el) => (el.style.transform = `scaleX(${el.dataset['k']})`)));
    },
    setCompact(compact) {
      if (ui.classList.contains('mf-compact') === compact) return;
      ui.classList.toggle('mf-compact', compact);
      ui.classList.remove('mf-open');
      toggle.setAttribute('aria-expanded', 'false');
    },
    rects() {
      const s = stage.getBoundingClientRect();
      const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
      for (const el of [pg, sg, legend, panel, toggle]) {
        if (el.hidden || !el.isConnected) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        // a chip row is only as wide as its chips
        let x1 = r.right;
        if (el === pg || el === sg) {
          const last = el.lastElementChild?.getBoundingClientRect();
          if (last) x1 = Math.min(r.right, last.right);
        }
        out.push({ x0: r.left - s.left, y0: r.top - s.top, x1: x1 - s.left, y1: r.bottom - s.top });
      }
      return out;
    },
    destroy() {
      ui.remove();
      style.remove();
    },
  };
}
