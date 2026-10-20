/**
 * The 「推論時縮放」 note card (step 4): a small DOM card in the stage's top-right corner with one
 * sentence and an inline-SVG sketch of accuracy against (log) inference compute.
 *
 * Why DOM and not a 3D panel: the text must stay legible on a 360 px phone stage, where a card in
 * world space shrinks below the size of its own labels. Like budget.ts it is scene-private (no hex:
 * colours come from CSS tokens, so it follows the theme), sits outside `.scene-view`, ignores the
 * pointer (drags over it still orbit the camera) and is aria-hidden: the same facts are in the step
 * caption and the 「推論時縮放」 hotspot detail. Removed on dispose.
 */

/**
 * Layouts: `full` = corner card with title, sentence and the labelled sketch (wide landscape stages);
 * `row` = full-width strip, sentence beside the sketch (wide portrait stages);
 * `mini` = title + a simplified sketch with larger axis text (stages narrower than 560 px, and short or
 * narrow landscape stages).
 */
export type NoteLayout = 'full' | 'row' | 'mini';

export interface NoteCard {
  readonly el: HTMLElement;
  /** 0 = hidden … 1 = fully shown (follows the step's visibility tween). */
  setOpacity(v: number): void;
  /** `stageHeight` (CSS px) caps the sketch on short landscape phone stages. */
  setLayout(layout: NoteLayout, portrait: boolean, stageHeight: number): void;
  dispose(): void;
}

/**
 * The layout for a stage size. The full card is about 19rem × 13rem, so landscape stages below
 * 760 × 420 (the 640–720 px inline stage, phone landscape fullscreen) get the mini card instead.
 */
export const noteLayout = (size: { width: number; height: number }, portrait: boolean): NoteLayout =>
  size.width < 560 ? 'mini' : portrait ? 'row' : size.width < 760 || size.height < 420 ? 'mini' : 'full';

const SVG = 'http://www.w3.org/2000/svg';
const W = 260;
const H = 112;
const X0 = 30;
const X1 = 250;
const Y0 = 88; // x-axis (bottom)
const Y1 = 22; // top of the y-axis

/** Illustrative accuracy curve: an S-shape that flattens (示意, no data). */
const acc = (u: number): number => 0.1 + 0.78 / (1 + Math.exp(-(u - 0.42) * 6.5));
const px = (u: number): number => X0 + 8 + (X1 - X0 - 16) * u;
const py = (u: number): number => Y0 - (Y0 - Y1) * acc(u);

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, style = ''): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (style) n.setAttribute('style', style);
  return n;
}

function chart(): SVGSVGElement {
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'presentation', focusable: 'false' });
  svg.style.cssText = 'display:block;width:100%;height:auto;max-height:var(--ss-note-chart, 128px);overflow:visible';
  const ink = 'fill:var(--c-fg-muted, var(--scene-fg));font-size:var(--ss-note-fs, 11px);font-family:inherit';
  const dotInk = 'fill:var(--c-fg-muted, var(--scene-fg));font-size:11px;font-family:inherit;display:var(--ss-note-dots, inline)';
  // Axes.
  svg.append(
    el('path', { d: `M${X0} ${Y1 - 4} V${Y0} H${X1}`, fill: 'none' }, 'stroke:var(--scene-muted);stroke-width:1.2'),
    el('path', { d: `M${X0 - 3.5} ${Y1 + 1} L${X0} ${Y1 - 5} L${X0 + 3.5} ${Y1 + 1}`, fill: 'none' }, 'stroke:var(--scene-muted);stroke-width:1.2'),
    el('path', { d: `M${X1 - 6} ${Y0 - 3.5} L${X1} ${Y0} L${X1 - 6} ${Y0 + 3.5}`, fill: 'none' }, 'stroke:var(--scene-muted);stroke-width:1.2'),
  );
  const yl = el('text', { x: X0 + 6, y: Y1 - 8 }, ink);
  yl.textContent = '答對率';
  const xl = el('text', { x: X1, y: Y0 + 20, 'text-anchor': 'end' }, ink);
  xl.textContent = '推論運算（對數）';
  svg.append(yl, xl);
  // Curve.
  const pts = Array.from({ length: 48 }, (_, i) => {
    const u = i / 47;
    return `${i ? 'L' : 'M'}${px(u).toFixed(1)} ${py(u).toFixed(1)}`;
  }).join(' ');
  svg.append(el('path', { d: pts, fill: 'none' }, 'stroke:var(--scene-flow);stroke-width:2.6;stroke-linecap:round'));
  // Three illustrative operating points.
  const dots: [number, string, number, number, 'start' | 'middle' | 'end'][] = [
    [0.08, '直接回答', -6, -11, 'start'],
    [0.5, '多想幾步', 8, 14, 'start'],
    [0.92, '長時間推理', 4, -10, 'end'],
  ];
  for (const [u, label, dx, dy, anchor] of dots) {
    const x = px(u);
    const y = py(u);
    svg.append(el('circle', { cx: x, cy: y, r: 4.2 }, 'fill:var(--scene-flow);stroke:var(--c-bg-elev, var(--scene-bg));stroke-width:1.6'));
    const t = el('text', { x: x + dx, y: y + dy, 'text-anchor': anchor }, dotInk);
    t.textContent = label;
    svg.append(t);
  }
  return svg;
}

