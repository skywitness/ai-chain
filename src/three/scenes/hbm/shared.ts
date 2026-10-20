/**
 * hbm scene — helpers shared by the two variants (stack.ts, hierarchy.ts): maths, die geometry
 * with top-view UVs, procedural die textures, the faded floor grid and the in-stage toggle panel.
 */
import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, type CanvasTexture } from 'three';
import type { Palette, SceneContext } from '../../core/types';

/* ───────────────────────── maths ───────────────────────── */

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeOut = (k: number): number => 1 - (1 - clamp01(k)) ** 3;

/* ───────────────────────── colours ───────────────────────── */

/** sRGB CSS string of a palette colour (for canvas drawing; never a hard-coded hex). */
export const cssOf = (c: Color): string => c.getStyle();

/** Silicon grey, slightly tinted, readable on both themes. */
export function siliconColor(p: Palette, out = new Color()): Color {
  const dark = p.theme === 'dark';
  return out
    .copy(p.fg)
    .lerp(p.bg, dark ? 0.62 : 0.5)
    .lerp(p.layer.silicon, dark ? 0.1 : 0.08);
}

/**
 * Fade a lit material toward the background: colour × (1 − a) plus an emissive wash of the
 * background colour. Works on both themes (a multiplicative tint alone cannot brighten on light).
 */
export function fadeToBg(
  m: { color: Color; emissive: Color },
  base: Color,
  p: Palette,
  a: number,
  extraEmissive?: Color,
): void {
  const dark = p.theme === 'dark';
  // Dark theme: the background wash adds almost nothing, so the colour itself must drop further.
  m.color.copy(base).multiplyScalar(1 - (dark ? 0.88 : 0.72) * a);
  m.emissive.copy(p.bg).multiplyScalar((dark ? 0.55 : 0.85) * a);
  if (extraEmissive) m.emissive.add(extraEmissive);
}

/* ───────────────────────── geometry ───────────────────────── */

export type DiePart = 'full' | 'back' | 'front';

/**
 * Box for a die of footprint w × d (x, z) and height h, or one half of it split at z = 0 ("back"
 * = z ≤ 0, "front" = z ≥ 0). Top/bottom faces get planar UVs in the FULL die frame (canvas top =
 * back edge, canvas left = −x), so a die texture lines up across both halves; side faces sample
 * the border texel (plain silicon), which keeps the cut face clean.
 */
export function dieGeometry(w: number, h: number, d: number, part: DiePart = 'full'): BoxGeometry {
  const depth = part === 'full' ? d : d / 2;
  const g = new BoxGeometry(w, h, depth);
  if (part !== 'full') g.translate(0, 0, part === 'back' ? -d / 4 : d / 4);
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(nor.getY(i)) > 0.5) uv.setXY(i, (pos.getX(i) + w / 2) / w, 1 - (pos.getZ(i) + d / 2) / d);
    else uv.setXY(i, 0.003, 0.003);
  }
  uv.needsUpdate = true;
  return g;
}

/** A square grid of short segments whose alpha fades with distance from the centre (xz plane). */
export function buildFloorGrid(radius: number, step: number, aspect = 1) {
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 14;
  const n = Math.floor(radius / step);
  const add = (ax: number, az: number, bx: number, bz: number) => {
    for (let i = 0; i < pieces; i++) {
      for (const t of [i / pieces, (i + 1) / pieces]) {
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        pos.push(x * aspect, 0, z);
        const r = Math.hypot(x, z) / radius;
        fade.push(Math.max(0, 1 - r * r) ** 1.7);
      }
    }
  };
  for (let i = -n; i <= n; i++) {
    add(i * step, -radius, i * step, radius);
    add(-radius, i * step, radius, i * step);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  return {
    geometry,
    recolor(c: Color, alpha: number) {
      const attr = geometry.getAttribute('color') as Float32BufferAttribute;
      for (let i = 0; i < fade.length; i++) attr.setXYZW(i, c.r, c.g, c.b, (fade[i] ?? 0) * alpha);
      attr.needsUpdate = true;
    },
  };
}

/* ───────────────────────── die textures (no text: patterns only) ───────────────────────── */

/** Representative TSVs per group (a real die has thousands: 示意). */
export const TSV_PER_GROUP = 3;
/** TSV x positions in a die of width 1.6 (8 groups × 3 in the central TSV stripe). */
export const TSV_X: readonly number[] = (() => {
  const xs: number[] = [];
  for (let gI = 0; gI < 8; gI++) {
    const cx = -0.6 + (gI + 0.5) * (1.2 / 8);
    for (const o of [-0.042, 0, 0.042]) xs.push(+(cx + o).toFixed(4));
  }
  return xs;
})();

const DIE_W = 1.6;

function redraw(tex: CanvasTexture, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): void {
  const c = tex.image as HTMLCanvasElement;
  const g = c.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, c.width, c.height);
  draw(g, c.width, c.height);
  tex.needsUpdate = true;
}

