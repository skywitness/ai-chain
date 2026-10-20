/**
 * Shared helpers for the train-infer zones (training / inference / pipeline).
 *
 * The scene is one wide "AI factory" table with three dioramas side by side; a variant is the
 * zone the camera is looking at. Each zone is built in its own local frame (a Group placed at
 * `origin`), owns its labels through a LabelSet (so a hidden zone hides its labels too) and
 * registers its hotspots through `ZoneEnv.register` (index.ts adds cross-zone selection).
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
  Vector3,
  type Object3D,
} from 'three';
import { radialTexture } from '../../kit/canvasTex';
import type {
  CameraPose,
  HotspotSpec,
  LabelHandle,
  LabelSpec,
  Palette,
  QualityTier,
  SceneContext,
} from '../../core/types';

export type ZoneId = 'training' | 'inference' | 'pipeline';
export type V3 = [number, number, number];

export interface Zone {
  readonly id: ZoneId;
  readonly group: Group;
  /** (Re)start the choreography of guided step `step` (meta.json index). */
  start(step: number): void;
  /** Ambient animation (animation clock, dt = 0 while paused). */
  update(dt: number): void;
  /**
   * Ambient motion on/off. Off (reduced motion, 暫停動畫): show the final, fully explained state
   * of the current step statically. On: restart the step's choreography.
   */
  setMotion(animate: boolean): void;
  /** Geometry + labels on/off (only the zone in view is rendered). */
  setVisible(on: boolean): void;
  onPalette(p: Palette): void;
  onQuality(tier: QualityTier): void;
  /** Camera pose (world) for a step, or null for the variant's home pose. */
  pose(step: number): CameraPose | null;
  onResize?(portrait: boolean): void;
}

export interface ZoneEnv {
  ctx: SceneContext;
  /** Scene root the zone group is added to. */
  parent: Group;
  origin: Vector3;
  /** Register a hotspot owned by this zone (index.ts wraps cross-zone selection). */
  register(id: string, spec: HotspotSpec): void;
  /** meta.json hotspot detail text (single source for list, card and announce). */
  detail(id: string): string;
  /**
   * Pre-compensate an exact pose for ctx.setPose on portrait stages (the host scales every pose by
   * |portrait| / |landscape| there). Identity on landscape stages.
   */
  unfit(p: CameraPose): CameraPose;
}

/* ───────── maths ───────── */

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
/** Exponential approach that is frame-rate independent. */
export const approach = (cur: number, target: number, dt: number, rate = 8) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Quadratic Bézier a → c (control b) at t, written into out. */
export function bezier(a: Vector3, b: Vector3, c: Vector3, t: number, out: Vector3): Vector3 {
  const u = 1 - t;
  return out.set(
    u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    u * u * a.y + 2 * u * t * b.y + t * t * c.y,
    u * u * a.z + 2 * u * t * b.z + t * t * c.z,
  );
}

/** World pose from zone-local coordinates. */
export function poseAt(origin: Vector3, position: V3, target: V3): CameraPose {
  return {
    position: [origin.x + position[0], origin.y + position[1], origin.z + position[2]],
    target: [origin.x + target[0], origin.y + target[1], origin.z + target[2]],
  };
}

/* ───────── colours ───────── */

/** Neutral "hardware" grey that reads on both themes (boards, frames). */
export const hardware = (p: Palette, out = new Color()) =>
  p.theme === 'dark' ? out.copy(p.muted).lerp(p.bg, 0.42) : out.copy(p.muted).lerp(p.bg, 0.18);
/** Quiet surface tone for idle / empty elements. */
export const idle = (p: Palette, out = new Color()) =>
  p.theme === 'dark' ? out.copy(p.muted).lerp(p.bg, 0.5) : out.copy(p.grid).lerp(p.muted, 0.28);

/* ───────── shapes ───────── */

export function roundedRect(w: number, h: number, r: number, cx = 0, cy = 0): Shape {
  const s = new Shape();
  const x = cx - w / 2;
  const y = cy - h / 2;
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

/* ───────── labels ───────── */

/**
 * A label handle that forwards only real changes. LabelHandle.set() always invalidates the frame,
 * so setting the same text every frame (phase captions) would keep a demand loop alive forever
 * under reduced motion.
 */
function guarded(h: LabelHandle, init: LabelSpec): LabelHandle {
  const cur = { ...init } as Record<string, unknown>;
  const same = (a: unknown, b: unknown) =>
    a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]));
  return {
    set(patch) {
      let changed = false;
      for (const [k, v] of Object.entries(patch)) {
        if (same(v, cur[k])) continue;
        cur[k] = Array.isArray(v) ? [...(v as unknown[])] : v;
        changed = true;
      }
      if (changed) h.set(patch);
    },
    remove: () => h.remove(),
    get shown() {
      return h.shown;
    },
  };
}

interface LabelItem {
  h: LabelHandle;
  when: ((step: number) => boolean) | undefined;
}

/** Labels of one zone: shown only while the zone is visible (and the step filter passes). */
export class LabelSet {
  private readonly items: LabelItem[] = [];
  private on = false;
  private step = 0;

  constructor(
    private readonly ctx: SceneContext,
    private readonly anchor: Object3D,
  ) {}

  add(spec: LabelSpec, when?: (step: number) => boolean): LabelHandle {
    const h = guarded(this.ctx.labels.add({ object: this.anchor, ...spec, visible: false }), { ...spec, visible: false });
    this.items.push({ h, when });
    return h;
  }

  sync(on = this.on, step = this.step): void {
    this.on = on;
    this.step = step;
    for (const it of this.items) it.h.set({ visible: on && (!it.when || it.when(step)) });
  }
}

/* ───────── floor ───────── */

/** Faded square grid + soft contact disc under a zone (2 draw calls). */
export function makeFloor(ctx: SceneContext, radius: number, step: number, y: number) {
  const group = new Group();
  group.position.y = y;
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
        const r = Math.hypot(x, z) / radius;
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
  const colors = new Float32BufferAttribute(new Float32Array((pos.length / 3) * 4), 4);
  geo.setAttribute('color', colors);
  const gridMat = ctx.track(new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false }));
  const grid = new LineSegments(geo, gridMat);
  grid.renderOrder = -2;
  const tex = ctx.track(radialTexture(256));
  const shadowMat = ctx.track(new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  const shadow = new Mesh(ctx.track(new PlaneGeometry(radius * 1.5, radius * 1.5)), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.005;
  shadow.renderOrder = -1;
  group.add(grid, shadow);
  const c = new Color();
  return {
    group,
    applyPalette(p: Palette) {
      const dark = p.theme === 'dark';
      c.copy(p.grid).lerp(p.fg, dark ? 0.1 : 0.05);
      const a = dark ? 0.6 : 0.8;
      for (let i = 0; i < fade.length; i++) colors.setXYZW(i, c.r, c.g, c.b, (fade[i] ?? 0) * a);
      colors.needsUpdate = true;
      shadowMat.color.copy(dark ? p.flow : p.fg);
      shadowMat.opacity = dark ? 0.07 : 0.08;
    },
  };
}

/** Scratch vectors for per-frame work (never allocate in update()). */
export const scratch = { a: new Vector3(), b: new Vector3(), c: new Vector3(), d: new Vector3() };
