/**
 * cloud-globe overlay: the operator-type filter chips (top left) and the legend (bottom left),
 * as real HTML buttons inside the stage. Colours come from CSS tokens only, so the overlay follows
 * the theme without help from the scene. Removed on dispose.
 * Stacking: z-index 3 like the host's label layer but later in the DOM, so the overlay sits above
 * the labels and below the host card (z-index 4), which must never be covered by the bar panel.
 */
import { STATUS_INFO, STATUS_ORDER, TYPE_INFO, type CampusType, type Shape } from './data';

export type Filter = CampusType | 'all';

const CSS = `
.cg-ui{position:absolute;inset:0;z-index:3;pointer-events:none;font-family:var(--font-sans,system-ui,sans-serif);color:var(--scene-fg)}
.cg-filter{position:absolute;top:10px;left:10px;display:flex;flex-wrap:wrap;gap:6px;max-width:calc(100% - 7rem);margin:0;padding:0;border:0}
.cg-chip{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:3px 11px 4px;border-radius:999px;border:1px solid color-mix(in srgb,var(--scene-fg) 20%,transparent);background:color-mix(in srgb,var(--scene-bg) 82%,transparent);color:var(--scene-fg);font:inherit;font-size:12.5px;line-height:1.2;cursor:pointer;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);transition:background-color .15s ease,color .15s ease,border-color .15s ease}
.cg-chip:hover{border-color:color-mix(in srgb,var(--scene-fg) 45%,transparent)}
.cg-chip[aria-pressed=true]{background:var(--scene-fg);color:var(--scene-bg);border-color:var(--scene-fg)}
.cg-chip:focus-visible{outline:2px solid var(--c-focus,var(--scene-highlight));outline-offset:2px}
.cg-chip svg{width:11px;height:11px;flex:none}
.cg-n{opacity:.62;font-variant-numeric:tabular-nums}
.cg-legend{position:absolute;left:10px;bottom:10px;display:grid;gap:3px;margin:0;padding:7px 11px 8px;border-radius:12px;background:color-mix(in srgb,var(--scene-bg) 84%,transparent);border:1px solid color-mix(in srgb,var(--scene-fg) 12%,transparent);font-size:12px;line-height:1.4;max-width:min(30rem,calc(100% - 20px));-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.cg-row{display:flex;flex-wrap:wrap;gap:2px 12px;align-items:center}
.cg-key{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.cg-key svg{width:9px;height:13px;flex:none}
.cg-sub{color:var(--c-fg-muted,var(--scene-muted))}
.cg-extra:empty{display:none}
.cg-extra b{font-weight:600;color:var(--scene-fg)}
.cg-capex{position:absolute;right:10px;bottom:10px;width:min(17.5rem,calc(50% - 16px));margin:0;padding:8px 12px 9px;border-radius:12px;background:color-mix(in srgb,var(--scene-bg) 86%,transparent);border:1px solid color-mix(in srgb,var(--scene-fg) 12%,transparent);font-size:12px;line-height:1.35;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.cg-capex[hidden]{display:none}
.cg-capex-title{font-weight:600;margin:0 0 5px}
.cg-bars{display:grid;grid-template-columns:auto 1fr auto;gap:4px 8px;align-items:center;margin:0;padding:0;list-style:none}
.cg-bars li{display:contents}
.cg-track{height:8px;border-radius:4px;background:color-mix(in srgb,var(--scene-fg) 10%,transparent);overflow:hidden}
.cg-bar{display:block;height:100%;border-radius:4px;background:var(--c-accent,var(--scene-flow));transform-origin:left center;transition:transform .7s cubic-bezier(.2,.7,.2,1)}
.cg-val{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.cg-capex-note{margin:5px 0 0;color:var(--c-fg-muted,var(--scene-muted));font-size:11px}
@media (prefers-reduced-motion: reduce){.cg-bar{transition:none}}
:root[data-motion=reduce] .cg-bar{transition:none}
@container scene (max-width: 40rem){
  .cg-filter{gap:4px;top:8px;left:8px;max-width:calc(100% - 6rem)}
  .cg-chip{font-size:11.5px;min-height:28px;padding:2px 9px 3px;gap:5px}
  .cg-n{display:none}
  .cg-legend{left:8px;bottom:8px;font-size:11px;padding:5px 9px 6px}
  .cg-hide-narrow{display:none}
  .cg-legend{max-width:calc(50% - 12px)}
  .cg-capex{right:8px;bottom:8px;font-size:11px;padding:6px 9px 7px;width:calc(50% - 12px)}
  .cg-bars{gap:3px 6px}
}
@container scene (max-width: 30rem){
  .cg-filter{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;max-width:calc(100% - 16px);padding-bottom:2px}
  .cg-filter::-webkit-scrollbar{display:none}
  ai-scene[data-fixture] .cg-filter{max-width:calc(100% - 6rem)}
  .cg-chip{flex:none;font-size:11px;min-height:26px}
  .cg-legend{font-size:10.5px;padding:4px 8px 5px;gap:1px}
  .cg-legend .cg-sub{display:none}
  .cg-legend .cg-row{gap:2px 7px;flex-wrap:nowrap}
  .cg-key{gap:3px}
  .cg-key svg{width:7px;height:11px}
  .cg-capex{font-size:10.5px;padding:5px 8px 6px;width:calc(55% - 12px)}
  .cg-capex-title{margin-bottom:3px}
  .cg-capex-note{display:none}
  .cg-track{height:6px}
}
`;

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(viewBox: string, build: (s: SVGSVGElement) => void): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  build(s);
  return s;
}
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/** Marker-shape icon (matches the pillar cross-section in 3D). */
export function shapeIcon(shape: Shape): SVGSVGElement {
  return svg('0 0 12 12', (s) => {
    const fill = { fill: 'currentColor' };
    if (shape === 'round') s.appendChild(el('circle', { cx: '6', cy: '6', r: '5', ...fill }));
    else if (shape === 'square') s.appendChild(el('rect', { x: '1.5', y: '1.5', width: '9', height: '9', rx: '1', ...fill }));
    else if (shape === 'triangle') s.appendChild(el('path', { d: 'M6 0.8 11.4 10.8H0.6Z', ...fill }));
    else if (shape === 'hex') s.appendChild(el('path', { d: 'M6 0.6 10.7 3.3V8.7L6 11.4 1.3 8.7V3.3Z', ...fill }));
    else if (shape === 'pentagon') s.appendChild(el('path', { d: 'M6 0.6 11.4 4.5 9.3 11H2.7L0.6 4.5Z', ...fill }));
    else s.appendChild(el('path', { d: 'M6 0.5 11.5 6 6 11.5 0.5 6Z', ...fill }));
  });
}