/** DRAM core die, top view: bank arrays above and below a central TSV / peripheral stripe. */
export function paintDram(tex: CanvasTexture, p: Palette): void {
  const dark = p.theme === 'dark';
  const si = siliconColor(p);
  const body = si.clone().lerp(p.fg, dark ? 0.06 : 0.04);
  const bank = si.clone().lerp(p.seg['memory-storage'], dark ? 0.3 : 0.22);
  const mat = bank.clone().lerp(p.bg, dark ? 0.35 : 0.25);
  const stripe = si.clone().lerp(p.bg, dark ? 0.35 : 0.2);
  const pad = p.power.clone().lerp(p.fg, 0.15);
  redraw(tex, (g, w, h) => {
    g.fillStyle = cssOf(si);
    g.fillRect(0, 0, w, h);
    const m = 12;
    g.fillStyle = cssOf(body);
    g.fillRect(m, m, w - 2 * m, h - 2 * m);
    const s0 = h * 0.455;
    const s1 = h * 0.545;
    g.fillStyle = cssOf(stripe);
    g.fillRect(m, s0, w - 2 * m, s1 - s0);
    g.fillStyle = cssOf(pad);
    for (const x of TSV_X) {
      const u = ((x + DIE_W / 2) / DIE_W) * w;
      for (const v of [0.485, 0.515]) {
        g.beginPath();
        g.arc(u, v * h, 2.6, 0, Math.PI * 2);
        g.fill();
      }
    }
    // Banks: 2 rows × 4 columns on each side of the stripe, each split into mats.
    const cols = 4;
    const gap = 10;
    for (const [y0, y1] of [
      [m + 8, s0 - 8],
      [s1 + 8, h - m - 8],
    ] as const) {
      const rowH = (y1 - y0 - gap) / 2;
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < cols; c++) {
          const bw = (w - 2 * m - 16 - gap * (cols - 1)) / cols;
          const x = m + 8 + c * (bw + gap);
          const y = y0 + r * (rowH + gap);
          g.fillStyle = cssOf(bank);
          g.fillRect(x, y, bw, rowH);
          g.fillStyle = cssOf(mat);
          for (let k = 1; k < 6; k++) g.fillRect(x + (k * bw) / 6 - 0.6, y + 2, 1.2, rowH - 4);
          g.fillRect(x + 2, y + rowH / 2 - 1, bw - 4, 2);
        }
      }
    }
  });
}

/** HBM base (logic) die, top view: PHY bump field along the −x edge, TSV stripe, logic blocks. */
export function paintBase(tex: CanvasTexture, p: Palette): void {
  const dark = p.theme === 'dark';
  const si = siliconColor(p);
  const body = si.clone().lerp(p.fg, dark ? 0.05 : 0.03);
  const logic = si.clone().lerp(p.seg['servers-systems'], dark ? 0.28 : 0.2);
  const phy = si.clone().lerp(p.highlight, dark ? 0.35 : 0.3);
  const stripe = si.clone().lerp(p.bg, dark ? 0.35 : 0.2);
  const pad = p.power.clone().lerp(p.fg, 0.15);
  redraw(tex, (g, w, h) => {
    g.fillStyle = cssOf(si);
    g.fillRect(0, 0, w, h);
    const m = 12;
    g.fillStyle = cssOf(body);
    g.fillRect(m, m, w - 2 * m, h - 2 * m);
    // PHY along the GPU-facing (−x) edge.
    const pw = w * 0.17;
    g.fillStyle = cssOf(phy);
    g.fillRect(m + 4, m + 10, pw, h - 2 * m - 20);
    g.fillStyle = cssOf(pad);
    for (let y = m + 18; y < h - m - 14; y += 11) for (let x = m + 10; x < m + pw - 2; x += 11) g.fillRect(x, y, 4, 4);
    const s0 = h * 0.455;
    const s1 = h * 0.545;
    g.fillStyle = cssOf(stripe);
    g.fillRect(m + pw + 10, s0, w - 2 * m - pw - 10, s1 - s0);
    g.fillStyle = cssOf(pad);
    for (const x of TSV_X) {
      const u = ((x + DIE_W / 2) / DIE_W) * w;
      if (u < m + pw + 14) continue;
      for (const v of [0.485, 0.515]) {
        g.beginPath();
        g.arc(u, v * h, 2.6, 0, Math.PI * 2);
        g.fill();
      }
    }
    // Logic / test blocks (fixed layout).
    g.fillStyle = cssOf(logic);
    const blocks = [
      [0.3, 0.08, 0.3, 0.3],
      [0.64, 0.08, 0.28, 0.16],
      [0.64, 0.27, 0.28, 0.14],
      [0.3, 0.6, 0.18, 0.32],
      [0.51, 0.6, 0.41, 0.15],
      [0.51, 0.78, 0.2, 0.14],
      [0.74, 0.78, 0.18, 0.14],
    ] as const;
    for (const [x, y, bw, bh] of blocks) g.fillRect(x * w, y * h, bw * w, bh * h);
  });
}

