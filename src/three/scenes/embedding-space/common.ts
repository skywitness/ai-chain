/** embedding-space — small scene-private helpers shared by the two variant views. */
import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  SRGBColorSpace,
  Shape,
  Vector3,
} from 'three';
import type { CameraPose, LabelHandle, LabelSpec, Palette, QualityTier, SceneContext } from '../../core/types';

/** What index.ts needs from a variant view. */
export interface View {
  readonly group: Group;
  /** Floor height for this variant. */
  readonly floorY: number;
  setActive(on: boolean): void;
  /** (Re)start the plan for a guided step (static final state when motion is off). */
  start(step: number): void;
  update(dt: number, t: number): void;
  /** Camera pose for a step (null = the variant's home pose). */
  pose(step: number): CameraPose | null;
  layout(portrait: boolean): void;
  /** Narrow stage (phones): fewer and shorter labels. */
  compact(on: boolean): void;
  palette(p: Palette): void;
  motion(animate: boolean): void;
  quality(tier: QualityTier): void;
}

/** Callbacks from index.ts (variant / step switching through the host's command channel). */
export interface ViewApi {
  goStep(index: number): void;
  goVariant(variant: string): void;
  readonly active: string;
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
export const easeOut = (k: number) => 1 - (1 - k) ** 3;

/** 'seg:memory-storage' → 'seg-memory-storage', 'chart:1' → 'chart-1' (palette.css keys). */
export const cssToken = (ref: string): string => ref.replace(':', '-');

/** A rounded rectangle centred on the origin (XY plane). */
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

/** Closed outline of a rounded rectangle as line-segment pairs (for LineSegments), at depth z. */
export function roundedRectOutline(w: number, h: number, r: number, z = 0): BufferGeometry {
  const pts = roundedRect(w, h, r).getPoints(8);
  const pos: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    pos.push(a.x, a.y, z, b.x, b.y, z);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  return g;
}

type Cached = { -readonly [K in keyof LabelSpec]?: LabelSpec[K] };
const sameVec = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  const x = a as ArrayLike<number> & { x?: number; y?: number; z?: number };
  const y = b as ArrayLike<number> & { x?: number; y?: number; z?: number };
  const ax = x.x ?? x[0];
  const ay = x.y ?? x[1];
  const az = x.z ?? x[2];
  const bx = y.x ?? y[0];
  const by = y.y ?? y[1];
  const bz = y.z ?? y[2];
  return Math.abs(ax! - bx!) < 1e-5 && Math.abs(ay! - by!) < 1e-5 && (az === undefined || Math.abs(az - bz!) < 1e-5);
};

/**
 * Labels that belong to one variant view: `setActive(false)` hides them all without forgetting
 * what each one wants when the view comes back. `set()` forwards only real changes, so calling it
 * every frame never keeps a demand loop (reduced motion) awake.
 */
export class LabelSet {
  private items: { h: LabelHandle; want: boolean; spec: Cached }[] = [];
  private active = true;
  constructor(private readonly ctx: SceneContext) {}

  add(spec: LabelSpec): LabelHandle {
    const want = spec.visible !== false;
    const h = this.ctx.labels.add({ ...spec, visible: want && this.active });
    const cached: Cached = { ...spec };
    if (spec.position) cached.position = [...toArr(spec.position)];
    const item = { h, want, spec: cached };
    this.items.push(item);
    const self = this;
    return {
      set(patch) {
        const diff: Cached = {};
        let changed = false;
        for (const key of Object.keys(patch) as (keyof LabelSpec)[]) {
          if (key === 'visible') continue;
          const v = patch[key];
          const cur = item.spec[key];
          const same = key === 'position' || key === 'offset' ? sameVec(cur, v) : cur === v;
          if (same) continue;
          changed = true;
          const stored = key === 'position' && v ? [...toArr(v as LabelSpec['position'] & object)] : key === 'offset' && v ? [...(v as readonly number[])] : v;
          (item.spec as Record<string, unknown>)[key] = stored;
          (diff as Record<string, unknown>)[key] = stored;
        }
        if (patch.visible !== undefined && patch.visible !== item.want) {
          item.want = patch.visible;
          diff.visible = patch.visible && self.active;
          changed = true;
        }
        if (changed) h.set(diff as Partial<LabelSpec>);
      },
      remove() {
        h.remove();
        self.items = self.items.filter((x) => x !== item);
      },
      get shown() {
        return h.shown;
      },
    };
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    for (const it of this.items) it.h.set({ visible: it.want && on });
  }
}

const toArr = (p: NonNullable<LabelSpec['position']>): [number, number, number] =>
  p instanceof Vector3 ? [p.x, p.y, p.z] : [p[0], p[1], p[2]];

/* ───────────────────────── LabelFit: keep key labels inside the stage ───────────────────────── */

export type Align = NonNullable<LabelSpec['align']>;
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const fp = new Vector3();
const fpx = { x: 0, y: 0 };
const fbox: Box = { x: 0, y: 0, w: 0, h: 0 };

