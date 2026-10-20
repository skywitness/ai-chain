/**
 * Theme: reads the --scene-*, --seg-*, --layer-*, --chart-* and a few --c-* CSS tokens from the
 * <ai-scene> element into a Palette of THREE.Color, and re-reads them whenever the theme changes
 * (html[data-theme] mutation or the OS colour-scheme media query).
 *
 * Tokens are resolved through a probe element, so `light-dark()`, `oklch()` and `color-mix()` all
 * work; a 1×1 canvas converts any resolved colour to sRGB bytes. Missing tokens fall back to the
 * built-in defaults below (scenes3d.md A14), so a scene still renders before tokens.css exists.
 */
import { Color, SRGBColorSpace } from 'three';
import { LAYER_IDS, SEGMENT_IDS } from './ids';
import type { LayerId, Palette, PaletteKey, SegmentId, ThemeName } from './types';

type Defaults = Record<string, readonly [dark: string, light: string]>;

/** Built-in fallbacks: [dark, light]. Only used when a token is missing. */
const DEFAULTS: Defaults = {
  'scene-bg': ['#0b1020', '#f5f7fb'],
  'scene-fg': ['#e7ebf3', '#152033'],
  'scene-grid': ['#26304a', '#d3dae8'],
  'scene-muted': ['#8d97b0', '#5a6478'],
  'scene-highlight': ['#ffd166', '#c26a00'],
  'scene-flow': ['#5ce1ff', '#0b78b0'],
  'scene-power': ['#f5a524', '#b86e00'],
  'scene-heat': ['#ff6b4a', '#c4401f'],
  'scene-coolant': ['#3e9bf0', '#1f69b8'],
  'scene-optic': ['#b07cff', '#6f3fc0'],
  'scene-tw-accent': ['#ff4d6d', '#c8243f'],
  'c-pos': ['#3ccf8e', '#14804a'],
  'c-neg': ['#ff6b6b', '#c0392b'],
  'c-accent': ['#6d9cff', '#2453c7'],
  'seg-energy-power': ['#f5a524', '#b86e00'],
  'seg-semi-equipment-materials': ['#f07a3a', '#b4501a'],
  'seg-foundry-packaging': ['#ef5d5d', '#b83232'],
  'seg-memory-storage': ['#e0569b', '#a82e6e'],
  'seg-eda-ip-design': ['#c977e6', '#8a3aa8'],
  'seg-ai-accelerators': ['#a56bf0', '#6f3fc0'],
  'seg-networking-optics': ['#6d7cf5', '#3c4bc4'],
  'seg-servers-systems': ['#3e9bf0', '#1f69b8'],
  'seg-datacenter-infra': ['#26bfd9', '#0e7f94'],
  'seg-cloud-neocloud': ['#2bc9a4', '#11826a'],
  'seg-foundation-models': ['#57cc6a', '#2d8a3e'],
  'seg-devtools-data-mlops': ['#a6cf3e', '#66861a'],
  'seg-apps-agents': ['#e8c83a', '#8f7a10'],
  'seg-physical-ai': ['#ff8fa3', '#c2455e'],
  'layer-foundation': ['#f5a524', '#b86e00'],
  'layer-silicon': ['#a56bf0', '#6f3fc0'],
  'layer-systems': ['#3e9bf0', '#1f69b8'],
  'layer-cloud-models': ['#2bc9a4', '#11826a'],
  'layer-applications': ['#e8c83a', '#8f7a10'],
  'chart-1': ['#6d9cff', '#2453c7'],
  'chart-2': ['#f5a524', '#b86e00'],
  'chart-3': ['#3ccf8e', '#14804a'],
  'chart-4': ['#ff6b8a', '#c2185b'],
  'chart-5': ['#b07cff', '#6f3fc0'],
  'chart-6': ['#26bfd9', '#0e7f94'],
  'chart-7': ['#e8c83a', '#8f7a10'],
  'chart-8': ['#a3adc2', '#5a6478'],
};

