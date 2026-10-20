/**
 * physical-ai — scene-private helpers shared by the two variants (robot.ts, autonomy.ts).
 *
 *  - PartsBuilder: merges many small primitives into ONE geometry with a per-vertex colour role,
 *    so a whole robot link (or a car, a building row) is a single draw call that still follows
 *    the theme (`recolor(roles)` rewrites the colour attribute).
 *  - DotStreams: data "pulses" travelling along Bézier curves whose end points may MOVE every
 *    frame (sensor on a moving wrist → model → joint). PathFlow needs fixed paths, so this is a
 *    local helper (proposals/scene-physical-ai.yaml): one InstancedMesh of dots + optional glows.
 *  - fitPortrait (portrait camera poses), crossHotspots / hotspotCard (hotspot cards and the
 *    hotspots that live in the other variant), buildFloorGrid, roundedRect, frustum helpers, easing.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Euler,
  Float32BufferAttribute,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Shape,
  Vector3,
  type Group,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CameraPose, CardContent, Palette, SceneContext, Vec3Like } from '../../core/types';
import { GlowSprites } from '../../kit/GlowSprites';

/* ───────────────────────── easing ───────────────────────── */

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/* ───────────────────────── camera ───────────────────────── */

const toV = (v: Vec3Like, out = new Vector3()) => (v instanceof Vector3 ? out.copy(v) : out.set(v[0], v[1], v[2]));

/**
 * `ctx.setPose` scales every pose's camera distance by |portrait| / |main| on portrait stages (so a
 * landscape pose still fits). Poses authored FOR portrait are pre-divided by that factor here.
 */
export function fitPortrait(ctx: SceneContext, p: CameraPose): CameraPose {
  const cam = ctx.meta.camera;
  if (!ctx.size.portrait || !cam.portrait?.position) return p;
  const main = toV(cam.position).distanceTo(toV(cam.target));
  const port = toV(cam.portrait.position).distanceTo(toV(cam.portrait.target ?? cam.target));
  if (!(main > 0) || !(port > 0)) return p;
  const t = toV(p.target);
  const pos = toV(p.position).sub(t).multiplyScalar(main / port).add(t);
  return { ...p, position: [pos.x, pos.y, pos.z] };
}

/* ───────────────────────── hotspots ───────────────────────── */

/** Guided step that shows each hotspot (meta.json step indices). */
export const HOTSPOT_STEP: Readonly<Record<string, number>> = {
  'head-cameras': 1,
  'wrist-sensors': 1,
  gripper: 1,
  'edge-computer': 2,
  'vla-model': 2,
  'action-chunk': 2,
  'joint-actuators': 3,
  'sim-twin': 4,
  lidar: 5,
  'car-cameras': 5,
  radar: 5,
  detections: 5,
  trajectory: 6,
  'e2e-model': 7,
};

/** Card content for a meta.json hotspot (label, detail, glossary link) plus optional extra links. */
export function hotspotCard(ctx: SceneContext, id: string, extra: readonly { label: string; href: string }[] = []): CardContent {
  const h = (ctx.json.hotspots ?? []).find((x) => x.id === id);
  return {
    title: h?.label ?? id,
    ...(h?.detail ? { body: h.detail } : {}),
    ...(h?.glossary ? { href: `/glossary/#${h.glossary}`, linkLabel: '名詞解釋 →' } : {}),
    ...(extra.length ? { items: extra.map((e) => ({ label: e.label, href: e.href })) } : {}),
  };
}

/**
 * The HTML hotspot list shows the hotspots of BOTH variants. Those that live in the other variant
 * get a card here, and selecting one jumps to the guided step that shows it (which switches the
 * variant), mirroring proposals/scene-gpu-scale.yaml#hotspot-go-to-step.
 */
export function crossHotspots(ctx: SceneContext, ids: readonly string[]): void {
  for (const id of ids) {
    const index = HOTSPOT_STEP[id] ?? 0;
    ctx.hotspots.register(id, {
      card: () => hotspotCard(ctx, id),
      onSelect: () => {
        ctx.root.dispatchEvent(new CustomEvent('scene:command', { detail: { type: 'step', index } }));
        return true;
      },
    });
  }
}