/**
 * The LabelLayer culls any label whose box crosses the stage edge, so on a phone a long equation
 * next to a point near the edge simply vanishes. LabelFit measures a label the way the layer does
 * (a hidden `.scene-label` in the same container, so the container-query font sizes match),
 * reproduces the layer's box maths, and lets a view pick a side that fits or slide a label inside.
 */
export class LabelFit {
  private readonly el: HTMLElement;
  private readonly cache = new Map<string, [number, number]>();
  private cacheW = -1;

  constructor(private readonly ctx: SceneContext) {
    this.el = document.createElement('div');
    this.el.className = 'scene-label';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.cssText = 'visibility:hidden;transform:none;left:-9999px;top:0';
    (ctx.stage.querySelector('.scene-labels') ?? ctx.stage).appendChild(this.el);
    ctx.signal.addEventListener('abort', () => this.el.remove(), { once: true });
  }

  /** Rendered [width, height] in px (cached per stage width, since font sizes follow it). */
  size(text: string, kind: LabelSpec['kind'] = 'default', swatch = false): [number, number] {
    const sw = Math.round(this.ctx.size.width);
    if (sw !== this.cacheW) {
      this.cache.clear();
      this.cacheW = sw;
    }
    const key = `${kind}|${swatch ? 1 : 0}|${text}`;
    let s = this.cache.get(key);
    if (!s) {
      this.el.dataset['kind'] = kind;
      this.el.textContent = '';
      if (swatch) {
        const i = document.createElement('i');
        i.className = 'scene-label-swatch';
        this.el.appendChild(i);
      }
      this.el.appendChild(document.createTextNode(text));
      s = [Math.ceil(this.el.offsetWidth), Math.ceil(this.el.offsetHeight)];
      this.cache.set(key, s);
    }
    return s;
  }

  /** World → stage px (false when behind the camera). */
  px(world: Vector3, out: { x: number; y: number }): boolean {
    fp.copy(world).project(this.ctx.camera);
    if (fp.z > 1 || fp.z < -1) return false;
    out.x = ((fp.x + 1) / 2) * this.ctx.size.width;
    out.y = ((1 - fp.y) / 2) * this.ctx.size.height;
    return true;
  }

  /** The box the LabelLayer would give a w×h label at screen point (x, y). */
  box(x: number, y: number, w: number, h: number, align: Align, offset: readonly [number, number], out: Box): Box {
    let bx = x - w / 2;
    let by = y - h / 2;
    if (align === 'above') by = y - h - 8;
    else if (align === 'below') by = y + 8;
    else if (align === 'left') bx = x - w - 10;
    else if (align === 'right') bx = x + 10;
    out.x = bx + offset[0];
    out.y = by + offset[1];
    out.w = w;
    out.h = h;
    return out;
  }

  inside(b: Box, margin = 4): boolean {
    return b.x >= margin && b.y >= margin && b.x + b.w <= this.ctx.size.width - margin && b.y + b.h <= this.ctx.size.height - margin;
  }

  /**
   * Offset for a label anchored at `world` that slides it back inside the stage. Only applies
   * while the anchor itself is on screen (a label never floats away from an off-screen object).
   */
  nudge(world: Vector3, text: string, kind: LabelSpec['kind'], align: Align, base: readonly [number, number] = [0, 0]): [number, number] {
    const W = this.ctx.size.width;
    const H = this.ctx.size.height;
    if (!this.px(world, fpx) || fpx.x < 0 || fpx.x > W || fpx.y < 0 || fpx.y > H) return [base[0], base[1]];
    const [w, h] = this.size(text, kind);
    const [dx, dy] = this.slide(this.box(fpx.x, fpx.y, w, h, align, base, fbox));
    return [base[0] + dx, base[1] + dy];
  }

  /** Horizontal / vertical shift that brings box b inside the stage (0 when it already fits). */
  slide(b: Box, margin = 6): [number, number] {
    const W = this.ctx.size.width;
    const H = this.ctx.size.height;
    const dx = b.x < margin ? margin - b.x : b.x + b.w > W - margin ? W - margin - b.x - b.w : 0;
    const dy = b.y < margin ? margin - b.y : b.y + b.h > H - margin ? H - margin - b.y - b.h : 0;
    return [Math.round(dx), Math.round(dy)];
  }
}

/**
 * A square floor grid of short segments whose alpha fades with distance from the centre
 * (same look as chain-panorama, kept private here).
 */
