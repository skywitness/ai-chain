/**
 * company-globe overlay: the layer filter chips (top left) and the legend with the marker-size
 * toggle (bottom left), as real HTML buttons inside the stage (keyboard and screen-reader
 * accessible). Colours come from CSS tokens only, so the overlay follows the theme by itself.
 * Removed on dispose.
 */
import type { LayerId } from '../../core/types';
import { LAYER_INFO } from './data';

export type Filter = LayerId | 'all';
export type SizeMode = 'tier' | 'revenue';

const CSS = `
.cgl-ui{position:absolute;inset:0;z-index:4;pointer-events:none;font-family:var(--font-sans,system-ui,sans-serif);color:var(--scene-fg)}
.cgl-filter{position:absolute;top:10px;left:10px;display:flex;flex-wrap:wrap;gap:6px;max-width:calc(100% - 20px)}
.cgl-badge .cgl-filter{max-width:calc(100% - 7rem)}
.cgl-chip,.cgl-seg button{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:3px 11px 4px;border-radius:999px;border:1px solid color-mix(in srgb,var(--scene-fg) 20%,transparent);background:color-mix(in srgb,var(--scene-bg) 82%,transparent);color:var(--scene-fg);font:inherit;font-size:12.5px;line-height:1.2;cursor:pointer;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);transition:background-color .15s ease,color .15s ease,border-color .15s ease}
.cgl-chip:hover,.cgl-seg button:hover{border-color:color-mix(in srgb,var(--scene-fg) 45%,transparent)}
.cgl-chip[aria-pressed=true],.cgl-seg button[aria-pressed=true]{background:var(--scene-fg);color:var(--scene-bg);border-color:var(--scene-fg)}
.cgl-chip:focus-visible,.cgl-seg button:focus-visible{outline:2px solid var(--c-focus,var(--scene-highlight));outline-offset:2px}
.cgl-dot{width:10px;height:10px;border-radius:3px;flex:none;box-shadow:0 0 0 1px color-mix(in srgb,var(--scene-bg) 60%,transparent)}
.cgl-n{opacity:.62;font-variant-numeric:tabular-nums}
.cgl-legend{position:absolute;left:10px;bottom:10px;display:grid;gap:4px;margin:0;padding:8px 11px 9px;border-radius:12px;background:color-mix(in srgb,var(--scene-bg) 84%,transparent);border:1px solid color-mix(in srgb,var(--scene-fg) 12%,transparent);font-size:12px;line-height:1.4;max-width:min(27rem,calc(100% - 20px));-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.cgl-row{display:flex;flex-wrap:wrap;gap:3px 10px;align-items:center}
.cgl-key{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.cgl-sub{color:var(--c-fg-muted,var(--scene-muted))}
.cgl-stack{display:inline-flex;flex-direction:column-reverse;gap:1px;flex:none}
.cgl-stack i{display:block;width:12px;height:3px;border-radius:1px}
.cgl-disc{display:inline-block;border-radius:50%;background:currentColor;opacity:.85;flex:none}
.cgl-sliver{display:inline-block;width:12px;height:3px;border-radius:2px;background:var(--scene-muted);flex:none}
.cgl-seg{display:inline-flex;gap:4px;align-items:center;margin:0;padding:0;border:0}
.cgl-seg button{min-height:26px;padding:2px 10px 3px;font-size:12px}
.cgl-note:empty{display:none}
.cgl-note b{font-weight:600;color:var(--scene-fg)}
@container scene (max-width: 40rem){
  .cgl-filter{gap:4px;top:8px;left:8px;max-width:calc(100% - 16px)}
  .cgl-badge .cgl-filter{max-width:calc(100% - 6rem)}
  .cgl-chip{font-size:11px;min-height:26px;padding:2px 7px 3px;gap:4px}
  .cgl-dot{width:8px;height:8px;border-radius:2px}
  .cgl-n{display:none}
  .cgl-legend{left:8px;bottom:8px;font-size:10.5px;padding:5px 8px 6px;display:flex;flex-wrap:wrap;gap:3px 9px;align-items:center;max-width:calc(100% - 16px)}
  .cgl-row{gap:2px 7px}
  .cgl-hide-narrow,.cgl-note{display:none}
  .cgl-seg button{min-height:24px;font-size:11px;padding:1px 8px 2px}
}
`;

export interface Overlay {
  setFilter(f: Filter): void;
  setSize(m: SizeMode): void;
  setCounts(counts: Readonly<Record<LayerId, number>>, total: number): void;
  /** Bottom legend line (plain text segments; `strong` ones are emphasised). */
  setNote(parts: readonly (string | { strong: string })[]): void;
  /** The filter chips' right and bottom edges in stage px (labels are kept out from under them). */
  chipsBox(): { right: number; bottom: number };
  destroy(): void;
}