/* ───────────────────────── shapes ───────────────────────── */

export function roundedRect(w: number, d: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + d - r);
  s.absarc(x + w - r, y + d - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + d);
  s.absarc(x + r, y + d - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/* ───────────────────────── merged, role-coloured parts ───────────────────────── */

const M = new Matrix4();
const Q = new Quaternion();
const S = new Vector3();
const P = new Vector3();
const EU = new Euler();
const UP = new Vector3(0, 1, 0);

export interface Range {
  start: number;
  count: number;
  role: string;
}

/**
 * Collects primitives (each with a colour role and a transform) and merges them into one
 * indexed geometry with a `color` attribute. Geometries passed in are disposed after merging.
 */
export class PartsBuilder {
  private parts: { geo: BufferGeometry; role: string }[] = [];

  /** Add `geo` placed at `pos` with Euler rotation `rot` (radians, XYZ) and optional scale. */
  add(
    geo: BufferGeometry,
    role: string,
    pos: readonly [number, number, number] = [0, 0, 0],
    rot: readonly [number, number, number] = [0, 0, 0],
    scale: readonly [number, number, number] = [1, 1, 1],
  ): this {
    // Non-indexed so primitives of every kind (indexed or not) merge together.
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    Q.setFromEuler(EU.set(rot[0], rot[1], rot[2]));
    M.compose(P.set(pos[0], pos[1], pos[2]), Q, S.set(scale[0], scale[1], scale[2]));
    g.applyMatrix4(M);
    // Keep only the attributes every primitive has, so mergeGeometries never rejects a part.
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    this.parts.push({ geo: g, role });
    return this;
  }

  /** Add `geo` with an explicit quaternion. */
  addQ(geo: BufferGeometry, role: string, pos: Vector3, quat: Quaternion): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.applyMatrix4(M.compose(pos, quat, S.set(1, 1, 1)));
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    this.parts.push({ geo: g, role });
    return this;
  }

  /** Add a y-aligned primitive (capsule, cylinder) stretched between points a and b. */
  addAlong(geo: BufferGeometry, role: string, a: Vector3, b: Vector3): this {
    const dir = P.subVectors(b, a);
    const q = new Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
    return this.addQ(geo, role, a.clone().add(b).multiplyScalar(0.5), q);
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  build(): RoleGeometry {
    const ranges: Range[] = [];
    let v = 0;
    for (const p of this.parts) {
      const n = p.geo.getAttribute('position').count;
      ranges.push({ start: v, count: n, role: p.role });
      v += n;
    }
    const geometry = mergeGeometries(
      this.parts.map((p) => p.geo),
      false,
    );
    for (const p of this.parts) p.geo.dispose();
    this.parts = [];
    if (!geometry) throw new Error('physical-ai: merge failed');
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(v * 3), 3));
    geometry.computeBoundingSphere();
    return new RoleGeometry(geometry, ranges);
  }
}

export class RoleGeometry {
  constructor(
    readonly geometry: BufferGeometry,
    readonly ranges: Range[],
  ) {}

  recolor(roles: Readonly<Record<string, Color>>): void {
    const attr = this.geometry.getAttribute('color') as BufferAttribute;
    const a = attr.array as Float32Array;
    for (const r of this.ranges) {
      const c = roles[r.role];
      if (!c) continue;
      for (let i = r.start; i < r.start + r.count; i++) {
        a[i * 3] = c.r;
        a[i * 3 + 1] = c.g;
        a[i * 3 + 2] = c.b;
      }
    }
    attr.needsUpdate = true;
  }
}

/* ───────────────────────── floor grid ───────────────────────── */