/** Status icon: a small pillar with the built fraction filled. */
function statusIcon(fill: number, token: string): SVGSVGElement {
  const s = svg('0 0 9 13', (g) => {
    g.appendChild(el('rect', { x: '1', y: '0.75', width: '7', height: '11.5', rx: '1.2', fill: 'currentColor', 'fill-opacity': '0.28', stroke: 'currentColor', 'stroke-width': '1' }));
    if (fill > 0) {
      const h = 11.5 * fill;
      g.appendChild(el('rect', { x: '1', y: String(0.75 + 11.5 - h), width: '7', height: String(h), rx: '1.2', fill: 'currentColor' }));
    }
  });
  s.style.color = `var(--${token})`;
  return s;
}

/** A small 2D bar panel (capex comparison, capacity by build status). */
export interface BarPanel {
  title: string;
  /** `color`: CSS custom property name (without `--`) for the bar; default --c-accent. */
  rows: readonly { label: string; value: number; text: string; color?: string }[];
  note: string;
}

export interface Overlay {
  setFilter(f: Filter): void;
  setCounts(counts: Partial<Record<CampusType, number>>, total: number): void;
  /** Step-specific legend line (plain text segments; `strong` ones are emphasised). */
  setExtra(parts: readonly (string | { strong: string })[]): void;
  /** Bar panel (bottom right); `null` hides it. */
  setPanel(panel: BarPanel | null): void;
  destroy(): void;
}