export function createOverlay(
  stage: HTMLElement,
  layers: readonly LayerId[],
  on: { filter(f: Filter): void; size(m: SizeMode): void },
  signal: AbortSignal,
  /** the host shows its 「示意資料」 badge top right: keep the chips clear of it */
  badge = false,
): Overlay {
  const style = document.createElement('style');
  style.textContent = CSS;
  const ui = document.createElement('div');
  ui.className = badge ? 'cgl-ui cgl-badge' : 'cgl-ui';

  /* filter chips */
  const group = document.createElement('div');
  group.className = 'cgl-filter';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '依產業鏈層篩選公司');
  const chips = new Map<Filter, { btn: HTMLButtonElement; n: HTMLSpanElement; label: string }>();
  const addChip = (f: Filter, label: string) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cgl-chip';
    btn.setAttribute('aria-pressed', 'false');
    if (f !== 'all') {
      const dot = document.createElement('span');
      dot.className = 'cgl-dot';
      dot.setAttribute('aria-hidden', 'true');
      dot.style.background = `var(--layer-${f})`;
      btn.appendChild(dot);
    }
    btn.appendChild(document.createTextNode(label));
    const n = document.createElement('span');
    n.className = 'cgl-n';
    n.setAttribute('aria-hidden', 'true');
    btn.appendChild(n);
    btn.addEventListener('click', () => on.filter(f), { signal });
    group.appendChild(btn);
    chips.set(f, { btn, n, label: f === 'all' ? '全部層' : LAYER_INFO[f].title });
  };
  addChip('all', '全部');
  for (const l of layers) addChip(l, LAYER_INFO[l].chip);

  /* legend */
  const legend = document.createElement('div');
  legend.className = 'cgl-legend';
  const r1 = document.createElement('div');
  // narrow stages drop this row (the 總覽 caption explains the columns) to leave room for the globe
  r1.className = 'cgl-row cgl-hide-narrow';
  const stackKey = document.createElement('span');
  stackKey.className = 'cgl-key';
  const stack = document.createElement('span');
  stack.className = 'cgl-stack';
  stack.setAttribute('aria-hidden', 'true');
  for (const l of layers) {
    const i = document.createElement('i');
    i.style.background = `var(--layer-${l})`;
    stack.appendChild(i);
  }
  stackKey.append(stack, document.createTextNode('柱子＝同一城市的公司'));
  const stackSub = document.createElement('span');
  stackSub.className = 'cgl-sub cgl-hide-narrow';
  stackSub.textContent = '由下而上：能源 → 應用';
  r1.append(stackKey, stackSub);

  const r2 = document.createElement('div');
  r2.className = 'cgl-row cgl-sub';

  const r3 = document.createElement('div');
  r3.className = 'cgl-row';
  const seg = document.createElement('div');
  seg.className = 'cgl-seg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', '圓片大小代表');
  const segLabel = document.createElement('span');
  segLabel.className = 'cgl-sub';
  segLabel.textContent = '大小代表';
  segLabel.setAttribute('aria-hidden', 'true');
  const sizeBtns = new Map<SizeMode, HTMLButtonElement>();
  for (const [m, text] of [
    ['tier', '公司層級'],
    ['revenue', '營收'],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => on.size(m), { signal });
    sizeBtns.set(m, b);
    seg.appendChild(b);
  }
  r3.append(segLabel, seg);

  const note = document.createElement('div');
  note.className = 'cgl-row cgl-sub cgl-note';
  legend.append(r1, r2, r3, note);

  ui.append(group, legend);
  stage.append(style, ui);

  const disc = (px: number) => {
    const s = document.createElement('span');
    s.className = 'cgl-disc';
    s.setAttribute('aria-hidden', 'true');
    s.style.width = s.style.height = `${px}px`;
    return s;
  };
  const txt = (...parts: (Node | string)[]) => {
    const s = document.createElement('span');
    s.append(...parts);
    return s;
  };
  /** text shown only on wide stages */
  const wide = (text: string) => {
    const s = document.createElement('span');
    s.className = 'cgl-hide-narrow';
    s.textContent = text;
    return s;
  };
  const key = (...nodes: (Node | string)[]) => {
    const k = document.createElement('span');
    k.className = 'cgl-key';
    k.append(...nodes);
    return k;
  };

  return {
    setFilter(f) {
      for (const [k, c] of chips) c.btn.setAttribute('aria-pressed', String(k === f));
    },
    setSize(m) {
      for (const [k, b] of sizeBtns) b.setAttribute('aria-pressed', String(k === m));
      r2.textContent = '';
      if (m === 'tier') r2.append(key(disc(11), txt('一線', wide('龍頭'))), key(disc(8), '二線'), key(disc(6), txt('三線', wide('與新創'))));
      else {
        const sliver = document.createElement('span');
        sliver.className = 'cgl-sliver';
        sliver.setAttribute('aria-hidden', 'true');
        r2.append(key(disc(6), disc(12), txt('面積＝近一年營收', wide('（美元換算）'))), key(sliver, '未公開營收'));
      }
    },
    setCounts(counts, total) {
      for (const [k, c] of chips) {
        const n = k === 'all' ? total : (counts[k] ?? 0);
        c.n.textContent = String(n);
        c.btn.hidden = k !== 'all' && n === 0;
        c.btn.setAttribute('aria-label', `${c.label}（${n} 家公司）`);
      }
    },
    setNote(parts) {
      note.textContent = '';
      for (const p of parts) {
        if (typeof p === 'string') note.appendChild(document.createTextNode(p));
        else {
          const b = document.createElement('b');
          b.textContent = p.strong;
          note.appendChild(b);
        }
      }
    },
    chipsBox() {
      const s = stage.getBoundingClientRect();
      const g = group.getBoundingClientRect();
      return g.height > 0 ? { right: g.right - s.left, bottom: g.bottom - s.top } : { right: 0, bottom: 0 };
    },
    destroy() {
      ui.remove();
      style.remove();
    },
  };
}