/** A rectangular grid of short segments whose alpha fades towards the edges (one draw call). */
export function buildFloorGrid(halfW: number, halfD: number, step: number) {
  const pos: number[] = [];
  const fade: number[] = [];
  const pieces = 14;
  const add = (ax: number, az: number, bx: number, bz: number) => {
    for (let i = 0; i < pieces; i++) {
      for (const t of [i / pieces, (i + 1) / pieces]) {
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        pos.push(x, 0, z);
        const r = Math.max(Math.abs(x) / halfW, Math.abs(z) / halfD);
        const rr = Math.hypot(x / halfW, z / halfD) / Math.SQRT2;
        fade.push(Math.max(0, 1 - Math.max(r ** 3, rr * rr)) ** 1.4);
      }
    }
  };
  for (let x = -halfW; x <= halfW + 1e-6; x += step) add(x, -halfD, x, halfD);
  for (let z = -halfD; z <= halfD + 1e-6; z += step) add(-halfW, z, halfW, z);
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

/* ───────────────────────── camera frustum lines ───────────────────────── */

/**
 * Edges of a pyramid frustum (apex at the origin, looking down −z) as line-segment pairs:
 * 4 apex rays + the far rectangle + a near rectangle (12 segments).
 */
export function frustumSegments(hfov: number, aspect: number, near: number, far: number, withNear = true): number[] {
  const out: number[] = [];
  const hw = (d: number) => Math.tan(hfov / 2) * d;
  const hh = (d: number) => hw(d) / aspect;
  const corners = (d: number) => [
    [-hw(d), -hh(d), -d],
    [hw(d), -hh(d), -d],
    [hw(d), hh(d), -d],
    [-hw(d), hh(d), -d],
  ];
  const f = corners(far);
  const n = corners(near);
  for (let i = 0; i < 4; i++) {
    const a = f[i]!;
    const b = f[(i + 1) % 4]!;
    out.push(...a, ...b);
    const c = n[i]!;
    const d = n[(i + 1) % 4]!;
    if (withNear) out.push(...c, ...d);
    out.push(0, 0, 0, ...a);
  }
  return out;
}

/** Triangles of the 4 side faces of the same frustum (for a translucent fill). */
export function frustumFaces(hfov: number, aspect: number, far: number): BufferGeometry {
  const hw = Math.tan(hfov / 2) * far;
  const hh = hw / aspect;
  const c = [
    [-hw, -hh, -far],
    [hw, -hh, -far],
    [hw, hh, -far],
    [-hw, hh, -far],
  ];
  const pos: number[] = [];
  for (let i = 0; i < 4; i++) pos.push(0, 0, 0, ...c[i]!, ...c[(i + 1) % 4]!);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/* ───────────────────────── dynamic dot streams ───────────────────────── */

export interface StreamSpec {
  /** Writes the current start point into `out` (called every frame). */
  from: (out: Vector3) => Vector3;
  to: (out: Vector3) => Vector3;
  /** Control-point offset added to the midpoint (world units). Default [0, 0.35, 0]. */
  bend?: readonly [number, number, number];
  /** Palette colour of this stream. */
  color: (p: Palette) => Color;
  /** Opacity group (e.g. 'sense', 'act'): `setGroup(name, level)` dims a whole group. */
  group: string;
  /** Dots per stream (default 7). */
  dots?: number;
  /** World units per second (default 0.55). */
  speed?: number;
  /** Phase offset 0..1. */
  phase?: number;
}

const A = new Vector3();
const B = new Vector3();
const C = new Vector3();
const D = new Vector3();
const ONE = new Vector3(1, 1, 1);

/**
 * Small solid dots that travel along quadratic Bézier curves between (possibly moving) points.
 * Light theme: solid dots. Dark theme: dots plus additive halos (GlowSprites).
 * Reduced motion: dots are spread evenly and frozen (`setReduced(true)`).
 */
export class DotStreams {
  readonly mesh: InstancedMesh;
  readonly glows: GlowSprites;
  private readonly specs: StreamSpec[];
  private readonly base: number[] = [];
  private readonly levels = new Map<string, number>();
  private readonly target = new Map<string, number>();
  private readonly colors: Color[] = [];
  private readonly bg = new Color();
  private readonly tmpC = new Color();
  private dark = true;
  private reduced = false;
  private time = 0;
  private size = 0.022;
  readonly total: number;

  constructor(ctx: SceneContext, specs: StreamSpec[], parent: Group) {
    this.specs = specs;
    let n = 0;
    for (const s of specs) {
      this.base.push(n);
      n += s.dots ?? 7;
      this.levels.set(s.group, 1);
      this.target.set(s.group, 1);
    }
    this.total = n;
    const geo = ctx.track(new IcosahedronGeometry(1, 1));
    const mat = ctx.track(new MeshBasicMaterial({ toneMapped: false }));
    this.mesh = new InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.setColorAt(0, new Color());
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    ctx.track({ dispose: () => this.mesh.dispose() });
    this.glows = ctx.track(new GlowSprites({ count: n, theme: ctx.theme }));
    this.glows.object.renderOrder = 7;
    parent.add(this.mesh, this.glows.object);
    this.setPalette(ctx.palette);
  }

  setPalette(p: Palette): void {
    this.dark = p.theme === 'dark';
    this.bg.copy(p.bg);
    this.colors.length = 0;
    for (const s of this.specs) this.colors.push(s.color(p).clone());
    this.glows.setTheme(p.theme);
    this.glows.object.visible = this.dark;
    this.size = this.dark ? 0.02 : 0.019;
  }

  setReduced(on: boolean): void {
    this.reduced = on;
  }

  /** Target visibility of a group: 1 = full, 0.25 = dimmed, 0 = hidden. Eased in update(). */
  setGroup(name: string, level: number, instant = false): void {
    this.target.set(name, level);
    if (instant) this.levels.set(name, level);
  }

  /** Advance (dt seconds of animation time) and rewrite every dot. Returns true while easing. */
  update(dt: number, realDt = dt): boolean {
    if (!this.reduced) this.time += dt;
    let easing = false;
    for (const [g, to] of this.target) {
      const cur = this.levels.get(g) ?? to;
      if (Math.abs(cur - to) > 0.001) {
        const k = Math.min(1, realDt * 5 + (this.reduced ? 1 : 0));
        this.levels.set(g, cur + (to - cur) * k);
        easing = true;
      } else this.levels.set(g, to);
    }
    this.specs.forEach((s, si) => {
      const n = s.dots ?? 7;
      s.from(A);
      s.to(B);
      const bend = s.bend ?? [0, 0.35, 0];
      C.addVectors(A, B).multiplyScalar(0.5).add(D.set(bend[0], bend[1], bend[2]));
      const len = A.distanceTo(C) + C.distanceTo(B);
      const lvl = this.levels.get(s.group) ?? 1;
      const col = this.colors[si]!;
      const speed = s.speed ?? 0.55;
      for (let i = 0; i < n; i++) {
        const idx = this.base[si]! + i;
        let t = this.reduced ? (i + 0.5) / n : (this.time * speed) / Math.max(0.2, len) + i / n + (s.phase ?? 0);
        t -= Math.floor(t);
        const u = 1 - t;
        D.copy(A)
          .multiplyScalar(u * u)
          .addScaledVector(C, 2 * u * t)
          .addScaledVector(B, t * t);
        const edge = this.reduced ? 1 : smooth(0, 0.12, t) * smooth(1, 0.88, t);
        const sc = this.size * (0.55 + 0.45 * edge) * (lvl > 0.02 ? 0.6 + 0.4 * lvl : 0);
        M.compose(D, Q.identity(), S.copy(ONE).multiplyScalar(sc));
        this.mesh.setMatrixAt(idx, M);
        this.tmpC.copy(col).lerp(this.bg, (1 - lvl) * 0.75);
        this.mesh.setColorAt(idx, this.tmpC);
        this.glows.set(idx, D, sc * 6.5, col, this.dark ? 0.5 * lvl * edge : 0);
      }
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return easing;
  }
}