export function createNoteCard(o: { stage: HTMLElement }): NoteCard {
  const card = document.createElement('aside');
  card.className = 'ss-note';
  card.setAttribute('aria-hidden', 'true');
  card.style.cssText = [
    'position:absolute',
    'top:12px',
    'right:12px',
    'z-index:4',
    'box-sizing:border-box',
    'width:min(19rem, calc(100% - 24px))',
    'padding:10px 14px 8px',
    'border-radius:var(--radius-m, 8px)',
    'border:1px solid var(--c-border, color-mix(in srgb, var(--scene-fg) 16%, transparent))',
    'background:color-mix(in srgb, var(--c-bg-elev, var(--scene-bg)) 92%, transparent)',
    'box-shadow:var(--shadow-2, none)',
    'color:var(--c-fg, var(--scene-fg))',
    'font-family:var(--font-sans, system-ui, sans-serif)',
    'font-size:var(--fs-s, 14px)',
    'line-height:1.5',
    '-webkit-backdrop-filter:blur(4px)',
    'backdrop-filter:blur(4px)',
    'pointer-events:none',
    'visibility:hidden',
    'opacity:0',
  ].join(';');

  const title = document.createElement('p');
  title.style.cssText =
    'margin:0;display:flex;align-items:center;gap:8px;white-space:nowrap;font-weight:var(--fw-semibold, 600);font-size:var(--fs-m, 17px);line-height:1.3';
  const sw = document.createElement('i');
  sw.style.cssText = 'display:inline-block;width:10px;height:10px;border-radius:3px;flex:none;background:var(--scene-flow)';
  title.append(sw, '推論時縮放（示意）');

  const text = document.createElement('p');
  text.style.cssText = 'margin:4px 0 6px;color:var(--c-fg-muted, var(--scene-fg))';
  for (const line of ['同一個模型，想得越久、答得越準；', '但多花的推論運算，報酬一樣遞減。']) {
    const s = document.createElement('span');
    s.style.display = 'block';
    s.textContent = line;
    text.append(s);
  }
  const head = document.createElement('div');
  head.append(title, text);
  const sketch = chart();
  const figure = document.createElement('div');
  figure.append(sketch);

  card.append(head, figure);
  o.stage.appendChild(card);

  return {
    el: card,
    setOpacity(v) {
      card.style.opacity = String(Math.min(1, Math.max(0, v)));
      card.style.visibility = v > 0.01 ? 'visible' : 'hidden';
    },
    setLayout(layout, portrait, stageHeight) {
      const mini = layout === 'mini';
      const row = layout === 'row';
      // Small stages: title + sketch only (the step caption under the stage carries the sentence);
      // the sketch drops its point labels and enlarges the axis text so it stays legible.
      text.style.display = mini ? 'none' : '';
      title.style.fontSize = mini ? 'var(--fs-s, 14px)' : 'var(--fs-m, 17px)';
      title.style.marginBottom = mini ? '2px' : '';
      card.style.display = row ? 'flex' : 'block';
      card.style.alignItems = row ? 'center' : '';
      card.style.gap = row ? '18px' : '';
      head.style.flex = row ? '1 1 0' : '';
      figure.style.flex = row ? '1 1 0' : '';
      figure.style.maxWidth = row ? '20rem' : '';
      // Landscape phones (the 4:3 inline stage): a narrow corner card, so the A / B pins below stay clear.
      card.style.width = row || (mini && portrait) ? 'calc(100% - 24px)' : mini ? 'min(12rem, max(48%, 10.5rem))' : 'min(19rem, calc(100% - 24px))';
      card.style.padding = mini ? '7px 10px 4px' : '10px 14px 8px';
      const miniChart = portrait ? 104 : Math.round(Math.min(72, Math.max(52, stageHeight * 0.24)));
      card.style.setProperty('--ss-note-chart', mini ? `${miniChart}px` : '128px');
      card.style.setProperty('--ss-note-fs', mini ? (portrait ? '16px' : '20px') : '11px');
      card.style.setProperty('--ss-note-dots', mini ? 'none' : 'inline');
    },
    dispose() {
      card.remove();
    },
  };
}