const KEY_TOKENS: Record<PaletteKey, string> = {
  bg: 'scene-bg',
  fg: 'scene-fg',
  grid: 'scene-grid',
  muted: 'scene-muted',
  highlight: 'scene-highlight',
  flow: 'scene-flow',
  power: 'scene-power',
  heat: 'scene-heat',
  coolant: 'scene-coolant',
  optic: 'scene-optic',
  twAccent: 'scene-tw-accent',
  pos: 'c-pos',
  neg: 'c-neg',
  accent: 'c-accent',
};

const SENTINEL = 'rgba(1, 2, 3, 0.004)';

/** Current theme name: html[data-theme], else the OS preference. */
export function currentTheme(): ThemeName {
  const t = document.documentElement.dataset['theme'];
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let ctx2d: CanvasRenderingContext2D | null | undefined;
function toBytes(css: string): [number, number, number] | null {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(css);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  if (ctx2d === undefined) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    ctx2d = c.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx2d) return null;
  ctx2d.clearRect(0, 0, 1, 1);
  ctx2d.fillStyle = '#000';
  ctx2d.fillStyle = css;
  ctx2d.fillRect(0, 0, 1, 1);
  const d = ctx2d.getImageData(0, 0, 1, 1).data;
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
}

function colorFrom(bytes: [number, number, number]): Color {
  return new Color().setRGB(bytes[0] / 255, bytes[1] / 255, bytes[2] / 255, SRGBColorSpace);
}

/** Resolve every token under `el` into a Palette. */
export function readPalette(el: HTMLElement): Palette {
  const theme = currentTheme();
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
  probe.style.setProperty('transition', 'none', 'important');
  el.appendChild(probe);
  const css: Record<string, string> = {};
  const resolve = (token: string): Color => {
    probe.style.color = `var(--${token}, ${SENTINEL})`;
    let value = getComputedStyle(probe).color;
    if (!value || value.replace(/\s/g, '') === SENTINEL.replace(/\s/g, '')) {
      const d = DEFAULTS[token];
      value = d ? (theme === 'dark' ? d[0] : d[1]) : '#888888';
    }
    const bytes = toBytes(value) ?? [136, 136, 136];
    css[token] = `rgb(${bytes[0]} ${bytes[1]} ${bytes[2]})`;
    return colorFrom(bytes);
  };
  try {
    const base = {} as Record<PaletteKey, Color>;
    for (const [k, token] of Object.entries(KEY_TOKENS) as [PaletteKey, string][]) base[k] = resolve(token);
    const seg = {} as Record<SegmentId, Color>;
    for (const id of SEGMENT_IDS) seg[id] = resolve(`seg-${id}`);
    const layer = {} as Record<LayerId, Color>;
    for (const id of LAYER_IDS) layer[id] = resolve(`layer-${id}`);
    const chart: Color[] = [];
    for (let i = 1; i <= 8; i++) chart.push(resolve(`chart-${i}`));
    return { ...base, theme, seg, layer, chart, css };
  } finally {
    probe.remove();
  }
}

/**
 * Watch for theme changes. `cb` runs (coalesced to one animation frame) after html[data-theme],
 * html[class] / html[style] or the OS colour scheme changes.
 */
export function watchTheme(cb: () => void, signal: AbortSignal): void {
  let raf = 0;
  const fire = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!signal.aborted) cb();
    });
  };
  const mo = new MutationObserver(fire);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', fire, { signal });
  signal.addEventListener(
    'abort',
    () => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    },
    { once: true },
  );
}

/** Resolve a palette colour by key (for kit modules that receive a palette). */
export function paletteColor(p: Palette, key: string): Color {
  if (key.startsWith('seg:')) return p.seg[key.slice(4) as SegmentId] ?? p.fg;
  if (key.startsWith('layer:')) return p.layer[key.slice(6) as LayerId] ?? p.fg;
  if (key.startsWith('chart:')) return p.chart[(Number(key.slice(6)) - 1) | 0] ?? p.fg;
  return (p as unknown as Record<string, Color>)[key] ?? p.fg;
}
