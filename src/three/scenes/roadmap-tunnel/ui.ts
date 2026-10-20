/**
 * roadmap-tunnel in-stage controls (real HTML: keyboard and screen-reader accessible):
 *  - the marker legend (實心＝已發生、空心＝預期、虛線＝推測、光帶＝只知年份), top left;
 *  - lane toggle chips (硬體／軟體／市場／政策) whose dots double as the colour legend, bottom left;
 *  - the time slider (month resolution, 2024-01 … 2031-12) with a 「現在」 button, bottom right;
 *  - a transient hint for the cooperative wheel.
 * Styles use the site tokens only (no hex), scoped by the `rt-` prefix and removed on dispose.
 */
import { monthText } from './data';

export interface TunnelUiOptions {
  stage: HTMLElement;
  signal: AbortSignal;
  lanes: readonly { label: string; count: number }[];
  time: { min: number; max: number; value: number; now: number };
  onLane(index: number, on: boolean): void;
  onTime(t: number): void;
  onNow(): void;
}

export interface TunnelUi {
  setTime(t: number): void;
  setLaneColors(css: readonly string[]): void;
  setLane(index: number, on: boolean): void;
  hint(text: string): void;
  dispose(): void;
}

const CSS = `
.rt-ui{position:absolute;inset:0;z-index:3;pointer-events:none;font-family:var(--font-sans);color:var(--c-fg)}
.rt-legend{position:absolute;top:10px;left:12px;display:flex;flex-wrap:wrap;align-items:center;gap:2px 12px;max-width:calc(100% - 120px);
  padding:4px 11px;border-radius:var(--radius-pill);font-size:11.5px;line-height:1.5;color:var(--c-fg-muted);
  background:color-mix(in srgb,var(--scene-bg) 76%,transparent);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.rt-key{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.rt-key svg{width:12px;height:12px;flex:none;color:var(--scene-fg)}
.rt-bar{position:absolute;left:10px;right:10px;bottom:10px;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:6px 10px}
.rt-group{pointer-events:auto;display:flex;align-items:center;gap:2px;padding:3px;min-width:0;border-radius:var(--radius-pill);
  border:1px solid var(--c-border);background:color-mix(in srgb,var(--c-bg-elev) 90%,transparent);box-shadow:var(--shadow-1);
  -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.rt-lanes{overflow-x:auto;scrollbar-width:none;max-width:100%}
.rt-lanes::-webkit-scrollbar{display:none}
.rt-chip{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:0 11px;flex:none;border:0;border-radius:var(--radius-pill);
  background:transparent;color:var(--c-fg-muted);font:inherit;font-size:12.5px;line-height:1;cursor:pointer;white-space:nowrap}
.rt-chip:hover{color:var(--c-fg);background:color-mix(in srgb,var(--c-fg) 7%,transparent)}
.rt-chip i{width:10px;height:10px;border-radius:50%;flex:none;box-shadow:0 0 0 1px color-mix(in srgb,var(--scene-fg) 22%,transparent)}
.rt-chip small{font-size:10.5px;opacity:.75;font-variant-numeric:tabular-nums}
.rt-chip[aria-pressed=true]{color:var(--c-fg);font-weight:600;background:color-mix(in srgb,var(--c-fg) 6%,transparent)}
.rt-chip[aria-pressed=false]{opacity:.62}
.rt-chip[aria-pressed=false] i{background:transparent!important;box-shadow:inset 0 0 0 1.5px var(--c-fg-muted)}
.rt-time{flex:1 1 300px;max-width:480px;gap:8px;padding:3px 4px 3px 12px}
.rt-tlabel{font-size:12px;color:var(--c-fg-muted);white-space:nowrap}
.rt-range{flex:1 1 auto;min-width:60px;height:24px;margin:0;accent-color:var(--c-accent);cursor:pointer;background:transparent}
.rt-date{min-width:6.4em;text-align:end;font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.rt-now{min-height:30px;padding:0 12px;flex:none;border:0;border-radius:var(--radius-pill);background:var(--c-accent);color:var(--c-accent-fg);
  font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap}
.rt-ui :is(button,input):focus-visible{outline:3px solid var(--c-focus);outline-offset:2px}
.rt-hint{position:absolute;left:50%;top:50%;translate:-50% -50%;margin:0;padding:var(--space-2) var(--space-4);border-radius:var(--radius-pill);
  background:color-mix(in srgb,var(--c-bg-elev) 94%,transparent);color:var(--c-fg);font-size:var(--fs-s);box-shadow:var(--shadow-2);
  opacity:0;transition:opacity 200ms ease;white-space:nowrap}
.rt-hint[data-show]{opacity:1}
@container scene (max-width: 40rem){
  .rt-legend{top:8px;left:8px;font-size:10.5px;gap:0 8px;padding:3px 9px;max-width:calc(100% - 96px)}
  .rt-bar{left:6px;right:6px;bottom:6px;gap:5px}
  .rt-time{flex-basis:100%;max-width:none;order:-1}
  .rt-chip{min-height:28px;padding:0 9px;font-size:12px}
  .rt-chip small,.rt-tlabel{display:none}
  .rt-date{min-width:5.8em;font-size:12px}
}
@media (pointer: coarse){.rt-chip,.rt-now{min-height:34px}}
@media (prefers-reduced-motion: reduce){.rt-hint{transition:none}}
`;