export function floorGrid(radius: number, step: number) {
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
        const r = Math.hypot(x / 1.25, z) / radius;
        fade.push(Math.max(0, 1 - r * r) ** 1.8);
      }
    }
  };
  for (let i = -n; i <= n; i++) {
    add(i * step * 1.25, -radius, i * step * 1.25, radius);
    add(-radius * 1.25, i * step, radius * 1.25, i * step);
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

/** Colour for marks on the current theme: dark theme lifts dim hues a little so they read on navy. */
export function markColor(c: Color, p: Palette, out = new Color()): Color {
  out.copy(c);
  if (p.theme === 'dark') {
    const hsl = { h: 0, s: 0, l: 0 };
    out.getHSL(hsl, SRGBColorSpace);
    if (hsl.l < 0.58) out.setHSL(hsl.h, Math.min(1, hsl.s * 1.05), 0.58 + (hsl.l - 0.58) * 0.35, SRGBColorSpace);
  }
  return out;
}

/** Fire `scene:command` on the scene element (the documented command channel). */
export function command(ctx: SceneContext, detail: { type: string; [k: string]: unknown }): void {
  ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail }));
}

/* ───────────────────────── Links: solid 3D links and arrows ───────────────────────── */

const UP = new Vector3(0, 1, 0);
const lm = new Matrix4();
const lq = new Quaternion();
const lv = new Vector3();
const ld = new Vector3();
const ls = new Vector3();
const ZERO = new Matrix4().makeScale(0, 0, 0);

export interface LinkStyle {
  /** Shaft radius (world units). */
  radius: number;
  color: Color;
  /** Arrow-head length (0 = no head). The head radius is 2.4 × the shaft radius. */
  head?: number;
  /** Draw-on progress 0..1 from `a` towards `b`. */
  progress?: number;
  /** Pull the end back by this much (stop at a sphere's surface). */
  trimEnd?: number;
  trimStart?: number;
}

/**
 * Many straight links / arrows as solid tubes: one InstancedMesh of shafts and one of cone heads
 * (2 draw calls in total). Unlit diagram colours. Positions are in the parent's local space.
 * (Kept local: the kit's ArcRibbons are camera-facing Bézier ribbons; these read as diorama rods.)
 */
export class Links {
  readonly group = new Group();
  private readonly shafts: InstancedMesh;
  private readonly heads: InstancedMesh;
  private dirty = false;

  constructor(
    ctx: SceneContext,
    readonly capacity: number,
    opts: { renderOrder?: number; radial?: number } = {},
  ) {
    const shaftGeo = ctx.track(new CylinderGeometry(1, 1, 1, opts.radial ?? 10, 1, false));
    shaftGeo.translate(0, 0.5, 0);
    const headGeo = ctx.track(new ConeGeometry(1, 1, 18, 1, false));
    headGeo.translate(0, 0.5, 0);
    const mat = ctx.track(new MeshBasicMaterial({ toneMapped: false }));
    this.shafts = new InstancedMesh(shaftGeo, mat, capacity);
    this.heads = new InstancedMesh(headGeo, mat, capacity);
    for (const m of [this.shafts, this.heads]) {
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.setColorAt(0, new Color(1, 1, 1));
      m.frustumCulled = false;
      m.renderOrder = opts.renderOrder ?? 6;
      for (let i = 0; i < capacity; i++) m.setMatrixAt(i, ZERO);
      ctx.track({ dispose: () => m.dispose() });
    }
    this.group.add(this.shafts, this.heads);
    this.group.name = 'links';
  }

  /** Link i from a to b. */
  set(i: number, a: Vector3, b: Vector3, s: LinkStyle): void {
    if (i < 0 || i >= this.capacity) return;
    ld.copy(b).sub(a);
    const full = ld.length();
    const t0 = Math.min(s.trimStart ?? 0, full * 0.45);
    const t1 = Math.min(s.trimEnd ?? 0, full * 0.45);
    const avail = full - t0 - t1;
    const len = avail * clamp01(s.progress ?? 1);
    if (full < 1e-5 || len < 1e-4) {
      this.hide(i);
      return;
    }
    ld.divideScalar(full);
    lq.setFromUnitVectors(UP, ld);
    const hl = s.head ? Math.min(s.head, len * 0.6) : 0;
    lv.copy(a).addScaledVector(ld, t0);
    this.shafts.setMatrixAt(i, lm.compose(lv, lq, ls.set(s.radius, Math.max(1e-4, len - hl * 0.85), s.radius)));
    this.shafts.setColorAt(i, s.color);
    if (hl > 0) {
      lv.addScaledVector(ld, len - hl);
      const hr = s.radius * 2.4;
      this.heads.setMatrixAt(i, lm.compose(lv, lq, ls.set(hr, hl, hr)));
      this.heads.setColorAt(i, s.color);
    } else this.heads.setMatrixAt(i, ZERO);
    this.dirty = true;
  }

  hide(i: number): void {
    if (i < 0 || i >= this.capacity) return;
    this.shafts.setMatrixAt(i, ZERO);
    this.heads.setMatrixAt(i, ZERO);
    this.dirty = true;
  }

  hideAll(from = 0, to = this.capacity): void {
    for (let i = from; i < to; i++) this.hide(i);
  }

  /** Upload changes (call once per frame after the `set`s). */
  commit(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const m of [this.shafts, this.heads]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}