/** GPU die, top view: SM tiles around a central L2 band, HBM PHY strips on both long edges. */
export function paintGpu(tex: CanvasTexture, p: Palette, stacksPerSide: number): void {
  const dark = p.theme === 'dark';
  const acc = p.seg['ai-accelerators'];
  const base = siliconColor(p).lerp(acc, dark ? 0.22 : 0.16);
  const body = base.clone().lerp(p.bg, dark ? 0.12 : 0.06);
  const sm = base.clone().lerp(acc, dark ? 0.32 : 0.3);
  const core = sm.clone().lerp(p.fg, dark ? 0.18 : 0.1);
  const l2 = base.clone().lerp(p.seg['servers-systems'], dark ? 0.25 : 0.2);
  const phy = base.clone().lerp(p.highlight, dark ? 0.45 : 0.4);
  redraw(tex, (g, w, h) => {
    g.fillStyle = cssOf(base);
    g.fillRect(0, 0, w, h);
    const m = 10;
    g.fillStyle = cssOf(body);
    g.fillRect(m, m, w - 2 * m, h - 2 * m);
    // PHY strips (left and right), one segment per HBM stack.
    const pw = w * 0.06;
    for (const x of [m + 4, w - m - 4 - pw]) {
      for (let s = 0; s < stacksPerSide; s++) {
        const segH = (h - 2 * m - 16) / stacksPerSide;
        g.fillStyle = cssOf(phy);
        g.fillRect(x, m + 8 + s * segH + 6, pw, segH - 12);
      }
    }
    // L2 band across the middle.
    const x0 = m + pw + 14;
    const x1 = w - m - pw - 14;
    g.fillStyle = cssOf(l2);
    g.fillRect(x0, h * 0.46, x1 - x0, h * 0.08);
    // SM tiles.
    const cols = 6;
    const rows = 5;
    const gap = 6;
    for (const [y0, y1] of [
      [m + 8, h * 0.46 - 8],
      [h * 0.54 + 8, h - m - 8],
    ] as const) {
      const tw = (x1 - x0 - gap * (cols - 1)) / cols;
      const th = (y1 - y0 - gap * (rows - 1)) / rows;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const x = x0 + c * (tw + gap);
          const y = y0 + r * (th + gap);
          g.fillStyle = cssOf(sm);
          g.fillRect(x, y, tw, th);
          g.fillStyle = cssOf(core);
          g.fillRect(x + tw * 0.12, y + th * 0.18, tw * 0.34, th * 0.64);
          g.fillRect(x + tw * 0.54, y + th * 0.18, tw * 0.34, th * 0.64);
        }
    }
  });
}

/* ───────────────────────── in-stage toggle panel ───────────────────────── */

export interface ToggleOption {
  id: string;
  text: string;
  /** Accessible description (title + aria-label). */
  aria?: string;
}
export interface ToggleGroup {
  label: string;
  options: readonly ToggleOption[];
  value: string;
  onChange(id: string): void;
}
export interface TogglePanel {
  set(group: number, value: string): void;
  dispose(): void;
}

const PANEL_CSS = `
.hbm-ctl{position:absolute;top:10px;left:10px;z-index:4;display:flex;flex-wrap:wrap;gap:6px;max-width:calc(100% - 20px);font-family:var(--font-sans);font-size:12px;line-height:1.2;pointer-events:none}
.hbm-ctl-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;pointer-events:auto;background:color-mix(in srgb,var(--scene-bg) 82%,transparent);border:1px solid color-mix(in srgb,var(--scene-fg) 18%,transparent);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.hbm-ctl-cap{padding:0 4px 0 8px;color:var(--c-fg-muted);font-size:11px;white-space:nowrap}
.hbm-ctl button{all:unset;box-sizing:border-box;cursor:pointer;padding:4px 10px;border-radius:999px;color:var(--scene-fg);white-space:nowrap;font:inherit}
.hbm-ctl button:hover:not([aria-pressed="true"]){background:color-mix(in srgb,var(--scene-fg) 10%,transparent)}
.hbm-ctl button[aria-pressed="true"]{background:var(--scene-fg);color:var(--scene-bg);font-weight:600}
.hbm-ctl button:focus-visible{outline:2px solid var(--scene-highlight);outline-offset:1px}
@media (pointer:coarse){.hbm-ctl button{padding:7px 12px}}
@container scene (max-width: 30rem){.hbm-ctl{font-size:11px}.hbm-ctl-cap{display:none}}
`;