const ICONS = {
  done: '<circle cx="6" cy="6" r="4.4" fill="currentColor"/>',
  expected: '<circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  speculative:
    '<circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.1 1.6"/>',
  span: '<rect x=".5" y="4.4" width="11" height="3.2" rx="1.6" fill="currentColor" opacity=".35"/><circle cx="6" cy="6" r="2.2" fill="currentColor"/>',
} as const;

const KEYS: readonly { icon: keyof typeof ICONS; label: string }[] = [
  { icon: 'done', label: '已發生' },
  { icon: 'expected', label: '預期' },
  { icon: 'speculative', label: '推測' },
  { icon: 'span', label: '光帶：只知年份' },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Slider value (months since `min`) ↔ fractional year (middle of that month). */
const toMonth = (t: number, min: number) => Math.round((t - min) * 12 - 0.5);
const fromMonth = (v: number, min: number) => min + (v + 0.5) / 12;

export function createTunnelUi(o: TunnelUiOptions): TunnelUi {
  const { signal } = o;
  const root = el('div', 'rt-ui');
  const style = el('style', '');
  style.textContent = CSS;
  root.appendChild(style);

  /* legend */
  const legend = el('div', 'rt-legend');
  legend.setAttribute('role', 'note');
  legend.setAttribute(
    'aria-label',
    '圖例：實心球是已發生，空心環是預期，虛線環是推測，淡色光帶表示日期只知道年份',
  );
  for (const k of KEYS) {
    const span = el('span', 'rt-key');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true">${ICONS[k.icon]}</svg>`; // static markup above
    span.appendChild(document.createTextNode(k.label));
    legend.appendChild(span);
  }
  root.appendChild(legend);

  /* bottom bar */
  const bar = el('div', 'rt-bar');
  const lanes = el('div', 'rt-group rt-lanes');
  lanes.setAttribute('role', 'group');
  lanes.setAttribute('aria-label', '顯示哪些軌道');
  const chips: HTMLButtonElement[] = [];
  const dots: HTMLElement[] = [];
  o.lanes.forEach((l, i) => {
    const b = el('button', 'rt-chip');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'true');
    const dot = el('i', '');
    dots.push(dot);
    b.append(dot, document.createTextNode(l.label));
    const n = el('small', '', String(l.count));
    n.setAttribute('aria-hidden', 'true');
    b.appendChild(n);
    b.setAttribute('aria-label', `${l.label}軌道（${l.count} 個里程碑）`);
    b.addEventListener('click', () => o.onLane(i, b.getAttribute('aria-pressed') !== 'true'), { signal });
    chips.push(b);
    lanes.appendChild(b);
  });

  const time = el('div', 'rt-group rt-time');
  time.setAttribute('role', 'group');
  time.setAttribute('aria-label', '時間軸：拖曳以在隧道中穿梭');
  const tlabel = el('span', 'rt-tlabel', '時間');
  tlabel.setAttribute('aria-hidden', 'true');
  const range = el('input', 'rt-range');
  range.type = 'range';
  range.min = '0';
  range.max = String(toMonth(o.time.max - 1 / 24, o.time.min));
  range.step = '1';
  range.setAttribute('aria-label', '時間：把鏡頭移到這個月份');
  const out = el('output', 'rt-date');
  out.setAttribute('aria-hidden', 'true');
  const now = el('button', 'rt-now', '現在');
  now.type = 'button';
  now.setAttribute('aria-label', `回到現在（資料基準 ${monthText(o.time.now)}）`);
  now.addEventListener('click', () => o.onNow(), { signal });
  const show = (t: number) => {
    const txt = monthText(t);
    out.textContent = txt;
    range.setAttribute('aria-valuetext', txt);
  };
  range.addEventListener(
    'input',
    () => {
      const t = fromMonth(Number(range.value), o.time.min);
      show(t);
      o.onTime(t);
    },
    { signal },
  );
  time.append(tlabel, range, out, now);
  bar.append(lanes, time);
  root.appendChild(bar);

  const hintEl = el('p', 'rt-hint');
  hintEl.setAttribute('aria-hidden', 'true');
  root.appendChild(hintEl);
  let hintTimer = 0;

  o.stage.appendChild(root);

  const api: TunnelUi = {
    setTime(t) {
      const v = String(Math.max(0, Math.min(Number(range.max), toMonth(t, o.time.min))));
      if (range.value !== v) range.value = v;
      show(t);
    },
    setLaneColors(css) {
      dots.forEach((d, i) => (d.style.background = css[i] ?? ''));
    },
    setLane(i, on) {
      chips[i]?.setAttribute('aria-pressed', String(on));
    },
    hint(text) {
      hintEl.textContent = text;
      hintEl.dataset['show'] = '';
      clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => delete hintEl.dataset['show'], 1600);
    },
    dispose() {
      clearTimeout(hintTimer);
      root.remove();
    },
  };
  api.setTime(o.time.value);
  return api;
}
