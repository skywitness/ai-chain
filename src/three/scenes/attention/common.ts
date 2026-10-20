/**
 * Helpers shared by the three attention-scene variants: floor, shapes, easing, theme-derived
 * neutrals, and the cross-variant hotspot table (a hotspot that lives in another variant jumps to
 * the guided step that shows it).
 */
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Shape,
  type Vector3,
} from 'three';
import type { CardContent, HotspotSpec, Palette, SceneContext, Vec3Like } from '../../core/types';
import { radialTexture } from '../../kit/canvasTex';

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

export function roundedRect(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Quadratic Bézier identical to ArcRibbons' planar mode (apex lifted by 2·height along `up`). */
export function arcPoints(start: Vector3, end: Vector3, up: Vector3, height: number, n: number): Vector3[] {
  const mid = start.clone().add(end).multiplyScalar(0.5).addScaledVector(up, height * 2);
  const out: Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start.clone().lerp(mid, t);
    const b = mid.clone().lerp(end, t);
    out.push(a.lerp(b, t));
  }
  return out;
}

/* ───────────── theme neutrals ───────────── */

const WHITE = new Color(1, 1, 1);
export interface Tones {
  dark: boolean;
  /** Token chip body. */
  chip: Color;
  /** Dimmed chip (masked / inactive). */
  chipDim: Color;
  /** Neutral cube (value ≈ 0). */
  cube: Color;
  /** Faint structure lines. */
  line: Color;
}
export function tones(p: Palette): Tones {
  const dark = p.theme === 'dark';
  return {
    dark,
    chip: dark ? p.bg.clone().lerp(p.fg, 0.2) : p.bg.clone().lerp(WHITE, 0.75),
    chipDim: dark ? p.bg.clone().lerp(p.fg, 0.07) : p.bg.clone().lerp(p.fg, 0.06),
    cube: dark ? p.bg.clone().lerp(p.fg, 0.26) : p.bg.clone().lerp(p.fg, 0.14),
    line: p.grid.clone().lerp(p.fg, dark ? 0.18 : 0.12),
  };
}

/* ───────────── floor: faded grid + soft contact shadow ───────────── */

export interface Floor {
  group: Group;
  apply(p: Palette): void;
}
export function addFloor(ctx: SceneContext, parent: Group, radius: number, step: number, y = 0): Floor {
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 14;
  const n = Math.floor(radius / step);
  const add = (ax: number, az: number, bx: number, bz: number) => {
    for (let i = 0; i < pieces; i++) {
      for (const t of [i / pieces, (i + 1) / pieces]) {
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        pos.push(x, 0, z);
        const r = Math.hypot(x, z * 1.35) / radius;
        fade.push(Math.max(0, 1 - r * r) ** 1.7);
      }
    }
  };
  for (let i = -n; i <= n; i++) {
    add(i * step, -radius, i * step, radius);
    add(-radius, i * step, radius, i * step);
  }
  const geo = ctx.track(new BufferGeometry());
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const col = new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4);
  geo.setAttribute('color', col);
  const mat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const lines = new LineSegments(geo, mat);
  const group = new Group();
  group.position.y = y;
  group.add(lines);
  const shadowMat = ctx.track(new MeshBasicMaterial({ map: ctx.track(radialTexture(256)), transparent: true, depthWrite: false, toneMapped: false }));
  const shadow = new Mesh(ctx.track(new PlaneGeometry(radius * 1.5, radius * 0.95)), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  group.add(shadow);
  for (const o of [lines, shadow]) {
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  }
  parent.add(group);
  return {
    group,
    apply(p) {
      const dark = p.theme === 'dark';
      const c = p.grid.clone().lerp(p.fg, dark ? 0.1 : 0.05);
      const a = dark ? 0.5 : 0.7;
      for (let i = 0; i < fade.length; i++) col.setXYZW(i, c.r, c.g, c.b, (fade[i] ?? 0) * a);
      col.needsUpdate = true;
      shadowMat.color.copy(dark ? p.flow : p.fg);
      shadowMat.opacity = dark ? 0.07 : 0.06;
    },
  };
}

/* ───────────── hotspots across variants ───────────── */

export type Variant = 'attention' | 'layers' | 'moe';

/** Which guided step (and variant) shows each hotspot. */
export const HOTSPOT_HOME: Readonly<Record<string, { step: number; variant: Variant }>> = {
  tokens: { step: 1, variant: 'attention' },
  embedding: { step: 2, variant: 'attention' },
  qkv: { step: 3, variant: 'attention' },
  'attention-weights': { step: 4, variant: 'attention' },
  'multi-head': { step: 5, variant: 'attention' },
  'transformer-block': { step: 6, variant: 'layers' },
  residual: { step: 6, variant: 'layers' },
  ffn: { step: 6, variant: 'layers' },
  'next-token': { step: 6, variant: 'layers' },
  router: { step: 7, variant: 'moe' },
  experts: { step: 7, variant: 'moe' },
  'load-balance': { step: 7, variant: 'moe' },
  'kv-cache': { step: 8, variant: 'attention' },
};

/** A hotspot picked in another variant: remembered across the remount, then selected. */
let pending: { root: HTMLElement; id: string } | null = null;

/**
 * Register the hotspots this variant does not draw: hovering their list entry shows the card at
 * `anchor`; choosing it jumps to the guided step that shows it (and selects it there).
 */
export function registerAway(ctx: SceneContext, present: ReadonlySet<string>, anchor: Vec3Like, stepTitle: (i: number) => string): void {
  for (const h of ctx.json.hotspots ?? []) {
    if (present.has(h.id)) continue;
    const home = HOTSPOT_HOME[h.id];
    const spec: HotspotSpec = {
      anchor,
      card: (): CardContent => ({
        title: h.label,
        ...(h.detail ? { body: h.detail } : {}),
        ...(home ? { subtitle: `在導覽「${stepTitle(home.step)}」中顯示` } : {}),
        ...(h.href ? { href: h.href } : {}),
      }),
      onHighlight: () => {},
    };
    if (home)
      spec.onSelect = (source) => {
        if (source !== 'list' && source !== 'keyboard' && source !== 'command') return false;
        pending = { root: ctx.root, id: h.id };
        ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'step', index: home.step } }));
        return true;
      };
    ctx.hotspots.register(h.id, spec);
  }
}

/** Call at the end of setStep: selects a hotspot chosen from another variant's list. */
export function consumePending(ctx: SceneContext): void {
  const p = pending;
  if (!p || p.root !== ctx.root) return;
  pending = null;
  window.setTimeout(() => {
    if (!ctx.signal.aborted) ctx.hotspots.select(p.id, 'command');
  }, 950);
}

/** Card for a hotspot from meta.json text (used by the variants for their own hotspots). */
export function metaCard(ctx: SceneContext, id: string, extra: Partial<CardContent> = {}): CardContent {
  const h = (ctx.json.hotspots ?? []).find((x) => x.id === id);
  return {
    title: h?.label ?? id,
    ...(h?.detail ? { body: h.detail } : {}),
    ...(h?.href ? { href: h.href } : {}),
    ...extra,
  };
}