/* ───────────────────────── in-stage legend ───────────────────────── */

export interface LegendItem {
  /** CSS colour (a var(--token) so it follows the theme), or '' for a text-only note. */
  color: string;
  text: string;
  /** Shorter text for narrow stages (≤ 30rem), so the legend stays on one line there. */
  short?: string;
}
export interface Legend {
  show(on: boolean): void;
  dispose(): void;
}

const LEGEND_CSS = `
.hbm-legend{position:absolute;left:10px;bottom:10px;z-index:4;display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;max-width:calc(100% - 20px);padding:5px 10px;border-radius:10px;font-family:var(--font-sans);font-size:12px;line-height:1.3;color:var(--scene-fg);pointer-events:none;background:color-mix(in srgb,var(--scene-bg) 80%,transparent);border:1px solid color-mix(in srgb,var(--scene-fg) 14%,transparent);transition:opacity .2s ease}
.hbm-legend[data-off]{opacity:0}
.hbm-legend>span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.hbm-legend i{display:inline-block;width:8px;height:8px;border-radius:50%}
.hbm-legend .hbm-note{color:var(--c-fg-muted)}
.hbm-legend .hbm-s{display:none}
@container scene (max-width: 30rem){.hbm-legend{font-size:11px;gap:2px 10px;padding:3px 8px}.hbm-legend .hbm-l{display:none}.hbm-legend .hbm-s{display:inline}}
@container scene (max-width: 20rem){.hbm-legend .hbm-note{display:none}}
`;

/** A small, decorative legend in the stage's bottom-left corner (the description carries the text). */
export function createLegend(ctx: SceneContext, items: readonly LegendItem[]): Legend {
  const style = document.createElement('style');
  style.textContent = LEGEND_CSS;
  const box = document.createElement('div');
  box.className = 'hbm-legend';
  box.setAttribute('aria-hidden', 'true');
  for (const it of items) {
    const s = document.createElement('span');
    if (it.color) {
      const dot = document.createElement('i');
      dot.style.background = it.color;
      s.appendChild(dot);
    } else s.className = 'hbm-note';
    if (it.short) {
      const long = document.createElement('span');
      long.className = 'hbm-l';
      long.textContent = it.text;
      const short = document.createElement('span');
      short.className = 'hbm-s';
      short.textContent = it.short;
      s.append(long, short);
    } else s.append(it.text);
    box.appendChild(s);
  }
  ctx.stage.append(style, box);
  return {
    show(on) {
      box.toggleAttribute('data-off', !on);
    },
    dispose() {
      box.remove();
      style.remove();
    },
  };
}

/** Small segmented controls in the stage's top-left corner (real buttons, aria-pressed). */
export function createTogglePanel(ctx: SceneContext, groups: readonly ToggleGroup[]): TogglePanel {
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  const box = document.createElement('div');
  box.className = 'hbm-ctl';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'HBM 規格切換');
  const buttons: HTMLButtonElement[][] = [];
  groups.forEach((grp) => {
    const seg = document.createElement('div');
    seg.className = 'hbm-ctl-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', grp.label);
    const cap = document.createElement('span');
    cap.className = 'hbm-ctl-cap';
    cap.setAttribute('aria-hidden', 'true');
    cap.textContent = grp.label;
    seg.appendChild(cap);
    const row: HTMLButtonElement[] = [];
    for (const o of grp.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.text;
      if (o.aria) {
        b.title = o.aria;
        b.setAttribute('aria-label', o.aria);
      }
      b.setAttribute('aria-pressed', String(o.id === grp.value));
      b.addEventListener('click', () => grp.onChange(o.id), { signal: ctx.signal });
      seg.appendChild(b);
      row.push(b);
    }
    buttons.push(row);
    box.appendChild(seg);
  });
  ctx.stage.append(style, box);
  return {
    set(gi, value) {
      const grp = groups[gi];
      buttons[gi]?.forEach((b, i) => b.setAttribute('aria-pressed', String(grp?.options[i]?.id === value)));
    },
    dispose() {
      box.remove();
      style.remove();
    },
  };
}