export function createOverlay(stage: HTMLElement, types: readonly CampusType[], onFilter: (f: Filter) => void, signal: AbortSignal): Overlay {
  const style = document.createElement('style');
  style.textContent = CSS;
  const ui = document.createElement('div');
  ui.className = 'cg-ui';

  // Filter chips.
  const group = document.createElement('div');
  group.className = 'cg-filter';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '依業者類型篩選園區');
  const chips = new Map<Filter, { btn: HTMLButtonElement; n: HTMLSpanElement }>();
  const addChip = (f: Filter, label: string, shape: Shape | null) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cg-chip';
    btn.setAttribute('aria-pressed', 'false');
    if (shape) btn.appendChild(shapeIcon(shape));
    btn.appendChild(document.createTextNode(label));
    const n = document.createElement('span');
    n.className = 'cg-n';
    btn.appendChild(n);
    btn.addEventListener('click', () => onFilter(f), { signal });
    group.appendChild(btn);
    chips.set(f, { btn, n });
  };
  addChip('all', '全部', null);
  for (const t of types) addChip(t, TYPE_INFO[t].label, TYPE_INFO[t].shape);

  // Legend.
  const legend = document.createElement('div');
  legend.className = 'cg-legend';
  const r1 = document.createElement('div');
  r1.className = 'cg-row';
  for (const s of STATUS_ORDER) {
    const info = STATUS_INFO[s];
    const k = document.createElement('span');
    k.className = 'cg-key';
    k.appendChild(statusIcon(info.fill, info.token));
    k.appendChild(document.createTextNode(info.label));
    r1.appendChild(k);
  }
  const r2 = document.createElement('div');
  r2.className = 'cg-row cg-sub';
  r2.textContent = '柱高＝規劃電力（MW）・實心段＝已上線';
  const r2b = document.createElement('span');
  r2b.className = 'cg-hide-narrow';
  r2b.textContent = '柱形＝業者類型';
  r2.appendChild(r2b);
  const r3 = document.createElement('div');
  r3.className = 'cg-row cg-sub cg-extra';
  legend.append(r1, r2, r3);

  // Bar panel (power per operator in the type steps, build progress in 建置進度).
  const capex = document.createElement('div');
  capex.className = 'cg-capex';
  capex.hidden = true;
  const capexTitle = document.createElement('p');
  capexTitle.className = 'cg-capex-title';
  const bars = document.createElement('ul');
  bars.className = 'cg-bars';
  const capexNote = document.createElement('p');
  capexNote.className = 'cg-capex-note';
  capex.append(capexTitle, bars, capexNote);

  ui.append(group, legend, capex);
  stage.append(style, ui);

  return {
    setFilter(f) {
      for (const [k, c] of chips) c.btn.setAttribute('aria-pressed', String(k === f));
      // Narrow stages scroll the chip row sideways: keep the pressed chip in view (horizontally
      // only; scrollIntoView could also scroll the page).
      const b = chips.get(f)?.btn;
      if (b && group.scrollWidth > group.clientWidth + 1) {
        const x = b.offsetLeft;
        const w = b.offsetWidth;
        if (x < group.scrollLeft) group.scrollLeft = Math.max(0, x - 6);
        else if (x + w > group.scrollLeft + group.clientWidth) group.scrollLeft = x + w - group.clientWidth + 6;
      }
    },
    setCounts(counts, total) {
      for (const [k, c] of chips) {
        const n = k === 'all' ? total : (counts[k] ?? 0);
        c.n.textContent = String(n);
        c.btn.hidden = k !== 'all' && n === 0;
        c.btn.setAttribute('aria-label', `${k === 'all' ? '全部' : TYPE_INFO[k].label}（${n} 座園區）`);
      }
    },
    setExtra(parts) {
      r3.textContent = '';
      if (!parts.length) return;
      // One inline run (the row is a flex container: separate nodes would get flex gaps).
      const line = document.createElement('span');
      for (const p of parts) {
        if (typeof p === 'string') line.appendChild(document.createTextNode(p));
        else {
          const b = document.createElement('b');
          b.textContent = p.strong;
          line.appendChild(b);
        }
      }
      r3.appendChild(line);
    },
    setPanel(panel) {
      capex.hidden = !panel?.rows.length;
      if (!panel?.rows.length) return;
      capexTitle.textContent = panel.title;
      capexNote.textContent = panel.note;
      bars.textContent = '';
      const max = Math.max(...panel.rows.map((r) => r.value), 1);
      const fills: HTMLElement[] = [];
      for (const r of panel.rows) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = r.label;
        const track = document.createElement('span');
        track.className = 'cg-track';
        const bar = document.createElement('span');
        bar.className = 'cg-bar';
        bar.style.transform = 'scaleX(0)';
        if (r.color) bar.style.background = `var(--${r.color})`;
        bar.dataset['k'] = String(r.value / max);
        track.appendChild(bar);
        const val = document.createElement('span');
        val.className = 'cg-val';
        val.textContent = r.text;
        li.append(name, track, val);
        bars.appendChild(li);
        fills.push(bar);
      }
      // Next frame: grow the bars (CSS transition; instant under reduced motion).
      requestAnimationFrame(() => fills.forEach((b) => (b.style.transform = `scaleX(${b.dataset['k']})`)));
    },
    destroy() {
      ui.remove();
      style.remove();
    },
  };
}
