/**
 * taiwan-map legend: a small aria-hidden HTML key in the stage's bottom-left corner (the hotspot
 * list and the 場景文字說明 carry the same information). Colours come from CSS tokens only, so it
 * follows the theme by itself. `covers()` lets the scene hide 3D labels that would sit under it.
 * Removed on dispose.
 */
const CSS = `
.twm-legend{position:absolute;left:10px;bottom:10px;z-index:3;display:grid;gap:4px;margin:0;padding:7px 11px 8px;max-width:min(26rem,calc(100% - 20px));border-radius:12px;pointer-events:none;
 font-family:var(--font-sans,system-ui,sans-serif);font-size:12px;line-height:1.4;color:var(--scene-fg);
 background:color-mix(in srgb,var(--scene-bg) 84%,transparent);border:1px solid color-mix(in srgb,var(--scene-fg) 12%,transparent);
 -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.twm-legend[hidden]{display:none}
.twm-title{font-weight:600}
.twm-row{display:flex;flex-wrap:wrap;gap:2px 11px;align-items:center}
.twm-key{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.twm-dot{width:9px;height:9px;border-radius:50%;flex:none;box-shadow:0 0 0 1px color-mix(in srgb,var(--scene-fg) 25%,transparent)}
.twm-coin{width:12px;height:9px;flex:none;border-radius:2px;background:repeating-linear-gradient(to top,currentColor 0 2px,transparent 2px 3.5px);opacity:.75}
.twm-line{width:16px;height:3px;border-radius:2px;flex:none}
.twm-sub{color:var(--c-fg-muted,var(--scene-muted))}
@container scene (max-width: 40rem){
 .twm-legend{left:8px;bottom:8px;font-size:11px;padding:5px 9px 6px;gap:3px;max-width:calc(100% - 16px)}
 .twm-row{gap:2px 8px}
 .twm-key{gap:4px}
 .twm-hide-narrow{display:none}
}
`;

export interface LegendKey {
  label: string;
  /** CSS colour (resolved token) */
  color: string;
  shape?: 'dot' | 'line';
}
export interface LegendState {
  title: string;
  keys: LegendKey[];
  note?: string;
}

export interface Legend {
  set(state: LegendState | null): void;
  /** true when the stage point (x, y) in CSS px lies within the box grown by `pad` px (`padRight` on
   * the right, where left-aligned label boxes reach back over it) */
  covers(x: number, y: number, pad: number, padRight?: number): boolean;
  /** forget the measured box (call after the stage resizes) */
  invalidate(): void;
  dispose(): void;
}

export function createLegend(stage: HTMLElement): Legend {
  const style = document.createElement('style');
  style.textContent = CSS;
  const box = document.createElement('div');
  box.className = 'twm-legend';
  box.setAttribute('aria-hidden', 'true');
  stage.appendChild(style);
  stage.appendChild(box);
  let last = '';
  // Box in stage coordinates, measured lazily (one layout read after each change).
  let rect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let measured = false;
  const measure = () => {
    measured = true;
    rect = null;
    if (box.hidden || !box.isConnected) return;
    const b = box.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    if (b.width > 0) rect = { x0: b.left - s.left, y0: b.top - s.top, x1: b.right - s.left, y1: b.bottom - s.top };
  };
  return {
    covers(x, y, pad, padRight = pad) {
      if (!measured) measure();
      return !!rect && x > rect.x0 - pad && x < rect.x1 + padRight && y > rect.y0 - pad && y < rect.y1 + pad;
    },
    invalidate() {
      measured = false;
    },
    set(state) {
      const key = JSON.stringify(state);
      if (key === last) return;
      last = key;
      measured = false;
      box.hidden = !state;
      box.replaceChildren();
      if (!state) return;
      const title = document.createElement('div');
      title.className = 'twm-row';
      const coin = document.createElement('span');
      coin.className = 'twm-coin';
      const t = document.createElement('span');
      t.className = 'twm-title';
      t.textContent = state.title;
      title.append(coin, t);
      box.appendChild(title);
      if (state.keys.length) {
        const row = document.createElement('div');
        row.className = 'twm-row';
        for (const k of state.keys) {
          const item = document.createElement('span');
          item.className = 'twm-key';
          const sw = document.createElement('span');
          sw.className = k.shape === 'line' ? 'twm-line' : 'twm-dot';
          sw.style.background = k.color;
          const label = document.createElement('span');
          label.textContent = k.label;
          item.append(sw, label);
          row.appendChild(item);
        }
        box.appendChild(row);
      }
      if (state.note) {
        const n = document.createElement('div');
        n.className = 'twm-sub twm-hide-narrow';
        n.textContent = state.note;
        box.appendChild(n);
      }
    },
    dispose() {
      box.remove();
      style.remove();
    },
  };
}
