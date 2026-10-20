/**
 * model-galaxy in-stage controls (real HTML, keyboard and screen-reader accessible):
 *  - a colour legend (來源地區) and the size key, top left;
 *  - kind filter chips whose icons double as the shape legend, bottom left;
 *  - the release-date slider with a play button, bottom right.
 * Styles use the site tokens only (no hex), scoped by the `mg-` prefix and removed on dispose.
 */
import { formatMonth, type Kind, type Region, type Shape } from './data';

export type KindFilter = Kind | 'all';

export interface GalaxyUiOptions {
  stage: HTMLElement;
  signal: AbortSignal;
  regions: readonly { id: Region; label: string }[];
  sizeKey: string;
  kinds: readonly { id: KindFilter; label: string; shape?: Shape; count: number }[];
  time: { min: number; max: number; value: number };
  onKind(k: KindFilter): void;
  onTime(t: number): void;
  onPlay(play: boolean): void;
}

export interface GalaxyUi {
  setTime(t: number): void;
  setKind(k: KindFilter): void;
  setPlaying(on: boolean): void;
  /** Show the play button only while ambient motion is allowed. */
  setPlayable(on: boolean): void;
  setRegionColors(css: Readonly<Record<Region, string>>): void;
  /** Stage-relative boxes of the controls (for 3D label placement). */
  obstacles(): { x: number; y: number; w: number; h: number }[];
  dispose(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON: Record<Shape, string> = {
  sphere: '<circle cx="6" cy="6" r="4.6"/>',
  diamond: '<path d="M6 .8 11.2 6 6 11.2.8 6z"/>',
  cube: '<rect x="1.6" y="1.6" width="8.8" height="8.8" rx="1.6"/>',
  tetra: '<path d="M6 1.2 11 10.4H1z"/>',
  dodeca: '<path d="M6 1.1 10.95 4.7 9.06 10.5H2.94L1.05 4.7z"/>',
  ring: '<path fill-rule="evenodd" d="M6 .9a5.1 5.1 0 1 0 0 10.2A5.1 5.1 0 1 0 6 .9zm0 2.7a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 1 1 0-4.8z"/>',
};

const CSS = `
.mg-ui{position:absolute;inset:0;z-index:3;pointer-events:none;font-family:var(--font-sans);color:var(--c-fg)}
.mg-legend{position:absolute;top:10px;left:12px;display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;max-width:calc(100% - 130px);
  padding:4px 11px;border-radius:var(--radius-pill);font-size:11.5px;line-height:1.5;color:var(--c-fg-muted);
  background:color-mix(in srgb,var(--scene-bg) 74%,transparent);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.mg-key{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.mg-key i{width:9px;height:9px;border-radius:50%;flex:none;box-shadow:0 0 0 1px color-mix(in srgb,var(--scene-fg) 22%,transparent)}
.mg-size{white-space:nowrap;padding-inline-start:10px;border-inline-start:1px solid color-mix(in srgb,var(--scene-fg) 18%,transparent)}
.mg-bar{position:absolute;left:10px;right:10px;bottom:10px;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:6px 10px}
.mg-group{pointer-events:auto;display:flex;align-items:center;gap:2px;padding:3px;min-width:0;border-radius:var(--radius-pill);
  border:1px solid var(--c-border);background:color-mix(in srgb,var(--c-bg-elev) 90%,transparent);box-shadow:var(--shadow-1);
  -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.mg-kinds{overflow-x:auto;scrollbar-width:none;max-width:100%}
.mg-kinds::-webkit-scrollbar{display:none}
.mg-chip{display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:0 11px;flex:none;border:0;border-radius:var(--radius-pill);
  background:transparent;color:var(--c-fg-muted);font:inherit;font-size:12.5px;line-height:1;cursor:pointer;white-space:nowrap}
.mg-chip:hover{color:var(--c-fg);background:color-mix(in srgb,var(--c-fg) 7%,transparent)}
.mg-chip[aria-pressed=true]{background:var(--c-accent);color:var(--c-accent-fg);font-weight:600}
.mg-chip svg{width:11px;height:11px;fill:currentColor;flex:none;opacity:.9}
.mg-chip small{font-size:10.5px;opacity:.75;font-variant-numeric:tabular-nums}
.mg-time{flex:1 1 280px;max-width:470px;gap:8px;padding:3px 12px 3px 3px}
.mg-play{display:grid;place-items:center;width:30px;height:30px;flex:none;border:0;border-radius:50%;background:var(--c-accent);color:var(--c-accent-fg);cursor:pointer}
.mg-play svg{width:14px;height:14px;fill:currentColor}
.mg-play .mg-i-pause,.mg-play[aria-pressed=true] .mg-i-play{display:none}
.mg-play[aria-pressed=true] .mg-i-pause{display:block}
.mg-play[hidden]{display:none}
.mg-tlabel{font-size:12px;color:var(--c-fg-muted);white-space:nowrap;padding-inline-start:4px}
.mg-range{flex:1 1 auto;min-width:60px;height:24px;margin:0;accent-color:var(--c-accent);cursor:pointer;background:transparent}
.mg-date{min-width:6.6em;text-align:end;font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.mg-ui :is(button,input):focus-visible{outline:3px solid var(--c-focus);outline-offset:2px}
@container scene (max-width: 40rem){
  .mg-legend{top:8px;left:8px;font-size:10.5px;gap:0 8px;padding:3px 9px;max-width:calc(100% - 96px)}
  .mg-size{display:none}
  .mg-bar{left:6px;right:6px;bottom:6px;gap:5px}
  .mg-time{flex-basis:100%;max-width:none;order:-1}
  .mg-chip{min-height:28px;padding:0 9px;font-size:12px}
  .mg-chip small{display:none}
  .mg-tlabel{display:none}
}
@media (pointer: coarse){.mg-chip{min-height:34px}.mg-play{width:34px;height:34px}}
`;

function svgIcon(shape: Shape): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 12 12');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICON[shape]; // static markup from the constant above
  return s;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createGalaxyUi(o: GalaxyUiOptions): GalaxyUi {
  const { signal } = o;
  const root = el('div', 'mg-ui');
  const style = el('style', '');
  style.textContent = CSS;
  root.appendChild(style);

  /* legend */
  const legend = el('div', 'mg-legend');
  legend.setAttribute('role', 'note');
  legend.setAttribute('aria-label', '圖例：顏色代表來源地區，大小代表等級，形狀代表類型');
  const swatches = new Map<Region, HTMLElement>();
  for (const r of o.regions) {
    const k = el('span', 'mg-key');
    const i = el('i', '');
    swatches.set(r.id, i);
    k.append(i, document.createTextNode(r.label));
    legend.appendChild(k);
  }
  legend.appendChild(el('span', 'mg-size', o.sizeKey));
  root.appendChild(legend);

  /* bottom bar */
  const bar = el('div', 'mg-bar');
  const kinds = el('div', 'mg-group mg-kinds');
  kinds.setAttribute('role', 'group');
  kinds.setAttribute('aria-label', '依模型類型篩選');
  const chips: HTMLButtonElement[] = [];
  for (const k of o.kinds) {
    const b = el('button', 'mg-chip');
    b.type = 'button';
    b.dataset['kind'] = k.id;
    b.setAttribute('aria-pressed', 'false');
    if (k.shape) b.appendChild(svgIcon(k.shape));
    b.appendChild(document.createTextNode(k.label));
    const n = el('small', '', String(k.count));
    n.setAttribute('aria-hidden', 'true');
    b.appendChild(n);
    b.setAttribute('aria-label', `${k.label}（${k.count} 個）`);
    b.addEventListener('click', () => o.onKind(k.id), { signal });
    chips.push(b);
    kinds.appendChild(b);
  }

  const time = el('div', 'mg-group mg-time');
  time.setAttribute('role', 'group');
  time.setAttribute('aria-label', '時間軸');
  const play = el('button', 'mg-play');
  play.type = 'button';
  play.setAttribute('aria-pressed', 'false');
  play.setAttribute('aria-label', '播放時間演進');
  play.innerHTML =
    '<svg class="mg-i-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg>' +
    '<svg class="mg-i-pause" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>';
  play.addEventListener('click', () => o.onPlay(play.getAttribute('aria-pressed') !== 'true'), { signal });
  const tlabel = el('span', 'mg-tlabel', '發布時間');
  tlabel.setAttribute('aria-hidden', 'true');
  const range = el('input', 'mg-range');
  range.type = 'range';
  range.min = String(Math.floor(o.time.min));
  range.max = String(Math.floor(o.time.max));
  range.step = '1';
  range.setAttribute('aria-label', '發布時間：只顯示這個月以前發布的模型版本');
  const out = el('output', 'mg-date');
  out.setAttribute('aria-hidden', 'true');
  const show = (t: number) => {
    const txt = formatMonth(t);
    out.textContent = txt;
    range.setAttribute('aria-valuetext', txt);
  };
  range.addEventListener('input', () => {
    const t = Number(range.value);
    show(t);
    o.onTime(t);
  }, { signal });
  time.append(play, tlabel, range, out);

  bar.append(kinds, time);
  root.appendChild(bar);
  o.stage.appendChild(root);

  const api: GalaxyUi = {
    setTime(t) {
      const v = String(Math.floor(t + 1e-6));
      if (range.value !== v) range.value = v;
      show(t);
    },
    setKind(k) {
      for (const b of chips) b.setAttribute('aria-pressed', String(b.dataset['kind'] === k));
    },
    setPlaying(on) {
      play.setAttribute('aria-pressed', String(on));
      play.setAttribute('aria-label', on ? '暫停時間演進' : '播放時間演進');
    },
    setPlayable(on) {
      play.hidden = !on;
    },
    setRegionColors(css) {
      for (const [r, i] of swatches) i.style.background = css[r];
    },
    obstacles() {
      const base = o.stage.getBoundingClientRect();
      return [legend, kinds, time].map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.left - base.left - 4, y: r.top - base.top - 4, w: r.width + 8, h: r.height + 8 };
      });
    },
    dispose() {
      root.remove();
    },
  };
  api.setTime(o.time.value);
  return api;
}
